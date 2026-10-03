"""Step 5: per-card printings (1st Edition, Shadowless, Unlimited, reverse holo, ...)
and the default printing, plus the 1996-2007 key-coverage audit.

Usage:  python variants.py      (run after groups.py)

Source: the key names of tcgplayer.prices (values were never stored), mapped
to display names, then variants_overrides.json. Default rule: the most common
printing, so an unconfirmed scan never logs as a scarcer, more valuable one.

Same-set holo/non-holo pairs (one art group cluster in a single set) share one
chip list: the non-holo card's printings first, then the holo card's prefixed
"Holo ·". Each chip names the card id it resolves to.

Writes cache/variants.json and cache/variants_audit.json.
"""
import json
from collections import Counter, defaultdict

from config import CACHE, CARDS_DIR, OVERRIDES, SETS_FILE, VINTAGE_END

KEY_MAP = {
    'normal': ('normal', 'Normal'),
    'holofoil': ('holo', 'Holo'),
    'reverseHolofoil': ('reverse_holo', 'Reverse Holo'),
    '1stEdition': ('1st_edition', '1st Edition'),
    '1stEditionNormal': ('1st_edition', '1st Edition'),
    '1stEditionHolofoil': ('1st_edition', '1st Edition'),
    'unlimited': ('unlimited', 'Unlimited'),
    'unlimitedNormal': ('unlimited', 'Unlimited'),
    'unlimitedHolofoil': ('unlimited', 'Unlimited'),
}
# Most common first. The default is the first non-optional printing in this order.
PRIORITY = ['unlimited', 'normal', 'holo', 'reverse_holo', 'shadowless', '1st_edition', '4th_print']

FIRST_EDITION_SETS = {'base1', 'base2', 'base3', 'base5', 'gym1', 'gym2', 'neo1', 'neo2', 'neo3', 'neo4'}
REVERSE_HOLO_SETS_FROM = '2002-05-24'   # Legendary Collection introduced reverse holos
# Printed without reverse holos, so a missing key there is not a gap.
NO_REVERSE_RARITIES = {'Rare Holo EX', 'Rare Holo Star', 'Rare Secret', 'Rare Holo LV.X', 'Promo'}
NO_REVERSE_SET_WORDS = ('Promo', 'POP Series', 'Trainer Kit', 'Best of Game')
HOLO_ONLY_H_SETS = {'ecard2', 'ecard3'}   # Aquapolis / Skyridge H-numbered holos

GROUPS = CACHE / 'groups.json'
OUT = CACHE / 'variants.json'
AUDIT_OUT = CACHE / 'variants_audit.json'


def rank(p):
    return (p.get('optional', False), PRIORITY.index(p['code']) if p['code'] in PRIORITY else len(PRIORITY))


def own_printings(card, ov, unknown):
    found = {}
    for k in card['printings']:
        if k in KEY_MAP:
            code, label = KEY_MAP[k]
        else:
            unknown[k] += 1
            code, label = k, k
        found.setdefault(code, {'code': code, 'label': label})
    rule = ov['sets'].get(card['set_id'], {})
    if 'replace' in rule:
        found = {p['code']: dict(p) for p in rule['replace']}
    for p in rule.get('ensure', []):
        found.setdefault(p['code'], dict(p))
    fix = ov['cards'].get(card['id'], {})
    for p in fix.get('add', []):
        found[p['code']] = dict(p)
    for code in fix.get('remove', []):
        found.pop(code, None)
    return sorted(found.values(), key=rank)


def main():
    ov = json.loads(OVERRIDES.read_text(encoding='utf-8'))
    ov.setdefault('sets', {})
    ov.setdefault('cards', {})
    sets = json.loads(SETS_FILE.read_text(encoding='utf-8'))
    cards = {}
    for s in sets:
        p = CARDS_DIR / (s['id'] + '.json')
        if p.exists():
            for c in json.loads(p.read_text(encoding='utf-8')):
                cards[c['id']] = c
    groups = json.loads(GROUPS.read_text(encoding='utf-8'))

    unknown = Counter()
    own = {cid: own_printings(c, ov, unknown) for cid, c in cards.items()}

    variants = {}
    for cid, ps in own.items():
        chips = [dict(p, card=cid) for p in ps]
        variants[cid] = {'printings': chips, 'default': 0 if chips else None}

    for g in groups.values():
        for rep, cluster in g['same_set'].items():
            chips = []
            rep_card = cards[cluster[0]]
            for k, cid in enumerate(cluster):  # non-holo / most common first
                c = cards[cid]
                if k == 0:
                    prefix = ''
                elif 'holo' in (c.get('rarity') or '').lower() and 'holo' not in (rep_card.get('rarity') or '').lower():
                    prefix = 'Holo'    # classic WOTC pair: same art as a holo and a non-holo rare
                else:
                    prefix = c.get('rarity') or ''   # modern: Full Art / Rainbow / Gold of the same art
                    if not prefix or prefix == rep_card.get('rarity'):
                        prefix = (prefix + ' #' + c['number']).strip()
                for p in own.get(cid, []):
                    if not prefix:
                        label = p['label']
                    elif p['code'] == 'holo' or len(own.get(cid, [])) == 1:
                        label = prefix
                    else:
                        label = prefix + ' · ' + p['label']
                    chips.append(dict(p, label=label, card=cid))
            if not chips:
                continue
            default = next((i for i, c in enumerate(chips) if c['card'] == cluster[0] and not c.get('optional')), 0)
            for cid in cluster:
                variants[cid] = {'printings': chips, 'default': default, 'same_set_cluster': cluster}

    # Audit: 1996-2007 sets.
    audit = []
    by_set = defaultdict(list)
    for c in cards.values():
        by_set[c['set_id']].append(c)
    for s in sets:
        if s['release_date'] > VINTAGE_END or s['id'] not in by_set:
            continue
        cs = by_set[s['id']]
        no_keys = [c['id'] for c in cs if not c['printings']]
        row = {'set_id': s['id'], 'set_name': s['name'], 'release_date': s['release_date'],
               'cards': len(cs), 'no_keys': len(no_keys), 'no_keys_examples': no_keys[:5],
               'override': s['id'] in ov['sets']}
        if s['id'] in FIRST_EDITION_SETS:
            miss = [c['id'] for c in cs
                    if not {'1st_edition', 'unlimited'} <= {KEY_MAP.get(k, (k,))[0] for k in c['printings']}]
            row['missing_1st_or_unlimited_keys'] = len(miss)
            row['missing_examples'] = miss[:5]
        elif s['release_date'] >= REVERSE_HOLO_SETS_FROM and not any(w in s['name'] for w in NO_REVERSE_SET_WORDS):
            miss = [c for c in cs if 'reverseHolofoil' not in c['printings']
                    and (c.get('rarity') or '') not in NO_REVERSE_RARITIES
                    and not (s['id'] in HOLO_ONLY_H_SETS and c['number'].startswith('H'))]
            row['missing_reverse_holo_key'] = len(miss)
            row['missing_reverse_by_rarity'] = dict(Counter(c.get('rarity') or 'None' for c in miss))
        audit.append(row)

    OUT.write_text(json.dumps(variants, separators=(',', ':'), ensure_ascii=False), encoding='utf-8')
    AUDIT_OUT.write_text(json.dumps({'unknown_keys': dict(unknown), 'sets': audit}, indent=1,
                                    ensure_ascii=False), encoding='utf-8')
    defaults = Counter(v['printings'][v['default']]['code'] for v in variants.values() if v['printings'])
    print('%d cards, %d with no printings at all; default printing counts: %s; unknown keys: %s'
          % (len(variants), sum(1 for v in variants.values() if not v['printings']),
             dict(defaults), dict(unknown) or 'none'), flush=True)


if __name__ == '__main__':
    main()
