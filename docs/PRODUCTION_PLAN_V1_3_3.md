# GICS v1.3.3 - Production Plan (Bootstrap)

> Deprecated for new implementation work as of `1.3.4`.
> This document remains as historical bootstrap evidence for the previous cycle.

Purpose: establish the minimum runbook that was used to start `v1.3.3` on top of a cleaned documentation baseline.

> Canonical execution source for that cycle: `gics_1_3_3_plan`.
> This file is retained as an operational index for the historical `1.3.3` cycle.

State: historical
Original branch: `dev/v1.3.3`
Original date: 2026-03-15

## Objective of that phase

Prepare the environment so `1.3.3` implementation could start without ambiguity between:

- historical documentation, and
- active source-of-truth documentation.

## Historical invariants

1. Historical documentation was not deleted; it was deprecated and referenced.
2. New implementation for that cycle was planned against `1.3.3` docs.
3. Technical work for that cycle happened on `dev/v1.3.3`.
4. Standard gates for technical phases remained:
   - `npm run build`
   - `npm test`
   - `npm run verify`
   - `npm run bench` when applicable

## Historical bootstrap checklist

- [x] Create branch `dev/v1.3.3`
- [x] Publish documentation deprecation ledger
- [x] Mark `1.3.2` docs as legacy for new planning
- [x] Create the base roadmap for `1.3.3`
- [x] Update references in `README.md` and `docs/VERSIONING.md`

## Historical references

- `docs/VERSIONING.md`
- `docs/DEPRECATIONS_v1_3_3.md`
- `docs/roadmaps/GICS_ROADMAP_v1_3_3.md`
