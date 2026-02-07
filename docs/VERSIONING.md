# GICS Versioning

> **Purpose**: Document version history and location of each GICS release.

---

## Version Matrix

| Version | Status | Location | Notes |
|---------|--------|----------|-------|
| **v1.1.0** | 🏛️ Archived | `GICS-ARCHIVE/versions/v1.1/frozen/` | Original frozen implementation |
| **v1.2.0** | 🏛️ Archived | `GICS-ARCHIVE/versions/v1.2/` | Canonical + Distribution + Deploy |
| **v1.3.x** | 🔧 Active | **This repository** | Current development version |

---

## v1.1.0 — Frozen

- **Archive Path**: `../GICS-ARCHIVE/versions/v1.1/frozen/`
- **Description**: Original GICS implementation
- **Status**: Immutable reference

## v1.2.0 — Archived

- **Archive Path**: `../GICS-ARCHIVE/versions/v1.2/`
- **Structure**:
  - `canonical/` — Verified, clean source
  - `distribution/` — Packaged for distribution
  - `deploy/` — Full deployment bundle with `node_modules`
- **Status**: Production-verified, archived

## v1.3.x — Active Development

- **Location**: This repository (`src/`)
- **Report**: See `GICS_v1.3_IMPLEMENTATION_REPORT.md`
- **Status**: Active development

---

## Accessing Archived Versions

```bash
# Clone archive (if not already present)
cd ..
git clone <archive-remote-url> GICS-ARCHIVE

# Verify integrity
cd GICS-ARCHIVE
# Check specific file against SHA256SUMS.txt
```

---

## Deprecation Policy

- **Archived versions** (v1.1, v1.2) are **read-only**
- **No backports** — fixes only go to active version
- **Archive is append-only** — new versions may be added, existing content never modified
