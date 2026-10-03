"""Phase 1 harness: score every encoder x crop configuration on the labeled photos.

Usage:  python evaluate.py [--encoders dinov2-small mobileclip-s0] [--modes full art]

Photos go in poc/photos/, named by card id: base1-4.jpg, or base1-4_2.jpg for
a second shot of the same card. Writes poc/results/report.md, results.json,
and misses.csv.
"""
import argparse
import csv
import json
import time
from pathlib import Path

import numpy as np
from PIL import Image

from common import CORE_SETS, EMBED_DIR, PHOTOS_DIR, POC_DIR, RESULTS_DIR, image_path, load_cards
from encoders import DEVICE, ENCODERS
from imaging import art_crop, detect_and_warp, load_rgb

PHOTO_EXT = {'.jpg', '.jpeg', '.png', '.webp', '.heic'}
TOP_K = 5


def load_truth(cards):
    path = POC_DIR / 'art_groups_truth.json'
    if not path.exists():
        raise SystemExit('Missing %s. Run build_truth.py first.' % path)
    group_of = {}
    for gi, ids in enumerate(json.loads(path.read_text(encoding='utf-8'))['groups']):
        for cid in ids:
            group_of[cid] = gi
    return group_of


def load_photos(known_ids, photo_dir):
    photos, skipped = [], []
    for p in sorted(photo_dir.iterdir()):
        if p.suffix.lower() not in PHOTO_EXT:
            continue
        label = p.stem.split('_')[0]
        (photos if label in known_ids else skipped).append((p, label))
    if skipped:
        print('Skipping %d photos whose id is not in the POC sets: %s'
              % (len(skipped), ', '.join(s[0].name for s in skipped[:10])))
    if not photos:
        raise SystemExit('No labeled photos in %s.' % photo_dir)
    return photos


def view(img, mode):
    return art_crop(img) if mode == 'art' else img


def catalog_embeddings(enc, mode, cards):
    key = '%s_%s_%d' % (enc.name, mode, len(cards))
    path = EMBED_DIR / (key + '.npz')
    ids = [c['id'] for c in cards]
    if path.exists():
        z = np.load(path)
        if list(z['ids']) == ids:
            return z['vecs']
    imgs = [view(Image.open(image_path(c, 'large')).convert('RGB'), mode) for c in cards]
    vecs = enc.embed(imgs)
    np.savez(path, ids=np.array(ids), vecs=vecs)
    return vecs


def pct(xs, q):
    return float(np.percentile(xs, q)) if xs else float('nan')


def run_config(enc, mode, cards, group_of, photos, warped, detect_ms):
    cat = catalog_embeddings(enc, mode, cards)
    ids = [c['id'] for c in cards]
    enc.embed([view(warped[0][1], mode)])  # warm-up, not timed

    rows, times = [], []
    for (path, label), (_, card_img), d_ms in zip(photos, warped, detect_ms):
        t0 = time.perf_counter()
        # Embed upright and rotated 180 degrees: a card can be shot either way up.
        q = enc.embed([view(card_img, mode), view(card_img.rotate(180), mode)])
        sims = np.maximum(cat @ q[0], cat @ q[1])
        top = np.argsort(-sims)[:TOP_K]
        times.append(d_ms + (time.perf_counter() - t0) * 1000)

        top_ids = [ids[i] for i in top]
        g = group_of[label]
        rows.append({
            'photo': path.name, 'label': label,
            'exact_top1': top_ids[0] == label,
            'group_top1': group_of[top_ids[0]] == g,
            'group_top5': any(group_of[t] == g for t in top_ids),
            'top1_sim': float(sims[top[0]]),
            'top5': ['%s (%.3f)' % (ids[i], sims[i]) for i in top],
        })

    hit = [r['top1_sim'] for r in rows if r['group_top1']]
    miss = [r['top1_sim'] for r in rows if not r['group_top1']]
    core = [r for r in rows if r['label'].split('-')[0] in CORE_SETS]
    return dict(rates(rows), **{
        'encoder': getattr(enc, 'variant', enc.name), 'mode': mode,
        'core': rates(core),
        'median_ms': pct(times, 50), 'p95_ms': pct(times, 95),
        'model_mb_fp16': enc.fp16_bytes() / 1e6,
        'top1_sim_hits_median': pct(hit, 50), 'top1_sim_misses_median': pct(miss, 50),
        'rows': rows,
    })


def rates(rows):
    n = len(rows) or 1
    return {
        'photos': len(rows),
        'group_top1': sum(r['group_top1'] for r in rows) / n,
        'group_top5': sum(r['group_top5'] for r in rows) / n,
        'exact_top1': sum(r['exact_top1'] for r in rows) / n,
    }


def write_report(results, detected, total, out_dir):
    lines = [
        '# Phase 1 results', '',
        'Photos: %d. Card outline detected in %d (%.0f%%); the rest fell back to the full frame.'
        % (total, detected, 100.0 * detected / total), '',
        'Device: %s. Times include detection and two embeddings (upright + 180 degrees).' % DEVICE, '',
        'Targets: art group in top 5 >= 95%%, top 1 >= 85%%, measured on the core four sets '
        '(%s).' % ', '.join(CORE_SETS), '',
        '| Encoder | Crop | Core: group top-1 | Core: group top-5 | Core: exact top-1 '
        '| All: group top-1 | All: group top-5 | All: exact top-1 '
        '| Median ms | p95 ms | Model MB (fp16) | Top-1 sim, hits / misses |',
        '|---|---|---|---|---|---|---|---|---|---|---|---|',
    ]
    for r in results:
        c = r['core']
        lines.append('| %s | %s | %.1f%% | %.1f%% | %.1f%% | %.1f%% | %.1f%% | %.1f%% '
                     '| %.0f | %.0f | %.1f | %.3f / %.3f |' % (
                         r['encoder'], r['mode'],
                         100 * c['group_top1'], 100 * c['group_top5'], 100 * c['exact_top1'],
                         100 * r['group_top1'], 100 * r['group_top5'], 100 * r['exact_top1'],
                         r['median_ms'], r['p95_ms'], r['model_mb_fp16'],
                         r['top1_sim_hits_median'], r['top1_sim_misses_median']))
    lines += ['', 'Core photos: %d of %d.' % (results[0]['core']['photos'], total) if results else '',
              '', 'Per-photo misses are in misses.csv.']
    (out_dir / 'report.md').write_text('\n'.join(lines) + '\n', encoding='utf-8')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--encoders', nargs='+', default=list(ENCODERS))
    ap.add_argument('--modes', nargs='+', default=['full', 'art'], choices=['full', 'art'])
    ap.add_argument('--photos', type=Path, default=PHOTOS_DIR)
    ap.add_argument('--out', default='', help='subfolder of results/ (e.g. synthetic)')
    args = ap.parse_args()
    out_dir = RESULTS_DIR / args.out if args.out else RESULTS_DIR
    out_dir.mkdir(parents=True, exist_ok=True)

    cards = load_cards()
    group_of = load_truth(cards)
    photos = load_photos(set(group_of), args.photos)

    warped, detect_ms, detected = [], [], 0
    for path, _ in photos:
        img = load_rgb(path)
        t0 = time.perf_counter()
        card_img, ok = detect_and_warp(img)
        detect_ms.append((time.perf_counter() - t0) * 1000)
        detected += ok
        warped.append((ok, card_img))
    debug_dir = out_dir / 'warped'
    debug_dir.mkdir(exist_ok=True)
    for (path, _), (ok, img) in zip(photos, warped):
        img.save(debug_dir / (path.stem + ('' if ok else '_NODETECT') + '.jpg'), quality=85)

    results = []
    for name in args.encoders:
        enc = ENCODERS[name]()
        for mode in args.modes:
            r = run_config(enc, mode, cards, group_of, photos, warped, detect_ms)
            print('%-28s %-4s group@1 %.1f%%  group@5 %.1f%%  exact@1 %.1f%%  median %.0f ms'
                  % (r['encoder'], mode, 100 * r['group_top1'], 100 * r['group_top5'],
                     100 * r['exact_top1'], r['median_ms']))
            results.append(r)

    write_report(results, detected, len(photos), out_dir)
    (out_dir / 'results.json').write_text(json.dumps(
        [{k: v for k, v in r.items() if k != 'rows'} for r in results], indent=1), encoding='utf-8')
    print('Core sets: ' + '; '.join('%s/%s group@1 %.1f%% group@5 %.1f%%' % (
        r['encoder'], r['mode'], 100 * r['core']['group_top1'], 100 * r['core']['group_top5'])
        for r in results))
    with open(out_dir / 'misses.csv', 'w', newline='', encoding='utf-8') as f:
        w = csv.writer(f)
        w.writerow(['encoder', 'mode', 'photo', 'label', 'group_top1', 'group_top5', 'exact_top1', 'top5'])
        for r in results:
            for row in r['rows']:
                if not row['exact_top1']:
                    w.writerow([r['encoder'], r['mode'], row['photo'], row['label'], row['group_top1'],
                                row['group_top5'], row['exact_top1'], ' | '.join(row['top5'])])
    print('Report: %s' % (out_dir / 'report.md'))


if __name__ == '__main__':
    main()
