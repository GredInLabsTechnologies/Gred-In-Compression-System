# GICS — Deterministic Time-Series Compression

![Version](https://img.shields.io/badge/version-1.3.2-blue)
![Status](https://img.shields.io/badge/status-production-green)
![License](https://img.shields.io/badge/license-proprietary-red)

## What Is GICS?

**GICS** is a **deterministic, fail-closed, agnostic time-series compression engine** designed for critical infrastructure where **data integrity and auditability are paramount**.

- **Bit-exact lossless compression** for time-series data
- **Deterministic encoding** (same input + same config = same output bytes)
- **Fail-closed safety** (rejects corrupted/incomplete data, never returns partial results)
- **Domain-agnostic** (works with any monotonic time-series via Schema Profiles)
- **22x-42x compression** on structured data (vs 5x-11x with raw Zstd)
- **Zero ML, zero approximation** — pure algorithmic compression

---

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

### v1.3.2 Module Map

```
@gredinlabstechnologies/gics-core
├── Core Engine         Encode/decode with auto-codec selection
│   ├── Encoder         Streaming or batch, with segment assembly
│   ├── Decoder         Query by item ID, Bloom filter skip
│   ├── Codecs          DELTA, RLE, DELTA_RLE, HUFFMAN, RAW (trial-by-size)
│   ├── Segments        Indexed segments with SHA-256 integrity chain
│   └── Item-Major      Auto-transpose for multi-item data (+90% compression)
├── Daemon              Persistent process for continuous ingestion
│   ├── MemTable        In-memory buffer with auto-flush
│   ├── WAL             Write-ahead log for crash recovery
│   ├── IPC Server      JSON-RPC 2.0 over named pipe / Unix socket
│   └── File Lock       AsyncRWLock (in-process) + marker files (cross-process)
├── Insight Engine      Behavioral intelligence (zero ML)
│   ├── Tracker         Per-item velocity, entropy, volatility, streaks
│   ├── Correlation     Pearson pairwise + Union-Find clustering
│   └── Signals         Anomaly detection, trend forecasting, recommendations
└── Profiler            Encoder parameter optimizer (level × blockSize matrix)
```

### Item-Major Layout (v1.3.2)

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
| `ingest` | Add snapshots to MemTable (auto-flushes to segments) |
| `query` | Query by item ID with Bloom filter skip |
| `flush` | Force MemTable to disk as GICS segment |
| `compact` | Merge segments for better compression |
| `rotate` | Archive old segments (HOT → WARM → COLD) |
| `getInsights` | Behavioral metrics, correlations, anomalies |

### Python Client

```python
from gics_client import GICSClient

client = GICSClient(pipe_name="gics-prod")
client.connect()

client.ingest([{"timestamp": 1700000000, "items": {"1": {"price": 100, "quantity": 10}}}])
results = client.query(item_id=1)
insights = client.get_insights()
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

### Compression Ratios (v1.3.2 benchmarks)

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
npm test          # 188 tests (vitest)
npm run verify    # Integrity chain verification
npm run bench     # Full benchmark suite
npm run profile   # Encoder parameter profiler
```

### Test Coverage

| Module | Tests | Status |
|--------|-------|--------|
| Core encode/decode | 80+ | Stable |
| Segments & format | 20+ | Stable |
| Encryption | 10+ | Stable |
| Schema profiles | 15+ | Stable |
| Daemon (MemTable, WAL, IPC, lock) | 21 | Stable |
| Insight Engine | 15+ | Stable |
| Item-major layout | 5 | Stable |
| Profiler | 6 | Stable |
| Regression suite | 7 | Stable |
| Adversarial / fuzzing | 10+ | Stable |

---

## Safety Guarantees

| Invariant | Description |
|-----------|-------------|
| **Determinism** | Same input + same options = identical output bytes |
| **Lossless** | `unpack(pack(data)) === data` — exact roundtrip, zero precision loss |
| **Fail-closed** | Corrupt/truncated/tampered data always throws, never returns partial results |
| **Backward compatible** | v1.3.2 decoder reads v1.2 and v1.3.0 files |
| **Schema embedded** | Schema profile stored inside the file; decoder is self-describing |
| **Segment isolation** | Corruption in segment N does not affect segments N-1 or N+1 |
| **No external state** | No network calls, no filesystem reads during encode/decode |

---

## Documentation

- **[API Reference](./docs/API.md)** — Full public API with examples
- **[CHANGELOG](./CHANGELOG.md)** — Version history with detailed changes
- **[Format Spec](./docs/FORMAT.md)** — Binary format specification
- **[Security Model](./docs/SECURITY_MODEL.md)** — Threat model and encryption details
- **[Versioning](./docs/VERSIONING.md)** — Version matrix and archive pointers

---

## License

**Proprietary** — All rights reserved. GredIn Labs Technologies.

---

*v1.3.2 | 2026-02-12*
