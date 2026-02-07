# Repository Layout

> Project structure overview for the GICS core repository.

---

## 📁 Directory Structure

```
/
├── src/                    # Production source code
│   ├── gics/v1_2/         # Core compression engine
│   ├── services/          # Support services (key, telemetry)
│   └── index.ts           # Public API exports
│
├── tests/                  # Vitest test suites
│   ├── *.test.ts          # Unit and integration tests
│   └── fixtures/          # Test data fixtures
│
├── bench/                  # Performance benchmarks
│   └── sensitive/         # CPU-sensitive harness
│
├── tools/                  # Development utilities
│   └── verify/            # Verification scripts
│
├── docs/                   # Documentation
│   ├── ARCHIVE_POINTERS.md   # References to gics-archive
│   ├── VERSIONING.md         # Version history
│   ├── SECURITY_MODEL.md     # Safety guarantees
│   ├── FORMAT.md             # Binary format spec
│   └── REPO_LAYOUT.md        # This file
│
├── README.md               # Project overview
├── GICS_v1.3_IMPLEMENTATION_REPORT.md  # Current implementation details
├── package.json            # npm config + scripts
├── tsconfig.json           # TypeScript config
└── vitest.config.ts        # Test runner config
```

---

## 🎯 Key Directories

| Directory | Purpose |
|-----------|---------|
| `src/` | Production code only — no tests, no scripts |
| `tests/` | Vitest suites (`*.test.ts`) |
| `bench/` | Performance measurement harnesses |
| `tools/` | Standalone verification scripts |
| `docs/` | Technical documentation |

---

## 📦 Related Repositories

| Repository | Purpose |
|------------|---------|
| **GICS-ARCHIVE** | Historical versions (v1.1, v1.2) — append-only museum |

See [ARCHIVE_POINTERS.md](./ARCHIVE_POINTERS.md) for references and checksums.

---

## 🚫 Excluded Content

The following are **NOT** in this repository:

- Legacy frozen code (`gics_frozen/`) → moved to GICS-ARCHIVE
- Distribution packages (`gics-v1.2-distribution/`) → archived
- Old deployment artifacts (`deploy/`) → archived
- Benchmark artifacts from previous versions → archived

---

## 🔧 NPM Scripts

| Script | Command | Purpose |
|--------|---------|---------|
| `build` | `tsc` | Compile TypeScript |
| `test` | `vitest run` | Run test suite |
| `bench` | `vitest bench` | Run benchmarks |
| `verify` | (see tools/) | Quick integrity checks |

---

*Document version: 1.0 | Updated: 2026-02-07*
