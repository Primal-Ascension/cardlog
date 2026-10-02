# Phase 1 results

Photos: 80. Card outline detected in 68 (85%); the rest fell back to the full frame.

Device: cpu. Times include detection and two embeddings (upright + 180 degrees).

Targets: art group in top 5 >= 95%, top 1 >= 85%.

| Encoder | Crop | Group top-1 | Group top-5 | Exact top-1 | Median ms | p95 ms | Model MB (fp16) | Top-1 sim, hits / misses |
|---|---|---|---|---|---|---|---|---|
| dinov2-small | full | 86.2% | 91.2% | 72.5% | 204 | 213 | 44.1 | 0.934 / 0.614 |
| dinov2-small | art | 91.2% | 93.8% | 67.5% | 199 | 210 | 44.1 | 0.912 / 0.494 |
| MobileCLIP2-S0/dfndr2b | full | 87.5% | 93.8% | 73.8% | 196 | 211 | 22.8 | 0.961 / 0.694 |
| MobileCLIP2-S0/dfndr2b | art | 81.2% | 86.2% | 67.5% | 187 | 198 | 22.8 | 0.935 / 0.601 |

Per-photo misses are in misses.csv.
