# GICS v1.3.4 API Baseline

State: iteration baseline
Branch: `codex/1.3.4`
Date: 2026-03-19

## Purpose

This file defines the API posture at the opening of the `1.3.4` cycle.

No new API behavior is introduced by this bootstrap document.
It exists to make the transition explicit: `1.3.4` is open, but implementation has not started in this prep step.

## Current baseline

- The runtime codebase currently exposes the `1.3.3` public surface.
- `1.3.4` API additions are not considered active until they are specified here and implemented in code.
- Historical API references remain useful for comparison, but they are not the active planning surface for this cycle.

## Planned API areas under evaluation

- daemon batch write surface
- idempotency support
- prefix count/latest/summary helpers
- official Node/TypeScript SDK surface
- promoted Python SDK surface
- stronger verification helpers for integration workflows

## Working rule

If an API is not documented in the active `1.3.4` set, it should be treated as either:

- inherited baseline behavior from the current code, or
- not yet approved for this cycle.
