# GICS v1.3.4 - Roadmap

Date: 2026-03-19
Target version: `1.3.4`
State: iteration open
Branch: `codex/1.3.4`

## Objective of the cycle

Open `1.3.4` as a real new iteration centered on hardening, packaging, ecosystem migration, and selected platform primitives.

This roadmap is the active planning baseline for the branch.

## Release posture

- This is not a hotfix cycle.
- Documentation and release framing are prepared first.
- Implementation starts only after the `1.3.4` scope is closed inside the active document set.

## Planned work streams

### A. Core hardening

- encryption safety review and migration posture
- decode/query fail-closed behavior
- corruption handling and legacy decoding boundaries

### B. Runtime and daemon hardening

- deletion durability and transaction shape
- process locking and IPC hardening
- resilience shell cleanup
- audit serialization discipline

### C. New primitives

- batch write semantics
- idempotency support
- prefix count/latest/summary helpers
- inference seeding if it fits the schedule

### D. Packaging and SDKs

- official `gics-core` `1.3.4` package posture
- official Node/TypeScript SDK surface
- promoted Python SDK surface

### E. Ecosystem migration

- migration path from `1.2.0` / `1.3.3` consumers
- documentation and contract cleanup before integrations move

## Scope rule

The roadmap expresses direction, not implementation approval by itself.

Before code lands for any stream above, the corresponding `1.3.4` task must be verified against the active branch state and tied to the active documentation set.
