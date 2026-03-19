# GICS 1.3.4 Client Consumption Scope

Purpose: define the known `1.3.4` consumers of GICS and the minimum work each one must complete to be considered fully migrated to the official release.

This document ships with `@gredinlabstechnologies/gics-core@1.3.4` and is part of the release contract.

## Release artifacts that consumers must target

- Package: `@gredinlabstechnologies/gics-core@1.3.4`
- Node/TypeScript SDK: `@gredinlabstechnologies/gics-core/clients/node`
- Python SDK artifact: `clients/python/gics_client.py` from the `1.3.4` release artifact

## Definition of "100% consuming GICS 1.3.4"

A consumer is only considered fully on `1.3.4` if all of the following are true:

1. It pins the official `1.3.4` release artifact and stops using local tarballs, ad hoc forks, or copied older clients.
2. It uses the official SDK or core surface instead of reimplementing socket, token, retry, or verification logic.
3. It aligns its public contract with the real `1.3.4` API surface: `putMany`, idempotency, summaries, verification, and seed APIs where applicable.
4. It verifies externally received GICS files before promoting, reloading, or trusting them.
5. It does not expose misleading names for behaviors the release does not actually provide.

## Shared baseline requirements for all consumers

- Pin `@gredinlabstechnologies/gics-core` to exact version `1.3.4`.
- Remove any dependency on a local `1.2.0` tarball or older copied package.
- Treat idempotent `putMany` as atomic durability in `1.3.4`.
- Prefer `countPrefix`, `latestByPrefix`, and `scanSummary` over manual full scans when the use case is summary/status oriented.
- Use `ping` for anonymous liveness and `pingVerbose` only where authenticated runtime details are required.
- Keep the daemon single-writer rule intact: one daemon per `dataPath`.

## Consumer matrix

| Consumer | Main role over GICS | Required surface in `1.3.4` |
| --- | --- | --- |
| VIGIL / Gred-In-Labs | Snapshot reader, sync, reload, operational queries | Official package, Node/TS SDK, file verification helpers |
| GIMO | Python operational memory, reliability, bulk ingest, inference seeding | Official Python client artifact, daemon RPC, bulk primitives |
| GIST / Bio Interpreter | Python sync and ingest bridge | Official Python client artifact, `put_many`, summaries, verification |
| New Node/TS backends | Direct daemon consumer | Official Node/TS SDK |

## VIGIL / Gred-In-Labs

### Scope

VIGIL is a Node/TypeScript consumer with library-centric usage. Its `1.3.4` migration is primarily about official packaging, verified snapshot reload, and contract cleanup. It is not required to become daemon-centric just to adopt `1.3.4`.

### Mandatory work to consume `1.3.4` at 100%

1. Replace the local `gics-core 1.2.0` tarball with the official `@gredinlabstechnologies/gics-core@1.3.4` package.
2. Move imports to the official published surfaces:
   - root package exports for core reader and verification utilities
   - `@gredinlabstechnologies/gics-core/clients/node` for daemon-facing calls if VIGIL uses daemon RPC
3. Keep `GICSv2ReaderAdapter` compatible with the `1.3.4` reader/decoder behavior.
4. Harden the snapshot sync path:
   - download to a temporary file
   - validate manifest metadata for the batch
   - validate SHA-256 checksum
   - run `verifyFile(tmp)` or equivalent official verification
   - only then rename/promote and trigger reload
5. Do not expose a "sparse query" contract unless the implementation is truly sparse. If it is not sparse in `1.3.4`, rename it or document it honestly.
6. Remove or implement dead config flags such as autosave/salvage-style settings if they are still exposed by VIGIL's public contract.
7. If VIGIL writes snapshots itself, its save/persist contract must return real byte counts, finalize correctly, and clean active writers deterministically.

### Acceptance criteria

- No local tarball remains.
- No reload path skips verification.
- No misleading "sparse" label remains for full-read behavior.
- Reader adapter compatibility is validated against `1.3.4`.

## GIMO

### Scope

GIMO is a Python daemon consumer for operational memory, scoring/reliability flows, and potentially inference seeding.

### Mandatory work to consume `1.3.4` at 100%

1. Replace any custom bridge with the official `clients/python/gics_client.py` artifact from the `1.3.4` release.
2. Remove duplicated manual logic for:
   - socket lifecycle
   - token handling
   - retry behavior
   - daemon supervision/startup
3. Route batch ingest through `put_many(...)` instead of repeated `put(...)` loops when records belong to one logical batch.
4. Use deterministic `idempotency_key` values for replayable or retryable bulk writes.
5. Replace hand-rolled summary scans with:
   - `count_prefix(...)`
   - `latest_by_prefix(...)`
   - `scan_summary(...)`
6. If GIMO consumes inference profiles or policy priors, wire:
   - `seed_profile(...)`
   - `seed_policy(...)`
7. Keep GIMO-specific scoring, trust, and domain logic outside GICS. GICS is the storage/runtime substrate, not the place for GIMO's product logic.

### Acceptance criteria

- No bespoke Python bridge remains for core daemon transport concerns.
- Bulk ingest uses `put_many(...)` where retries matter.
- Summary/status code uses the official summary primitives.
- Inference seed APIs are wired if that feature is part of the deployment.

## GIST / Bio Interpreter

### Scope

GIST is a Python sync and ingest consumer. Its `1.3.4` adoption is mainly about standardizing the client, hardening sync pushes, and removing dynamic/manual client loading.

### Mandatory work to consume `1.3.4` at 100%

1. Stop loading the GICS Python client from arbitrary local paths at runtime.
2. Vendor or ship the official `clients/python/gics_client.py` artifact from the `1.3.4` release and version it explicitly with the rest of the service.
3. Route `/sync/push` or equivalent bulk ingestion through `put_many(...)`.
4. Derive `idempotency_key` from a stable payload hash for replay-safe sync operations.
5. Use `scan_summary(...)` and `latest_by_prefix(...)` for sync status and checkpoint-style metadata instead of manual scans where summaries are sufficient.
6. If GIST imports or rotates external GICS files, verify them before promotion or reload.

### Acceptance criteria

- No dynamic client path loading remains.
- Sync push is idempotent at batch level.
- Status/checkpoint logic uses official summary primitives where applicable.
- Verification happens before trusting external GICS files.

## New Node/TypeScript backends

### Scope

Any new Node/TypeScript backend that consumes GICS directly should use the official SDK rather than raw JSON-RPC transport code.

### Mandatory work to consume `1.3.4` at 100%

1. Install and pin `@gredinlabstechnologies/gics-core@1.3.4`.
2. Use `GICSNodeClient` for `put`, `get`, `delete`, `scan`, `putMany`, summaries, and file verification.
3. Do not duplicate request retry, timeout, or token resolution unless there is a documented reason to wrap the SDK.
4. Use `verifyFile(...)` before promoting standalone GICS files received from outside the process boundary.

## Out of scope for `1.3.4`

The following are not required for a consumer to be considered fully on `1.3.4`:

- workload synthesis
- LLM analyzers
- ML additions
- a Python refactor of GICS core
- a new VIGIL daemon architecture when its library-centric model is sufficient
- non-essential format migrations outside the encryption hardening already shipped in `1.3.4`
