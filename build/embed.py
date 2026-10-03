"""Step 3: embed every card's art-box crop, and save grayscale crops for keypoints.

Usage:  python embed.py [--sets ...]

Per set it writes cache/embed/{set_id}.npz (ids, float32 vectors, source keys)
and cache/art/{set_id}/{card_id}.png. A set is skipped when every source image
is unchanged since its last run, and when its images are not all downloaded
yet (catalog.py may still be running), so this can be rerun at any time.
"""
import argparse
import json

import numpy as np
from PIL import Image

from config import ART_DIR, CACHE, CARDS_DIR, EMBED_DIR, SETS_FILE, file_id, image_path
from embedder import OnnxEncoder, art_crop

KEYPOINT_SIZE = (480, 250)


def source_image(card):
    for size in ('large', 'small'):  # a few cards have no hires scan
        p = image_path(card, size)
        if p.exists() and p.stat().st_size > 0:
            return p
    return None


def source_key(path):
    st = path.stat()
    return '%s:%d:%d' % (path.parent.parent.name, st.st_size, int(st.st_mtime))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--sets', nargs='*')
    args = ap.parse_args()

    sets = json.loads(SETS_FILE.read_text(encoding='utf-8'))
    if args.sets:
        sets = [s for s in sets if s['id'] in set(args.sets)]
    missing_file = CACHE / 'missing_images.json'
    known_missing = set(json.loads(missing_file.read_text(encoding='utf-8'))) if missing_file.exists() else set()
    enc = None
    done = skipped = pending = 0
    for s in sets:
        cards_path = CARDS_DIR / (s['id'] + '.json')
        if not cards_path.exists():
            pending += 1
            continue
        cards = json.loads(cards_path.read_text(encoding='utf-8'))
        srcs = [source_image(c) for c in cards]
        missing_large = [c['id'] for c in cards
                         if not image_path(c, 'large').exists()
                         and c.get('image_url_large') and c['image_url_large'] not in known_missing]
        if missing_large:
            pending += 1
            continue
        keys = [source_key(p) if p else 'none' for p in srcs]
        out = EMBED_DIR / (s['id'] + '.npz')
        if out.exists():
            z = np.load(out)
            if list(z['ids']) == [c['id'] for c in cards] and list(z['keys']) == keys:
                skipped += 1
                continue

        enc = enc or OnnxEncoder('fp32')
        crops, ok = [], []
        art_dir = ART_DIR / s['id']
        art_dir.mkdir(parents=True, exist_ok=True)
        for c, p in zip(cards, srcs):
            if p is None:
                ok.append(False)
                crops.append(Image.new('RGB', (64, 64)))
                continue
            crop = art_crop(Image.open(p).convert('RGB'))
            crop.convert('L').resize(KEYPOINT_SIZE, Image.BILINEAR).save(art_dir / (file_id(c['id']) + '.png'))
            crops.append(crop)
            ok.append(True)
        vecs = enc.embed(crops)
        vecs[~np.array(ok)] = 0.0  # no image: never matches anything
        np.savez(out, ids=np.array([c['id'] for c in cards]), vecs=vecs, keys=np.array(keys))
        done += 1
        print('%-10s %4d cards embedded%s' % (s['id'], len(cards),
              '' if all(ok) else ' (%d without any image)' % ok.count(False)), flush=True)
    print('embedded %d sets, %d unchanged, %d waiting on downloads' % (done, skipped, pending), flush=True)


if __name__ == '__main__':
    main()
