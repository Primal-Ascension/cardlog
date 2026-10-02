"""Shared paths, set list, and HTTP helpers for the Phase 1 proof of concept."""
import json
import os
import random
import time
from pathlib import Path

import requests

API_BASE = 'https://api.pokemontcg.io/v2'

# Phase 1 sets (IDs verified against the live API during Phase 0).
POC_SETS = ['base1', 'base2', 'base4', 'base6']

POC_DIR = Path(__file__).resolve().parent
PHOTOS_DIR = POC_DIR / 'photos'
RESULTS_DIR = POC_DIR / 'results'

# Build cache lives outside the repo (and outside OneDrive) so thousands of
# images never sync or get committed. Not under AppData: packaged apps get
# AppData redirected. Override with CARDLOG_CACHE.
CACHE_DIR = Path(os.environ.get('CARDLOG_CACHE') or Path.home() / '.cardlog' / 'cache')
CARDS_DIR = CACHE_DIR / 'cards'          # {set_id}.json, card records
IMAGES_DIR = CACHE_DIR / 'images'        # {size}/{set_id}/{card_id}.png
EMBED_DIR = CACHE_DIR / 'embeddings'     # {config}.npz

for d in (CARDS_DIR, IMAGES_DIR, EMBED_DIR, RESULTS_DIR):
    d.mkdir(parents=True, exist_ok=True)


def api_headers():
    # Optional key raises rate limits. Never commit it; set it in the shell.
    key = os.environ.get('POKEMONTCG_API_KEY')
    return {'X-Api-Key': key} if key else {}


def get_with_retry(url, params=None, headers=None, tries=6, timeout=60, stream=False):
    """GET with exponential backoff. The API returns sporadic 500/502s."""
    last = None
    for attempt in range(tries):
        try:
            r = requests.get(url, params=params, headers=headers, timeout=timeout, stream=stream)
            if r.status_code == 200:
                return r
            if r.status_code == 404:
                r.raise_for_status()
            last = RuntimeError('HTTP %d for %s' % (r.status_code, r.url))
        except requests.RequestException as e:
            last = e
        time.sleep(min(60, 2 ** attempt) + random.random())
    raise last


def load_cards(set_ids=POC_SETS):
    """Card records for the given sets, in set then catalog order."""
    cards = []
    for sid in set_ids:
        path = CARDS_DIR / (sid + '.json')
        if not path.exists():
            raise SystemExit('Missing %s. Run ingest.py first.' % path)
        cards.extend(json.loads(path.read_text(encoding='utf-8')))
    return cards


def image_path(card, size):
    return IMAGES_DIR / size / card['set_id'] / (card['id'] + '.png')
