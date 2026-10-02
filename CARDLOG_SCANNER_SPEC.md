# CardLog Scanner: Build Spec

Instructions for Claude Code. Read this whole file before doing anything. Execute one phase at a time and stop at each gate for owner review.

## 1. Goal

Add a camera-based card scanner to CardLog. The phone photographs a Pokémon card, the app identifies it against a local catalog of every card, shows a popup of reprints and print variants, and the user confirms. Everything runs in the browser, works fully offline after first load, and is hosted on GitHub Pages.

Owner context: heavy focus on vintage and mid-era cards (WOTC through EX era, roughly 1996 to 2007). Accuracy on those sets matters more than on modern sets. Primary use is scanning at card shows with poor or no connectivity.

## 2. Hard constraints

- **Hosting is GitHub Pages.** Static files only. No server, no backend compute. All matching runs on-device.
- **Public repo.** No API keys, tokens, or secrets in client code or committed files. Build-time secrets go in GitHub Actions secrets only.
- **No pricing data.** The catalog holds card data and images only. Do not store price values. (Reading the *keys* of the pokemontcg.io `tcgplayer.prices` object to detect which printings exist is allowed; see section 6. Discard the values.)
- **File limits.** No single file over 95 MB. Total published site under 800 MB (Pages cap is 1 GB; leave headroom).
- **Repo growth.** Generated data must be append-only per set so weekly updates do not rewrite large files and bloat git history.
- **Do not commit raw or full-size images.** They are build inputs only.
- **Do not break existing CardLog behavior.** The scanner plugs into CardLog's existing card entry flow.

## 3. Architecture

### Build time (local first run, then GitHub Actions)
1. Ingest all English cards and sets from the Pokémon TCG API v2 (`https://api.pokemontcg.io/v2`), 250 cards per page.
2. Download each card's `images.large` for embedding and `images.small` for thumbnail generation (into a gitignored cache).
3. Compute one embedding per card. L2-normalize. Store as float16.
4. Cluster same-art cards into art groups (section 5).
5. Build the variant table (section 6).
6. Generate offline thumbnails: about 100px wide, WebP, quality tuned to about 5 to 8 KB each.
7. Write per-set shards plus a manifest (section 4).

### Run time (phone browser)
1. Camera via `getUserMedia` (rear camera, HTTPS required; Pages provides it).
2. Card detection: OpenCV.js contour detection, find the largest 4-point contour, perspective-warp to the 63x88 card aspect. Show an outline overlay; auto-capture when the outline is stable for about 300 ms, with a manual shutter as fallback.
3. Embed the warped card with ONNX Runtime Web (WebGPU when available, WASM fallback).
4. Brute-force dot product against the full index (about 20k vectors; no ANN library needed). Take the top 5.
5. Resolve the top hit's art group and open the popup (section 7).
6. On confirm, hand the selected card record (plus chosen variant) to CardLog's existing card entry flow.
7. If the top similarity is below a tuned threshold, show "No confident match" with a manual search (name or number over local metadata).

## 4. Data layout (published)

```
/scanner/
  manifest.json            version, file list, sha256 hashes, counts
  model/encoder.onnx       quantized or fp16 image encoder
  index/{set_id}.bin       float16 vectors for one set, row order matches meta
  meta/{set_id}.json       card records for that set (no prices)
  groups.json              art_group_id -> member card ids
  variants.json            per-card printings + default (section 6)
  thumbs/{set_id}/{card_id}.webp
```

Card record fields: `id, name, number, set_id, set_name, series, release_date, rarity, artist, language, art_group_id, image_url_small, image_url_large`.

Each shard is written once and only rewritten if that set's data changes. New sets add new files.

## 5. Art groups (reprints)

Cards that share the same artwork belong to one `art_group_id`.

- Candidate pairs: cosine similarity above a threshold (tune in Phase 1, start around 0.92).
- Confirm with metadata: same Pokémon name and same artist. Pairs that pass similarity but fail metadata go to a review log; do not auto-merge them.
- Within a group, sort by `release_date` ascending. **Default selection is the oldest card in the selected language.**
- Expected groups to verify explicitly: Base Set / Base Set 2 / Legendary Collection / Celebrations Classic Collection reprints, and Evolutions reprints of Base Set art.
- **Same-set holo and non-holo pairs.** Jungle, Fossil, and Team Rocket printed the same art as a holo rare and a non-holo rare with different card numbers. Group them by art, but treat them as variants of each other, not reprints: they share a set and a date, so "oldest" does not apply. The non-holo is the default (most common printing rule). Verify which other sets have this pattern during Phase 2.

## 6. Print variants

Variants are printings that the catalog does not list as separate cards: 1st Edition, Shadowless, Unlimited, reverse holo, etc.

- **Source:** for each card, read the key names of `tcgplayer.prices` (e.g. `1stEditionHolofoil`, `unlimitedHolofoil`, `holofoil`, `normal`, `reverseHolofoil`). Map them to display names. Discard all price values.
- **Manual overrides:** `variants_overrides.json` covers printings the keys miss. At minimum: Base Set Shadowless (both 1st Edition and Unlimited-era Shadowless), and Base Set 4th print (UK 1999-2000) as an optional entry. Verify the key coverage for every 1996 to 2007 set in Phase 2 and log gaps.
- **Default rule: most common printing.** Unlimited over 1st Edition or Shadowless; normal over reverse holo; non-holo over holo for same-set art pairs.
- Rationale: an unconfirmed scan should never log as a scarcer, more valuable printing.

## 7. Popup selector

- Row 1: **Reprints.** The art group's thumbnails, oldest first, oldest preselected. Each shows set name, set symbol (from the set's image), year, and number.
- Row 2: **Printing.** The variant chips for the selected card, most-common preselected.
- Also show the top 5 raw matches as a "Not it?" expander for misses.
- Confirm is one tap. Correcting is at most two taps.
- Thumbnail fallback order: cached local thumbnail, then hotlinked `image_url_small`, then text only.
- Log every scan (embedding top-5, chosen card, chosen variant, whether the default was kept) to local storage for later tuning. Do not upload it anywhere.

## 8. Offline caching (service worker)

GitHub Pages sets short cache lifetimes, so caching must be handled by a service worker using Cache Storage.

- **Tier 0:** app shell. Cached on install.
- **Tier 1:** model, all index shards, metadata, groups, variants. Required before scanning. Show a progress bar.
- **Tier 2:** thumbnails, fetched in the background in batches after Tier 1 completes. Must not block scanning.
- On load, compare the remote `manifest.json` with the cached one and fetch only changed or new files.
- Show an indicator: "Offline ready: X / Y". Green only when Tiers 1 and 2 are complete.
- Wrap all storage calls in try/catch and degrade gracefully.

## 9. Language

- v1 is English only.
- **English always comes first.** Build, test, and ship the full English catalog before any Japanese work begins.
- Phase 5 adds Japanese (see below). When it does, the art group default must be **the oldest English printing**, with Japanese printings listed after all English ones in the popup. Only when the toggle is set to JP does the default become the oldest Japanese printing. Japanese vintage predates English (Japanese Base is 1996, English Base is 1999), so a cross-language "oldest" would default every WOTC card to the Japanese version. Add a language toggle in the scanner (EN default, remembered per device).

## 10. Phases

### Phase 0: Recon (no changes)
- Read the CardLog repo. Report: stack, file structure, how a card is currently added or logged, where the scanner should hook in, and how Pages deploys (branch or Actions).
- Confirm pokemontcg.io set IDs for the Phase 1 sets.
- **Gate:** owner approves the integration point.

### Phase 1: Proof of concept (local only, no deploy)
- Sets: Base Set (`base1`), Jungle (`base2`), Base Set 2 (`base4`), Legendary Collection (`base6`). Verify these IDs. This mix tests reprints, same-set holo/non-holo pairs, and vintage glare.
- Compare two encoders: DINOv2-small and MobileCLIP-S0. Also compare full-card embeddings vs art-box-crop embeddings.
- Test harness: owner puts labeled photos in `/poc/photos/` (filename = card id; mix raw cards, sleeved, top-loaded, holos, and slabs). Report for each configuration: art-group top-1, art-group top-5, exact-card top-1, median and p95 scan time on desktop, and model file size.
- Targets: art group in top 5 at least 95 percent; top 1 at least 85 percent.
- **Gate:** owner reviews results and picks the configuration.

### Phase 2: Full catalog build
- Ingest all sets, embed, art groups, variants, thumbnails, shards, manifest.
- Output a build report: card count, set count, group count, groups needing review, variant key gaps for 1996 to 2007 sets, total size by folder.
- **Gate:** owner reviews the report and the art group review log.

### Phase 3: In-app scanner
- Camera, detection, embedding, matching, popup, service worker tiers, offline indicator, manual search fallback, CardLog hookup.
- Test on the owner's phone with airplane mode on after caching.
- Target: under 1.5 seconds from capture to popup on the owner's phone.
- **Gate:** owner field-tests with real cards.

### Phase 4: Automation
- GitHub Actions workflow, weekly plus manual dispatch: fetch sets, process only new or changed sets, write new shards, update manifest, deploy.
- Cache model weights between runs. Use a repository secret for the API key if one is used.
- Fail loudly (workflow error) if a build would push any single file over 95 MB or total size over 800 MB.

### Phase 5: Vintage boosters (optional, after field testing)
- **1st Edition stamp detector:** template match on the fixed stamp region of the warped card (left side, below the art box). **Shadowless detector:** check for the missing drop shadow on the art box's right edge. Each shows a "Detected: 1st Ed?" badge on the matching variant chip. The default stays most-common unless the owner decides otherwise after seeing accuracy numbers.
- **Japanese:** ingest from TCGdex. Audit vintage Japanese coverage (Base through Neo, VS, Web, e-series, ADV/PCG) and report gaps before building. Implement the language toggle (section 9).

## 11. Out of scope for now
- Pricing of any kind.
- Stamped and staff promos as variants (log as a future item).
- Cloud sync of the scan log.
- Grading-label OCR for slabs (good future item: PSA/CGC cert lookup could skip matching entirely).
