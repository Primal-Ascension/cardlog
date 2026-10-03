"""Step 4: cluster same-art cards into art groups, and log what needs review.

Usage:  python groups.py

Thresholds were tuned on the Phase 1 sets with the shipping encoder: every
true reprint pair has art-crop cosine >= 0.76, while 1% of different-art pairs
also clear 0.70. So cosine only nominates candidates; SIFT keypoints on the art
box plus metadata decide.

  merge   same name, artists agree, cosine >= 0.70 and >= 20 keypoint inliers
  merge   same name, artists agree, cosine >= 0.85 and >= 12 inliers (featureless art)
  merge   basic energies with the same name and cosine >= 0.90
  review  cosine >= 0.90 and >= 30 inliers but the names differ
  review  same name, >= 20 inliers, artists differ
  review  same name, artists agree, cosine >= 0.85 but too few inliers

Manual decisions go in art_groups_overrides.json ({"merge": [[a, b]],
"split": [[a, b]]}) and are applied last, so a rebuild keeps them.

Writes cache/groups.json (consumed by publish.py) and cache/groups_review.json.
"""
import json
import re
from collections import OrderedDict, defaultdict

import cv2
import numpy as np

from config import ART_DIR, CACHE, CARDS_DIR, EMBED_DIR, ROOT, SETS_FILE, file_id

COS_CAND = 0.70
COS_FEATURELESS = 0.85
COS_ENERGY = 0.90
COS_NAME_MISMATCH = 0.90
COS_REVIEW_FEW_INLIERS = 0.85
INLIERS_SAME = 20
INLIERS_FEATURELESS = 12   # Base/BS2 Magneton (17), TR Dark Dragonite holo/non-holo (12)
INLIERS_NAME_MISMATCH = 30
KP_TRIM = 0.12   # fraction of the art crop ignored at top and bottom for keypoints

OVERRIDES = ROOT / 'art_groups_overrides.json'
OUT = CACHE / 'groups.json'
REVIEW_OUT = CACHE / 'groups_review.json'

_sift = cv2.SIFT_create(nfeatures=1000)
_clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
_matcher = cv2.BFMatcher()


class FeatureCache:
    def __init__(self, cap=4000):
        self.cap, self.d = cap, OrderedDict()

    def get(self, card):
        cid = card['id']
        if cid in self.d:
            self.d.move_to_end(cid)
            return self.d[cid]
        g = cv2.imread(str(ART_DIR / card['set_id'] / (file_id(cid) + '.png')), cv2.IMREAD_GRAYSCALE)
        if g is not None:
            # From Black & White on, the fixed crop catches "Evolves from ..." at
            # the top and the "NO. 025 Mouse Pokemon HT/WT" strip at the bottom,
            # text that is identical on every card of a species and made
            # different art match. Keypoints only come from the middle band.
            h = g.shape[0]
            g = g[int(h * KP_TRIM): int(h * (1 - KP_TRIM))]
        f = (None, None) if g is None else _sift.detectAndCompute(_clahe.apply(g), None)
        self.d[cid] = f
        if len(self.d) > self.cap:
            self.d.popitem(last=False)
        return f


class PairCache:
    """Keypoint results persist between runs, keyed by both crops' source keys,
    so a rebuild only matches pairs whose images changed."""
    PATH = CACHE / 'pair_inliers.json'

    def __init__(self, keys):
        self.keys = keys
        self.d = json.loads(self.PATH.read_text(encoding='utf-8')) if self.PATH.exists() else {}
        if self.d.get('_version') != KP_TRIM:
            self.d = {'_version': KP_TRIM}
        self.hits = 0

    def get(self, a, b, compute):
        k = '|'.join(sorted(('%s@%s' % (a['id'], self.keys.get(a['id'], '')),
                             '%s@%s' % (b['id'], self.keys.get(b['id'], '')))))
        if k in self.d:
            self.hits += 1
            return self.d[k]
        v = self.d[k] = compute()
        return v

    def save(self):
        self.PATH.write_text(json.dumps(self.d), encoding='utf-8')


def inliers(fa, fb):
    (ka, da), (kb, db) = fa, fb
    if da is None or db is None or len(ka) < 2 or len(kb) < 2:
        return 0
    good = [m for m, n in _matcher.knnMatch(da, db, k=2) if m.distance < 0.75 * n.distance]
    if len(good) < 8:
        return len(good)
    pa = np.float32([ka[m.queryIdx].pt for m in good])
    pb = np.float32([kb[m.trainIdx].pt for m in good])
    _, mask = cv2.findHomography(pa, pb, cv2.RANSAC, 6.0)
    return int(mask.sum()) if mask is not None else 0


def norm_name(n):
    n = n.lower().replace('é', 'e').replace('’', "'")
    n = re.sub(r'\s*\([^)]*\)\s*$', '', n)   # "Professor's Research (Professor Sada)" -> "professor's research"
    return re.sub(r'\s+', ' ', n).strip()


def norm_artist(a):
    """'Shinji Higuchi + Noriko Takaya' == 'Noriko Takaya, Shinji Higuchi'; 'aky CG Works' == 'akyCG Works'."""
    if not a:
        return None
    parts = re.split(r'\s*(?:\+|&|,|/|\band\b)\s*', a.lower())
    return tuple(sorted(re.sub(r'[^a-z0-9]', '', p) for p in parts if p.strip()))


def is_basic_energy(c):
    return c.get('supertype') == 'Energy' and 'Basic' in (c.get('subtypes') or [])


def card_sort_key(c):
    num = re.match(r'(\D*)(\d*)', c['number'])
    return (c['release_date'], c['set_id'], num.group(1), int(num.group(2) or 0), c['number'])


def is_holo(c):
    return 'holo' in (c.get('rarity') or '').lower()


def load_catalog():
    sets = json.loads(SETS_FILE.read_text(encoding='utf-8'))
    cards, vecs, keys = [], [], {}
    for s in sets:
        p, e = CARDS_DIR / (s['id'] + '.json'), EMBED_DIR / (s['id'] + '.npz')
        if not (p.exists() and e.exists()):
            continue
        cs = json.loads(p.read_text(encoding='utf-8'))
        z = np.load(e)
        assert list(z['ids']) == [c['id'] for c in cs], 'stale embeddings for ' + s['id']
        cards.extend(cs)
        vecs.append(z['vecs'])
        keys.update(zip(z['ids'], z['keys']))
    return cards, np.concatenate(vecs).astype(np.float32), keys


def main():
    cards, V, src_keys = load_catalog()
    pairs = PairCache({k: str(v) for k, v in src_keys.items()})
    idx = {c['id']: i for i, c in enumerate(cards)}
    print('%d cards with embeddings' % len(cards), flush=True)

    parent = list(range(len(cards)))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a, b):
        parent[find(a)] = find(b)

    feats = FeatureCache()
    review, merged_pairs = [], 0

    def artists_ok(a, b):
        x, y = norm_artist(a['artist']), norm_artist(b['artist'])
        return x is None or y is None or x == y

    def entry(a, b, cos, n, reason):
        return {'a': a['id'], 'b': b['id'], 'name_a': a['name'], 'name_b': b['name'],
                'artist_a': a['artist'], 'artist_b': b['artist'],
                'cosine': round(float(cos), 3), 'inliers': n, 'reason': reason}

    # 1) Same-name pairs: the reprint candidates.
    by_name = defaultdict(list)
    for i, c in enumerate(cards):
        by_name[norm_name(c['name'])].append(i)
    checked = 0
    for name, members in by_name.items():
        if len(members) < 2:
            continue
        m = np.array(members)
        S = V[m] @ V[m].T
        for x in range(len(m)):
            for y in range(x + 1, len(m)):
                cos = S[x, y]
                if cos < COS_CAND:
                    continue
                a, b = cards[m[x]], cards[m[y]]
                if is_basic_energy(a) and is_basic_energy(b):
                    if cos >= COS_ENERGY:
                        union(m[x], m[y])
                        merged_pairs += 1
                    continue
                n = pairs.get(a, b, lambda: inliers(feats.get(a), feats.get(b)))
                checked += 1
                ok = artists_ok(a, b)
                if ok and (n >= INLIERS_SAME or (cos >= COS_FEATURELESS and n >= INLIERS_FEATURELESS)):
                    union(m[x], m[y])
                    merged_pairs += 1
                elif n >= INLIERS_SAME and not ok:
                    review.append(entry(a, b, cos, n, 'art matches, artist differs'))
                elif ok and cos >= COS_REVIEW_FEW_INLIERS:
                    review.append(entry(a, b, cos, n, 'same name and artist, art match borderline'))
    print('same-name pairs checked with keypoints: %d, merged: %d' % (checked, merged_pairs), flush=True)

    # 2) Near-identical art under different names: log only, never merge.
    names = [norm_name(c['name']) for c in cards]
    block = 2048
    mismatch = 0
    for start in range(0, len(cards), block):
        S = V[start:start + block] @ V.T
        rows, cols = np.nonzero(S >= COS_NAME_MISMATCH)
        for r, col in zip(rows, cols):
            i = start + r
            if col <= i or names[i] == names[col]:
                continue
            a, b = cards[i], cards[col]
            if is_basic_energy(a) and is_basic_energy(b):
                continue
            n = pairs.get(a, b, lambda: inliers(feats.get(a), feats.get(b)))
            if n >= INLIERS_NAME_MISMATCH:
                review.append(entry(a, b, S[r, col], n, 'art matches, name differs'))
                mismatch += 1
    print('different-name near-duplicates logged: %d (keypoint results reused from cache: %d)'
          % (mismatch, pairs.hits), flush=True)
    pairs.save()

    # 3) Manual decisions from the owner's review.
    ov = json.loads(OVERRIDES.read_text(encoding='utf-8')) if OVERRIDES.exists() else {}
    for a, b in ov.get('merge', []):
        if a in idx and b in idx:
            union(idx[a], idx[b])
    members = defaultdict(list)
    for i in range(len(cards)):
        members[find(i)].append(i)
    splits = {frozenset(p) for p in ov.get('split', [])}
    if splits:
        # Rebuild the affected groups without the forbidden pairs' links.
        for root, ms in list(members.items()):
            ids = {cards[i]['id'] for i in ms}
            if any(p <= ids for p in splits):
                for i in ms:
                    parent[i] = i
                for x in ms:
                    for y in ms:
                        if x < y and frozenset((cards[x]['id'], cards[y]['id'])) not in splits \
                                and norm_name(cards[x]['name']) == norm_name(cards[y]['name']) \
                                and V[x] @ V[y] >= COS_CAND:
                            union(x, y)
        members = defaultdict(list)
        for i in range(len(cards)):
            members[find(i)].append(i)

    # 4) Order each group, pick the default, mark same-set holo/non-holo clusters.
    groups = {}
    for ms in members.values():
        cs = sorted((cards[i] for i in ms), key=card_sort_key)
        gid = 'g-' + cs[0]['id']
        by_set = defaultdict(list)
        for c in cs:
            by_set[c['set_id']].append(c)
        reprints, same_set = [], {}
        for c in cs:
            cluster = by_set[c['set_id']]
            if len(cluster) > 1:
                # Same set, same art, different numbers (Jungle/Fossil/Team Rocket
                # holo + non-holo). One reprint entry; the non-holo represents it
                # and is the default (most common printing).
                rep = sorted(cluster, key=lambda x: (is_holo(x), card_sort_key(x)))[0]
                if rep['id'] not in same_set:
                    same_set[rep['id']] = [x['id'] for x in sorted(cluster, key=lambda x: (is_holo(x), card_sort_key(x)))]
                    reprints.append(rep['id'])
            else:
                reprints.append(c['id'])
        groups[gid] = {
            'members': [c['id'] for c in cs],
            'reprints': reprints,          # oldest first; reprints[0] is the default
            'same_set': same_set,          # representative -> cluster, non-holo first
        }

    OUT.write_text(json.dumps(groups, indent=0, ensure_ascii=False), encoding='utf-8')
    # Drop pairs that ended up in one group anyway (transitively or by override).
    group_of = {cid: gid for gid, g in groups.items() for cid in g['members']}
    review = [e for e in review if group_of[e['a']] != group_of[e['b']]]
    review.sort(key=lambda e: (e['reason'], -e['inliers']))
    REVIEW_OUT.write_text(json.dumps(review, indent=1, ensure_ascii=False), encoding='utf-8')
    multi = [g for g in groups.values() if len(g['members']) > 1]
    print('%d groups, %d with reprints, %d same-set clusters, %d pairs to review'
          % (len(groups), len(multi), sum(len(g['same_set']) for g in groups.values()), len(review)), flush=True)


if __name__ == '__main__':
    main()
