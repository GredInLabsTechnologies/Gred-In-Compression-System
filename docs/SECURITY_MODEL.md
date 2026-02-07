# GICS Security Model

> Safety guarantees and threat model for the GICS compression system.

---

## 🔒 Core Security Principles

### 1. Deterministic-Only Operations

| Guarantee | Description |
|-----------|-------------|
| **No AI/ML** | Purely algorithmic compression with reproducible results |
| **No randomness** | Same input + config → identical output bytes |
| **No external calls** | Fully offline — zero network dependencies |

### 2. Fail-Closed Architecture

GICS **never silently accepts** malformed or incomplete data:

```
VALID INPUT → Compressed output
INVALID INPUT → Immediate rejection (typed error)
TRUNCATED → IncompleteDataError (requires EOS)
CORRUPTED → IntegrityError (structural/checksum failure)
```

### 3. Data Integrity Enforcement

| Mechanism | Purpose |
|-----------|---------|
| **EOS Marker** | Mandatory End-of-Stream — distinguishes completion from truncation |
| **Structural Validation** | Frame headers, block boundaries verified on decode |
| **Optional Checksums** | `IntegrityGuardian` for cryptographic validation |

---

## 🛡️ Threat Model

### In-Scope Threats

| Threat | Mitigation |
|--------|------------|
| Data truncation (network cut) | EOS enforcement rejects incomplete streams |
| Bit-flip corruption | Structural validation detects malformed frames |
| Replay attacks | Stream IDs + timestamps for uniqueness |
| Silent data degradation | Bit-exact roundtrip guarantees |

### Out-of-Scope Threats

| Threat | Reason |
|--------|--------|
| Key management | GICS compresses, does not encrypt |
| Transport security | Use TLS at network layer |
| Denial of Service | Resource limits are caller responsibility |

---

## 🔐 Deployment Recommendations

1. **Airgapped Compatibility** — GICS makes zero network calls
2. **Telemetry Isolation** — All metrics stay local (no phoning home)
3. **Input Validation** — Caller should validate snapshot schema before encoding
4. **Error Handling** — Always catch typed errors (`GICSError` hierarchy)

---

## ✅ Assurance Artifacts

| Artifact | Location |
|----------|----------|
| Roundtrip tests | `tests/gics-roundtrip.test.ts` |
| EOS enforcement | `tests/eos-enforcement.test.ts` |
| Integrity checks | `tests/integrity-check.test.ts` |
| Benchmarks | `bench/` |

---

## 📋 Compliance Notes

- **No PII processing** — GICS is schema-agnostic
- **Audit-ready** — Determinism enables reproducible verification
- **Offline-capable** — Zero external dependencies

---

*Document version: 1.0 | Updated: 2026-02-07*
