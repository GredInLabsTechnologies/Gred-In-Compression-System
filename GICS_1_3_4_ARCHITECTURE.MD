# GICS 1.3.4 - Architecture Baseline

Status: working architecture baseline
Branch: `codex/1.3.4`
Date: 2026-03-19

## Intent

Open `1.3.4` as a controlled iteration with a clear boundary:

- hardening first
- packaging and migration as first-class work
- primitives added only where they materially improve the platform
- no accidental drift into unrelated product work

## Architectural stance

`1.3.4` starts from the shipped `1.3.3` codebase and reclassifies the next cycle around four concerns:

1. Core integrity and fail-closed behavior
2. Daemon/runtime durability and IPC discipline
3. Packaging and SDK contracts
4. Ecosystem migration readiness

## Non-goals of this bootstrap document

- it does not approve implementation by itself
- it does not redefine the runtime surface yet
- it does not replace the binary format or storage model in this step

## Working rule

Every new `1.3.4` implementation item must prove which of the four concerns above it serves, and it must link back to the active `1.3.4` document set before code starts.
