"""Card detection, perspective warp, and art-box crop.

This mirrors what the phone will do with OpenCV.js in Phase 3, so the POC
measures the same pipeline rather than an idealized one.
"""
import cv2
import numpy as np
from PIL import Image

try:  # iPhone photos are often HEIC
    from pillow_heif import register_heif_opener
    register_heif_opener()
except ImportError:
    pass

CARD_W, CARD_H = 630, 880          # 63 x 88 mm at 10 px/mm
CARD_ASPECT = CARD_W / CARD_H      # 0.716
ASPECT_TOL = 0.09

# Art window of a WOTC-era card, as fractions of the card (left, top, right,
# bottom). Measured on Base Set scans; holds for 1999-2003 frames.
ART_BOX = (0.085, 0.105, 0.915, 0.535)


def load_rgb(path):
    img = Image.open(path)
    try:
        from PIL import ImageOps
        img = ImageOps.exif_transpose(img)
    except Exception:
        pass
    return img.convert('RGB')


def _order_quad(pts):
    pts = pts.reshape(4, 2).astype(np.float32)
    s, d = pts.sum(1), np.diff(pts, axis=1).ravel()
    tl, br = pts[np.argmin(s)], pts[np.argmax(s)]
    tr, bl = pts[np.argmin(d)], pts[np.argmax(d)]
    return np.array([tl, tr, br, bl], np.float32)


def _quad_aspect(q):
    w = (np.linalg.norm(q[1] - q[0]) + np.linalg.norm(q[2] - q[3])) / 2
    h = (np.linalg.norm(q[3] - q[0]) + np.linalg.norm(q[2] - q[1])) / 2
    return w, h


MIN_AREA_FRAC = 0.03     # card must fill at least 3% of the frame (slabs shrink it)
MIN_EDGE_SUPPORT = 0.70  # share of the quad's perimeter that must lie on real edges


def _yellow_mask(rgb):
    """The yellow border every English card had until 2023. Through sleeves and
    slab plastic it survives far better than edges do."""
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)
    mask = cv2.inRange(hsv, (19, 70, 110), (38, 255, 255))  # hue 19+ excludes orange slab labels
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8), iterations=2)
    # Fill the ring so the card becomes one solid blob whose outline is the card edge.
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    filled = np.zeros_like(mask)
    cv2.drawContours(filled, contours, -1, 255, -1)
    return filled


def _edge_maps(rgb, gray):
    yield _yellow_mask(rgb)
    blur = cv2.GaussianBlur(gray, (5, 5), 0)
    canny = cv2.Canny(blur, 40, 140)
    yield cv2.morphologyEx(canny, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8), iterations=2)
    thr = cv2.adaptiveThreshold(blur, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                cv2.THRESH_BINARY, 31, 5)
    yield 255 - thr


def _edge_support(edges, quad, samples=240):
    """Fraction of points along the quad's sides that sit on an edge pixel."""
    h, w = edges.shape
    hits = total = 0
    for i in range(4):
        p, q = quad[i], quad[(i + 1) % 4]
        for t in np.linspace(0, 1, samples // 4, endpoint=False):
            x, y = (p + (q - p) * t).astype(int)
            if 0 <= x < w and 0 <= y < h:
                total += 1
                hits += edges[y, x] > 0
    return hits / total if total else 0.0


def _hull_quad(c):
    """Card-shaped quad from a contour's convex hull, or None.

    Using the hull means an outline with small gaps (glare, rounded corners)
    still yields the card's four sides.
    """
    hull = cv2.convexHull(c)
    approx = cv2.approxPolyDP(hull, 0.02 * cv2.arcLength(hull, True), True)
    if len(approx) == 4:
        return _order_quad(approx)
    rect = _order_quad(cv2.boxPoints(cv2.minAreaRect(hull)))
    if cv2.contourArea(hull) >= 0.85 * cv2.contourArea(rect):
        return rect
    return None


def find_card_quad(rgb_np):
    """Largest card-proportioned quad backed by real edges, in original pixel coords.

    Requiring the 63:88 aspect is what keeps a slab or top-loader outline
    from winning over the card inside it. Requiring portrait orientation keeps
    the art window out: turned sideways it has almost exactly card proportions
    (52 x 38 mm, 0.72). The phone is held upright, so a real card is tall.
    """
    h, w = rgb_np.shape[:2]
    scale = 1000.0 / max(h, w) if max(h, w) > 1000 else 1.0
    small = cv2.resize(rgb_np, (int(w * scale), int(h * scale))) if scale != 1.0 else rgb_np
    gray = cv2.cvtColor(small, cv2.COLOR_RGB2GRAY)
    min_area = MIN_AREA_FRAC * gray.shape[0] * gray.shape[1]

    best, best_area = None, 0
    for edges in _edge_maps(small, gray):
        if not edges.any():
            continue
        support_map = cv2.dilate(edges, np.ones((5, 5), np.uint8))
        contours, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
        for c in contours:
            if cv2.contourArea(cv2.convexHull(c)) < max(min_area, best_area):
                continue
            quad = _hull_quad(c)
            if quad is None:
                continue
            area = cv2.contourArea(quad)
            qw, qh = _quad_aspect(quad)
            if area <= best_area or qw > qh or abs(qw / qh - CARD_ASPECT) > ASPECT_TOL:
                continue
            if _edge_support(support_map, quad) >= MIN_EDGE_SUPPORT:
                best, best_area = quad, area
    return None if best is None else best / scale


def warp_card(rgb_np, quad):
    qw, qh = _quad_aspect(quad)
    if qw > qh:  # landscape outline: rotate corner order to portrait
        quad = np.roll(quad, -1, axis=0)
    dst = np.array([[0, 0], [CARD_W - 1, 0], [CARD_W - 1, CARD_H - 1], [0, CARD_H - 1]], np.float32)
    m = cv2.getPerspectiveTransform(quad.astype(np.float32), dst)
    return cv2.warpPerspective(rgb_np, m, (CARD_W, CARD_H), flags=cv2.INTER_AREA)


def detect_and_warp(img):
    """PIL RGB -> (warped PIL card, detected flag). Falls back to the whole frame."""
    arr = np.asarray(img)
    quad = find_card_quad(arr)
    if quad is None:
        return img.resize((CARD_W, CARD_H), Image.BILINEAR), False
    return Image.fromarray(warp_card(arr, quad)), True


def art_crop(card_img):
    w, h = card_img.size
    l, t, r, b = ART_BOX
    return card_img.crop((int(l * w), int(t * h), int(r * w), int(b * h)))
