"""Python side of the browser parity check: same photos (JPG/PNG only, as the
browser test cannot decode HEIC), full catalog, shipping encoder, full-catalog
art groups. Prints one JSON line per photo plus a summary, for comparison with
poc/scan_test.html.

Usage:  python parity_python.py
"""
import json
import sys

import numpy as np

from config import CACHE, EMBED_DIR, REPO, SETS_FILE
from embedder import OnnxEncoder, art_crop

sys.path.insert(0, str(REPO / 'poc'))
from imaging import detect_and_warp, find_card_quad, load_rgb  # noqa: E402

CORE = ('base1', 'base2', 'base4', 'base6')


def main():
    sets = json.loads(SETS_FILE.read_text(encoding='utf-8'))
    ids, vecs = [], []
    for s in sets:
        p = EMBED_DIR / (s['id'] + '.npz')
        if p.exists():
            z = np.load(p)
            ids.extend(z['ids'])
            vecs.append(z['vecs'])
    V = np.concatenate(vecs).astype(np.float32)
    groups = json.loads((CACHE / 'groups.json').read_text(encoding='utf-8'))
    group_of = {cid: gid for gid, g in groups.items() for cid in g['members']}
    enc = OnnxEncoder('fp16')
    rows = []
    exts = ('.jpg', '.jpeg', '.png') + (('.heic',) if '--all' in sys.argv else ())
    for p in sorted((REPO / 'poc' / 'photos').iterdir()):
        if p.suffix.lower() not in exts:
            continue
        label = p.stem.split('_')[0]
        if label not in group_of:
            continue
        img = load_rgb(p)
        quad = find_card_quad(np.asarray(img))
        card, ok = detect_and_warp(img)
        q = enc.embed([art_crop(card), art_crop(card.rotate(180))])
        sims = np.maximum(V @ q[0], V @ q[1])
        top = [ids[i] for i in np.argsort(-sims)[:5]]
        g1 = group_of[top[0]] == group_of[label]
        g5 = any(group_of[t] == group_of[label] for t in top)
        rows.append({'f': p.name, 'label': label, 'quad': None if quad is None else np.round(quad).astype(int).tolist(),
                     'top': top, 'score': round(float(sims.max()), 3), 'g1': g1, 'g5': g5})
        print(json.dumps(rows[-1]))
    core = [r for r in rows if r['label'].split('-')[0] in CORE]
    print('SUMMARY core: group@1 %.1f%% group@5 %.1f%% (n=%d) | all: @1 %.1f%% @5 %.1f%% (n=%d)' % (
        100 * np.mean([r['g1'] for r in core]), 100 * np.mean([r['g5'] for r in core]), len(core),
        100 * np.mean([r['g1'] for r in rows]), 100 * np.mean([r['g5'] for r in rows]), len(rows)))


if __name__ == '__main__':
    main()
