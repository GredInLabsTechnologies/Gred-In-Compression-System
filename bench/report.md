# GICS Benchmark Report
**Run ID**: run-2026-03-17T05-14-27.035Z.json
**Time**: 2026-03-17T05:14:27.035Z
**Environment**: AMD Ryzen 5 5600G with Radeon Graphics          / Windows_NT 10.0.26200

## Results
| Dataset | System | Workload | Size (In) | Size (Out) | Ratio | Total (ms) | Setup (ms) | Encode (ms) | RAM (MB) |
|---|---|---|---|---|---|---|---|---|---|
| TS_TREND_INT | **GICS** | BENCH-ENC-001 | 2.11 MB | 0.07 MB | **29.04x** | 383 | 0.5 | 382.4 | 162.1 |
| TS_TREND_INT | **GICS** | BENCH-ENC-APPEND-001 | 10.57 MB | 0.46 MB | **23.03x** | 1528 | 0.1 | 1528.4 | 196.7 |
| TS_TREND_INT | **BASELINE_ZSTD** | BENCH-ENC-001 | 2.11 MB | 0.42 MB | **5.06x** | 13 | - | - | 198.8 |
| TS_VOLATILE_INT | **GICS** | BENCH-ENC-001 | 1.99 MB | 0.09 MB | **21.89x** | 330 | 0.0 | 330.4 | 265.5 |
| TS_VOLATILE_INT | **GICS** | BENCH-ENC-APPEND-001 | 9.94 MB | 0.45 MB | **22.00x** | 1728 | 0.1 | 1728.0 | 611.9 |
| TS_VOLATILE_INT | **BASELINE_ZSTD** | BENCH-ENC-001 | 1.99 MB | 0.48 MB | **4.10x** | 12 | - | - | 613.9 |
| TS_MULTI_ITEM | **GICS** | BENCH-ENC-001 | 3.65 MB | 0.07 MB | **52.01x** | 298 | 0.1 | 297.5 | 637.1 |
| TS_MULTI_ITEM | **GICS** | BENCH-ENC-APPEND-001 | 18.23 MB | 0.35 MB | **51.92x** | 1303 | 0.1 | 1303.4 | 694.8 |
| TS_MULTI_ITEM | **BASELINE_ZSTD** | BENCH-ENC-001 | 3.65 MB | 0.32 MB | **11.28x** | 12 | - | - | 698.5 |