"""Slab (graded card) detection prototype, run on the owner's labeled photos.

Given the card's quad, look for either
  - the grading label: a wide rectangle just above the card, about card-wide
    (PSA, CGC, BGS, PCG all put it there), or
  - the slab outline: a taller portrait rectangle that contains the card with
    room for the label above it.
Either one means graded. The slab quad (or, failing that, card + label) is
what the front photo should show so the grade stays in the picture.

Usage:  python slab.py      (prints per-photo results and precision/recall)
"""
import sys

import cv2
import numpy as np

from imaging import (_edge_maps, _edge_support, _hull_quad, _quad_aspect, _is_rectangular,
                     find_card_and_slab, load_rgb)

# Photos of slabs among the 41 labeled ones (from the Phase 1 labeling pass).
SLABS = {'base1-2', 'base1-2_2', 'base3-4', 'base3-14_2', 'base3-14_3', 'base1-4', 'base1-4_3',
         'base1-4_4', 'base2-7', 'base2-7_2', 'base3-3_2', 'base2-6', 'base3-20_2', 'base3-20_3'}


def _bounds(q):
    return q[:, 0].min(), q[:, 1].min(), q[:, 0].max(), q[:, 1].max()


def find_slab(rgb_np, card_quad):
    """-> (kind, quad) with kind in {'label', 'slab', None}; quad in original pixels."""
    h, w = rgb_np.shape[:2]
    scale = 1000.0 / max(h, w) if max(h, w) > 1000 else 1.0
    small = cv2.resize(rgb_np, (int(w * scale), int(h * scale))) if scale != 1.0 else rgb_np
    gray = cv2.cvtColor(small, cv2.COLOR_RGB2GRAY)
    card = card_quad * scale
    cx0, cy0, cx1, cy1 = _bounds(card)
    cw, ch = cx1 - cx0, cy1 - cy0
    ccx = (cx0 + cx1) / 2
    card_area = cw * ch

    best_label, best_slab = None, None
    for edges in list(_edge_maps(small, gray))[1:]:      # Canny + adaptive; the yellow mask is card-only
        support = cv2.dilate(edges, np.ones((5, 5), np.uint8))
        contours, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
        for c in contours:
            if cv2.contourArea(cv2.convexHull(c)) < 0.02 * card_area:
                continue
            q = _hull_quad(c)
            if q is None or not _is_rectangular(q, max_skew=20):
                continue
            x0, y0, x1, y1 = _bounds(q)
            qw, qh = _quad_aspect(q)
            # Label: wide, about card-wide, centered over the card, just above it.
            if qw > qh and 2.0 <= qw / qh <= 6.5 and 0.7 * cw <= qw <= 1.3 * cw and \
                    abs((x0 + x1) / 2 - ccx) <= 0.2 * cw and \
                    cy0 - 0.5 * ch <= y1 <= cy0 + 0.06 * ch and 0.07 * ch <= qh <= 0.45 * ch:
                if _edge_support(support, q) >= 0.6 and (best_label is None or qw > best_label[1]):
                    best_label = (q, qw)
            # Slab: portrait, contains the card, with label room above it.
            if qh > qw and 0.50 <= qw / qh <= 0.70 and 1.2 <= (qw * qh) / card_area <= 3.0 and \
                    x0 <= cx0 + 0.04 * cw and x1 >= cx1 - 0.04 * cw and y1 >= cy1 - 0.04 * ch and \
                    cy0 - y0 >= 0.10 * qh:
                if _edge_support(support, q) >= 0.5 and (best_slab is None or qw * qh < best_slab[1]):
                    best_slab = (q, qw * qh)
    if best_slab is not None:
        return 'slab', best_slab[0] / scale
    if best_label is not None:
        return 'label', best_label[0] / scale
    return None, None


def main():
    from pathlib import Path
    photos = sorted(p for p in (Path(__file__).parent / 'photos').iterdir()
                    if p.suffix.lower() in ('.jpg', '.jpeg', '.png', '.heic'))
    tp = fp = fn = tn = 0
    for p in photos:
        arr = np.asarray(load_rgb(p))
        card, nested = find_card_and_slab(arr)
        truth = p.stem in SLABS
        kind = 'nested' if nested is not None else None
        if card is not None and kind is None:
            kind, _ = find_slab(arr, card)
        pred = kind is not None
        tp += truth and pred; fp += pred and not truth; fn += truth and not pred; tn += not truth and not pred
        flag = 'ok ' if truth == pred else 'XX '
        print('%s %-16s truth=%-5s pred=%-5s via=%s%s' % (flag, p.stem, 'slab' if truth else 'raw', 'slab' if pred else 'raw',
                                                        kind, '' if card is not None else ' (no card found)'))
    print('slabs caught %d/%d, raw called slab %d/%d' % (tp, tp + fn, fp, fp + tn))


if __name__ == '__main__':
    sys.exit(main())
