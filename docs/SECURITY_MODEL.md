# GICS Security Model (v1.3)

> Safety guarantees, encryption features, and threat model for GICS.

---

## 🔒 Core Security Principles

### 1. Deterministic-Only Operations
| Guarantee | Description |
|-----------|-------------|
| **No AI/ML** | Purely algorithmic compression with reproducible results |
| **No randomness** | Same input + password → identical output bytes |
| **No external calls** | Fully offline — zero network dependencies |

### 2. Fail-Closed Architecture
GICS **never silently accepts** malformed, modified, or incomplete data:
```
VALID INPUT   → Compressed output
INVALID INPUT → Immediate rejection (typed error)
TRUNCATED     → IncompleteDataError (requires EOS + Hash verify)
CORRUPTED     → IntegrityError (SHA-256 or CRC32 failure)
WRONG PWD     → AuthenticationError (PBKDF2/HMAC check)
```

### 3. Native Encryption (New in v1.3)
GICS v1.3 implements industry-standard encryption directly in the wire format.
- **Algorithm**: AES-256-GCM (Galois/Counter Mode).
- **KDF**: PBKDF2-HMAC-SHA256 with 100,000 iterations.
- **Key Rotation**: Every file has a unique salt and file-level nonce.
- **Authentication**: GCM Authentication Tags per StreamSection + password verification via HMAC.

---

## 🛡️ Threat Model

### In-Scope Threats
| Threat | Mitigation |
|--------|------------|
| **Data Truncation** | File-level EOS + SHA-256 final hash verification |
| **Bit-Flip / Tampering**| AES-GCM Auth Tags + CRC32 on every segment |
| **Unauthorized Access** | AES-256-GCM encryption of StreamSection payloads |
| **Replay Attacks** | Deterministic nonces derived from unique file salt |
| **Password Guessing** | PBKDF2 slowdown with 100k iterations |

### Out-of-Scope Threats
| Threat | Reason |
|--------|--------|
| **Endpoint Security** | GICS assumes the host environment is not compromised |
| **Key Distribution** | Password/Key management is up to the caller |
| **Side-channels** | Compression ratio can reveal data entropy (standard behavior) |

---

## 🔐 Data Integrity Chain
GICS v1.3 uses a "Chain of Integrity" to ensure every byte is valid.
1. **Block Level**: Verified during decompression.
2. **Section Level**: AES-GCM tag (if encrypted) + SectionHash.
3. **Segment Level**: Cumulative `RootHash` (SHA-256) updated after every section.
4. **File Level**: Final EOS marker contains the global state hash.

---

## ✅ Assurance Artifacts

| Artifact | Purpose | Location |
|----------|---------|----------|
| **Encryption Tests** | Verify AES/PBKDF2 | `tests/gics-encryption.test.ts` |
| **Integrity Tests** | Verify hash chain | `tests/gics-integrity.test.ts` |
| **Adversarial Tests**| Verify tampering rejection | `tests/gics-adversarial.test.ts` |
| **Roundtrip Specs** | Bit-exact verification | `tests/gics-roundtrip.test.ts` |

---

*Document version: 1.3 | Updated: 2026-02-10*
