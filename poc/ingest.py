"""Fetch card records and images for the Phase 1 sets into the build cache.

Usage:  python ingest.py [set_id ...]      (defaults to the four POC sets)

Records follow the spec's card record fields. Price values are never stored:
only the key names of tcgplayer.prices are kept, as `printings`, so the
variant table can tell which printings exist.
"""
import json
import sys
from concurrent.futures import ThreadPoolExecutor

from common import (API_BASE, CARDS_DIR, POC_SETS, api_headers,
                    get_with_retry, image_path)


def fetch_set_cards(set_id):
    cards, page = [], 1
    while True:
        r = get_with_retry(API_BASE + '/cards', headers=api_headers(), params={
            'q': 'set.id:' + set_id, 'page': page, 'pageSize': 250,
            'orderBy': 'number',
        })
        body = r.json()
        cards.extend(body['data'])
        if page * body['pageSize'] >= body['totalCount']:
            return cards
        page += 1


def to_record(c):
    s = c['set']
    prices = (c.get('tcgplayer') or {}).get('prices') or {}
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
        'language': 'en',
        'art_group_id': None,                     # assigned in Phase 2
        'printings': sorted(prices.keys()),       # keys only, values discarded
        'set_symbol_url': (s.get('images') or {}).get('symbol'),
        'image_url_small': c['images']['small'],
        'image_url_large': c['images']['large'],
    }


def download(url, dest):
    if dest.exists() and dest.stat().st_size > 0:
        return False
    dest.parent.mkdir(parents=True, exist_ok=True)
    r = get_with_retry(url)
    tmp = dest.with_suffix('.part')
    tmp.write_bytes(r.content)
    tmp.replace(dest)
    return True


def main(set_ids):
    for sid in set_ids:
        raw = fetch_set_cards(sid)
        records = [to_record(c) for c in raw]
        out = CARDS_DIR / (sid + '.json')
        out.write_text(json.dumps(records, indent=1, ensure_ascii=False), encoding='utf-8')
        print('%s: %d cards -> %s' % (sid, len(records), out))

        jobs = []
        for rec in records:
            jobs.append((rec['image_url_large'], image_path(rec, 'large')))
            jobs.append((rec['image_url_small'], image_path(rec, 'small')))
        with ThreadPoolExecutor(max_workers=8) as pool:
            fetched = sum(pool.map(lambda j: download(*j), jobs))
        print('%s: %d images downloaded, %d already cached' % (sid, fetched, len(jobs) - fetched))


if __name__ == '__main__':
    main(sys.argv[1:] or POC_SETS)
