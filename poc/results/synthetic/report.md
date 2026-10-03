# Phase 1 results

Photos: 80. Card outline detected in 68 (85%); the rest fell back to the full frame.

Device: cpu. Times include detection and two embeddings (upright + 180 degrees).

Targets: art group in top 5 >= 95%, top 1 >= 85%, measured on the core four sets (base1, base2, base4, base6).

| Encoder | Crop | Core: group top-1 | Core: group top-5 | Core: exact top-1 | All: group top-1 | All: group top-5 | All: exact top-1 | Median ms | p95 ms | Model MB (fp16) | Top-1 sim, hits / misses |
|---|---|---|---|---|---|---|---|---|---|---|---|
| dinov2-small | full | 89.2% | 90.5% | 66.2% | 90.0% | 91.2% | 68.8% | 217 | 248 | 44.1 | 0.910 / 0.653 |
| dinov2-small | art | 91.9% | 97.3% | 63.5% | 91.2% | 97.5% | 65.0% | 227 | 285 | 44.1 | 0.901 / 0.567 |
| MobileCLIP2-S0/dfndr2b | full | 93.2% | 95.9% | 75.7% | 91.2% | 93.8% | 75.0% | 223 | 291 | 22.8 | 0.953 / 0.730 |
| MobileCLIP2-S0/dfndr2b | art | 82.4% | 91.9% | 67.6% | 82.5% | 91.2% | 68.8% | 197 | 230 | 22.8 | 0.929 / 0.627 |

Core photos: 74 of 80.

Per-photo misses are in misses.csv.
