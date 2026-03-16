# GICS v1.3.3 — Documentation Deprecation Ledger

**Effective date:** 2026-03-15  
**Scope:** This ledger marks previous-cycle documentation as legacy for **new implementation work** targeting v1.3.3.

---

## Policy

- Deprecated documents are **not deleted**.
- Deprecated documents remain **read-only historical references**.
- New planning and implementation for the next cycle must reference v1.3.3 prep docs.
- **Global scope rule (effective immediately):** every document produced before v1.3.3 prep is considered legacy for new implementation work, unless explicitly listed as active below.

### Active documentation set for v1.3.3 prep (allowlist)

- `gics_1_3_3_plan`
- `docs/DEPRECATIONS_v1_3_3.md`
- `docs/PRODUCTION_PLAN_V1_3_3.md`
- `docs/roadmaps/GICS_ROADMAP_v1_3_3.md`
- `docs/VERSIONING.md` (updated for transition state)
- `README.md` (transition notice)

---

## Deprecated for new work (as of v1.3.3 prep)

| Document | Previous status | New status | Replacement / Reference |
|---|---|---|---|
| `docs/roadmaps/GICS_ROADMAP_v1_3_2.md` | Active roadmap | Deprecated for new planning | `docs/roadmaps/GICS_ROADMAP_v1_3_3.md` |
| `docs/PRODUCTION_PLAN_V1_3.md` | Active implementation runbook | Deprecated for v1.3.3 planning | `docs/PRODUCTION_PLAN_V1_3_3.md` |
| `docs/reports/*` (up to v1.3.2 cycle) | Current delivery evidence | Historical / legacy evidence only | v1.3.3 reports to be generated in new cycle |
| `README.md` sections tied specifically to v1.3.2 planning state | Current | Legacy context | README transition note + v1.3.3 prep artifacts |

---

## Notes

- This deprecation is **documentation-level**, not code deletion.
- v1.3.2 remains valid as released software; this ledger only re-scopes what is considered active planning material.
