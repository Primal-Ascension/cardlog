"""Step 1: fetch every English set and card from pokemontcg.io, plus images.

Usage:  python catalog.py [--sets base1 base2 ...] [--no-images]

Per set it writes cache/cards/{set_id}.json. A set's card list is refetched
every run (cheap), but images are only downloaded when missing, so reruns
mostly touch new sets. Price values are never stored: only the key names of
tcgplayer.prices are kept, as `printings`.
"""
import argparse
import hashlib
import json
import os
from concurrent.futures import ThreadPoolExecutor, as_completed

from config import API_BASE, CACHE, CARDS_DIR, SETS_FILE, image_path

MISSING_FILE = CACHE / 'missing_images.json'
from net import api_headers, get


def fetch_sets():
    sets, page = [], 1
    while True:
        body = get(API_BASE + '/sets', headers=api_headers(),
                   params={'page': page, 'pageSize': 250, 'orderBy': 'releaseDate'}).json()
        sets.extend(body['data'])
        if page * body['pageSize'] >= body['totalCount']:
            break
        page += 1
    out = [{
        'id': s['id'], 'name': s['name'], 'series': s.get('series'),
        'printed_total': s.get('printedTotal'), 'total': s.get('total'),
        'release_date': (s.get('releaseDate') or '').replace('/', '-'),
        'symbol_url': (s.get('images') or {}).get('symbol'),
        'logo_url': (s.get('images') or {}).get('logo'),
    } for s in sets]
    out.sort(key=lambda s: (s['release_date'], s['id']))
    SETS_FILE.write_text(json.dumps(out, indent=1, ensure_ascii=False), encoding='utf-8')
    return out


def fetch_set_cards(set_id):
    # Order by id, which is unique: ordering by number is not stable across
    # pages when numbers tie, and Ascended Heroes came back with 45 cards
    # duplicated and 45 missing.
    cards, page = {}, 1
    while True:
        body = get(API_BASE + '/cards', headers=api_headers(), params={
            'q': 'set.id:"%s"' % set_id, 'page': page, 'pageSize': 250, 'orderBy': 'id',
        }).json()
        for c in body['data']:
            cards[c['id']] = c
        if page * body['pageSize'] >= body['totalCount']:
            break
        page += 1
    if len(cards) != body['totalCount']:
        raise RuntimeError('%s: got %d unique cards, API says %d' % (set_id, len(cards), body['totalCount']))
    return sorted(cards.values(), key=lambda c: (len(c['number']), c['number'], c['id']))


def to_record(c):
    s = c['set']
    prices = (c.get('tcgplayer') or {}).get('prices') or {}
    images = c.get('images') or {}
    return {
        'id': c['id'],
        'name': c['name'],
        'number': c['number'],
        'printed_total': s.get('printedTotal'),
        'set_id': s['id'],
        'set_name': s['name'],
        'series': s.get('series'),
        'release_date': (s.get('releaseDate') or '').replace('/', '-'),
        'rarity': c.get('rarity'),
        'artist': c.get('artist'),
        'supertype': c.get('supertype'),
        'subtypes': c.get('subtypes') or [],
        'language': 'en',
        'art_group_id': None,                     # assigned by groups.py
        'printings': sorted(prices.keys()),       # keys only, values discarded
        'set_symbol_url': (s.get('images') or {}).get('symbol'),
        'image_url_small': images.get('small'),
        'image_url_large': images.get('large'),
    }


def records_hash(records):
    return hashlib.sha256(json.dumps(records, sort_keys=True).encode()).hexdigest()


def download(job):
    url, dest = job
    if not url or (dest.exists() and dest.stat().st_size > 0):
        return 0
    dest.parent.mkdir(parents=True, exist_ok=True)
    data = get(url, timeout=120).content
    tmp = dest.with_name('%s.%d.part' % (dest.name, os.getpid()))  # unique if two runs overlap
    tmp.write_bytes(data)
    tmp.replace(dest)
    return 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--sets', nargs='*', help='limit to these set ids')
    ap.add_argument('--no-images', action='store_true')
    ap.add_argument('--images-only', action='store_true', help='download images for cached card lists, no API calls')
    args = ap.parse_args()

    if args.images_only:
        all_records = []
        for p in sorted(CARDS_DIR.glob('*.json')):
            all_records.extend(json.loads(p.read_text(encoding='utf-8')))
        download_images(all_records)
        return

    sets = fetch_sets()
    if args.sets:
        sets = [s for s in sets if s['id'] in set(args.sets)]
    print('%d sets' % len(sets), flush=True)

    # Card lists first, a few sets at a time: the API is slow (seconds per
    # page) and its retries would otherwise stall the image downloads.
    def refresh(s):
        records = [to_record(c) for c in fetch_set_cards(s['id'])]
        path = CARDS_DIR / (s['id'] + '.json')
        old = json.loads(path.read_text(encoding='utf-8')) if path.exists() else None
        changed = old is None or records_hash(old) != records_hash(records)
        if changed:
            path.write_text(json.dumps(records, indent=1, ensure_ascii=False), encoding='utf-8')
        return records, changed

    # About half of API requests fail at random (HTTP 500), so a set that
    # exhausts its retries is queued for another pass instead of aborting.
    all_records, changed, todo, done = [], 0, list(sets), 0
    for attempt in range(4):
        failed = []
        with ThreadPoolExecutor(max_workers=6) as pool:
            futures = {pool.submit(refresh, s): s for s in todo}
            for fut in as_completed(futures):
                s = futures[fut]
                try:
                    records, ch = fut.result()
                except Exception as e:
                    failed.append(s)
                    print('  %-10s card list failed (%s); will retry' % (s['id'], e), flush=True)
                    continue
                done += 1
                all_records.extend(records)
                changed += ch
                print('[%3d/%d] %-10s %4d cards%s' % (done, len(sets), s['id'], len(records),
                                                      ' (changed)' if ch else ''), flush=True)
        todo = failed
        if not todo:
            break
    if todo:
        print('WARNING: card lists still failing for %s; using cached lists where present'
              % ', '.join(s['id'] for s in todo), flush=True)
        for s in todo:
            p = CARDS_DIR / (s['id'] + '.json')
            if p.exists():
                all_records.extend(json.loads(p.read_text(encoding='utf-8')))
    print('card lists: %d cards, %d set files changed' % (len(all_records), changed), flush=True)

    if not args.no_images:
        download_images(all_records)


def download_images(all_records):
    known_missing = set(json.loads(MISSING_FILE.read_text(encoding='utf-8'))) if MISSING_FILE.exists() else set()
    jobs = []
    for r in all_records:
        for size in ('large', 'small'):
            dest = image_path(r, size)
            if r['image_url_' + size] and r['image_url_' + size] not in known_missing \
                    and not (dest.exists() and dest.stat().st_size > 0):
                jobs.append((r['image_url_' + size], dest))
    print('images to download: %d' % len(jobs), flush=True)
    failed = []

    def safe_download(job):
        try:
            return download(job)
        except Exception as e:  # keep going; a rerun picks these up
            failed.append((job[0], str(e)))
            return 0

    with ThreadPoolExecutor(max_workers=32) as pool:
        for n, _ in enumerate(pool.map(safe_download, jobs), 1):
            if n % 1000 == 0:
                print('  %d / %d images' % (n, len(jobs)), flush=True)
    # 404s are images pokemontcg.io does not have; record them so embed.py
    # falls back to the other size instead of waiting for them forever.
    missing = json.loads(MISSING_FILE.read_text(encoding='utf-8')) if MISSING_FILE.exists() else []
    missing = sorted(set(missing) | {url for url, err in failed if '404' in err})
    MISSING_FILE.write_text(json.dumps(missing, indent=1), encoding='utf-8')
    transient = [(u, e) for u, e in failed if '404' not in e]
    print('done: %d images downloaded, %d not on the server (404), %d failed transiently (rerun to retry)'
          % (len(jobs) - len(failed), len(failed) - len(transient), len(transient)), flush=True)
    for url, err in transient[:20]:
        print('  failed:', url, err, flush=True)


if __name__ == '__main__':
    main()
