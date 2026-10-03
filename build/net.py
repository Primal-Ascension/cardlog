"""HTTP helpers. The pokemontcg.io API returns sporadic 5xx and rate limits."""
import os
import random
import time

import requests

_session = requests.Session()
_session.headers['User-Agent'] = 'cardlog-scanner-build'


def api_headers():
    # Optional key raises rate limits. Never commit it: set it in the shell or
    # as a GitHub Actions secret (Phase 4).
    key = os.environ.get('POKEMONTCG_API_KEY')
    return {'X-Api-Key': key} if key else {}


def get(url, params=None, headers=None, tries=7, timeout=90):
    last = None
    for attempt in range(tries):
        try:
            r = _session.get(url, params=params, headers=headers, timeout=timeout)
            if r.status_code == 200:
                return r
            if r.status_code == 404:
                r.raise_for_status()
            last = RuntimeError('HTTP %d for %s' % (r.status_code, r.url))
            wait = float(r.headers.get('Retry-After') or 0)
        except requests.RequestException as e:
            last, wait = e, 0
        time.sleep(max(wait, min(60, 2 ** attempt)) + random.random())
    raise last
