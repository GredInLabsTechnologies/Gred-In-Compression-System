# GICS Versioning

> **Purpose**: Document version history and location of each GICS release.

---

## Version Matrix

| Version | Status | Location | Notes |
|---------|--------|----------|-------|
| **v1.1.0** | 🏛️ Archived | `GICS-ARCHIVE/versions/v1.1/frozen/` | Original frozen implementation |
| **v1.2.0** | 🏛️ Archived | `GICS-ARCHIVE/versions/v1.2/` | Verification suite + legacy formats |
| **v1.3.1** | ✅ Production | **This repository** | Stable core (Schema + Encryption) |
| **v1.3.2** | ✅ Release | `dev/v1.3.2` | The Cognitive Storage Engine (Daemon + Insight) |
| **v1.3.3** | 🚧 In Preparation | `dev/v1.3.3` | Documentation transition + implementation prep |

> ⚠️ **v1.3.3 Transition Policy (2026-03-15):** Documentation from cycles up to **v1.3.2** is considered **legacy/deprecated for new implementation work**. Historical content remains available as read-only reference.

---

## v1.1.0 — Frozen (Archived)
Original GICS implementation. Immutable reference.

## v1.2.0 — Legacy (Archived)
Stable legacy version. Archived for historical reproducibility.

## v1.3.0 — Current Production
Current active version.
- **Key Features**: StreamSegments, AES-256-GCM Encryption, JSON Schema profiles, SHA-256 Integrity Chain, CHM (Compression Health Monitor).
- **Spec**: See [FORMAT.md](./FORMAT.md)
- **API**: See [API.md](./API.md)
- **Security**: See [SECURITY_MODEL.md](./SECURITY_MODEL.md)
- **Report**: See [docs/reports/GICS_v1.3_IMPLEMENTATION_REPORT.md](./reports/GICS_v1.3_IMPLEMENTATION_REPORT.md)

### v1.3 Legacy Archival (2026-02-11)
Legacy files from the v1.3 development cycle (hybrid prototypes, v1.2-era tests, deprecated docs) were moved to `GICS-ARCHIVE/versions/v1.3-legacy/`. This repository now contains only production v1.3 code.

---

## Deprecation Policy

- **Archived versions** (v1.1, v1.2) are **read-only**.
- **v1.3 legacy files** archived at `GICS-ARCHIVE/versions/v1.3-legacy/`.
- **v1.3.0** is the current source of truth.

## v1.3.2 — The Cognitive Storage Engine
Released from `dev/v1.3.2` branch.
- **Key Features**:
  - **Daemon Mode**: Persistent process with MemTable, WAL, IPC (JSON-RPC 2.0)
  - **Tier Engine**: HOT/WARM/COLD with auto-flush, compaction, rotation, tier index
  - **Insight Engine**: Behavioral Tracker (velocity, entropy, volatility, streaks, fieldTrends, lifecycle), Correlation Analyzer (co-movement, clusters, leading indicators, seasonal patterns), Predictive Signals (anomaly detection, trend forecasting, recommendations)
  - **File Locking**: Cross-platform shared/exclusive locks for concurrent access
  - **Python Client SDK**: Zero-dependency sync/async client with connection pooling
  - **Zero new runtime dependencies**: All intelligence uses pure incremental statistics
- **Roadmap**: See [GICS_ROADMAP_v1_3_2.md](./roadmaps/GICS_ROADMAP_v1_3_2.md)

## v1.3.3 — Preparation Branch
Active preparation in `dev/v1.3.3`.
- **Scope (prep):** documentation deprecation framework, roadmap/bootstrap docs for 1.3.3, and release branch setup.
- **Roadmap (prep):** See [GICS_ROADMAP_v1_3_3.md](./roadmaps/GICS_ROADMAP_v1_3_3.md)
- **Deprecation ledger:** See [DEPRECATIONS_v1_3_3.md](./DEPRECATIONS_v1_3_3.md)

---

*Document version: 1.3.3-prep | Updated: 2026-03-15*
