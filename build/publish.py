"""Step 7: write the published layout and manifest into BUILD_OUT.

Usage:  python publish.py

  manifest.json          version, encoder config, every file with sha256 + bytes, counts
  model/encoder.onnx     fp16 encoder
  index/{set_id}.bin     float16 vectors, row order matches meta/{set_id}.json
  meta/{set_id}.json     card records (no prices)
  groups.json            art_group_id -> reprints/members/same-set clusters
  variants.json          per-card printings + default
  thumbs/...             from thumbs.py

Files are only rewritten when their bytes change, so a rebuild that adds one
set adds files instead of rewriting old ones (the spec's append-only rule).
Fails if any file exceeds 95 MB or the total exceeds 800 MB.
"""
import hashlib
import json
import shutil
from datetime import datetime, timezone

import numpy as np

from thumbs import thumb_rel
from config import (BUILD_OUT, CACHE, CARDS_DIR, EMBED_DIR, ENCODER, IMAGES_DIR, MAX_FILE_BYTES,
                    MAX_SITE_BYTES, MODEL_DIR, SETS_FILE)

RECORD_FIELDS = ['id', 'name', 'number', 'printed_total', 'set_id', 'set_name', 'series', 'release_date',
                 'rarity', 'artist', 'supertype', 'language', 'art_group_id', 'set_symbol_url',
                 'image_url_small', 'image_url_large']


def write_if_changed(path, data):
    if isinstance(data, str):
        data = data.encode('utf-8')
    if path.exists() and path.read_bytes() == data:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + '.tmp')
    tmp.write_bytes(data)
    tmp.replace(path)
    return True


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def main():
    sets = json.loads(SETS_FILE.read_text(encoding='utf-8'))
    groups = json.loads((CACHE / 'groups.json').read_text(encoding='utf-8'))
    variants = json.loads((CACHE / 'variants.json').read_text(encoding='utf-8'))
    group_of = {cid: gid for gid, g in groups.items() for cid in g['members']}

    changed, set_ids, n_cards = [], [], 0
    for s in sets:
        p, e = CARDS_DIR / (s['id'] + '.json'), EMBED_DIR / (s['id'] + '.npz')
        if not (p.exists() and e.exists()):
            continue
        cards = json.loads(p.read_text(encoding='utf-8'))
        z = np.load(e)
        assert list(z['ids']) == [c['id'] for c in cards], s['id']
        symbol_src = IMAGES_DIR / 'symbols' / (s['id'] + '.png')
        symbol_rel = 'symbols/%s.png' % s['id'] if symbol_src.exists() else None
        if symbol_rel and write_if_changed(BUILD_OUT / symbol_rel, symbol_src.read_bytes()):
            changed.append(symbol_rel)
        records = []
        for c in cards:
            r = {k: c.get(k) for k in RECORD_FIELDS}
            r['set_symbol'] = symbol_rel
            r['art_group_id'] = group_of.get(c['id'])
            r['thumb'] = thumb_rel(c) if (BUILD_OUT / thumb_rel(c)).exists() else None
            records.append(r)
        if write_if_changed(BUILD_OUT / 'meta' / (s['id'] + '.json'),
                            json.dumps(records, separators=(',', ':'), ensure_ascii=False)):
            changed.append('meta/' + s['id'])
        if write_if_changed(BUILD_OUT / 'index' / (s['id'] + '.bin'), z['vecs'].astype('<f2').tobytes()):
            changed.append('index/' + s['id'])
        set_ids.append(s['id'])
        n_cards += len(cards)

    published_groups = {gid: g for gid, g in groups.items() if len(g['members']) > 1}
    if write_if_changed(BUILD_OUT / 'groups.json', json.dumps(published_groups, separators=(',', ':'))):
        changed.append('groups.json')
    if write_if_changed(BUILD_OUT / 'variants.json', json.dumps(variants, separators=(',', ':'), ensure_ascii=False)):
        changed.append('variants.json')
    sets_pub = [s for s in sets if s['id'] in set(set_ids)]
    if write_if_changed(BUILD_OUT / 'sets.json', json.dumps(sets_pub, separators=(',', ':'), ensure_ascii=False)):
        changed.append('sets.json')

    model_src = MODEL_DIR / 'encoder_fp16.onnx'
    model_dst = BUILD_OUT / 'model' / 'encoder.onnx'
    if not model_dst.exists() or sha256(model_src) != sha256(model_dst):
        model_dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(model_src, model_dst)
        changed.append('model/encoder.onnx')

    # Manifest: every published file, tiered for the service worker (spec section 8).
    files, total = {}, 0
    for path in sorted(BUILD_OUT.rglob('*')):
        if not path.is_file() or path.name == 'manifest.json' or path.suffix == '.tmp':
            continue
        rel = path.relative_to(BUILD_OUT).as_posix()
        size = path.stat().st_size
        if size > MAX_FILE_BYTES:
            raise SystemExit('FAIL: %s is %.1f MB, over the 95 MB per-file limit' % (rel, size / 1e6))
        total += size
        files[rel] = {'sha256': sha256(path), 'bytes': size, 'tier': 2 if rel.startswith('thumbs/') else 1}
    if total > MAX_SITE_BYTES:
        raise SystemExit('FAIL: scanner data totals %.1f MB, over the 800 MB budget' % (total / 1e6))

    digest = hashlib.sha256(''.join(f['sha256'] for f in files.values()).encode()).hexdigest()[:12]
    manifest = {
        'version': datetime.now(timezone.utc).strftime('%Y%m%d') + '-' + digest,
        'built_at': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'encoder': dict(ENCODER, file='model/encoder.onnx', dtype='float16'),
        'index': {'dtype': 'float16', 'dim': ENCODER['dim'], 'sets': set_ids},
        'counts': {'cards': n_cards, 'sets': len(set_ids), 'art_groups_with_reprints': len(published_groups),
                   'thumbs': sum(1 for k in files if k.startswith('thumbs/'))},
        'bytes': {'total': total, 'tier1': sum(f['bytes'] for f in files.values() if f['tier'] == 1),
                  'tier2': sum(f['bytes'] for f in files.values() if f['tier'] == 2)},
        'files': files,
    }
    old = json.loads((BUILD_OUT / 'manifest.json').read_text(encoding='utf-8')) if (BUILD_OUT / 'manifest.json').exists() else {}
    if old.get('files') != files:
        write_if_changed(BUILD_OUT / 'manifest.json', json.dumps(manifest, indent=1))
    print('%d cards in %d sets; %d files, %.1f MB (tier 1 %.1f MB, thumbs %.1f MB); %d changed this run'
          % (n_cards, len(set_ids), len(files), total / 1e6, manifest['bytes']['tier1'] / 1e6,
             manifest['bytes']['tier2'] / 1e6, len(changed)), flush=True)


if __name__ == '__main__':
    main()
