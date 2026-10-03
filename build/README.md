# Scanner catalog build

Builds the offline card catalog the in-app scanner matches against. Phase 2 of `CARDLOG_SCANNER_SPEC.md`; Phase 4 runs it weekly in GitHub Actions.

## Setup (once)

Uses the same Python environment as `poc/` (`%USERPROFILE%\.cardlog\venv`), plus:

```
pip install onnx onnxruntime onnxscript onnxconverter-common
```

## Run

```
cd build
python encoder_export.py        # once, or when the encoder changes
python run_all.py --sanity 40   # every step below, incremental
```

| Step | What it does | Output |
|---|---|---|
| `catalog.py` | All English sets and cards from pokemontcg.io, plus images | cache: `cards/`, `images/` |
| `embed.py` | DINOv2 art-box embedding per card (fp32 ONNX) | cache: `embed/`, `art/` |
| `groups.py` | Reprint groups: same name + cosine ≥ 0.70, confirmed by keypoints and artist | cache: `groups.json`, `groups_review.json` |
| `variants.py` | Printings per card (1st Edition, Unlimited, reverse holo, ...) and the default | cache: `variants.json`, `variants_audit.json` |
| `thumbs.py` | ~100 px WebP thumbnails, 5-8 KB | `thumbs/` |
| `publish.py` | Shards, model, manifest; enforces 95 MB/file and 800 MB total | `~/.cardlog/build/scanner/` |
| `report.py` | Build report and art-group review log | `reports/` |

`eval_photos.py` rescores the owner's labeled photos (`poc/photos/`) with the shipping pipeline. Run it after any change to the encoder, crop or preprocessing.

The cache (about 18 GB of images) and the build output live in `%USERPROFILE%\.cardlog`, outside the repo and OneDrive. The output is copied into the repo's `/scanner/` folder once a build has been reviewed.

## Manual fixes

- `art_groups_overrides.json`: `merge` / `split` pairs of card ids, applied after the automatic grouping.
- `variants_overrides.json`: printings the tcgplayer keys miss (Base Set Shadowless and 4th Print, 1st Edition for WOTC sets).

No price values are ever stored; only the key names of `tcgplayer.prices` are read.
