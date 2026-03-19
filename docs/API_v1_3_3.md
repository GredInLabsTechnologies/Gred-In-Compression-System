# GICS v1.3.3 API Reference

> Deprecated for new implementation work as of `1.3.4`.
> Keep this file as historical release reference only.
> The active API baseline for the new iteration is `docs/API_v1_3_4.md`.

This is the API reference for `v1.3.3`.

It covers:

- public library API
- daemon RPC API
- inference runtime API
- CLI automation surface
- operational error semantics

For detailed failure behavior and recovery guidance, pair this file with:

`docs/FAILURE_MODES_v1_3_3_PRE_RELEASE.md`

## 1. Package Surface

Primary package:

`@gredinlabstechnologies/gics-core`

Primary exports in `v1.3.3-pre` include:

- `GICS`
- `GICSDaemon`
- `StateIndex`
- `ModuleRegistry`
- `GICSInferenceEngine`
- `InferenceEngineModule`
- `InferenceStateStore`

## 2. Core Compression API

### `GICS.pack(snapshots, options?)`

Purpose:

- compress snapshots into GICS binary format

Returns:

- `Promise<Uint8Array>`

### `GICS.unpack(data, options?)`

Purpose:

- restore compressed archive into snapshots

Returns:

- `Promise<Snapshot[]>`

### `GICS.verify(data)`

Purpose:

- verify integrity without full decode

Returns:

- `Promise<boolean>`

### `GICS.readSession(manifestPath, options?)`

Purpose:

- read rotated session manifests

### `GICS.verifySession(manifestPath, options?)`

Purpose:

- verify rotated sessions without full decode

## 3. Daemon Construction API

### `new GICSDaemon(config)`

Key fields in `v1.3.3-pre`:

| Field | Purpose |
|---|---|
| `socketPath` | named pipe / unix socket path |
| `dataPath` | daemon data directory |
| `tokenPath` | auth token path |
| `walType` | `binary` or `jsonl` |
| `walFsyncMode` | fsync policy |
| `walFsyncOnCommit` | stronger durability mode |
| `walCheckpointEveryOps` | checkpoint cadence |
| `walCheckpointEveryMs` | checkpoint cadence by time |
| `walMaxSizeMB` | WAL size control |
| `maxMemSizeBytes` | memtable threshold |
| `maxDirtyCount` | memtable dirty threshold |
| `warmRetentionMs` | warm retention policy |
| `coldRetentionMs` | cold retention policy |
| `coldEncryption` | encrypt cold archives |
| `coldPasswordEnvVar` | password env var for cold encryption |
| `modules` | runtime module config map |
| `defaultProfileScope` | default inference/insight scope |

## 4. Daemon RPC Surface

GICS daemon speaks JSON-RPC 2.0 over named pipe or unix socket.

### 4.1 Core data methods

| Method | Purpose |
|---|---|
| `put` | write/update a key |
| `get` | read latest visible state for a key |
| `delete` | durable tombstone delete |
| `scan` | prefix scan over current visible state |
| `flush` | flush HOT to WARM |
| `compact` | merge/deduplicate warm segments |
| `rotate` | move eligible WARM to COLD |
| `verify` | verify WARM/COLD artifacts |

### 4.2 Observability and runtime methods

| Method | Purpose |
|---|---|
| `ping` | quick runtime status |
| `getStatus` | supervisor/runtime state |
| `getHealth` | comprehensive health payload |
| `resetDegraded` | attempt supervisor recovery |
| `subscribe` | event subscription |
| `unsubscribe` | remove subscription |

### 4.3 Native insight methods

| Method | Purpose |
|---|---|
| `getInsight` | per-key behavioral state |
| `getInsights` | list/filter tracked insights |
| `getAccuracy` | confidence metrics |
| `getCorrelations` | correlation graph view |
| `getClusters` | cluster view |
| `getLeadingIndicators` | lagged indicator view |
| `getSeasonalPatterns` | seasonal view |
| `getForecast` | forecast view |
| `getAnomalies` | anomaly feed |
| `getRecommendations` | native + module recommendations |
| `reportOutcome` | register outcome/feedback |

### 4.4 Inference methods

| Method | Purpose |
|---|---|
| `infer` | produce ranked inference decision |
| `getProfile` | fetch current inference profile |
| `getInferenceRuntime` | fetch inference runtime health/snapshot |
| `flushInference` | force durable flush of inference runtime |

## 5. Important RPC Contracts

### 5.1 `scan`

`scan(prefix, options?)` now targets current visible state across tiers.

Important options:

- `tiers`: default `all`
- `mode`: default `current`
- `includeSystem`: default `false`
- `limit`
- `cursor`

Behavior:

- hidden system keys are not returned unless `includeSystem=true`
- deleted keys are hidden if the latest visible state is a tombstone

### 5.2 `get`

`get(key)` returns the latest visible state for the key, regardless of whether the latest value lives in:

- HOT
- WARM
- COLD

### 5.3 `delete`

`delete(key)` persists a tombstone.

Behavior:

- deleted key disappears from normal `get()` and `scan()`
- tombstone remains in hidden system state

### 5.4 `infer`

Request shape:

```json
{
  "domain": "ops.provider_select",
  "objective": "low_latency",
  "subject": "gimo",
  "context": { "scope": "host:default" },
  "candidates": [
    { "id": "haiku", "latencyMs": 90, "cost": 0.2 },
    { "id": "sonnet", "latencyMs": 110, "cost": 0.3 }
  ]
}
```

Result shape includes:

- `decisionId`
- `domain`
- `ranking`
- `recommended`
- `policyVersion`
- `profileVersion`
- `evidenceKeys`
- `createdAt`

### 5.5 `reportOutcome`

`reportOutcome()` now matters for both native insight and inference.

Relevant fields for inference:

- `domain`
- `decisionId`
- `result`
- `context.candidateId`
- `context.scope`
- `context.subject`
- `metrics`

This feeds:

- outcome stats
- feedback records
- future policy/decision ranking

## 6. Inference Runtime Domains

Current built-in deterministic domains:

### `compression.encode`

Use case:

- choose/tune compression behavior by local workload profile

### `ops.provider_select`

Use case:

- rank providers/LLMs using cost, latency and historical outcomes

### `ops.plan_rank`

Use case:

- rank proposed plans/candidates using risk, confidence and cost

### `storage.policy`

Use case:

- propose storage/runtime knobs such as:
  - `maxMemSizeBytes`
  - `maxDirtyCount`
  - `warmRetentionMs`

## 7. Inference Runtime Artifacts

The engine materializes hidden system records:

| Prefix | Meaning |
|---|---|
| `_infer|profile|*` | learned profile |
| `_infer|policy|*` | current policy |
| `_infer|decision|*` | ranked decision |
| `_infer|feedback|*` | explicit feedback/outcome |

These are not included in normal scans unless `includeSystem=true`.

## 8. CLI Automation Surface

### Core daemon automation

- `gics rpc <method> --params-json ...`
- `gics daemon status --json`
- `gics module status --json`

### Inference automation

- `gics inference infer --domain ... --json`
- `gics inference profile --scope ... --json`
- `gics inference recommendations --domain ... --limit ... --json`
- `gics inference health --json`
- `gics inference flush --json`

### Example automation patterns

Current CLI output is designed to be machine-readable so it can be chained into wider scripts.

PowerShell examples:

```powershell
gics rpc scan --params-json "{\"prefix\":\"orders:\",\"limit\":100}" --pretty > orders.json

$decision = gics inference infer --domain ops.provider_select `
  --objective low_latency `
  --subject gimo `
  --context-json "{\"scope\":\"host:default\",\"task\":\"chat\"}" `
  --candidates-json "[{\"id\":\"provider-a\",\"latencyMs\":90,\"cost\":0.2},{\"id\":\"provider-b\",\"latencyMs\":120,\"cost\":0.1}]" `
  --json

$decision | Set-Content latest-decision.json
```

Important operational rule:

- use `--json` or `gics rpc ...` for automation
- use table/text output only for interactive terminal use

## 9. Python Client Surface

Important methods for `v1.3.3-pre`:

- `put()`
- `get()`
- `delete()`
- `scan(prefix="", tiers="all", include_system=False, limit=None, cursor=None, mode="current")`
- `infer()`
- `get_profile()`
- `get_recommendations()`
- `get_inference_runtime()`
- `flush_inference()`
- `report_outcome()`

Async variants exist for the most important calls.

Python client compatibility notes:

- `get_recommendations()` accepts both legacy-style `filter_type` / `target` parameters and current inference-style `domain` / `subject` / `limit`.
- `report_outcome()` accepts classic insight feedback (`insight_id`, `result`) and current inference feedback (`domain`, `decision_id`, `metrics`, `context`).

## 10. Error Semantics

### Core principle

GICS prefers explicit failure over silent success.

### Typical failure classes

| Failure | What user sees |
|---|---|
| invalid RPC method | JSON-RPC error |
| auth/token mismatch | JSON-RPC error |
| missing daemon/token path | CLI/script failure |
| WAL corruption on replay | warning, corrupted entry skipped |
| state index corruption | rebuild warning, startup recovery path |
| verify failure | explicit invalid result/error |
| disabled inference engine | inference RPC error |

### Important note

`put()` acknowledged successfully is not the same thing as "all possible failure classes are impossible forever". Durability depends on WAL/fsync mode and failure class.

## 11. Benchmarks And Validation References

Use these concrete artifacts when documenting or discussing performance:

- empirical gate: `bench/results/latest/empirical-report.md`
- validate-50x: `bench/results/latest/validate-50x-report.md`
- security: `bench/results/latest/empirical-security-report.md`
- long horizon: `bench/results/latest/long-horizon-report.md`
- forensics: `bench/forensics/artifacts/postfreeze/summary.postfreeze.json`

Current test validation:

- `reports/vitest-junit.xml`
- `284 tests`
- `0 failures`
- `0 errors`

## 12. Current Boundaries

Closed in current branch:

- embedded inference runtime
- current-state tiered reads
- durable deletes
- explicit hidden inference artifacts
- inference CLI + Python integration

Not closed yet:

- official out-of-process sidecar as default deployment
- cursored event replay for external inference worker
- final public documentation wording for all product claims
