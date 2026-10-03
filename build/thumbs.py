"""Step 6: offline thumbnails, about 100 px wide WebP, quality tuned per image to
land in roughly 5-8 KB.

Usage:  python thumbs.py

Writes BUILD_OUT/thumbs/{set_id}/{card_id}.webp from the small scans. A
thumbnail is only regenerated when its source is newer, so a published file
stays byte-identical across rebuilds.
"""
import io
import json
from concurrent.futures import ProcessPoolExecutor

from PIL import Image

from config import BUILD_OUT, CARDS_DIR, SETS_FILE, THUMB_TARGET_BYTES, THUMB_WIDTH, file_id, image_path

LO, HI = THUMB_TARGET_BYTES


def thumb_rel(card):
    """Published path of a card's thumbnail; publish.py stores it in each record."""
    return 'thumbs/%s/%s.webp' % (card['set_id'], file_id(card['id']))


def encode(img, q):
    buf = io.BytesIO()
    img.save(buf, 'WEBP', quality=q, method=6)
    return buf.getvalue()


def make(job):
    src, dest = job
    if dest.exists() and dest.stat().st_mtime >= src.stat().st_mtime:
        return dest.stat().st_size, False
    img = Image.open(src).convert('RGB')
    img = img.resize((THUMB_WIDTH, round(img.height * THUMB_WIDTH / img.width)), Image.LANCZOS)
    lo, hi, best = 30, 92, None
    while lo <= hi:  # largest quality that stays under the cap
        q = (lo + hi) // 2
        data = encode(img, q)
        if len(data) <= HI:
            best, lo = data, q + 1
        else:
            hi = q - 1
    data = best or encode(img, 30)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
    return len(data), True


def main():
    sets = json.loads(SETS_FILE.read_text(encoding='utf-8'))
    jobs = []
    for s in sets:
        p = CARDS_DIR / (s['id'] + '.json')
        if not p.exists():
            continue
        for c in json.loads(p.read_text(encoding='utf-8')):
            src = image_path(c, 'small')
            if not src.exists():
                src = image_path(c, 'large')
            if src.exists():
                jobs.append((src, BUILD_OUT / thumb_rel(c)))
    with ProcessPoolExecutor() as pool:
        res = list(pool.map(make, jobs, chunksize=64))
    sizes = sorted(r[0] for r in res)
    n = len(sizes)
    print('%d thumbnails (%d new); median %.1f KB, p5 %.1f KB, p95 %.1f KB, total %.1f MB; %d below %d KB'
          % (n, sum(r[1] for r in res), sizes[n // 2] / 1024, sizes[n // 20] / 1024,
             sizes[n * 19 // 20] / 1024, sum(sizes) / 1e6, sum(1 for s in sizes if s < LO), LO // 1024), flush=True)


if __name__ == '__main__':
    main()
