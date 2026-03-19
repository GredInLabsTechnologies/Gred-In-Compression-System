# GICS v1.3.4 - Production Plan (Bootstrap)

Purpose: prepare the repository for a new development iteration before feature work starts.

State: bootstrap
Branch: `codex/1.3.4`
Date: 2026-03-19

## Objective of this phase

Leave `1.3.4` ready to start implementation without treating it as a hotfix train over `1.3.3`.

This bootstrap phase is about version posture, documentation posture, and release-shape clarity.

## Operational invariants

1. `1.3.4` is a new iteration.
2. No feature work should land without an active `1.3.4` planning reference.
3. Documentation from `1.3.3` and earlier is legacy by default for new implementation work.
4. Historical material is preserved, but active work must point to the `1.3.4` document set.
5. Standard engineering gates remain the same for later technical phases:
   - `npm run build`
   - `npm test`
   - `npm run verify`
   - `npm run bench` when applicable

## Bootstrap checklist

- [x] Create dedicated branch `codex/1.3.4`
- [x] Open `1.3.4` in `package.json`, `package-lock.json`, `README.md`, and `CHANGELOG.md`
- [x] Publish a new active documentation set for `1.3.4`
- [x] Deprecate previous-cycle planning documents for new implementation work
- [x] Publish a `1.3.4` roadmap and architecture baseline

## Next phase

Before implementation starts, the cycle must explicitly close:

- release objective
- scope in / scope out
- phase ordering
- migration posture
- documentation contracts for new APIs if they are added

No runtime behavior changes are part of this bootstrap step.
