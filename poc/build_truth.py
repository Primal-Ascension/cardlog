"""Ground-truth art groups for scoring, built without either candidate encoder.

Two same-name cards share art when SIFT keypoints on their art boxes agree
under a RANSAC homography. Matching keypoints on the drawing itself ignores
holo foil patterns and the swirl backgrounds of same-set non-holo printings,
which defeated whole-image pixel comparison. On the POC sets, different art
scores under 10 inliers and true reprints score 20 or more.

Basic energies have no art box, so same-name energies are grouped by rule.
Pairs where metadata and keypoints disagree go to the review list instead of
being merged.

Writes poc/art_groups_truth.json. Once you have checked it, set "reviewed":
true in that file and reruns will leave it alone.
"""
import itertools
import json
import re
from collections import defaultdict

import cv2
import numpy as np
from PIL import Image

from common import POC_DIR, image_path, load_cards
from imaging import art_crop

OUT = POC_DIR / 'art_groups_truth.json'
INLIERS_SAME = 20     # at or above: same art (artist must also match)
INLIERS_REVIEW = 10   # artist matches but inliers fall between the bounds: flag

# Pairs confirmed by eye that the keypoint test misses (featureless art).
MANUAL_SAME = [
    ('base3-3', 'base3-18'),   # Fossil Ditto holo / non-holo: 17 inliers
]

_sift = cv2.SIFT_create(nfeatures=1500)
_clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
_matcher = cv2.BFMatcher()


def norm_name(n):
    return re.sub(r'\s+', ' ', n.lower().replace('é', 'e')).strip()


def art_features(card):
    g = art_crop(Image.open(image_path(card, 'large')).convert('L')).resize((480, 250), Image.BILINEAR)
    return _sift.detectAndCompute(_clahe.apply(np.asarray(g)), None)


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


def main():
    if OUT.exists() and json.loads(OUT.read_text(encoding='utf-8')).get('reviewed'):
        print('%s is marked reviewed; not overwriting.' % OUT)
        return

    cards = load_cards()
    by_name = defaultdict(list)
    for c in cards:
        by_name[norm_name(c['name'])].append(c)

    feats = {}
    parent = {c['id']: c['id'] for c in cards}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    review = []
    for group in by_name.values():
        for a, b in itertools.combinations(group, 2):
            if a['supertype'] == 'Energy' and b['supertype'] == 'Energy':
                parent[find(a['id'])] = find(b['id'])
                continue
            for c in (a, b):
                if c['id'] not in feats:
                    feats[c['id']] = art_features(c)
            n = inliers(feats[a['id']], feats[b['id']])
            artists_ok = not (a['artist'] and b['artist']) or a['artist'] == b['artist']
            pair = {'a': a['id'], 'b': b['id'], 'name': a['name'], 'inliers': n,
                    'artist_a': a['artist'], 'artist_b': b['artist']}
            if n >= INLIERS_SAME and artists_ok:
                parent[find(a['id'])] = find(b['id'])
            elif n >= INLIERS_SAME:
                review.append(dict(pair, reason='art matches, artist differs'))
            elif n >= INLIERS_REVIEW and artists_ok:
                review.append(dict(pair, reason='same name and artist, art match borderline'))

    manual = {frozenset(p) for p in MANUAL_SAME if all(i in parent for i in p)}
    for a, b in manual:
        parent[find(a)] = find(b)
    review = [p for p in review if frozenset((p['a'], p['b'])) not in manual]

    members = defaultdict(list)
    for c in cards:
        members[find(c['id'])].append(c)
    groups = []
    for ms in members.values():
        ms.sort(key=lambda c: (c['release_date'], c['set_id'], int(re.sub(r'\D', '', c['number']) or 0)))
        groups.append([c['id'] for c in ms])
    groups.sort(key=lambda g: g[0])

    multi = [g for g in groups if len(g) > 1]
    OUT.write_text(json.dumps({
        'reviewed': False,
        'thresholds': {'inliers_same': INLIERS_SAME, 'inliers_review': INLIERS_REVIEW},
        'groups': groups,
        'review': sorted(review, key=lambda p: -p['inliers']),
    }, indent=1), encoding='utf-8')
    print('%d cards, %d groups (%d with reprints), %d pairs to review -> %s'
          % (len(cards), len(groups), len(multi), len(review), OUT))


if __name__ == '__main__':
    main()
