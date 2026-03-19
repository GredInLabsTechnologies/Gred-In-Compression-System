# Repository Layout

> Project structure overview for the GICS core repository (v1.3.3).

---

## Directory Structure

```
/
├── src/                    # Production source code
│   ├── gics/               # Core v1.3 compression engine
│   │   ├── encode.ts       # Encoder (legacy + schema paths)
│   │   ├── decode.ts       # Decoder (legacy + schema + query)
│   │   ├── format.ts       # Binary format constants and enums
│   │   ├── codecs.ts       # Inner codecs (Varint, RLE, Bitpack, XOR Float, Fixed64)
│   │   ├── context.ts      # Coding context (dictionary, state snapshot/restore)
│   │   ├── chm.ts          # Compression Health Monitor (anomaly detection)
│   │   ├── metrics.ts      # Block metrics calculation + regime classification
│   │   ├── segment.ts      # Segment, SegmentIndex, BloomFilter, SegmentBuilder
│   │   ├── stream-section.ts # StreamSection serialization
│   │   ├── string-dict.ts  # String dictionary for schema string IDs
│   │   ├── integrity.ts    # SHA-256 hash chain + CRC32
│   │   ├── encryption.ts   # AES-256-GCM encryption/decryption
│   │   ├── outer-codecs.ts # Zstd compression wrapper
│   │   ├── field-math.ts   # Delta/DOD computation for time and value streams
│   │   ├── profiler.ts     # Compression parameter optimizer
│   │   ├── rotating-encoder.ts # Session-based rotating encoder
│   │   ├── errors.ts       # Error hierarchy (IntegrityError, etc.)
│   │   └── types.ts        # Encoder/Decoder option types
│   ├── daemon/             # Persistent daemon process
│   │   ├── server.ts       # GICSDaemon with IPC, MemTable, WAL, flush/compact/rotate
│   │   ├── memtable.ts     # In-memory key-value buffer
│   │   ├── wal.ts          # Binary write-ahead log
│   │   ├── state-index.ts  # Durable key→tier index with tombstone support
│   │   ├── file-lock.ts    # AsyncRWLock + cross-process file locks
│   │   ├── module-registry.ts # Pluggable module lifecycle
│   │   ├── config.ts       # Daemon configuration resolution
│   │   └── supervisor.ts   # Health monitoring and circuit breaker
│   ├── inference/          # Inference engine
│   │   ├── inference-engine.ts # Deterministic decision ranking
│   │   ├── inference-module.ts # Daemon module adapter
│   │   └── inference-state-store.ts # Durable profile/policy store
│   ├── insight/            # Insight engine
│   │   ├── tracker.ts      # Per-item behavioral metrics
│   │   ├── correlation.ts  # Pearson pairwise + Union-Find clustering
│   │   ├── signals.ts      # Anomaly detection, forecasting
│   │   └── confidence.ts   # Accuracy tracking
│   ├── cli/                # CLI commands
│   │   ├── commands.ts     # encode, decode, verify, bench, daemon, inference, rpc
│   │   ├── ui.ts           # ANSI formatting, tables, spinners
│   │   └── index.ts        # CLI entry point
│   ├── gics-types.ts       # Global type definitions (Snapshot, SchemaProfile, etc.)
│   ├── gics-utils.ts       # Low-level varint/RLE utilities
│   └── index.ts            # Public API (GICS namespace + exports)
│
├── clients/                # Language clients
│   └── python/
│       └── gics_client.py  # Zero-dependency Python client (sync + async)
│
├── tests/                  # Vitest test suites (284 tests)
│   ├── gics-*.test.ts      # Unit/Integration tests
│   ├── daemon-*.test.ts    # Daemon tests (WAL, memtable, recovery, resilience)
│   ├── inference-*.test.ts # Inference engine tests
│   ├── insight-*.test.ts   # Insight engine tests
│   ├── regression/         # Regression tests (EOS, integrity, truncation)
│   ├── fixtures/golden/    # Golden corpus (.gics + .expected.json)
│   └── helpers/            # Test utilities
│
├── bench/                  # Performance benchmarks
│   ├── scripts/            # Harness, datasets, report generation
│   ├── forensics/          # Determinism verification pipeline
│   └── results/            # Benchmark run artifacts
│
├── tools/                  # Development utilities
│   ├── golden/             # Golden corpus generator
│   └── verify/             # Standalone integrity verifier
│
├── docs/                   # Documentation
│   ├── API_v1_3_3.md       # Public API reference (v1.3.3)
│   ├── FORMAT.md           # Binary wire format specification
│   ├── SECURITY_MODEL.md   # Encryption, integrity, threat model
│   ├── FAILURE_MODES_v1_3_3.md # Error semantics and recoverability
│   ├── VERSIONING.md       # Version history and archive pointers
│   ├── REPO_LAYOUT.md      # This file
│   └── ARCHIVE_POINTERS.md # Checksums for archived versions
│
├── .github/workflows/      # CI: build, test, publish
├── package.json            # npm config + scripts
├── tsconfig.json           # TypeScript config
├── vitest.config.ts        # Test runner config
├── eslint.config.js        # ESLint + SonarJS config
└── sonar-project.properties # SonarCloud config
```

---

## NPM Scripts

| Script | Command | Purpose |
|--------|---------|---------|
| `build` | `tsc` | Compile TypeScript to `dist/` |
| `test` | `vitest run` | Run 284 automated tests |
| `bench` | `tsx bench/scripts/harness.ts && ...` | Performance benchmarks |
| `bench:forensics` | `tsx bench/forensics/...` | Determinism verification harness |
| `verify` | `tsx tools/verify/verify.ts` | Standalone integrity check |
| `lint` | `eslint src/**/*.ts` | ESLint + SonarJS code quality |
| `sonar` | `sonar-scanner` | SonarCloud analysis |

---

## Related Repositories

| Repository | Purpose |
|------------|---------|
| **GICS-ARCHIVE** | Historical versions (v1.1, v1.2) + legacy code from v1.3 sanitization |

---

*Document version: 1.3.3 | Updated: 2026-03-19*
