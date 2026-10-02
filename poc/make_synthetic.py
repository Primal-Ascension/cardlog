"""Synthetic test photos for smoke-testing evaluate.py before real photos exist.

Takes the *small* catalog scans (the catalog index is built from the large
ones), places each on a cluttered background with perspective tilt, rotation,
glare, blur, noise and JPEG compression. Scores on these are optimistic; they
check the pipeline end to end, not real-world accuracy.

Usage:  python make_synthetic.py [count]     -> %USERPROFILE%\\.cardlog\\cache\\synthetic\\
"""
import random
import sys

import cv2
import numpy as np
from PIL import Image

from common import CACHE_DIR, image_path, load_cards

OUT = CACHE_DIR / 'synthetic'


def background(w, h, rng):
    base = rng.integers(30, 200, size=3)
    bg = np.ones((h, w, 3), np.float32) * base
    for _ in range(12):  # table clutter
        c = tuple(int(v) for v in rng.integers(0, 255, size=3))
        p1 = tuple(int(v) for v in (rng.integers(0, w), rng.integers(0, h)))
        p2 = tuple(int(v) for v in (rng.integers(0, w), rng.integers(0, h)))
        cv2.rectangle(bg, p1, p2, c, -1)
    return cv2.GaussianBlur(bg, (0, 0), 8)


def synth(card_img, rng):
    W, H = 1200, 1600
    card = np.asarray(card_img.convert('RGB').resize((500, 698)), np.float32)
    ch, cw = card.shape[:2]
    scale = rng.uniform(0.9, 1.5)
    cx, cy = W / 2 + rng.uniform(-150, 150), H / 2 + rng.uniform(-150, 150)
    ang = np.deg2rad(rng.uniform(-15, 15) + (180 if rng.random() < 0.15 else 0))
    hw, hh = cw * scale / 2, ch * scale / 2
    corners = np.array([[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]])
    rot = np.array([[np.cos(ang), -np.sin(ang)], [np.sin(ang), np.cos(ang)]])
    dst = corners @ rot.T + [cx, cy] + rng.uniform(-35, 35, size=(4, 2))  # perspective tilt
    m = cv2.getPerspectiveTransform(np.float32([[0, 0], [cw, 0], [cw, ch], [0, ch]]), np.float32(dst))
    warped = cv2.warpPerspective(card, m, (W, H))
    mask = cv2.warpPerspective(np.ones((ch, cw), np.float32), m, (W, H))[..., None]
    img = background(W, H, rng) * (1 - mask) + warped * mask

    gx, gy = rng.uniform(0, W), rng.uniform(0, H)  # glare blob
    yy, xx = np.mgrid[0:H, 0:W]
    glare = np.exp(-((xx - gx) ** 2 + (yy - gy) ** 2) / (2 * rng.uniform(80, 220) ** 2))
    img = img * rng.uniform(0.6, 1.2) + glare[..., None] * rng.uniform(40, 140)
    img += rng.normal(0, 6, img.shape)
    img = cv2.GaussianBlur(np.clip(img, 0, 255).astype(np.uint8), (0, 0), rng.uniform(0.3, 1.6))
    return Image.fromarray(img)


def main(count):
    OUT.mkdir(parents=True, exist_ok=True)
    for old in OUT.glob('*.jpg'):
        old.unlink()
    rng = np.random.default_rng(7)
    cards = load_cards()
    for c in random.Random(7).sample(cards, min(count, len(cards))):
        img = synth(Image.open(image_path(c, 'small')), rng)
        img.save(OUT / (c['id'] + '.jpg'), quality=int(rng.integers(60, 90)))
    print('%d synthetic photos -> %s' % (count, OUT))


if __name__ == '__main__':
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 80)
