# Changelog

All notable changes to GICS are documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.3.2] - 2026-02-12

### Added

- **Item-Major Layout**: Deterministic matrix transpose for multi-item time-series. When all snapshots contain the same items in the same order, VALUE/QUANTITY/ITEM_ID arrays are transposed from snapshot-major to item-major order before codec processing. Multi-item compression improved from ~22x to ~42x (+90%). Backward compatible: `SEGMENT_FLAGS.ITEM_MAJOR_LAYOUT` flag in segment header; old archives (flag=0) decode unchanged.
- **Daemon Mode**: Persistent process with MemTable, WAL (write-ahead log), and IPC server (JSON-RPC 2.0 over named pipe / Unix socket). Supports `ingest`, `query`, `flush`, `compact`, `rotate`, `getInsights`, and tier management commands.
- **Insight Engine**: Three modules built on pure incremental statistics (zero ML dependencies):
  - `InsightTracker`: Per-item behavioral metrics (velocity, entropy, volatility, streaks, field trends, lifecycle stage) using Welford variance and Shannon entropy.
  - `CorrelationAnalyzer`: Cross-item Pearson correlation, Union-Find clustering with path compression, leading indicator detection, seasonal pattern recognition.
  - `PredictiveSignals`: Anomaly detection (z-score), EMA-based trend forecasting, actionable compression recommendations.
- **CompressionProfiler**: Benchmarks encoder across `compressionLevel x blockSize` matrix (quick: 6 trials, deep: 30 trials). Returns recommended config with reproducibility metadata (sample hash, encoder version). CLI: `npm run profile`.
- **Encoder Options**: `compressionLevel` (1-22) and `blockSize` exposed as public `GICSv2EncoderOptions`. Three presets: `balanced` (L3/B1000), `max_ratio` (L9/B4000), `low_latency` (L1/B512).
- **AsyncRWLock**: In-process async read-write lock with FIFO queue and write-preferring fairness. Used by daemon static lock helpers; eliminates TOCTOU race condition inherent in file-based check-then-act patterns.
- **File Locking**: Cross-platform shared/exclusive marker-file locks for cross-process safety (instance API). In-process `AsyncRWLock` per path for daemon operations (static API).
- **Python Client SDK**: Zero-dependency sync/async client (`clients/python/gics_client.py`) with connection pooling and JSON-RPC 2.0 protocol.
- **Security Benchmarks**: `bench:security` (encryption overhead, tamper detection), `bench:edge-cases` (float precision, codec boundaries), `bench:codec-stats` (per-codec selection frequency), `bench:validate-50x` (compression guarantee gate).
- **Regression Tests**: `tests/regression/` suite — codec selection stability, float precision loss, quarantine trigger.
- **Segment Header Extension**: Bytes 10-13 (previously reserved) now carry `flags: u8` and `itemsPerSnapshot: u16`. No size change (14 bytes). Full backward compatibility.

### Changed

- **Codec Selection**: Removed artificial codec gates. All codecs (DELTA, RLE, DELTA_RLE, HUFFMAN, RAW) compete on every block via trial-by-size. Best ratio wins.
- **String Dictionary**: Tightened encoding/decoding for edge cases.
- **Encryption Module**: Minor hardening.
- **Outer Codecs**: Cleanup and consistency.
- **Benchmark Harness**: Updated datasets, added multi-item workloads, stricter thresholds.

### Fixed

- **QUARANTINE roundtrip mismatch** (decode.ts): Decoder checked `blockFlags & 0x10` (HEALTH_QUAR) to skip state commit, but encoder always commits. Fix: always commit state. Resolved `integrity_mismatch` and `eos_missing` test failures.
- **Float roundtrip in legacy streams**: Preserve precision for float values in pre-v1.3 archives.
- **Daemon file-lock race condition**: Replaced file-based check-then-act with `AsyncRWLock` for in-process operations. Soak test: 3-4s to 789ms, consistent pass.

### Performance

| Dataset | Before | After | Change |
|---------|--------|-------|--------|
| TS_TREND_INT | 29.5x | 29.5x | - |
| TS_VOLATILE_INT | 21.9x | 21.9x | - |
| TS_MULTI_ITEM | 21.9x | 41.8x | **+90%** |
| TS_MULTI_ITEM (append) | 20.1x | 40.5x | **+101%** |

### Known Issues

- `gics-float-edge-cases.test.ts`: Extreme finite float roundtrip (MAX_VALUE, subnormals) — pre-existing precision edge case at codec level. Does not affect normal float ranges.

---

## [1.3.1] - 2026-02-10

### Changed

- Package scope renamed to `@gredinlabstechnologies/gics-core`.
- Published to GitHub Packages registry.
- CI hardening: SonarCloud config, optional SonarLint connected mode.

---

## [1.3.0] - 2026-02-08

### Added

- **StreamSegments**: Segmented archive format with per-segment index, Bloom filter, and CRC32 integrity.
- **AES-256-GCM Encryption**: Optional per-archive encryption with key derivation.
- **JSON Schema Profiles**: Typed field definitions for generic (non-financial) time-series.
- **SHA-256 Integrity Chain**: End-to-end hash chain across segments.
- **CHM (Compression Health Monitor)**: Runtime health tracking with quarantine flags.
- **Golden Corpus**: Reference fixtures for regression testing.
- **Adversarial Test Suite**: Fuzzing, truncation, bit-flip resistance tests.
- **Forensics Pipeline**: Determinism verification harness with cross-run comparison.
- **Outer Codec**: Segment-level Zstd wrapping for final compression pass.

### Changed

- Full encoder/decoder refactor: StreamSections, block manifests, codec trial system.
- Test count: 130+ (from ~50 in v1.2).

---

## [1.2.0] - 2026-02-07

### Added

- Verification suite for production deployment.
- Legacy format support for archived data.
- Dual-index architecture (v1.1 hybrid storage engine).
- Zstd/Brotli compression backends.

### Status

Archived at `GICS-ARCHIVE/versions/v1.2/`.

---

## [1.1.0] - 2026-02-06

### Added

- Initial GICS implementation: delta encoding, RLE, Huffman, block-based compression for integer time-series.
- Original frozen reference implementation.

### Status

Archived at `GICS-ARCHIVE/versions/v1.1/frozen/`.
