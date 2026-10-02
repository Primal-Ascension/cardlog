# Scanner proof of concept (Phase 1)

Local only. Nothing here is deployed.

## Setup (once)

The virtual environment and the image cache both live in `%USERPROFILE%\.cardlog`, outside the repo and outside OneDrive (PyTorch alone is about 2 GB).

```
python -m venv %USERPROFILE%\.cardlog\venv
%USERPROFILE%\.cardlog\venv\Scripts\activate
cd poc
pip install -r requirements.txt
```

## Run

1. `python ingest.py` downloads card data and images for Base Set, Jungle, Base Set 2 and Legendary Collection into `%USERPROFILE%\.cardlog\cache`.
2. `python build_truth.py` writes `art_groups_truth.json`, the reprint groups the scores are measured against. Check its `review` list, fix any groups by hand, then set `"reviewed": true`.
3. Put labeled photos in `photos/`: `base1-4.jpg` is Base Set Charizard, and `base1-4_2.jpg` is a second shot of the same card. Photos are gitignored.
4. `python evaluate.py` scores DINOv2-small and MobileCLIP-S0, each on the full card and on the art box. The results go to `results/report.md`. `results/warped/` shows what the card detector cropped from each photo.

Set `POKEMONTCG_API_KEY` in your shell for higher API rate limits. It's optional; never commit it.
