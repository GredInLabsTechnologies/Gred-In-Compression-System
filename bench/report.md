# GICS Benchmark Report
**Run ID**: run-2026-02-12T01-45-37.138Z.json
**Time**: 2026-02-12T01:45:37.138Z
**Environment**: AMD Ryzen 5 5600G with Radeon Graphics          / Windows_NT 10.0.26200

## Results
| Dataset | System | Workload | Size (In) | Size (Out) | Ratio | Total (ms) | Setup (ms) | Encode (ms) | RAM (MB) |
|---|---|---|---|---|---|---|---|---|---|
| TS_TREND_INT | **GICS** | BENCH-ENC-001 | 2.11 MB | 0.07 MB | **29.52x** | 346 | 0.5 | 345.1 | 122.8 |
| TS_TREND_INT | **GICS** | BENCH-ENC-APPEND-001 | 10.57 MB | 0.46 MB | **23.09x** | 1139 | 0.1 | 1139.0 | 474.6 |
| TS_TREND_INT | **BASELINE_ZSTD** | BENCH-ENC-001 | 2.11 MB | 0.42 MB | **5.06x** | 14 | - | - | 476.7 |
| TS_VOLATILE_INT | **GICS** | BENCH-ENC-001 | 1.99 MB | 0.09 MB | **21.89x** | 277 | 0.1 | 276.6 | 476.8 |
| TS_VOLATILE_INT | **GICS** | BENCH-ENC-APPEND-001 | 9.94 MB | 0.45 MB | **22.00x** | 1264 | 0.1 | 1263.5 | 383.8 |
| TS_VOLATILE_INT | **BASELINE_ZSTD** | BENCH-ENC-001 | 1.99 MB | 0.48 MB | **4.10x** | 12 | - | - | 385.8 |
| TS_MULTI_ITEM | **GICS** | BENCH-ENC-001 | 3.65 MB | 0.09 MB | **41.77x** | 175 | 0.1 | 174.7 | 400.7 |
| TS_MULTI_ITEM | **GICS** | BENCH-ENC-APPEND-001 | 18.23 MB | 0.45 MB | **40.50x** | 834 | 0.0 | 833.6 | 471.8 |
| TS_MULTI_ITEM | **BASELINE_ZSTD** | BENCH-ENC-001 | 3.65 MB | 0.32 MB | **11.28x** | 10 | - | - | 475.5 |