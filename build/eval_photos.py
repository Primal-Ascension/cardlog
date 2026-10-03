"""Regression check: score the owner's labeled photos with the shipping pipeline
(ONNX encoder + build preprocessing) against the Phase 1 POC catalog.

Usage:  python eval_photos.py [fp32 fp16 int8]

Uses poc/photos, poc/art_groups_truth.json and poc/imaging.py card detection.
Rerun after any change to the encoder, crop or preprocessing.
"""
import json
import sys
import time

import numpy as np
from PIL import Image

from config import REPO, image_path
from embedder import OnnxEncoder, art_crop

sys.path.insert(0, str(REPO / 'poc'))
from common import CORE_SETS, load_cards  # noqa: E402  (poc modules)
from imaging import detect_and_warp, load_rgb  # noqa: E402

PHOTOS = REPO / 'poc' / 'photos'


def main(variants):
    cards = load_cards()
    ids = [c['id'] for c in cards]
    truth = json.loads((REPO / 'poc' / 'art_groups_truth.json').read_text(encoding='utf-8'))
    group_of = {cid: gi for gi, g in enumerate(truth['groups']) for cid in g}
    photos = [(p, p.stem.split('_')[0]) for p in sorted(PHOTOS.iterdir())
              if p.suffix.lower() in {'.jpg', '.jpeg', '.png', '.heic'} and p.stem.split('_')[0] in group_of]
    warped = [detect_and_warp(load_rgb(p))[0] for p, _ in photos]
    cat_imgs = [art_crop(Image.open(image_path(c, 'large')).convert('RGB'))
                for c in cards]

    for v in variants:
        enc = OnnxEncoder(v)
        t0 = time.perf_counter()
        cat = enc.embed(cat_imgs)
        cat_s = time.perf_counter() - t0
        res = {'all': [0, 0, 0], 'core': [0, 0, 0]}
        hits, misses, times = [], [], []
        for (p, label), card in zip(photos, warped):
            t = time.perf_counter()
            q = enc.embed([art_crop(card), art_crop(card.rotate(180))])
            times.append((time.perf_counter() - t) * 1000)
            sims = np.maximum(cat @ q[0], cat @ q[1])
            top = [ids[i] for i in np.argsort(-sims)[:5]]
            g1 = group_of[top[0]] == group_of[label]
            g5 = any(group_of[t] == group_of[label] for t in top)
            (hits if g1 else misses).append(float(sims.max()))
            for k in ('all', 'core') if label.split('-')[0] in CORE_SETS else ('all',):
                res[k][0] += 1
                res[k][1] += g1
                res[k][2] += g5
        print('%-5s core: group@1 %5.1f%% group@5 %5.1f%% (n=%d) | all: @1 %5.1f%% @5 %5.1f%% (n=%d) '
              '| sim hits/misses %.3f/%.3f | %.0f ms/photo, catalog %.0f img/s'
              % (v, 100 * res['core'][1] / res['core'][0], 100 * res['core'][2] / res['core'][0], res['core'][0],
                 100 * res['all'][1] / res['all'][0], 100 * res['all'][2] / res['all'][0], res['all'][0],
                 np.median(hits), np.median(misses) if misses else float('nan'),
                 np.median(times), len(cat_imgs) / cat_s), flush=True)


if __name__ == '__main__':
    main(sys.argv[1:] or ['fp32', 'fp16', 'int8'])
