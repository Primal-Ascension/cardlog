"""Paths and constants for the scanner catalog build (Phase 2, reused by Phase 4).

Inputs and intermediate files live in the cache, outside the repo and outside
OneDrive. The publishable output is written to BUILD_OUT and only copied into
the repo's /scanner/ folder once a build has been reviewed.
"""
import os
from pathlib import Path

API_BASE = 'https://api.pokemontcg.io/v2'

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent
OVERRIDES = ROOT / 'variants_overrides.json'

# Not under AppData: the Claude desktop app is a packaged app and AppData
# writes get redirected. Override with CARDLOG_CACHE / CARDLOG_BUILD_OUT.
CACHE = Path(os.environ.get('CARDLOG_CACHE') or Path.home() / '.cardlog' / 'cache')
BUILD_OUT = Path(os.environ.get('CARDLOG_BUILD_OUT') or Path.home() / '.cardlog' / 'build' / 'scanner')

SETS_FILE = CACHE / 'sets.json'
CARDS_DIR = CACHE / 'cards'            # {set_id}.json
IMAGES_DIR = CACHE / 'images'          # {large,small}/{set_id}/{card_id}.png
ART_DIR = CACHE / 'art'                # {set_id}/{card_id}.png, grayscale art crop for keypoints
EMBED_DIR = CACHE / 'embed'            # {set_id}.npz, float32 vectors + ids + source hashes
MODEL_DIR = CACHE / 'model'            # exported ONNX encoders

for d in (CARDS_DIR, IMAGES_DIR, ART_DIR, EMBED_DIR, MODEL_DIR, BUILD_OUT):
    d.mkdir(parents=True, exist_ok=True)

# Encoder chosen at the Phase 1 gate: DINOv2-small on the art-box crop.
# The browser reads these from manifest.json so the crop and preprocessing
# match the catalog exactly.
ENCODER = {
    'name': 'dinov2-small',
    'hf_id': 'facebook/dinov2-small',
    'input_size': 224,
    'mean': [0.485, 0.456, 0.406],
    'std': [0.229, 0.224, 0.225],
    'dim': 384,
    # (left, top, right, bottom) as fractions of the 63x88 card. The same
    # fixed region is used for every era: catalog and photo are cropped
    # identically, so it does not need to line up with each frame's art window.
    'art_box': [0.085, 0.105, 0.915, 0.535],
    'resize': 'bilinear-squash',
}

# Hard limits from the spec.
MAX_FILE_BYTES = 95 * 1024 * 1024
MAX_SITE_BYTES = 800 * 1024 * 1024

THUMB_WIDTH = 100
THUMB_TARGET_BYTES = (5 * 1024, 8 * 1024)

VINTAGE_END = '2007-12-31'   # 1996-2007 sets get the variant key-coverage audit


def file_id(card_id):
    """Card id -> safe file/URL name. Only Unown ex10-! and ex10-? need it today."""
    return ''.join(ch if ch.isalnum() or ch in '._-' else '_x%02X' % ord(ch) for ch in card_id)


def image_path(card, size):
    return IMAGES_DIR / size / card['set_id'] / (file_id(card['id']) + '.png')
