# Phase 1 results

Photos: 41. Card outline detected in 32 (78%); the rest fell back to the full frame.

Device: cpu. Times include detection and two embeddings (upright + 180 degrees).

Targets: art group in top 5 >= 95%, top 1 >= 85%, measured on the core four sets (base1, base2, base4, base6).

| Encoder | Crop | Core: group top-1 | Core: group top-5 | Core: exact top-1 | All: group top-1 | All: group top-5 | All: exact top-1 | Median ms | p95 ms | Model MB (fp16) | Top-1 sim, hits / misses |
|---|---|---|---|---|---|---|---|---|---|---|---|
| dinov2-small | full | 75.9% | 86.2% | 48.3% | 78.0% | 87.8% | 53.7% | 223 | 269 | 44.1 | 0.779 / 0.573 |
| dinov2-small | art | 93.1% | 96.6% | 58.6% | 87.8% | 97.6% | 61.0% | 214 | 262 | 44.1 | 0.847 / 0.429 |
| MobileCLIP2-S0/dfndr2b | full | 93.1% | 96.6% | 51.7% | 85.4% | 95.1% | 48.8% | 211 | 267 | 22.8 | 0.924 / 0.799 |
| MobileCLIP2-S0/dfndr2b | art | 86.2% | 89.7% | 48.3% | 80.5% | 87.8% | 51.2% | 211 | 263 | 22.8 | 0.833 / 0.661 |

Core photos: 29 of 41.

Per-photo misses are in misses.csv.
