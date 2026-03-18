# GICS v1.3.3 Pre-Release

Date: 2026-03-18  
Branch: `dev/v1.3.3`  
State: `pre-release / implementation-complete for current dev cycle`

## 1. What This Document Is

This document is the technical pre-release snapshot for `GICS v1.3.3`.

It exists to answer five questions clearly:

1. What changed in `1.3.3`.
2. How the current system works.
3. How it fails, when it fails, and what the observable consequences are.
4. What is already validated.
5. What is still intentionally outside the release claim.

This is not marketing copy and not final public-facing documentation. It is the current source of truth for the real state of the branch.

## 2. Release Summary

`GICS v1.3.3` is the branch where the storage runtime and the inference runtime become coherent parts of the same system.

The two major outcomes are:

- `HOT/WARM/COLD` now behave as a unified operational truth for `get()` and `scan()`.
- `Inference Engine` is now a real runtime with batched persistence, explicit artifacts, feedback loops and operational health, instead of a thin module wrapper.

## 3. Documentation Map

For `v1.3.3-pre`, the recommended documentation reading order is:

1. This file  
   `docs/releases/2026-03-18_GICS_v1_3_3_PRE_RELEASE.md`
2. API reference for current branch  
   `docs/API_v1_3_3_PRE_RELEASE.md`
3. Failure modes and recoverability  
   `docs/FAILURE_MODES_v1_3_3_PRE_RELEASE.md`
4. Binary/file format  
   `docs/FORMAT.md`
5. Security model  
   `docs/SECURITY_MODEL.md`
6. Production and rollout planning  
   `docs/PRODUCTION_PLAN_V1_3_3.md`
7. Benchmarks index  
   `BENCHMARKS-RESULTS.md`

Legacy reference files still exist, but if they contradict this document, this document wins for `1.3.3-pre`.

## 4. Current Module Map

| Area | Status in 1.3.3 | Purpose |
|---|---|---|
| Core encoder/decoder | closed | deterministic compression and decompression |
| Segment/query layer | closed | selective reads, verification, schemas |
| Daemon runtime | closed | persistent process, JSON-RPC, tiers, recovery |
| StateIndex | closed | current visible state across HOT/WARM/COLD |
| WAL | closed | write-ahead durability and replay |
| Native insight | closed | incremental signals, lifecycle, correlations |
| Audit chain | closed | write/delete audit trail |
| Prompt distiller | closed | retention/distillation module |
| Inference engine | closed for embedded runtime | deterministic ranking, policies, profiles, feedback |
| Sidecar inference worker | not closed | planned future deployment mode |

## 5. What Changed In 1.3.3

### 5.1 Storage and daemon

- Added a persistent `StateIndex` as the primary source for current state.
- `get()` and `scan()` now see a unified view of `HOT`, `WARM` and `COLD`.
- Deletes are now durable by means of persistent tombstones.
- Hidden namespaces are reserved for system records:
  - `_sys|*`
  - `_insight|*`
  - `_infer|*`
- Prefix scans operate on current visible state instead of only in-memory hot data.
- Point reads from `WARM`/`COLD` route through selective decode paths instead of decoding whole archives.
- Module execution is formalized via a registry and explicit hooks.

### 5.2 Inference engine

- Added persistent profiles, policies, decisions and feedback records.
- Replaced per-event `save()` behavior with batched persistence.
- Added runtime health and forced flush.
- Added deterministic domain policies for:
  - `compression.encode`
  - `ops.provider_select`
  - `ops.plan_rank`
  - `storage.policy`
- Added CLI and Python client surfaces for inference operations.

## 6. Architecture In 1.3.3

At a high level, `1.3.3` is composed of four runtime layers:

### 6.1 Compression core

Responsible for:

- schema-aware encoding
- segment creation
- integrity verification
- generic query paths
- rotated sessions

### 6.2 Persistent daemon

Responsible for:

- JSON-RPC ingress
- memtable mutation
- WAL append/replay
- `HOT/WARM/COLD` transitions
- current-state reads
- module lifecycle

### 6.3 Native system modules

Responsible for:

- audit
- behavioral insight
- prompt retention
- deterministic inference

### 6.4 Operational consumers

Responsible for:

- application-specific writes and reads
- outcome reporting
- recommendation consumption
- automation via CLI or RPC

## 7. Data Model In The Daemon

### 7.1 HOT

`HOT` is the in-memory current working set.

Properties:

- lives in `MemTable`
- receives all fresh writes first
- backed by WAL
- fastest read path

### 7.2 WARM

`WARM` is flushed archive state.

Properties:

- stored as `.gics` segments on disk
- visible through `StateIndex`
- used for normal persisted historical access

### 7.3 COLD

`COLD` is long retention state.

Properties:

- archived segments moved out of warm
- can be encrypted
- still visible through the same current-state abstraction

### 7.4 StateIndex

`StateIndex` is the current-state directory for the daemon.

For each known key it tracks:

- timestamp
- tier
- deletion status
- segment reference
- materialized latest fields when available

This is what lets `get()` and `scan()` behave like a current-state database instead of a raw archive reader.

## 8. Inference Engine Model

The current inference engine is deterministic and explicit. It is not an opaque ML model.

The runtime is built around four persisted concepts:

### 8.1 Profile

A profile represents learned local operating characteristics for a `scope`.

Current profile contents include:

- read/write/scan/flush/compaction/rotation counters
- average payload size
- average read latency
- average compression ratio
- learned preferences
- policy hints

### 8.2 Policy

A policy represents the current deterministic strategy for a domain.

A policy contains:

- `policyVersion`
- `profileVersion`
- `basis`
- `weights`
- `thresholds`
- `payload`
- `recommendedCandidateId`

### 8.3 Decision

A decision is a ranked inference result for a given request.

A decision contains:

- domain
- scope
- subject
- ranking
- recommended candidate
- evidence keys
- policy/profile version references

### 8.4 Feedback

Feedback is the persisted record of what happened after a decision or candidate was used.

A feedback record contains:

- domain
- scope
- subject
- decision id
- candidate id
- result
- metrics
- success signal

## 9. Persisted System Artifacts

The inference engine publishes hidden system records under `_infer|*`.

### 9.1 Profiles

`_infer|profile|<scope>`

Contains:

- serialized profile
- profile version
- last update time

### 9.2 Policies

`_infer|policy|<domain>|<scope>[|<subject>]`

Contains:

- domain/scope/subject
- policy version
- profile version
- basis
- weights
- thresholds
- payload
- recommendation

### 9.3 Decisions

`_infer|decision|<decisionId>`

Contains:

- ranked result
- recommended candidate
- evidence links
- policy/profile references

### 9.4 Feedback

`_infer|feedback|<feedbackId>`

Contains:

- candidate
- result
- metrics
- timestamps
- contextual outcome data

## 10. Runtime Surfaces In 1.3.3

### 10.1 Core daemon RPC

Main operational methods:

- `put`
- `get`
- `delete`
- `scan`
- `flush`
- `compact`
- `rotate`
- `verify`
- `getHealth`
- `ping`

### 10.2 Insight RPC

- `getInsight`
- `getInsights`
- `getAccuracy`
- `getCorrelations`
- `getClusters`
- `getLeadingIndicators`
- `getSeasonalPatterns`
- `getForecast`
- `getAnomalies`
- `getRecommendations`
- `reportOutcome`

### 10.3 Inference RPC

- `infer`
- `getProfile`
- `getRecommendations`
- `getInferenceRuntime`
- `flushInference`

### 10.4 CLI

Current user-facing CLI groups:

- `gics encode`
- `gics decode`
- `gics verify`
- `gics info`
- `gics profile`
- `gics daemon`
- `gics module`
- `gics rpc`
- `gics inference`

### 10.5 Python client

Current inference-related client methods include:

- `infer()`
- `get_profile()`
- `get_recommendations()`
- `get_inference_runtime()`
- `flush_inference()`

## 11. How GICS Fails, When It Fails, And What Happens

This is the part that matters operationally.

For the exhaustive failure catalog, including data risk and recovery guidance, see:

`docs/FAILURE_MODES_v1_3_3_PRE_RELEASE.md`

### 11.1 Invalid or unknown RPC method

When it fails:

- a caller invokes a method that the daemon does not implement

What happens:

- daemon returns JSON-RPC error
- no internal state changes

Observability:

- client receives error envelope
- CLI exits non-zero

Recoverability:

- immediate; fix caller input

### 11.2 Authentication/token mismatch

When it fails:

- wrong token
- missing token file

What happens:

- request is rejected
- no read or write side effects occur

Observability:

- RPC error
- CLI reports daemon/token resolution failure

Recoverability:

- immediate after supplying the correct token

### 11.3 WAL append or WAL replay issues

When it fails:

- disk write fails
- CRC mismatch on replay
- JSONL corruption is detected

What happens:

- append failure: write is rejected
- replay corruption: corrupt entries are skipped, replay continues

Observability:

- warning/error in logs
- replay warnings include CRC mismatch information

Recoverability:

- per-entry corruption is isolated
- daemon continues if the rest of the WAL is readable
- corrupted entry may be lost

### 11.4 StateIndex corruption

When it fails:

- `state-index.json` is missing or invalid

What happens:

- daemon rebuilds `StateIndex` from persisted segments
- startup takes the rebuild path instead of fast load

Observability:

- warning at startup

Recoverability:

- automatic if segments are valid

### 11.5 Flush / compact / rotate failures

When it fails:

- file write/move/delete fails
- verification of new segment fails

What happens:

- operation returns error
- fail-closed behavior is preferred over silent continuation
- state is not intentionally advanced if the new persisted artifact cannot be trusted

Observability:

- RPC error or failed command
- health/reporting surface will reflect degraded operation if the daemon is affected

Recoverability:

- depends on filesystem condition
- can usually be retried once root cause is resolved

### 11.6 Read after restart if tiers are misindexed

When it used to fail:

- older daemon behavior could hide warm data from `scan()`

What happens now:

- `StateIndex` is the truth source
- `scan()` and `get()` read current visible state across tiers

Observability:

- validated by regression tests

Recoverability:

- fixed in current branch

### 11.7 Durable delete semantics

When it used to fail:

- deletes could disappear after flush/restart without persistent tombstones

What happens now:

- tombstones persist
- deleted keys stay hidden unless system keys are explicitly requested

Observability:

- `_sys|tombstone|*` records exist in hidden system namespace

Recoverability:

- fixed in current branch

### 11.8 Inference engine under write-heavy load

When it used to fail:

- every module hook saved state to disk immediately

What happens now:

- inference runtime batches persistence
- flushes by threshold or timer
- `infer()` and `reportOutcome()` default to strong durability through eager flush

Observability:

- `getInferenceRuntime` exposes dirty state, pending ops and flush stats

Recoverability:

- runtime flush can be forced with `flushInference`

### 11.9 Inference engine disabled or unavailable

When it fails:

- module is disabled by config

What happens:

- inference-specific RPC methods return explicit error
- core storage continues to work

Observability:

- module status and runtime health show inference unavailable

Recoverability:

- enable module and restart daemon if needed

### 11.10 Supervisor degraded mode

When it fails:

- repeated subsystem health failures trip the supervisor

What happens:

- daemon enters degraded behavior
- operational semantics depend on subsystem health and buffered recovery path

Observability:

- supervisor state changes are visible through health/status

Recoverability:

- `resetDegraded`
- subsystem recovery
- restart if required

## 12. Storage And Consistency Guarantees

What can be claimed today:

- deterministic compression/decompression for the same input and config
- fail-closed verification behavior
- current-state visibility across tiers
- durable tombstones
- restart recovery from WAL and/or segments
- inference state persistence across restart

What should not be claimed today:

- guaranteed sidecar inference deployment as release default
- exactly-once semantics across arbitrary external integrations
- blanket regulatory readiness
- "years without failure" as an absolute statement

## 13. Benchmark References

The branch already contains benchmark artifacts that should be referenced explicitly instead of paraphrased loosely.

### 13.1 Empirical compression gate

Reference:

- `bench/results/latest/empirical-report.md`

Current numbers in latest report:

- weighted critical ratio: `870.40x`
- critical gate: `PASS`
- critical integrity: `true`

### 13.2 50x validation gate

Reference:

- `bench/results/latest/validate-50x-report.md`

Current latest report:

- all datasets: `PASS`
- examples:
  - `market_data_trending`: `556.64x`
  - `market_data_stable`: `820.38x`
  - `iot_sensor_periodic`: `808.75x`
  - `event_log_structured`: `632.91x`

### 13.3 Security validation

Reference:

- `bench/results/latest/empirical-security-report.md`

Current latest report:

- pass: `YES`
- tamper rejection: `true`
- wrong-password rejection: `true`
- timing resistance check: `true`

### 13.4 Long-horizon benchmark

Reference:

- `bench/results/latest/long-horizon-report.md`

Important limitation:

- the latest long-horizon artifact is still a narrow workload
- it should be cited honestly as horizon evidence, not as proof of universal multiyear production behavior

### 13.5 Forensics and determinism

References:

- `bench/forensics/README.md`
- `bench/forensics/artifacts/postfreeze/summary.postfreeze.json`

These artifacts are the right place to justify determinism and cross-run reproducibility claims.

## 14. Validation Snapshot For This Branch

Current branch validation at the time of this pre-release snapshot:

- `npm.cmd run build`: pass
- `npm.cmd test`: pass
- `reports/vitest-junit.xml`: `284 tests`, `0 failures`, `0 errors`

## 15. Public Claims That Are Safe Right Now

These claims are technically defensible:

- GICS is a deterministic temporal storage and compression system.
- GICS supports tiered persistence with unified current-state reads.
- GICS includes a deterministic inference runtime built without opaque ML.
- GICS can persist decisions, policies, profiles and feedback as first-party runtime artifacts.
- GICS is suitable as an infrastructure substrate for systems that need compression, persistence, selective reads and feedback-driven adaptation.

## 16. Claims That Should Still Be Avoided

Do not state these as closed claims yet:

- "default sidecar inference deployment is complete"
- "ready for all regulated sectors by default"
- "outperforms the market" without naming and reproducing competitors/datasets
- "cannot fail for years"

## 17. Recommended Positioning For 1.3.3

Safe wording:

`GICS v1.3.3 consolidates the storage runtime and introduces a deterministic inference runtime. It now acts as both temporal memory and operational decision substrate, with tiered persistence, recovery, selective reads and feedback-driven adaptation.`

## 18. Files That Matter Most In This Branch

Core implementation:

- `src/daemon/server.ts`
- `src/daemon/state-index.ts`
- `src/daemon/module-registry.ts`
- `src/inference/engine.ts`
- `src/inference/module.ts`
- `src/inference/state-store.ts`
- `src/cli/commands.ts`
- `clients/python/gics_client.py`

Primary validation files:

- `tests/daemon-state-index-regression.test.ts`
- `tests/inference-engine-runtime.test.ts`
- `tests/cli.test.ts`

## 19. Next Documentation Work After This Pre-Release

The next documentation pass should close:

1. final README positioning
2. final API reference for `1.3.3`
3. deployment guidance for embedded vs future sidecar inference
4. benchmark interpretation guidance for external readers
5. application integration guides for GIMO / Labs / Telemetry-style workloads
