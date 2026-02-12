# GICS v1.3.2 API Reference

> Complete reference for consuming, integrating, and operating GICS.

---

## Table of Contents

1. [Installation](#installation)
2. [Core API](#core-api)
   - [GICS.pack()](#gicspack)
   - [GICS.unpack()](#gicsunpack)
   - [GICS.verify()](#gicsverify)
   - [GICS.Encoder (streaming)](#gicsencoder-streaming)
   - [GICS.Decoder (advanced)](#gicsdecoder-advanced)
   - [GICS.schemas](#gicsschemas)
3. [Compression Presets & Tuning](#compression-presets--tuning)
4. [CompressionProfiler](#compressionprofiler)
5. [Schema Profiles](#schema-profiles)
6. [Encryption](#encryption)
7. [Daemon API](#daemon-api)
8. [Insight Engine API](#insight-engine-api)
9. [Error Handling](#error-handling)
10. [Integration Patterns](#integration-patterns)
11. [Performance](#performance)
12. [Invariants & Guarantees](#invariants--guarantees)
13. [Exported Types](#exported-types)

---

## Installation

```ini
# .npmrc
@gredinlabstechnologies:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

```bash
npm install @gredinlabstechnologies/gics-core
```

**Runtime:** Node.js >= 18.0.0. Single dependency: `zstd-codec` (WASM). Fully offline.

---

## Core API

### GICS.pack()

Compresses an array of snapshots into a single GICS binary.

```typescript
GICS.pack(
  snapshots: Snapshot[],
  options?: EncoderOptions
): Promise<Uint8Array>
```

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `snapshots` | `Snapshot[]` | required | Array of time-series snapshots |
| `options.preset` | `'balanced' \| 'max_ratio' \| 'low_latency'` | `'balanced'` | Compression preset |
| `options.compressionLevel` | `number` (1-22) | 3 | Zstd compression level (overrides preset) |
| `options.blockSize` | `number` | 1000 | Items per block (overrides preset) |
| `options.password` | `string` | — | Enable AES-256-GCM encryption |
| `options.schema` | `SchemaProfile` | — | Custom field schema |
| `options.contextMode` | `'on' \| 'off'` | `'on'` | Dictionary context sharing |
| `options.segmentSizeLimit` | `number` | `1048576` | Bytes per segment |
| `options.probeInterval` | `number` | `4` | CHM probe frequency |
| `options.logger` | `Logger` | — | Route internal log messages |
| `options.sidecarWriter` | `Function` | — | Persist anomaly reports externally |

**Returns:** `Promise<Uint8Array>`

**Item-Major Layout:** If all snapshots contain the same items (same count, same IDs), GICS automatically transposes arrays to item-major order for better compression. This is transparent — no option needed.

---

### GICS.unpack()

Decompresses a GICS binary back into snapshots.

```typescript
GICS.unpack(
  data: Uint8Array,
  options?: DecoderOptions
): Promise<Snapshot[]>
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `data` | `Uint8Array` | required | GICS compressed binary |
| `options.password` | `string` | — | Password for encrypted files |
| `options.integrityMode` | `'strict' \| 'warn'` | `'strict'` | Hash chain verification mode |
| `options.logger` | `Logger` | — | Route warning messages |

**Throws:** `IntegrityError`, `IncompleteDataError`, `LimitExceededError`

---

### GICS.verify()

Verifies integrity (SHA-256 chain + CRC32) without decompressing payloads.

```typescript
GICS.verify(data: Uint8Array): Promise<boolean>
```

Returns `true` if all checks pass, `false` otherwise. Never throws.

---

### GICS.Encoder (streaming)

```typescript
const encoder = new GICS.Encoder({
  compressionLevel: 6,
  blockSize: 2000,
  password: 'optional',
});

await encoder.addSnapshot(snapshot1);
await encoder.addSnapshot(snapshot2);
const bytes = await encoder.finish();

// Telemetry
const stats = encoder.getTelemetry();
// { total_blocks, core_ratio, quarantine_rate, quarantine_blocks, blocks[] }
```

**File append mode:**

```typescript
import { open } from 'node:fs/promises';

const handle = await open('data.gics', 'r+');
const encoder = await GICS.Encoder.openFile(handle, { segmentSizeLimit: 2_000_000 });
await encoder.addSnapshot(newSnapshot);
await encoder.sealToFile();
await handle.close();
```

---

### GICS.Decoder (advanced)

```typescript
const decoder = new GICS.Decoder(data, { integrityMode: 'strict' });

// Full decode
const snapshots = await decoder.getAllSnapshots();

// Query by item ID (Bloom filter skip)
const item42 = await decoder.query(42);

// Generic decode (schema-based)
const generic = await decoder.getAllGenericSnapshots();

// Query by string key
const results = await decoder.queryGeneric('sensor_rack_03');

// Inspect schema
await decoder.parseHeader();
const schema = decoder.getSchema();
```

---

### GICS.schemas

Predefined schema profiles.

```typescript
GICS.schemas.MARKET_DATA   // price (value) + quantity (structural)
GICS.schemas.TRUST_EVENTS  // score, approvals, rejections, outcome (categorical)
```

---

## Compression Presets & Tuning

| Preset | `compressionLevel` | `blockSize` | Ratio | Speed |
|--------|-------------------|-------------|-------|-------|
| `balanced` | 3 | 1000 | Good | Fast |
| `max_ratio` | 9 | 4000 | Best | Slower |
| `low_latency` | 1 | 512 | Lower | Fastest |

```typescript
// Use a preset
await GICS.pack(data, { preset: 'max_ratio' });

// Or tune manually (overrides preset)
await GICS.pack(data, { compressionLevel: 12, blockSize: 2000 });
```

Use `CompressionProfiler` to find optimal parameters for your data.

---

## CompressionProfiler

Benchmarks encoder across a `compressionLevel x blockSize` matrix.

```typescript
import { CompressionProfiler } from '@gredinlabstechnologies/gics-core';

const result = await CompressionProfiler.profile(sampleSnapshots, 'quick');
```

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `sample` | `Snapshot[]` | required | Data sample (recommended: 200-5000) |
| `mode` | `'quick' \| 'deep'` | `'quick'` | Quick: 6 trials. Deep: 30 trials |
| `baseOptions` | `Omit<EncoderOptions, ...>` | `{}` | Base encoder options |

**Returns:** `ProfileResult`

```typescript
interface ProfileResult {
  compressionLevel: number;    // Recommended level
  blockSize: number;           // Recommended block size
  preset: string | null;       // Matching preset name, or null
  bestRatio: number;           // Best compression ratio achieved
  bestEncodeMs: number;        // Encode time for best config
  trials: TrialResult[];       // All trial results
  meta: ProfileMeta;           // Reproducibility metadata (hash, date, mode)
}
```

**CLI:**

```bash
npm run profile                              # quick, 500 snapshots, 10 items
npm run profile -- --mode deep               # exhaustive (30 trials)
npm run profile -- --snapshots 1000 --items 20
```

---

## Schema Profiles

Make GICS generic for any structured time-series.

```typescript
const sensorSchema: SchemaProfile = {
  id: 'iot_sensors_v1',
  version: 1,
  itemIdType: 'string',
  fields: [
    { name: 'temperature', type: 'numeric', codecStrategy: 'value' },
    { name: 'humidity', type: 'numeric', codecStrategy: 'value' },
    { name: 'status', type: 'categorical', enumMap: { ok: 0, warn: 1, critical: 2 } },
  ],
};

const compressed = await GICS.pack(snapshots, { schema: sensorSchema });
```

**Categorical fields** map strings to compact codes. The `enumMap` is embedded in the file.

**String item IDs** build a per-segment String Dictionary (delta-length-encoded, queryable via dictionary lookup + Bloom filter).

---

## Encryption

AES-256-GCM with PBKDF2 key derivation.

```typescript
const encrypted = await GICS.pack(snapshots, { password: 'my-secret' });
const restored = await GICS.unpack(encrypted, { password: 'my-secret' });
```

- KDF: PBKDF2-HMAC-SHA256, 100,000 iterations
- Unique 16-byte salt + 12-byte nonce per file
- Each stream section encrypted independently with deterministic IV
- Wrong password throws `IntegrityError` immediately (fail-closed)

See [SECURITY_MODEL.md](./SECURITY_MODEL.md) for full threat model.

---

## Daemon API

Persistent process for continuous ingestion, query, and tier management.

```typescript
import { GICSDaemon } from '@gredinlabstechnologies/gics-core/daemon';

const daemon = new GICSDaemon({
  dataDir: './data',
  pipeName: 'gics-prod',        // named pipe (Win) or socket path (Unix)
  flushThreshold: 1000,          // auto-flush after N snapshots
  compactThreshold: 10,          // auto-compact after N segments
  enableInsights: true,          // activate Insight Engine
});

await daemon.start();
```

### IPC Methods (JSON-RPC 2.0)

| Method | Params | Returns | Description |
|--------|--------|---------|-------------|
| `ingest` | `{ snapshots }` | `{ count }` | Add snapshots to MemTable |
| `query` | `{ itemId }` | `{ snapshots }` | Query by item ID |
| `flush` | — | `{ segmentPath }` | Force MemTable to disk |
| `compact` | — | `{ before, after }` | Merge segments |
| `rotate` | `{ maxAge? }` | `{ moved }` | HOT -> WARM -> COLD |
| `getInsights` | `{ itemId? }` | `{ behavioral, correlations, signals }` | Insight Engine results |
| `status` | — | `{ memtableSize, segments, uptime }` | Daemon health |
| `shutdown` | — | — | Graceful stop |

### WAL (Write-Ahead Log)

All ingested data is durably written to WAL before acknowledging. On crash/restart, the daemon replays the WAL to reconstruct the MemTable. Binary format for minimal overhead.

### File Locking

- **In-process**: `AsyncRWLock` — FIFO, write-preferring, zero syscalls
- **Cross-process**: Marker-file based shared/exclusive locks

```typescript
import { FileLock } from '@gredinlabstechnologies/gics-core/daemon';

await FileLock.withExclusiveLock('/path/to/file', async () => {
  // exclusive access
});

await FileLock.withSharedLock('/path/to/file', async () => {
  // concurrent read access
});
```

---

## Insight Engine API

Pure incremental statistics. No ML, no external dependencies.

### InsightTracker

Per-item behavioral metrics updated incrementally (O(1) per sample).

```typescript
import { InsightTracker } from '@gredinlabstechnologies/gics-core/insight';

const tracker = new InsightTracker();
tracker.observe(itemId, { price: 100, quantity: 50 }, timestamp);

const metrics = tracker.getMetrics(itemId);
// { velocity, entropy, volatility, streaks, fieldTrends, lifecycle }
```

| Metric | Algorithm | Description |
|--------|-----------|-------------|
| `velocity` | Delta / time | Rate of change |
| `entropy` | Shannon entropy | Randomness of recent values |
| `volatility` | Welford variance | Dispersion measure |
| `streaks` | Run counting | Consecutive same-direction moves |
| `lifecycle` | State machine | new -> active -> stable -> declining |

### CorrelationAnalyzer

Cross-item relationship detection.

```typescript
import { CorrelationAnalyzer } from '@gredinlabstechnologies/gics-core/insight';

const analyzer = new CorrelationAnalyzer();
analyzer.observe(itemId, value, timestamp);

const correlations = analyzer.getCorrelations(itemId);
// [{ itemA, itemB, pearson, lag }]

const clusters = analyzer.getClusters();
// [{ items: [1, 3, 7], centroid }]

const leaders = analyzer.getLeadingIndicators(itemId);
// [{ leaderId, lag, correlation }]
```

### PredictiveSignals

Anomaly detection and trend forecasting.

```typescript
import { PredictiveSignals } from '@gredinlabstechnologies/gics-core/insight';

const signals = new PredictiveSignals();
signals.observe(itemId, value, timestamp);

const anomalies = signals.getAnomalies(itemId);
// [{ timestamp, value, zScore, severity }]

const forecast = signals.getForecast(itemId);
// { nextValue, confidence, trend }

const recommendations = signals.getRecommendations(itemId);
// [{ action: 'raise_compression', reason: 'stability_high', confidence }]
```

---

## Error Handling

```
GicsError (base)
├── IntegrityError          — Corruption, hash mismatch, wrong password
│   └── IncompleteDataError — Truncated file, missing EOS
└── LimitExceededError      — Decompression bomb (>64MB section)
```

```typescript
import { IntegrityError, IncompleteDataError } from '@gredinlabstechnologies/gics-core';

try {
  const snapshots = await GICS.unpack(data, { password });
} catch (err) {
  if (err instanceof IncompleteDataError) {
    // Truncated — re-download or discard
  } else if (err instanceof IntegrityError) {
    // Corruption or wrong password — reject
  }
}
```

| Scenario | Error | Recovery |
|----------|-------|----------|
| File truncated | `IncompleteDataError` | Re-encode from source |
| Bit flip in storage | `IntegrityError` | Restore from backup |
| Wrong password | `IntegrityError` | Prompt for correct password |
| Decompression bomb | `LimitExceededError` | Reject file |

**GICS is fail-closed.** It never silently returns partial or wrong data.

---

## Integration Patterns

### Node.js Service

```typescript
import { GICS } from '@gredinlabstechnologies/gics-core';
import { readFile, writeFile } from 'node:fs/promises';

const binary = await GICS.pack(snapshots, { preset: 'max_ratio' });
await writeFile('data.gics', binary);

const restored = await GICS.unpack(new Uint8Array(await readFile('data.gics')));
```

### Streaming / Append Mode

```typescript
import { open } from 'node:fs/promises';

const handle = await open('timeseries.gics', 'w+');
const encoder = await GICS.Encoder.openFile(handle);

setInterval(async () => {
  await encoder.addSnapshot(collectSnapshot());
  await encoder.flush();
}, 60_000);

process.on('SIGTERM', async () => {
  await encoder.sealToFile();
  await handle.close();
});
```

### Query by Item ID

```typescript
const decoder = new GICS.Decoder(data);
const item42 = await decoder.query(42);           // numeric ID
const sensor = await decoder.queryGeneric('rack3'); // string ID (schema mode)
// Segments without the item are skipped via Bloom filter
```

---

## Performance

### Compression Ratios (v1.3.2)

| Dataset | GICS | Zstd Baseline | Multiplier |
|---------|------|---------------|------------|
| Trending (single-item) | 29.5x | 5.1x | 5.8x |
| Volatile (single-item) | 21.9x | 4.1x | 5.3x |
| Multi-item (10 items) | 41.8x | 11.3x | 3.7x |

### Throughput

| Operation | Rate |
|-----------|------|
| Encode | ~50,000 snapshots/sec |
| Decode | ~80,000 snapshots/sec |
| Verify | ~200,000 snapshots/sec |
| Memory | O(segment_size), default 1MB |

---

## Invariants & Guarantees

| Invariant | Description |
|-----------|-------------|
| **Determinism** | Same input + same options = identical output bytes |
| **Lossless** | `unpack(pack(data)) === data` — exact roundtrip |
| **Fail-closed** | Corrupt data always throws, never returns partial results |
| **Backward compatible** | v1.3.2 reads v1.2 and v1.3.0 files |
| **Schema embedded** | Decoder is self-describing |
| **Segment isolation** | Corruption in segment N doesn't affect N-1 or N+1 |
| **No external state** | No network, no filesystem during encode/decode |

---

## Exported Types

```typescript
// Core
export type { Snapshot }            // { timestamp, items: Map<number, { price, quantity }> }
export type { GenericSnapshot }     // { timestamp, items: Map<string|number, Record<string, number|string>> }

// Schema
export type { SchemaProfile }       // { id, version, itemIdType, fields }
export type { FieldDef }            // { name, type, codecStrategy?, enumMap? }

// Options
export type { GICSv2EncoderOptions }  // { preset?, compressionLevel?, blockSize?, password?, schema?, ... }
export type { CompressionPreset }     // 'balanced' | 'max_ratio' | 'low_latency'

// Profiler
export { CompressionProfiler }
export type { ProfileResult, ProfileMode, TrialResult, ProfileMeta }

// Errors
export { IntegrityError, IncompleteDataError }

// Presets
export { COMPRESSION_PRESETS }       // Record<CompressionPreset, { compressionLevel, blockSize }>
```

---

*Document version: 1.3.2 | Last updated: 2026-02-12*
