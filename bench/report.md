# GICS Benchmark Report
**Run ID**: run-2026-02-08T17-07-48.316Z.json
**Time**: 2026-02-08T17:07:48.316Z
**Environment**: AMD Ryzen 5 5600G with Radeon Graphics          / Windows_NT 10.0.26200

## Results
| Dataset | System | Workload | Size (In) | Size (Out) | Ratio | Total (ms) | Setup (ms) | Encode (ms) | RAM (MB) |
|---|---|---|---|---|---|---|---|---|---|
| TS_TREND_INT | **GICS** | BENCH-ENC-001 | 2.11 MB | 0.04 MB | **50.18x** | 239 | 0.3 | 238.7 | 92.2 |
| TS_TREND_INT | **GICS** | BENCH-ENC-APPEND-001 | 10.57 MB | 0.22 MB | **48.67x** | 787 | 0.0 | 786.5 | 374.9 |
| TS_TREND_INT | **BASELINE_ZSTD** | BENCH-ENC-001 | 2.11 MB | 0.42 MB | **5.06x** | 11 | - | - | 377.0 |
| TS_VOLATILE_INT | **GICS** | BENCH-ENC-001 | 2.14 MB | 0.10 MB | **20.89x** | 162 | 0.0 | 162.2 | 473.5 |
| TS_VOLATILE_INT | **GICS** | BENCH-ENC-APPEND-001 | 10.72 MB | 0.55 MB | **19.66x** | 808 | 0.0 | 807.9 | 815.3 |
| TS_VOLATILE_INT | **BASELINE_ZSTD** | BENCH-ENC-001 | 2.14 MB | 0.47 MB | **4.54x** | 10 | - | - | 817.5 |