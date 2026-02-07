# GICS Benchmark Report
**Run ID**: run-2026-02-07T19-22-01.878Z.json
**Time**: 2026-02-07T19:22:01.878Z
**Environment**: AMD Ryzen 5 5600G with Radeon Graphics          / Windows_NT 10.0.26200

## Results
| Dataset | System | Workload | Size (In) | Size (Out) | Ratio | Total (ms) | Setup (ms) | Encode (ms) | RAM (MB) |
|---|---|---|---|---|---|---|---|---|---|
| TS_TREND_INT | **GICS** | BENCH-ENC-001 | 2.11 MB | 0.09 MB | **23.17x** | 588 | 0.2 | 587.7 | 194.1 |
| TS_TREND_INT | **GICS** | BENCH-ENC-APPEND-001 | 10.57 MB | 0.46 MB | **22.86x** | 2604 | 0.0 | 2603.7 | 163.8 |
| TS_TREND_INT | **BASELINE_ZSTD** | BENCH-ENC-001 | 2.11 MB | 0.42 MB | **5.06x** | 21 | - | - | 165.9 |
| TS_VOLATILE_INT | **GICS** | BENCH-ENC-001 | 2.14 MB | 0.16 MB | **13.49x** | 773 | 0.0 | 773.1 | 185.0 |
| TS_VOLATILE_INT | **GICS** | BENCH-ENC-APPEND-001 | 10.72 MB | 0.80 MB | **13.37x** | 3734 | 0.0 | 3733.7 | 221.4 |
| TS_VOLATILE_INT | **BASELINE_ZSTD** | BENCH-ENC-001 | 2.14 MB | 0.47 MB | **4.54x** | 11 | - | - | 223.6 |
| TS_TREND_INT_LARGE | **GICS** | BENCH-ENC-001 | 47.83 MB | 1.87 MB | **25.64x** | 10698 | 0.0 | 10698.3 | 365.9 |
| TS_TREND_INT_LARGE | **GICS** | BENCH-ENC-APPEND-001 | 239.14 MB | 9.38 MB | **25.49x** | 54351 | 0.0 | 54350.8 | 448.0 |