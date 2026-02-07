# GICS Archive Pointers

> **Purpose**: Reference to the external `GICS-ARCHIVE` repository containing frozen historical versions.

---

## Archive Location

| Property | Value |
|----------|-------|
| **Repository** | `GICS-ARCHIVE` (sibling directory) |
| **Relative Path** | `../GICS-ARCHIVE` |
| **Policy** | **Append-only** — no modifications to imported content |

---

## Current Archive State

| Property | Value |
|----------|-------|
| **Latest Commit** | `e19ce0d68d1a1c3b7312bdeb6e6206913dc91a5d` |
| **Checksums** | 436 files hashed in `checksums/SHA256SUMS.txt` |

---

## Archived Versions

### v1.1 (Frozen)
- **Path**: `versions/v1.1/frozen/`
- **Status**: Immutable reference implementation
- **Files**: Core GICS v1.1.0 source

### v1.2 (Canonical + Distribution + Deploy)
- **Path**: `versions/v1.2/`
- **Subdirs**:
  - `canonical/` — Verified source
  - `distribution/` — Packaged distribution
  - `deploy/` — Full deployment with dependencies

---

## Benchmark Artifacts

| Path | Description |
|------|-------------|
| `benchmarks/postfreeze/runA/` | First benchmark run artifacts |
| `benchmarks/postfreeze/runB/` | Second benchmark run artifacts |
| `benchmarks/harnesses/` | Benchmark harness scripts |

---

## Verification

To verify archive integrity:

```powershell
cd ../GICS-ARCHIVE
# Verify a specific file
$expected = (Select-String -Path checksums/SHA256SUMS.txt -Pattern "path/to/file").Line.Split(" ")[0]
$actual = (Get-FileHash "path/to/file" -Algorithm SHA256).Hash.ToLower()
$expected -eq $actual
```

---

## Policy

See `GICS-ARCHIVE/POLICY_NO_TOUCH.md` for archive integrity rules.
