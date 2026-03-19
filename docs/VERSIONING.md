# GICS Versioning

> Purpose: document version history, active development line, and iteration-level documentation status.

---

## Version Matrix

| Version | Status | Location | Notes |
|---------|--------|----------|-------|
| **v1.1.0** | Archived | `GICS-ARCHIVE/versions/v1.1/frozen/` | Original frozen implementation |
| **v1.2.0** | Archived | `GICS-ARCHIVE/versions/v1.2/` | Legacy verification-era release |
| **v1.3.1** | Released | historical | Stable core packaging milestone |
| **v1.3.2** | Released | historical | Daemon + insight expansion |
| **v1.3.3** | Released | historical baseline | Last shipped line before the new iteration |
| **v1.3.4** | Active development | `codex/1.3.4` | New iteration opened on 2026-03-19 |

> `1.3.4` is a new cycle.
> It must not be treated as an implicit hotfix continuation of `1.3.3`.

---

## Active line

### v1.3.4 - Active development

- Branch: `codex/1.3.4`
- Working package version: `1.3.4`
- State: bootstrap complete, implementation not started in this prep step
- Active docs:
  - [ACTIVE_DOCS_v1_3_4.md](./ACTIVE_DOCS_v1_3_4.md)
  - [DEPRECATIONS_v1_3_4.md](./DEPRECATIONS_v1_3_4.md)
  - [PRODUCTION_PLAN_V1_3_4.md](./PRODUCTION_PLAN_V1_3_4.md)
  - [GICS_ROADMAP_v1_3_4.md](./roadmaps/GICS_ROADMAP_v1_3_4.md)
  - [API_v1_3_4.md](./API_v1_3_4.md)

### Transition policy for 1.3.4

- Documents produced for `1.3.3` and earlier are legacy for new implementation work.
- Historical material stays in the repository as read-only reference.
- Normative baseline specs may still be used only when they are explicitly carried into the active `1.3.4` set.

---

## Historical lines

### v1.3.3 - Released baseline

- Release note: [2026-03-18_GICS_v1_3_3.md](./releases/2026-03-18_GICS_v1_3_3.md)
- Status in `1.3.4`: historical baseline, not active planning material

### v1.3.2 - Released

- Historical roadmap: [GICS_ROADMAP_v1_3_2.md](./roadmaps/GICS_ROADMAP_v1_3_2.md)

### v1.1.0 / v1.2.0 - Archived

- Archived versions remain read-only.
- They are retained for reproducibility and historical traceability only.

---

*Document version: 1.3.4-prep | Updated: 2026-03-19*
