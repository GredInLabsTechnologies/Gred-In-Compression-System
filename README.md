# GICS — Deterministic Time-Series Compression

![Version](https://img.shields.io/badge/version-1.3.4-blue)
![Status](https://img.shields.io/badge/status-in_development-orange)
![License](https://img.shields.io/badge/license-proprietary-red)

> Iteration `1.3.4` is open on branch `codex/1.3.4`.
> This line is a new development cycle, not a hotfix continuation of `1.3.3`.
> Planning and documentation are reset for `1.3.4`; previous-cycle docs are legacy unless explicitly carried forward.

## What Is GICS?

**GICS** is a **deterministic, fail-closed, agnostic time-series compression engine** designed for critical infrastructure where **data integrity and auditability are paramount**.

- **Bit-exact lossless compression** for time-series data
- **Deterministic encoding** (same input + same config = same output bytes)
- **Fail-closed safety** (rejects corrupted/incomplete data, never returns partial results)
- **Domain-agnostic** (works with any monotonic time-series via Schema Profiles)
- **High-ratio compression on structured workloads** with current benchmark references documented in `BENCHMARKS-RESULTS.md`
- **Zero ML, zero approximation** — pure algorithmic compression

---

## Documentation

Primary `1.3.4` planning references:
`docs/ACTIVE_DOCS_v1_3_4.md`, `docs/DEPRECATIONS_v1_3_4.md`, `docs/PRODUCTION_PLAN_V1_3_4.md`, `docs/roadmaps/GICS_ROADMAP_v1_3_4.md`, `docs/API_v1_3_4.md`

- **[API Reference (v1.3.3)](./docs/API_v1_3_3.md)** — Full public API, daemon RPC, inference, CLI
- **[Failure Modes](./docs/FAILURE_MODES_v1_3_3.md)** — Recoverability and error semantics
- **[Binary Format](./docs/FORMAT.md)** — Wire format specification
- **[Security Model](./docs/SECURITY_MODEL.md)** — Encryption, integrity, threat model
- **[Benchmarks](./BENCHMARKS-RESULTS.md)** — Compression ratios and throughput
- **[CHANGELOG](./CHANGELOG.md)** — Version history

---

Active `1.3.4` planning set:
`docs/ACTIVE_DOCS_v1_3_4.md`, `docs/DEPRECATIONS_v1_3_4.md`, `docs/PRODUCTION_PLAN_V1_3_4.md`, `docs/roadmaps/GICS_ROADMAP_v1_3_4.md`, `docs/API_v1_3_4.md`

## Installation

### GitHub Packages (organization scope)

```ini
# .npmrc in your consuming project
@gredinlabstechnologies:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

```bash
npm install @gredinlabstechnologies/gics-core
```

### From source

```bash
git clone https://github.com/GredInLabsTechnologies/Gred-In-Compression-System.git
cd Gred-In-Compression-System
npm install
npm run build
```

**Runtime requirements:** Node.js >= 18.0.0. Single dependency: `zstd-codec` (WASM). No native compilation. Fully offline.

---

## Quick Start

```typescript
import { GICS } from '@gredinlabstechnologies/gics-core';

// Create snapshots
const snapshots = [
  {
    timestamp: 1700000000,
    items: new Map([
      [1, { price: 15000, quantity: 100 }],
      [2, { price: 8500, quantity: 250 }],
    ]),
  },
  {
    timestamp: 1700000060,
    items: new Map([
      [1, { price: 15010, quantity: 98 }],
      [2, { price: 8495, quantity: 260 }],
    ]),
  },
];

// Compress
const compressed = await GICS.pack(snapshots);

// Decompress
const restored = await GICS.unpack(compressed);

// Verify integrity without decompressing
const isValid = await GICS.verify(compressed);
```

### With Compression Presets

```typescript
// High compression
const binary = await GICS.pack(snapshots, { preset: 'max_ratio' });

// Low latency
const binary = await GICS.pack(snapshots, { preset: 'low_latency' });

// Manual tuning
const binary = await GICS.pack(snapshots, {
  compressionLevel: 9,
  blockSize: 4000,
});
```

| Preset | Level | Block Size | Use Case |
|--------|-------|------------|----------|
| `balanced` | 3 | 1000 | Default. Good ratio and speed |
| `max_ratio` | 9 | 4000 | Maximum compression, slower |
| `low_latency` | 1 | 512 | Fastest encode, lower ratio |

### With Encryption

```typescript
const encrypted = await GICS.pack(snapshots, { password: 'secret' });
const restored = await GICS.unpack(encrypted, { password: 'secret' });
```

---

## Architecture

### v1.3.4 Working Baseline

```
@gredinlabstechnologies/gics-core
├── Core Engine         Encode/decode with auto-codec selection
│   ├── Encoder         Streaming or batch, with segment assembly
│   ├── Decoder         Query by item ID, Bloom filter skip
│   ├── Codecs          Varint, RLE, Bitpack, XOR Float, Fixed64 (trial-by-size)
│   ├── Segments        Indexed segments with SHA-256 integrity chain
│   └── Item-Major      Auto-transpose for multi-item data (+90% compression)
├── Daemon              Persistent process for continuous ingestion
│   ├── MemTable        In-memory buffer with auto-flush
│   ├── WAL             Binary write-ahead log for crash recovery
│   ├── StateIndex      Durable key→tier index with tombstone support
│   ├── IPC Server      JSON-RPC 2.0 over named pipe / Unix socket
│   ├── File Lock       AsyncRWLock (in-process) + marker files (cross-process)
│   └── Module Registry Pluggable lifecycle hooks (onPut/onFlush/onScan)
├── Insight Engine      Behavioral intelligence (zero ML)
│   ├── Tracker         Per-item velocity, entropy, volatility, streaks
│   ├── Correlation     Pearson pairwise + Union-Find clustering
│   └── Signals         Anomaly detection, trend forecasting, recommendations
├── Inference Engine    Deterministic decision ranking
│   ├── Domains         compression.encode, ops.provider_select, ops.plan_rank
│   ├── Profile Store   Durable learned profiles
│   └── Feedback Loop   Outcome tracking → policy refinement
├── CLI                 gics encode|decode|verify|bench|profile|daemon|inference|rpc
└── Profiler            Encoder parameter optimizer (level × blockSize matrix)
```

### Item-Major Layout

When all snapshots contain the same items, GICS automatically transposes data from snapshot-major to item-major order before compression. This groups each item's values contiguously, producing dramatically better deltas.

| Dataset | Without | With | Improvement |
|---------|---------|------|-------------|
| 10 items × 500 snapshots | 22x | 42x | +90% |
| 20 items × 500 snapshots | 20x | 41x | +101% |

Single-item data is unaffected. The decision is binary and deterministic.

### Dual-Stream Design

```
[ DATA SOURCE ]
      |
[ Entropy Gate ]
    /       \
 CORE    QUARANTINE
  |           |
 High      Fallback
Compress    (1:1)
  |           |
[ Combined Output ]
```

- **CORE**: Predictable data with high compression
- **QUARANTINE**: Volatile/high-entropy data preserved as-is (CHM decides)

---

## Daemon Mode

For long-running services that continuously ingest time-series data.

```typescript
import { GICSDaemon } from '@gredinlabstechnologies/gics-core/daemon';

const daemon = new GICSDaemon({
  dataDir: '/var/lib/gics',
  pipeName: 'gics-prod',
});

await daemon.start();
// Now accepts JSON-RPC 2.0 over IPC:
// ingest, query, flush, compact, rotate, getInsights
```

### IPC Protocol

| Method | Description |
|--------|-------------|
| `put` | Write/update a key with fields |
| `get` | Read latest visible state for a key |
| `delete` | Durable tombstone delete |
| `scan` | Prefix scan over current visible state |
| `flush` | Force MemTable to disk as GICS segment |
| `compact` | Merge/deduplicate warm segments |
| `rotate` | Archive WARM → COLD (with optional encryption) |
| `verify` | Verify WARM/COLD artifact integrity |
| `infer` | Inference engine ranked decision |
| `getInsights` | Behavioral metrics, correlations, anomalies |

### Python Client

```python
from gics_client import GICSClient

with GICSClient() as client:
    client.put("sensor:1", {"temperature": 22.5, "humidity": 65})
    record = client.get("sensor:1")
    items = client.scan("sensor:")
    client.flush()
```

---

## Insight Engine

Pure incremental statistics — no ML, no external dependencies.

| Module | Algorithm | What It Detects |
|--------|-----------|-----------------|
| **Tracker** | Welford variance, Shannon entropy | Velocity, volatility, lifecycle stage per item |
| **Correlation** | Pearson + Union-Find | Co-moving items, clusters, leading indicators |
| **Signals** | Z-score, EMA forecast | Anomalies, trend changes, compression recommendations |

```typescript
import { InsightTracker, CorrelationAnalyzer, PredictiveSignals } from '@gredinlabstechnologies/gics-core/insight';
```

---

## Compression Profiler

Discovers optimal encoder parameters for your data.

```bash
# CLI
npm run profile
npm run profile -- --mode deep --snapshots 1000 --items 20
```

```typescript
import { CompressionProfiler } from '@gredinlabstechnologies/gics-core';

const result = await CompressionProfiler.profile(sampleSnapshots, 'quick');
// result.compressionLevel, result.blockSize, result.bestRatio, result.preset
```

---

## Performance

### Compression Ratios

| Dataset | GICS | Zstd Baseline | Multiplier |
|---------|------|---------------|------------|
| Trending integer (single-item) | 29.5x | 5.1x | 5.8x better |
| Volatile integer (single-item) | 21.9x | 4.1x | 5.3x better |
| Multi-item (10 items, stable) | 41.8x | 11.3x | 3.7x better |
| Multi-item append (5x volume) | 40.5x | — | — |

### Throughput

| Operation | Typical |
|-----------|---------|
| Encode | ~50,000 snapshots/sec |
| Decode | ~80,000 snapshots/sec |
| Verify (no decompress) | ~200,000 snapshots/sec |
| Memory | O(segment_size), default 1MB |

---

## Testing & Verification

```bash
npm test          # 284 tests (vitest)
npm run verify    # Integrity chain verification
npm run bench     # Full benchmark suite
npm run profile   # Encoder parameter profiler
```

### Test Coverage

| Module | Tests | Status |
|--------|-------|--------|
| Core encode/decode | 80+ | Stable |
| Segments & format | 20+ | Stable |
| Encryption & security | 10+ | Stable |
| Schema profiles | 15+ | Stable |
| Daemon (MemTable, WAL, IPC, supervisor, recovery) | 40+ | Stable |
| Insight Engine | 15+ | Stable |
| Inference Engine | 10+ | Stable |
| Item-major layout | 5 | Stable |
| Profiler | 6 | Stable |
| Regression suite | 7 | Stable |
| Adversarial / forensics | 10+ | Stable |

---

## Safety Guarantees

| Invariant | Description |
|-----------|-------------|
| **Determinism** | Same input + same options = identical output bytes |
| **Lossless** | `unpack(pack(data)) === data` — exact roundtrip, zero precision loss |
| **Fail-closed** | Corrupt/truncated/tampered data always throws, never returns partial results |
| **Backward compatible** | v1.3.3 decoder reads v1.2, v1.3.0, and v1.3.2 files |
| **Schema embedded** | Schema profile stored inside the file; decoder is self-describing |
| **Segment isolation** | Corruption in segment N does not affect segments N-1 or N+1 |
| **No external state** | No network calls, no filesystem reads during encode/decode |

---

## Documentation Index

Active `1.3.4` entry point: `docs/ACTIVE_DOCS_v1_3_4.md`

- **[API Reference (v1.3.3)](./docs/API_v1_3_3.md)** — Full API, daemon RPC, inference, CLI
- **[CHANGELOG](./CHANGELOG.md)** — Version history with detailed changes
- **[Format Spec](./docs/FORMAT.md)** — Binary format specification
- **[Security Model](./docs/SECURITY_MODEL.md)** — Threat model and encryption details
- **[Versioning](./docs/VERSIONING.md)** — Version matrix and archive pointers
- **[Repo Layout](./docs/REPO_LAYOUT.md)** — Project structure overview

---

## License

**Proprietary** — All rights reserved. GredIn Labs Technologies.

---

*v1.3.4 in development | 2026-03-19*
