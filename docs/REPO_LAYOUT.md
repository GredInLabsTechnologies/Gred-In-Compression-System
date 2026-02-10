# Repository Layout

> Project structure overview for the GICS core repository.

---

## 📁 Directory Structure

```
/
├── src/                    # Production source code
│   ├── gics/               # Core v1.3 engine (encode, decode, formatting)
│   ├── gics-types.ts       # Global type definitions
│   ├── gics-utils.ts       # Low-level bit/byte utilities
│   └── index.ts            # Public API exports
│
├── tests/                  # Vitest test suites
│   ├── gics-*.test.ts      # Unit/Integration tests for v1.3
│   └── fixtures/           # Binaries and snapshots for verification
│
├── bench/                  # Performance benchmarks
│
├── tools/                  # Development ops and verification
│   ├── gimo_server/        # GICS Monitoring Server (GIMO)
│   └── verify/             # Standalone state verification
│
├── docs/                   # Documentation
│   ├── deprecated/         # Obsolete documentation (with banners)
│   ├── reports/            # Implementation status and audits
│   ├── FORMAT.md           # Binary format spec (v1.3)
│   ├── SECURITY_MODEL.md   # Security and integrity model
│   └── REPO_LAYOUT.md      # This file
│
├── README.md               # Quick start and project status
├── package.json            # npm config + scripts
├── tsconfig.json           # TypeScript config
└── vitest.config.ts        # Test runner config
```

---

## 🎯 Key Directories

| Directory | Purpose |
|-----------|---------|
| `src/gics/` | Implementation of Segment architecture, Codecs, and Encryption |
| `tests/` | Comprehensive test suite (Roundtrip, Compression, Security) |
| `tools/` | Internal dev tools and monitoring infrastructure |
| `docs/` | Technical specifications and record of truth |

---

## 📦 Related Repositories

| Repository | Purpose |
|------------|---------|
| **GICS-ARCHIVE** | Historical versions (v1.1, v1.2) — append-only museum |

See [ARCHIVE_POINTERS.md](./ARCHIVE_POINTERS.md) for checksums of archived versions.

---

## 🚫 Excluded Content

- **Legacy modules** (`src/gics/v1_2/`) → Flattened/Refactored into `src/gics/`
- **Dist folders** (`dist/`, `build/`) → Ignored by git
- **Stray artifacts** (`tmp/`, `.gemini/`) → Internal agent state only

---

## 🔧 NPM Scripts

| Script | Command | Purpose |
|--------|---------|---------|
| `build` | `tsc` | Compile TypeScript |
| `test` | `vitest run` | Run automated test suite |
| `bench` | `tsx bench/scripts/harness.ts && tsx bench/scripts/gen-report.ts` | Execute performance suite |
| `bench:forensics` | `tsx bench/forensics/postfreeze/harness.postfreeze.ts` | Determinism + artifacts harness |
| `bench:forensics:verify` | `tsx bench/forensics/postfreeze/verifier.postfreeze.ts` | Contract verification for forensics |
| `verify` | `tsx tools/verify/verify.ts` | Integrity verification without decompression |

---

*Document version: 1.3 | Updated: 2026-02-10*
