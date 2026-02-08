# GICS Benchmark Report
**Run ID**: run-2026-02-08T15-42-59.561Z.json
**Time**: 2026-02-08T15:42:59.561Z
**Environment**: AMD Ryzen 5 5600G with Radeon Graphics          / Windows_NT 10.0.26200

## Results
| Dataset | System | Workload | Size (In) | Size (Out) | Ratio | Total (ms) | Setup (ms) | Encode (ms) | RAM (MB) |
|---|---|---|---|---|---|---|---|---|---|
| TS_TREND_INT | **GICS** | BENCH-ENC-001 | 2.11 MB | 0.09 MB | **23.17x** | 574 | 0.1 | 574.1 | 138.7 |
| TS_TREND_INT | **GICS** | BENCH-ENC-APPEND-001 | 10.57 MB | 0.46 MB | **22.86x** | 2655 | 0.0 | 2655.2 | 138.7 |
| TS_TREND_INT | **BASELINE_ZSTD** | BENCH-ENC-001 | 2.11 MB | 0.42 MB | **5.06x** | 22 | - | - | 132.6 |
| TS_VOLATILE_INT | **GICS** | BENCH-ENC-001 | 2.14 MB | 0.16 MB | **13.49x** | 782 | 0.0 | 781.8 | 132.6 |
| TS_VOLATILE_INT | **GICS** | BENCH-ENC-APPEND-001 | 10.72 MB | 0.80 MB | **13.37x** | 3841 | 0.0 | 3840.8 | 153.3 |
| TS_VOLATILE_INT | **BASELINE_ZSTD** | BENCH-ENC-001 | 2.14 MB | 0.47 MB | **4.54x** | 11 | - | - | 155.4 |
| TS_TREND_INT_LARGE | **GICS** | BENCH-ENC-001 | 47.83 MB | 1.87 MB | **25.64x** | 10706 | 0.0 | 10705.7 | 176.3 |
| TS_TREND_INT_LARGE | **GICS** | BENCH-ENC-APPEND-001 | 239.14 MB | 9.38 MB | **25.49x** | 58452 | 0.0 | 58452.1 | 184.2 |