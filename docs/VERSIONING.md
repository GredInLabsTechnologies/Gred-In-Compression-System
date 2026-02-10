# GICS Versioning

> **Purpose**: Document version history and location of each GICS release.

---

## Version Matrix

| Version | Status | Location | Notes |
|---------|--------|----------|-------|
| **v1.1.0** | 🏛️ Archived | `GICS-ARCHIVE/versions/v1.1/frozen/` | Original frozen implementation |
| **v1.2.0** | 🏛️ Archived | `GICS-ARCHIVE/versions/v1.2/` | Verification suite + legacy formats |
| **v1.3.0** | ✅ Production | **This repository** | Current stable version with Encryption + Schema |

---

## v1.1.0 — Frozen (Archived)
Original GICS implementation. Immutable reference.

## v1.2.0 — Legacy (Archived)
Stable legacy version. Archived for historical reproducibility.

## v1.3.0 — Current Production
Current active version. 
- **Key Features**: StreamSegments, AES-256-GCM Encryption, JSON Schema profiles, SHA-256 Integrity Chain.
- **Spec**: See [FORMAT.md](./FORMAT.md)
- **Report**: See [docs/reports/GICS_v1.3_IMPLEMENTATION_REPORT.md](./reports/GICS_v1.3_IMPLEMENTATION_REPORT.md)

---

## Deprecation Policy

- **Archived versions** (v1.1, v1.2) are **read-only**.
- **v1.3.0** is the current source of truth.
- All non-v1.3 documentation is moved to [docs/deprecated/](./deprecated/).

---

*Document version: 1.3 | Updated: 2026-02-10*
