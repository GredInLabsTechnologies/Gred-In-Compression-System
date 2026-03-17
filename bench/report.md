# GICS Benchmark Report
**Run ID**: run-2026-03-17T04-03-45.093Z.json
**Time**: 2026-03-17T04:03:45.093Z
**Environment**: AMD Ryzen 5 5600G with Radeon Graphics          / Windows_NT 10.0.26200

## Results
| Dataset | System | Workload | Size (In) | Size (Out) | Ratio | Total (ms) | Setup (ms) | Encode (ms) | RAM (MB) |
|---|---|---|---|---|---|---|---|---|---|
| TS_TREND_INT | **GICS** | BENCH-ENC-001 | 2.11 MB | 0.07 MB | **29.04x** | 396 | 0.4 | 395.2 | 160.1 |
| TS_TREND_INT | **GICS** | BENCH-ENC-APPEND-001 | 10.57 MB | 0.46 MB | **23.03x** | 1437 | 0.1 | 1437.3 | 190.0 |
| TS_TREND_INT | **BASELINE_ZSTD** | BENCH-ENC-001 | 2.11 MB | 0.42 MB | **5.06x** | 12 | - | - | 192.2 |
| TS_VOLATILE_INT | **GICS** | BENCH-ENC-001 | 1.99 MB | 0.09 MB | **21.89x** | 359 | 0.1 | 359.0 | 259.6 |
| TS_VOLATILE_INT | **GICS** | BENCH-ENC-APPEND-001 | 9.94 MB | 0.45 MB | **22.00x** | 1688 | 0.0 | 1687.9 | 609.4 |
| TS_VOLATILE_INT | **BASELINE_ZSTD** | BENCH-ENC-001 | 1.99 MB | 0.48 MB | **4.10x** | 11 | - | - | 611.4 |
| TS_MULTI_ITEM | **GICS** | BENCH-ENC-001 | 3.65 MB | 0.07 MB | **52.01x** | 325 | 0.1 | 324.9 | 634.3 |
| TS_MULTI_ITEM | **GICS** | BENCH-ENC-APPEND-001 | 18.23 MB | 0.35 MB | **51.92x** | 1337 | 0.1 | 1337.2 | 692.6 |
| TS_MULTI_ITEM | **BASELINE_ZSTD** | BENCH-ENC-001 | 3.65 MB | 0.32 MB | **11.28x** | 9 | - | - | 696.2 |