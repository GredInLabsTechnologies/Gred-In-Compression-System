# GICS Benchmark Report
**Run ID**: run-2026-02-10T18-16-00.676Z.json
**Time**: 2026-02-10T18:16:00.676Z
**Environment**: AMD Ryzen 5 5600G with Radeon Graphics          / Windows_NT 10.0.26200

## Results
| Dataset | System | Workload | Size (In) | Size (Out) | Ratio | Total (ms) | Setup (ms) | Encode (ms) | RAM (MB) |
|---|---|---|---|---|---|---|---|---|---|
| TS_TREND_INT | **GICS** | BENCH-ENC-001 | 2.11 MB | 0.06 MB | **34.59x** | 312 | 0.2 | 312.2 | 117.7 |
| TS_TREND_INT | **GICS** | BENCH-ENC-APPEND-001 | 10.57 MB | 0.37 MB | **28.30x** | 828 | 0.1 | 828.0 | 480.8 |
| TS_TREND_INT | **BASELINE_ZSTD** | BENCH-ENC-001 | 2.11 MB | 0.42 MB | **5.06x** | 14 | - | - | 482.9 |
| TS_VOLATILE_INT | **GICS** | BENCH-ENC-001 | 2.14 MB | 0.14 MB | **15.87x** | 196 | 0.0 | 196.3 | 482.9 |
| TS_VOLATILE_INT | **GICS** | BENCH-ENC-APPEND-001 | 10.72 MB | 0.78 MB | **13.67x** | 940 | 0.0 | 939.8 | 359.0 |
| TS_VOLATILE_INT | **BASELINE_ZSTD** | BENCH-ENC-001 | 2.14 MB | 0.47 MB | **4.54x** | 10 | - | - | 361.2 |