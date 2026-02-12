# GICS Security Validation Matrix

This document centralizes the security-focused validations for GICS v1.3.2 benchmark and test flows.

## Cryptographic primitives in use

- **AES-256-GCM** for authenticated encryption of stream sections
- **PBKDF2-SHA256** for password-based key derivation
- **HMAC-SHA256** for password verification token (`authVerify`)
- **SHA-256 hash chain** for section/segment/file integrity linkage
- **CRC32** for segment/file corruption detection

## Benchmark security checks

Implemented in `bench/scripts/empirical-security.ts`:

1. KDF execution consistency checks (configured with 100k iterations by default)
2. Auth token verification pass/fail behavior
3. Auth-verify timing delta regression check (match/mismatch average runtime bounded by threshold)
4. Deterministic same-stream encryption behavior
5. IV domain separation between stream IDs
6. Ciphertext tamper rejection
7. Auth-tag tamper rejection
8. Encrypted GICS roundtrip pass
9. Wrong-password rejection

Report artifacts:

- `bench/results/latest/empirical-security-report.json`
- `bench/results/latest/empirical-security-report.md`

## Security unit/regression checks

- `tests/gics-security-crypto.test.ts`
  - PBKDF2 determinism for same input
  - `authVerify` accepts correct key and rejects wrong key
  - bounded timing delta check for match/mismatch auth verification path
  - domain separation for stream encryption
  - decryption failure on tampered ciphertext/tag
  - wrong password rejection for encrypted pack/unpack

- `tests/gics-limits.test.ts`
  - defensive limit behavior against maliciously inflated uncompressed section lengths
  - optional heavy stress mode (`GICS_HEAVY_LIMITS=1`) for high snapshot/item-count validation

- `tests/regression/quarantine-trigger.test.ts`
  - regression guard to ensure high-entropy shifts still trigger quarantine routing
  - verifies output remains decodable under quarantine usage

- `tests/gics-adversarial.test.ts`
  - systematic truncation and bit-flip scenarios
  - decompression bomb protection path (`LimitExceededError`)

## Threat-model alignment (practical)

- **Tampering in transit/storage**: Covered by AES-GCM authentication + hash chain + CRC checks.
- **Wrong key / unauthorized decrypt**: Covered by PBKDF2 + auth verify + decryption failure path.
- **Auth comparison side-channel drift**: mitigated with constant-time `timingSafeEqual` in `verifyAuth` + benchmark/test regression checks.
- **Corrupted/truncated payloads**: Covered by integrity and truncation tests.
- **Decompression abuse**: Covered by decoder guard limits and adversarial tests.

## CI integration

The build workflow executes:

- `npm run bench:security`
- `npm run bench:validate-50x`
- `npm run bench:gate`
- `npm run bench:codec-stats`

Optional strict/full quality flow can additionally run `bench:strict` and `bench:edge-cases`.
