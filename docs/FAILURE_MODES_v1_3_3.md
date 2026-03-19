# GICS v1.3.3 Pre-Release Failure Modes

Date: 2026-03-18
Branch: `dev/v1.3.3`
State: `pre-release / internal source of truth`

## 1. Purpose

This document explains how `GICS v1.3.3` fails, when it fails, what the caller sees, what data risk exists, and what recovery path is expected.

This is not a generic reliability statement. It is the concrete failure behavior of the current branch.

## 2. Failure Philosophy

GICS prefers:

- explicit rejection over silent success
- current-state correctness over partial visibility
- isolated recovery over silent corruption
- system-key separation over exposing internal artifacts by default

That means a successful call has a defined meaning, and a failed call should be visible to the caller instead of being hidden behind optimistic behavior.

## 3. Failure Classes

| Failure class | When it happens | User-visible result | Data risk | Recovery |
|---|---|---|---|---|
| invalid RPC | unknown method or malformed params | JSON-RPC error, CLI non-zero exit | none | fix caller input and retry |
| auth failure | token missing or mismatched | request rejected | none | provide correct token |
| WAL append failure | filesystem write failure during commit path | write fails, caller gets error | write not committed | restore disk path/permissions and retry |
| WAL replay corruption | invalid CRC or malformed JSONL during replay | startup warning, bad entry skipped | corrupted WAL entry may be lost | inspect WAL, replay remaining valid entries |
| fsync unavailable | filesystem does not allow durable sync | warning in logs, daemon continues | weaker crash durability than requested | use supported filesystem or accept weaker mode |
| state index missing/corrupt | `state-index.json` absent or invalid | startup warning, rebuild path used | none if segments are valid | automatic rebuild from persisted segments |
| flush failure | segment write or verify fails | RPC/CLI error | HOT data remains authoritative until success | fix root cause and retry flush |
| compact failure | merged segment cannot be trusted or persisted | RPC/CLI error | existing segments remain source of truth | fix root cause and retry |
| rotate failure | warm-to-cold move or cold write fails | RPC/CLI error | data remains in previous trusted tier | fix root cause and retry |
| verify failure | archive corruption, hash mismatch, wrong password | invalid result or error | target artifact not trusted | replace artifact or use correct password |
| hidden system visibility mismatch | caller expects `_sys|*` or `_infer|*` in normal scans | records do not appear | none | request `includeSystem=true` |
| tombstone visibility | caller expects deleted key to remain readable | `get()` returns null and `scan()` hides key | none if tombstone exists | inspect system state with `includeSystem=true` |
| inference disabled | runtime does not enable inference engine | inference RPC returns error | none to core storage | enable module and retry |
| inference dirty state not flushed yet | inference has pending batched writes | latest policy/profile may not yet be durable on disk | limited to not-yet-flushed inference state | wait for timer/threshold or call `flushInference` |

## 4. Core Data Path Failures

### 4.1 Invalid RPC or invalid params

When it fails:

- unknown method name
- malformed JSON payload
- wrong params shape

What happens:

- request is rejected before state mutation
- daemon returns JSON-RPC error

What caller sees:

- `gics rpc ...` exits non-zero
- CLI command prints structured error
- application client receives JSON-RPC error object

Recovery:

- immediate after fixing the request

### 4.2 Authentication or token mismatch

When it fails:

- token file missing
- wrong token supplied
- daemon target resolved incorrectly

What happens:

- request is rejected
- no data path side effects occur

What caller sees:

- JSON-RPC auth failure
- `gics daemon status` or `gics rpc` failure if token resolution is wrong

Recovery:

- point the caller to the correct `--token-path` or `--config`

### 4.3 WAL append failure

When it fails:

- underlying filesystem write fails
- path permissions are wrong
- handle is unavailable

What happens:

- write path fails before the operation is considered durable
- caller gets an error instead of an optimistic success

What caller sees:

- failed `put` or `delete`
- log or stderr output depending on caller surface

Recovery:

- fix filesystem condition
- retry the operation

### 4.4 WAL replay corruption

When it fails:

- JSONL entry is malformed
- CRC validation fails during replay

What happens:

- corrupt replay entry is skipped
- daemon continues replaying remaining valid entries

What caller sees:

- startup warning in logs
- daemon still starts if enough WAL state remains readable

Data risk:

- the corrupted WAL record may be unrecoverable

Recovery:

- inspect or replace WAL file
- rely on persisted segments plus remaining valid WAL entries

### 4.5 `fsync` unavailable or denied

This already appears in validation on some filesystems as:

- `[WAL] fsync not supported/allowed on this filesystem. Continuing without durable sync.`

When it fails:

- filesystem does not support the configured sync operation
- runtime lacks permission to force durable sync

What happens:

- daemon continues
- write acknowledgement still means the write reached the WAL path, but not necessarily that the requested durability level was honored by the filesystem

What caller sees:

- warning in logs

Recovery:

- use a filesystem that supports durable sync
- or accept weaker crash semantics for that environment

## 5. Tier And State Failures

### 5.1 State index missing or corrupt

When it fails:

- `state-index.json` is missing
- serialized index is invalid
- index cannot be parsed

What happens:

- daemon falls back to rebuilding the current visible state from trusted segments

What caller sees:

- startup warning
- slower startup than the normal fast path

Recovery:

- automatic if persisted segments are valid

### 5.2 Flush failure

When it fails:

- writing a new warm segment fails
- verification of the new segment fails
- the final file cannot be moved into place

What happens:

- flush does not advance trusted persisted state
- current in-memory and WAL-backed state remains authoritative

What caller sees:

- `flush` returns error
- health surface may indicate degradation if the condition persists

Recovery:

- fix disk condition
- retry `flush`

### 5.3 Compact failure

When it fails:

- compaction output cannot be written
- merged segment fails validation

What happens:

- daemon does not replace the prior trusted warm segments

What caller sees:

- `compact` returns error

Recovery:

- existing trusted segments remain available
- retry after fixing the cause

### 5.4 Rotate failure

When it fails:

- archival move fails
- cold encryption/write fails
- post-write verification fails

What happens:

- data remains in the last trusted tier
- rotate does not pretend success

What caller sees:

- `rotate` returns error

Recovery:

- retry after fixing storage or encryption configuration

### 5.5 Hidden system namespaces

When it "fails":

- caller expects `_sys|*`, `_insight|*` or `_infer|*` to appear in normal scans

What happens:

- scan omits those records by default

Why:

- those namespaces are internal operational state

Recovery:

- call `scan(..., includeSystem=true)` if intentionally inspecting internals

### 5.6 Durable delete semantics

Current behavior:

- `delete()` creates a durable tombstone
- `get()` and `scan()` hide the key if the latest visible state is that tombstone

When confusion happens:

- caller expects old value resurrection after restart or flush

What happens now:

- the old value stays hidden
- tombstone survives flush, compact, rotate and restart

Inspection path:

- inspect system records with `includeSystem=true`

## 6. Verification And Archive Failures

### 6.1 Verify failure

When it fails:

- hash-chain mismatch
- CRC mismatch
- encrypted archive opened with wrong password
- tampered ciphertext or tag

What happens:

- verify returns invalid
- unpack/read path rejects the artifact rather than returning partial trust

What caller sees:

- explicit invalid result or raised error depending on surface

Recovery:

- replace the corrupted artifact
- or supply the correct password

### 6.2 Long-horizon misunderstanding

This is not a runtime failure, but it is a documentation failure mode if described carelessly.

Current evidence:

- `bench/results/latest/long-horizon-report.md` validates only a narrow workload:
  - `1y`
  - `730` snapshots
  - `8` items
  - ratio `6.63x`

What this means:

- GICS has an actual long-horizon benchmark artifact
- it does not prove universal multi-year behavior for all workloads

Correct claim:

- long-horizon support is implemented and partially benchmarked

Incorrect claim:

- "proven to run any workload for years without failure"

## 7. Inference Engine Failures

### 7.1 Inference engine disabled

When it fails:

- inference module is not enabled in daemon config

What happens:

- core daemon continues normally
- inference RPC methods return module/runtime error

Recovery:

- enable `inference-engine`

### 7.2 Inference dirty state not yet flushed

When it happens:

- runtime batches state changes in memory
- timer or op threshold has not yet flushed them

What happens:

- latest profiles/policies/feedback may exist in runtime but not yet be durable on disk

What caller sees:

- health reports dirty state and pending ops

Recovery:

- wait for scheduled flush
- or call `flushInference`

### 7.3 Heavy feedback or write load

Previous failure mode:

- engine persisted to disk on each hook/event

Current behavior:

- runtime batches persistence
- explicit eager flush is available where stronger durability is needed

What still matters:

- very heavy inference workloads can still increase flush latency
- inference is intentionally isolated from the core storage truth

Operational rule:

- if inference throughput matters more than immediate durability, rely on batching
- if the latest decision/feedback must be durable before proceeding, call `flushInference`

### 7.4 Hidden inference artifacts

When confusion happens:

- caller expects policies and decisions to appear in normal scans

What happens:

- `_infer|*` records stay hidden by default

Recovery:

- use `includeSystem=true`
- or consume official inference RPCs instead of internal records

## 8. Observability Surfaces

For diagnosing failure, the main surfaces are:

- daemon JSON-RPC errors
- CLI non-zero exits
- daemon health/status methods
- `getInferenceRuntime`
- hidden `_infer|*` and `_sys|*` records when explicitly requested
- benchmark and test artifacts under `bench/results/latest/` and `reports/`

## 9. Operational Guidance

Use these rules when integrating GICS into scripts or services:

1. Treat `put()` success as "accepted by current durability policy", not as magic immunity to every storage failure class.
2. Run `verify` on artifacts you move across trust boundaries.
3. Use `scan(..., includeSystem=true)` only for diagnostics or controlled internal tooling.
4. Use `flushInference` when a workflow depends on the immediate durability of learned inference state.
5. Keep public product claims aligned with benchmark artifacts, not with aspirational workload assumptions.

## 10. Validation References

- test report: `reports/vitest-junit.xml`
- empirical benchmark gate: `bench/results/latest/empirical-report.md`
- validate-50x report: `bench/results/latest/validate-50x-report.md`
- security report: `bench/results/latest/empirical-security-report.md`
- long-horizon report: `bench/results/latest/long-horizon-report.md`
