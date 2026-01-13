# GICS v1.2 CONTRACT

## 1. Identification
- **GICS Version**: 1.2
- **Status**: CRITICAL / FROZEN
- **Git Commit SHA**: 70aeafaaf9eb2fac6c86d003b2b22d291d82a6ea
- **Date**: 2026-01-13
- **Author**: GICS Release Engineering

## 2. Compatibility & Migration
- **Backward Compatibility**: v1.2 is NOT backward compatible with pre-EOS drafts.
- **EOS Requirement**: Files without `StreamId.EOS` (0xFF) are invalid by contract.
- **Legacy Adapters**: Must enforce EOS externally before passing data to GICS v1.2 decoder.

## 3. Protocol Guarantees
### Mandatory EOS
- `StreamId.EOS` (0xFF) is strictly mandatory at the end of every stream.
- The decoder MUST reject any file that does not end with this marker.

### Fail-Closed Truncation
- The decoder MUST fail-closed if data is truncated.
- No silent success or partial reads are permitted for critical streams.

### Typed Errors
- All failures must throw typed errors (e.g., `IncompleteDataError`, `IntegrityError`).
- Generic errors are not permitted in the critical path.

## 4. Integrity Scope
- **Guarantee**: Bit-exact roundtrip for valid data.
- **Scope**: Structural and protocol integrity is enforced.
- **Exclusion**: No claims of cryptographic tamper-resistance are made for this version.

## 5. Concurrency Model
- **Default**: Shared-nothing.
- **State**: No static shared context is permitted in critical mode. Instances must be isolated.

## 6. Regression Seal
The following regression tests MUST NEVER be removed or disabled:
- `eos_missing.test.ts`
- `truncation.test.ts`
- `integrity_mismatch.test.ts`

## 7. Version Freeze Clause
- **Status**: GICS v1.2 is officially FROZEN.
- **Modifications**: Any behavioral change, no matter how small, mandates a version bump to v1.3+.
- **Authority**: This contract is authoritative. Implementation must match this contract.

---
*Signed by GICS Release Engineering*
