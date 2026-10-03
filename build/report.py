"""Step 8: build report and art-group review log for the Phase 2 gate.

Usage:  python report.py [--sanity N]

Writes build/reports/build_report.md and build/reports/art_group_review.md
(committed, small). --sanity N embeds the small scan of N random cards per
series and checks the index finds the right art group: a quick check that
every era is distinguishable, not a substitute for real photos.
"""
import argparse
import json
import random
from collections import Counter, defaultdict

import numpy as np
from PIL import Image

from config import BUILD_OUT, CACHE, CARDS_DIR, EMBED_DIR, ROOT, SETS_FILE, VINTAGE_END, image_path

REPORTS = ROOT / 'reports'


def folder_sizes(manifest):
    sizes = Counter()
    for path, f in manifest['files'].items():
        sizes[path.split('/')[0] if '/' in path else '(root files)'] += f['bytes']
    return sizes


def sanity(n_per_series, cards, groups):
    from embedder import OnnxEncoder, art_crop
    vecs, ids = [], []
    for p in sorted(EMBED_DIR.glob('*.npz')):
        z = np.load(p)
        vecs.append(z['vecs'])
        ids.extend(z['ids'])
    V = np.concatenate(vecs).astype(np.float32)
    group_of = {cid: gid for gid, g in groups.items() for cid in g['members']}
    by_series = defaultdict(list)
    for c in cards:
        if image_path(c, 'small').exists():
            by_series[c['series'] or '?'].append(c)
    enc = OnnxEncoder('fp32')
    rng = random.Random(7)
    rows = []
    for series, cs in sorted(by_series.items(), key=lambda kv: min(c['release_date'] for c in kv[1])):
        sample = rng.sample(cs, min(n_per_series, len(cs)))
        q = enc.embed([art_crop(Image.open(image_path(c, 'small')).convert('RGB'))
                       for c in sample])
        top = np.argmax(q @ V.T, axis=1)
        exact = sum(ids[t] == c['id'] for t, c in zip(top, sample))
        grp = sum(group_of.get(ids[t]) == group_of.get(c['id']) for t, c in zip(top, sample))
        rows.append((series, len(sample), grp, exact))
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--sanity', type=int, default=0)
    args = ap.parse_args()
    REPORTS.mkdir(exist_ok=True)

    sets = json.loads(SETS_FILE.read_text(encoding='utf-8'))
    cards = []
    for s in sets:
        p = CARDS_DIR / (s['id'] + '.json')
        if p.exists():
            cards.extend(json.loads(p.read_text(encoding='utf-8')))
    card_by_id = {c['id']: c for c in cards}
    groups = json.loads((CACHE / 'groups.json').read_text(encoding='utf-8'))
    review = json.loads((CACHE / 'groups_review.json').read_text(encoding='utf-8'))
    audit = json.loads((CACHE / 'variants_audit.json').read_text(encoding='utf-8'))
    manifest = json.loads((BUILD_OUT / 'manifest.json').read_text(encoding='utf-8'))

    multi = {gid: g for gid, g in groups.items() if len(g['members']) > 1}
    same_set_sets = Counter(card_by_id[rep]['set_id'] for g in groups.values() for rep in g['same_set'])
    size_dist = Counter(min(len(g['members']), 10) for g in multi.values())
    biggest = sorted(multi.values(), key=lambda g: -len(g['members']))[:8]

    L = ['# Scanner catalog build report', '',
         'Manifest version `%s`, built %s.' % (manifest['version'], manifest['built_at']), '',
         '## Counts', '',
         '| | |', '|---|---|',
         '| Cards | %d |' % manifest['counts']['cards'],
         '| Sets | %d |' % manifest['counts']['sets'],
         '| Art groups with reprints | %d (covering %d cards) |' % (len(multi), sum(len(g['members']) for g in multi.values())),
         '| Same-set holo/non-holo clusters | %d |' % sum(same_set_sets.values()),
         '| Pairs needing review | %d |' % len(review),
         '| Thumbnails | %d |' % manifest['counts']['thumbs'], '',
         '## Size by folder', '', '| Folder | MB |', '|---|---|']
    for folder, b in sorted(folder_sizes(manifest).items(), key=lambda kv: -kv[1]):
        L.append('| %s | %.1f |' % (folder, b / 1e6))
    L += ['| **Total** | **%.1f** (limit 800) |' % (manifest['bytes']['total'] / 1e6),
          '', 'Tier 1 (needed before scanning): %.1f MB. Tier 2 (thumbnails, background): %.1f MB.'
          % (manifest['bytes']['tier1'] / 1e6, manifest['bytes']['tier2'] / 1e6),
          'Largest file: %s, %.1f MB (limit 95).' % max(((k, f['bytes'] / 1e6) for k, f in manifest['files'].items()),
                                                         key=lambda kv: kv[1]), '',
          '## Art groups', '',
          'Group size distribution: ' + ', '.join('%s: %d' % ('10+' if k == 10 else k, v) for k, v in sorted(size_dist.items())), '',
          'Largest groups:', '']
    for g in biggest:
        c0 = card_by_id[g['members'][0]]
        L.append('- %s (%s): %d cards, %s' % (c0['name'], c0['artist'], len(g['members']), ', '.join(g['members'][:12])
                                               + (' ...' if len(g['members']) > 12 else '')))
    L += ['', '### Spec checks: expected reprint groups', '']
    for label, probe in [('Base Set Charizard', 'base1-4'), ('Base Set Blastoise', 'base1-2'), ('Base Set Venusaur', 'base1-15'),
                         ('Base Set Pikachu', 'base1-58'), ('Base Set Mewtwo', 'base1-10'), ('Base Set Chansey', 'base1-3')]:
        g = next((g for g in groups.values() if probe in g['members']), None)
        if g:
            L.append('- %s: %s' % (label, ', '.join('%s (%s)' % (m, card_by_id[m]['set_name']) for m in g['members'])))
    # Agreement with the Phase 1 answer key (reprint groups checked by eye).
    truth_path = ROOT.parent / 'poc' / 'art_groups_truth.json'
    if truth_path.exists():
        truth = json.loads(truth_path.read_text(encoding='utf-8'))['groups']
        poc_ids = {cid for g in truth for cid in g}
        t_of = {cid: i for i, g in enumerate(truth) for cid in g}
        b_of = {cid: gid for gid, g in groups.items() for cid in g['members']}
        ids = sorted(poc_ids & set(b_of))
        missed, extra = [], []
        for x in range(len(ids)):
            for y in range(x + 1, len(ids)):
                a, b = ids[x], ids[y]
                same_t, same_b = t_of[a] == t_of[b], b_of[a] == b_of[b]
                if same_t and not same_b:
                    missed.append((a, b))
                elif same_b and not same_t:
                    extra.append((a, b))
        L += ['', '### Agreement with the Phase 1 answer key', '',
              '%d cards from the five Phase 1 sets, whose reprint groups were checked by eye. '
              'Same-art pairs the build missed: %d. Pairs it joined that the key keeps apart: %d.'
              % (len(ids), len(missed), len(extra)), '']
        for a, b in missed[:15]:
            L.append('- missed: %s %s / %s %s' % (a, card_by_id[a]['name'], b, card_by_id[b]['name']))
        for a, b in extra[:15]:
            L.append('- extra: %s %s / %s %s' % (a, card_by_id[a]['name'], b, card_by_id[b]['name']))
    L += ['', '### Sets with same-set holo/non-holo pairs', '',
          'Grouped by art but treated as printings of one card, non-holo default (spec section 5).', '']
    for sid, n in sorted(same_set_sets.items(), key=lambda kv: -kv[1]):
        s = next(x for x in sets if x['id'] == sid)
        L.append('- %s (%s, %s): %d' % (s['name'], sid, s['release_date'][:4], n))

    L += ['', '## Print variants: 1996-2007 key coverage', '',
          'Unknown tcgplayer keys seen: %s.' % (audit['unknown_keys'] or 'none'), '',
          '| Set | Year | Cards | No keys | Missing 1st/Unlimited | Missing reverse holo | Override |',
          '|---|---|---|---|---|---|---|']
    for r in audit['sets']:
        rev = r.get('missing_reverse_holo_key')
        L.append('| %s (%s) | %s | %d | %d | %s | %s | %s |' % (
            r['set_name'], r['set_id'], r['release_date'][:4], r['cards'], r['no_keys'],
            r.get('missing_1st_or_unlimited_keys', ''),
            '' if rev is None else '%d %s' % (rev, json.dumps(r['missing_reverse_by_rarity']) if rev else ''),
            'yes' if r['override'] else ''))

    if args.sanity:
        L += ['', '## Sanity check by era (official small scans, not photos)', '',
              '| Series | Sampled | Right art group | Exact card |', '|---|---|---|---|']
        for series, n, grp, exact in sanity(args.sanity, cards, groups):
            L.append('| %s | %d | %.0f%% | %.0f%% |' % (series, n, 100 * grp / n, 100 * exact / n))

    (REPORTS / 'build_report.md').write_text('\n'.join(L) + '\n', encoding='utf-8')

    R = ['# Art group review log', '',
         'Pairs the build did not merge automatically. Add confirmed merges or splits to',
         '`build/art_groups_overrides.json` as `{"merge": [["id1", "id2"]], "split": [["id1", "id2"]]}`.', '']
    def vintage(e):
        return min(card_by_id[e['a']]['release_date'], card_by_id[e['b']]['release_date']) <= VINTAGE_END

    def clean(s):
        return ' '.join(str(s).split())

    for era, keep in (('1996-2007 (your focus)', vintage), ('2008 onward', lambda e: not vintage(e))):
        es_era = [e for e in review if keep(e)]
        R += ['# %s: %d pairs' % (era, len(es_era)), '']
        by_reason = defaultdict(list)
        for e in es_era:
            by_reason[e['reason']].append(e)
        for reason, es in by_reason.items():
            R += ['## %s (%d)' % (reason, len(es)), '', '| A | B | Cosine | Keypoints | Artists |', '|---|---|---|---|---|']
            for e in es:
                R.append('| %s %s (%s) | %s %s (%s) | %.3f | %d | %s / %s |' % (
                    e['a'], e['name_a'], card_by_id[e['a']]['set_name'], e['b'], e['name_b'],
                    card_by_id[e['b']]['set_name'], e['cosine'], e['inliers'], clean(e['artist_a']), clean(e['artist_b'])))
            R.append('')
    (REPORTS / 'art_group_review.md').write_text('\n'.join(R) + '\n', encoding='utf-8')
    print('wrote', REPORTS / 'build_report.md', 'and', REPORTS / 'art_group_review.md')


if __name__ == '__main__':
    main()
