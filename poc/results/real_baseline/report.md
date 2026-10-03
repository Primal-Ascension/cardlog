# Phase 1 results

Photos: 41. Card outline detected in 25 (61%); the rest fell back to the full frame.

Device: cpu. Times include detection and two embeddings (upright + 180 degrees).

Targets: art group in top 5 >= 95%, top 1 >= 85%, measured on the core four sets (base1, base2, base4, base6).

| Encoder | Crop | Core: group top-1 | Core: group top-5 | Core: exact top-1 | All: group top-1 | All: group top-5 | All: exact top-1 | Median ms | p95 ms | Model MB (fp16) | Top-1 sim, hits / misses |
|---|---|---|---|---|---|---|---|---|---|---|---|
| dinov2-small | full | 75.9% | 82.8% | 34.5% | 75.6% | 82.9% | 41.5% | 250 | 293 | 44.1 | 0.712 / 0.541 |
| dinov2-small | art | 75.9% | 79.3% | 44.8% | 70.7% | 85.4% | 43.9% | 251 | 306 | 44.1 | 0.680 / 0.565 |
| MobileCLIP2-S0/dfndr2b | full | 82.8% | 93.1% | 41.4% | 75.6% | 95.1% | 36.6% | 225 | 274 | 22.8 | 0.841 / 0.762 |
| MobileCLIP2-S0/dfndr2b | art | 62.1% | 75.9% | 31.0% | 65.9% | 80.5% | 36.6% | 209 | 256 | 22.8 | 0.735 / 0.665 |

Core photos: 29 of 41.

Per-photo misses are in misses.csv.
