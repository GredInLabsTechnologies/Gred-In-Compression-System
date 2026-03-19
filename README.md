# GICS - Deterministic Time-Series Compression

![Version](https://img.shields.io/badge/version-1.3.4-blue)
![Status](https://img.shields.io/badge/status-in_development-orange)
![License](https://img.shields.io/badge/license-proprietary-red)

> Iteration `1.3.4` is open on branch `codex/1.3.4`.
> This line is a new development cycle, not a hotfix continuation of `1.3.3`.

## What Is GICS?

GICS is a deterministic, fail-closed compression and storage runtime for time-series and operational state.

- Bit-exact lossless compression
- Deterministic encoding and verification
- Fail-closed decoding on corruption or malformed metadata
- Embedded schema profiles for generic records
- Daemon runtime with WAL, state index, and IPC
- Insight and inference modules without ML dependencies

## Documentation

Active `1.3.4` entry points:

- [docs/ACTIVE_DOCS_v1_3_4.md](./docs/ACTIVE_DOCS_v1_3_4.md)
- [docs/API_v1_3_4.md](./docs/API_v1_3_4.md)
- [docs/PRODUCTION_PLAN_V1_3_4.md](./docs/PRODUCTION_PLAN_V1_3_4.md)
- [docs/roadmaps/GICS_ROADMAP_v1_3_4.md](./docs/roadmaps/GICS_ROADMAP_v1_3_4.md)
- [CHANGELOG.md](./CHANGELOG.md)

Legacy planning docs from `1.3.3` remain archived for reference only.

## Installation

### GitHub Packages

```ini
# .npmrc
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

Runtime requirements: Node.js `>=18`.

## Package Surface

`1.3.4` publishes:

- Root export: core API, daemon runtime, insight engine, inference engine, and public types
- `@gredinlabstechnologies/gics-core/clients/node`: official Node/TypeScript daemon client
- `clients/python/gics_client.py`: official Python client module shipped inside the package

## Core Quick Start

```typescript
import { GICS } from '@gredinlabstechnologies/gics-core';

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

const packed = await GICS.pack(snapshots);
const restored = await GICS.unpack(packed);
const valid = await GICS.verify(packed);
```

Encrypted archives must be verified with the password in `1.3.4` because verification now checks encrypted metadata and payload readability:

```typescript
const encrypted = await GICS.pack(snapshots, { password: 'secret' });
const valid = await GICS.verify(encrypted, { password: 'secret' });
```

## Daemon Runtime

```typescript
import { GICSDaemon } from '@gredinlabstechnologies/gics-core';

const daemon = new GICSDaemon({
  socketPath: '/var/run/gics.sock',
  dataPath: '/var/lib/gics',
  tokenPath: '/var/lib/gics/gics.token',
});

await daemon.start();
```

Key `1.3.4` RPCs:

- `put`, `get`, `delete`, `scan`
- `putMany`
- `countPrefix`, `latestByPrefix`, `scanSummary`
- `flush`, `compact`, `rotate`, `verify`
- `infer`, `seedProfile`, `seedPolicy`
- `ping`, `pingVerbose`
- `getTelemetry`, `getTelemetryEvents`

Runtime notes:

- `delete()` is durable as an atomic WAL batch with tombstone write
- daemon startup holds a real cross-process lock for `dataPath`
- `ping` is anonymous/minimal
- `pingVerbose` is authenticated/detailed

## Official Node/TypeScript Client

```typescript
import { GICSNodeClient } from '@gredinlabstechnologies/gics-core/clients/node';

const client = new GICSNodeClient({
  socketPath: '/var/run/gics.sock',
  tokenPath: '/var/lib/gics/gics.token',
});

await client.putMany(
  [
    { key: 'sensor:1', fields: { temperature: 22.5, humidity: 65 } },
    { key: 'sensor:2', fields: { temperature: 21.9, humidity: 61 } },
  ],
  { atomic: true, idempotencyKey: 'batch-001', verify: true },
);

const summary = await client.scanSummary('sensor:');
const latest = await client.latestByPrefix('sensor:');
const verified = await client.verifyFile('/var/lib/gics/cold/cold-001.gics');
```

## Official Python Client

```python
from gics_client import GICSClient

with GICSClient() as client:
    client.put_many(
        [
            {"key": "sensor:1", "fields": {"temperature": 22.5, "humidity": 65}},
            {"key": "sensor:2", "fields": {"temperature": 21.9, "humidity": 61}},
        ],
        atomic=True,
        idempotency_key="batch-001",
        verify=True,
    )
    count = client.count_prefix("sensor:")
    latest = client.latest_by_prefix("sensor:")
    summary = client.scan_summary("sensor:")
    status = client.ping_verbose()
```

## Insight And Inference

Root exports include the embedded operational modules:

```typescript
import {
  InsightTracker,
  CorrelationAnalyzer,
  PredictiveSignals,
  GICSInferenceEngine,
} from '@gredinlabstechnologies/gics-core';
```

`1.3.4` also introduces explicit inference seeding through `seedProfile` and `seedPolicy`.

## Telemetry

`1.3.4` exposes low-cardinality runtime and inference telemetry:

- RPC latency, volume, and in-flight gauges
- WAL, memtable, and tier storage gauges
- verify/flush/compact/rotate counters and durations
- inference runtime and quality metrics
- structured telemetry events for rejected requests and degraded operations

CLI access:

```bash
gics daemon telemetry --json
```

## Safety Guarantees

- Determinism: same input and options produce identical bytes
- Lossless round-trip: `unpack(pack(data)) === data`
- Fail-closed decode: corrupted or malformed input throws
- Backward compatibility: `1.3.4` reads legacy `v1.2` and `v1.3.x` files
- Embedded schema: generic files remain self-describing
- Segment isolation: corruption in one segment does not silently leak into another

## Development Validation

Typical `1.3.4` validation commands:

```bash
npm run build
npm test
npm pack --dry-run
```

## License

Proprietary - All rights reserved. GredIn Labs Technologies.
