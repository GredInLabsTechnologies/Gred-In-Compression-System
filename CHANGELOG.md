# Changelog

All notable changes to GICS are documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.3.5] - 2026-04-24

### Fixed

- **CLI** (`src/cli/commands.ts`): `gics daemon start` now honours `--token-path`.
  The previous build silently ignored the flag and always read the token from
  `~/.gics/gics.token`, while clients read from the path they actually passed.
  Every non-`ping` RPC was rejected as `-32000 Unauthorized` while `ping` kept
  reporting `alive=True`, so health probes lied for consumers sited outside
  the home directory. `daemon start` now mirrors `resolveDaemonTarget()`:
  CLI flags win over the config file, config file wins over built-in defaults.
  The boot log now includes `Token: <resolved path>` to make future drift
  visible with a one-line diff.
  Reported by the GIMO team. See
  `docs/reports/2026-04-24_GICS_1_3_5_BUG_DAEMON_IGNORES_TOKEN_PATH_FLAG.md`.
- **Python SDK** (`clients/python/gics_client.py`): `GICSDaemonSupervisor.start`
  no longer inherits the parent process's stdout/stderr when spawning the
  Node daemon. Daemon lifecycle output (`[GICS] ...`, `[Supervisor] ...`)
  is now redirected to `<data_path>/logs/gics_daemon.log` by default. This
  unbreaks consumers that embed GICS inside MCP / LSP / JSON-RPC-over-stdio
  hosts, where any non-JSON byte on stdout corrupts the protocol stream.
  A new `log_path` keyword argument allows callers to override the destination
  (or pass `os.devnull` to silence the daemon entirely). The daemon's stdin
  is now also redirected to `DEVNULL` to prevent symmetric breakage if the
  daemon ever reads from stdin in the future.
  Reported by the GIMO team. See
  `docs/reports/2026-04-09_GICS_1_3_5_BUG_PYTHON_SDK_STDIO_POLLUTION.md`.

### Added

- Regression tests `tests/daemon-token-path.test.ts` (3 tests): CLI flag
  honoured, end-to-end put/scan with explicit token, and CLI > config
  precedence.
- Regression tests `clients/python/test_gics_client.py` (6 tests): stdio
  redirection, default log path under `data_path`, custom `log_path` override,
  log-dir creation, and fh cleanup on stop.
- `daemon start` help banner now documents `--token-path`.

---

## [1.3.4] - 2026-03-19

### Added

- Opened the dedicated development branch for the new iteration: `codex/1.3.4`.
- Added the active `1.3.4` documentation set:
  - `docs/ACTIVE_DOCS_v1_3_4.md`
  - `docs/DEPRECATIONS_v1_3_4.md`
  - `docs/PRODUCTION_PLAN_V1_3_4.md`
  - `docs/roadmaps/GICS_ROADMAP_v1_3_4.md`
  - `docs/API_v1_3_4.md`
  - `docs/releases/2026-03-19_GICS_v1_3_4_iteration_open.md`
  - `GICS_1_3_4_ARCHITECTURE.MD`
- Official package surface for `@gredinlabstechnologies/gics-core@1.3.4`.
- Official Node/TypeScript daemon client with retries, `putMany`, summaries, verify helpers, and strict types.
- Expanded official Python client with `put_many`, summaries, `ping_verbose`, inference seeding, and daemon supervision.
- Runtime primitives:
  - `putMany(records, atomic, idempotency_key, verify)`
  - `countPrefix(prefix, ...)`
  - `latestByPrefix(prefix, ...)`
  - `scanSummary(prefix, ...)`
- Inference seeding:
  - `seedProfile`
  - `seedPolicy`
- Runtime and inference telemetry with CLI access through `gics daemon telemetry`.
- Verification hardening regression coverage, including encrypted header checks and schema float-field coverage.
- `npm pack` now rebuilds from a clean `dist/` via `prepack`, avoiding stale tarball artifacts.

### Changed

- Bumped the working package version from `1.3.3` to `1.3.4`.
- Deprecated `1.3.3` and earlier planning documents for new implementation work.
- File-lock stale cleanup now preserves freshly created lock markers long enough to avoid deleting live locks during creation races.
- Updated top-level references so `1.3.4` is the active development line.
- Introduced `encMode=2` with IV derivation from `fileNonce + segmentOrdinal + streamId`.
- Encrypted append now rejects unsafe legacy append paths from `encMode=1`.
- `query()` and encrypted bootstrap now share the same header preparation path.
- `verify()` now validates encrypted metadata and payload readability, not only outer hashes.
- Public `GICS.verify(data, options?)` now forwards decoder options such as `password`.
- `delete()` is now durable as an atomic WAL batch with tombstone write.
- Daemon startup now holds a real cross-process lock for the active `dataPath`.
- `ping` is anonymous/minimal and `pingVerbose` is authenticated/detailed.
- Resilience shell now clears timers correctly, applies hysteresis, and caps half-open probes.
- Audit chain mutation paths are serialized.
- Generic schema encoding now routes floating numeric fields through float-safe codecs instead of integer-only codecs.
- Build packaging now cleans `dist/` before compilation so published tarballs cannot retain stale artifacts.

### Fixed

- Unknown codecs no longer degrade to empty data.
- Malformed DICT/FOR/FIXED64 payloads now raise explicit integrity errors.
- Encrypted/header parsing now rejects malformed KDF metadata and reserved-byte misuse.
- Strict verification now catches payload unreadability in addition to CRC/hash failures.
- Encrypted files correctly fail verification when no password is supplied.
- Mixed daemon insight/system snapshots with float fields no longer produce invalid `DICT_VARINT` payloads.
- `verify` passes again in the daemon soak path for both binary and `jsonl` WAL modes.

### Validation

- `npm.cmd run build`
- `npm.cmd test -- --run tests/gics-generic-roundtrip.test.ts tests/gics-verify-hardening.test.ts tests/gics-security-crypto.test.ts tests/gics-golden-corpus.test.ts tests/gics-v1.3-segments.test.ts tests/daemon-realworld-soak.test.ts`
- `npm.cmd pack --dry-run`

## [1.3.3] - 2026-03-18

### Added

- **StateIndex / current-state directory**: persistent visible-state index for daemon reads across `HOT`, `WARM` and `COLD`, including segment references, deletion status and latest materialized fields.
- **Durable tombstones**: `delete()` now persists deletion state so keys stay hidden across flush, compact, rotate and restart.
- **Hidden system namespaces**: reserved runtime prefixes for internal state:
  - `_sys|*`
  - `_insight|*`
  - `_infer|*`
- **Module registry runtime**: built-in modules now run through an explicit registry and lifecycle hooks instead of ad hoc daemon wiring.
- **Inference runtime artifacts**: persistent `_infer|profile|*`, `_infer|policy|*`, `_infer|decision|*` and `_infer|feedback|*` records.
- **Inference runtime health and flush control**: added `getInferenceRuntime` and `flushInference`.
- **Inference CLI surface**: added `gics inference infer|profile|recommendations|health|flush`.
- **Machine-readable automation surface**: added/extended JSON-oriented CLI paths such as `gics rpc ...`, `gics daemon status --json` and `gics module status --json`.
- **Python client inference methods**: added `infer()`, `get_profile()`, `get_recommendations()`, `get_inference_runtime()` and `flush_inference()`.
- **Release documentation pack**:
  - `docs/releases/2026-03-18_GICS_v1_3_3.md`
  - `docs/API_v1_3_3.md`
  - `docs/FAILURE_MODES_v1_3_3.md`

### Changed

- **Unified tier semantics**: `get()` and `scan()` now operate on current visible state across all tiers by default, instead of effectively privileging hot-only visibility in older daemon behavior.
- **Warm/cold point reads**: single-key resolution prefers selective decode paths instead of whole-archive decode where current metadata is available.
- **Scan contract**: `scan(prefix, options?)` now defaults to current-state behavior with hidden system keys excluded unless `includeSystem=true`.
- **Inference runtime persistence**: replaced per-event synchronous saves with batched persistence plus explicit durable flush.
- **Inference engine scope**: deterministic policies and ranking are now first-class runtime behavior for:
  - `compression.encode`
  - `ops.provider_select`
  - `ops.plan_rank`
  - `storage.policy`

### Fixed

- **Warm-scan visibility regression**: scans after flush/restart now see current visible state from persisted tiers via `StateIndex`.
- **Delete durability regression**: deleted keys no longer resurface after persistence boundaries because tombstones are stored durably.
- **Inference write amplification**: runtime no longer writes inference state to disk on every hook/event.
- **CLI automation gap**: daemon RPC usage from scripts now has a stable JSON-oriented path.
- **JSONL WAL race under load**: append/close/truncate interactions were serialized to avoid `write after end` under soak conditions.
- **StateIndex ordering hazard**: older records can no longer overwrite newer visible state during rebuild/replay ordering.
- **Module activation semantics**: `gics daemon start --modules ...` now behaves authoritatively instead of allowing unspecified modules to remain implicitly enabled.

### Validation

- Tests: `reports/vitest-junit.xml`
  - `284 tests`
  - `0 failures`
  - `0 errors`
- Benchmark references:
  - `bench/results/latest/empirical-report.md`
  - `bench/results/latest/validate-50x-report.md`
  - `bench/results/latest/empirical-security-report.md`
  - `bench/results/latest/long-horizon-report.md`

### Boundaries

- Embedded inference runtime is considered closed for the current dev cycle.
- Sidecar inference worker remains planned, not closed.
- Long-horizon support has benchmark evidence, but not a universal multi-year proof across all workloads.

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
