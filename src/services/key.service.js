/**
 * GICS Key Service - Secure Key Management
 *
 * @module gics
 * @version 1.1.0
 * @status FROZEN - Canonical implementation
 * @see docs/GICS_V1.1_SPEC.md
 *
 * Manages the lifecycle of the Master Encryption Key.
 * Uses PBKDF2-SHA256 with 600k iterations. Keys stored in memory ONLY.
 */
import { pbkdf2, randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
const pbkdf2Async = promisify(pbkdf2);
// ============================================================================
// KDF Version Constants (Phase 2 Hardening)
// ============================================================================
/** KDF Algorithm Identifiers */
export var KdfId;
(function (KdfId) {
    KdfId[KdfId["PBKDF2_SHA256"] = 1] = "PBKDF2_SHA256";
    KdfId[KdfId["ARGON2ID"] = 2] = "ARGON2ID";
})(KdfId || (KdfId = {}));
/** Digest Algorithm Identifiers */
export var DigestId;
(function (DigestId) {
    DigestId[DigestId["SHA256"] = 1] = "SHA256";
    DigestId[DigestId["SHA512"] = 2] = "SHA512";
})(DigestId || (DigestId = {}));
/** Current KDF Configuration */
export const KDF_CONFIG = {
    id: KdfId.PBKDF2_SHA256,
    iterations: 600_000, // Phase 2: Hardened from 100k
    keyLen: 32, // AES-256 requires 32 bytes
    digest: 'sha256',
    digestId: DigestId.SHA256,
};
export const SALT_LEN = 16; // 128-bit salt
export const IV_LEN = 12; // GCM standard IV length
export const AUTH_TAG_LEN = 16; // GCM standard tag length
export const FILE_NONCE_LEN = 8; // Phase 2: For deterministic IV
export const AUTH_VERIFY_LEN = 32; // HMAC-SHA256 output
// Legacy exports for backward compatibility
export const KDF_ITERATIONS = KDF_CONFIG.iterations;
export const KDF_KEYLEN = KDF_CONFIG.keyLen;
export const KDF_DIGEST = KDF_CONFIG.digest;
// ============================================================================
// Errors
// ============================================================================
export class LockedError extends Error {
    constructor(message = 'GICS KeyStore is locked. Provide password to unlock.') {
        super(message);
        this.name = 'LockedError';
    }
}
// ============================================================================
// Service
// ============================================================================
class KeyService {
    masterKey = null;
    isLocked = true;
    /**
     * Check if the vault has a valid key loaded
     */
    isAuthenticated() {
        return !this.isLocked && this.masterKey !== null;
    }
    /**
     * Unlock the vault by deriving the key from a password
     * @param password User-provided password
     * @param salt File-specific salt (16 bytes)
     * @param iterations Optional custom iterations (for reading old files)
     */
    async unlock(password, salt, iterations) {
        // SECURITY: Never log passwords (even partially). Keep logs metadata-only.
        console.log('[KeyService] Unlocking with password: [REDACTED]');
        if (!password) {
            throw new Error('Password cannot be empty');
        }
        if (salt.length !== SALT_LEN) {
            throw new Error(`Invalid salt length: expected ${SALT_LEN}, got ${salt.length}`);
        }
        // Wipe old key if exists
        this.lock();
        const iters = iterations ?? KDF_CONFIG.iterations;
        try {
            this.masterKey = await pbkdf2Async(password, salt, iters, KDF_CONFIG.keyLen, KDF_CONFIG.digest);
            this.isLocked = false;
            console.log('[KeyService] Unlocked successfully.');
        }
        catch (error) {
            console.error('[KeyService] Unlock failed:', error);
            this.lock();
            throw error;
        }
    }
    /**
     * Lock the vault and wipe the key from memory
     */
    lock() {
        if (this.masterKey) {
            this.masterKey.fill(0);
            this.masterKey = null;
        }
        this.isLocked = true;
    }
    /**
     * Get the master key for encryption/decryption operations.
     * Throws if locked.
     */
    getKey() {
        if (this.isLocked || !this.masterKey) {
            throw new LockedError();
        }
        return this.masterKey;
    }
    // ========================================================================
    // Phase 2: AuthVerify (HMAC-based)
    // ========================================================================
    /**
     * Generate an HMAC-based authVerify token for a file.
     * Token = HMAC-SHA256(derivedKey, "GICS_VERIFY_V1" || salt || headerFixed)
     *
     * @param salt The file's salt
     * @param headerFixed Fixed header bytes to bind the token to
     */
    generateAuthVerify(salt, headerFixed) {
        if (this.isLocked || !this.masterKey) {
            throw new LockedError('Cannot generate authVerify without unlocked key');
        }
        const hmac = createHmac('sha256', this.masterKey);
        hmac.update('GICS_VERIFY_V1');
        hmac.update(salt);
        hmac.update(headerFixed);
        return hmac.digest();
    }
    /**
     * Verify an authVerify token using timing-safe comparison.
     * Returns true if valid, false otherwise.
     */
    verifyAuthVerify(expected, salt, headerFixed) {
        if (this.isLocked || !this.masterKey) {
            throw new LockedError('Cannot verify authVerify without unlocked key');
        }
        if (expected.length !== AUTH_VERIFY_LEN) {
            return false;
        }
        const computed = this.generateAuthVerify(salt, headerFixed);
        try {
            return timingSafeEqual(expected, computed);
        }
        catch {
            // Lengths differ (shouldn't happen, but safety first)
            return false;
        }
    }
    // ========================================================================
    // Utilities
    // ========================================================================
    /**
     * Generate a new random salt
     */
    generateSalt() {
        return randomBytes(SALT_LEN);
    }
    /**
     * Generate a new random file nonce (for deterministic IV)
     */
    generateFileNonce() {
        return randomBytes(FILE_NONCE_LEN);
    }
    /**
     * Generate deterministic IV from file nonce + block index
     * IV = fileNonce(8 bytes) + blockIndex(4 bytes LE)
     */
    generateDeterministicIV(fileNonce, blockIndex) {
        if (fileNonce.length !== FILE_NONCE_LEN) {
            throw new Error(`Invalid fileNonce length: expected ${FILE_NONCE_LEN}, got ${fileNonce.length}`);
        }
        const iv = Buffer.alloc(IV_LEN);
        fileNonce.copy(iv, 0);
        iv.writeUInt32LE(blockIndex, FILE_NONCE_LEN);
        return iv;
    }
    /**
     * Get current KDF configuration for header serialization
     */
    getKdfConfig() {
        return { ...KDF_CONFIG };
    }
}
// Singleton instance
export const keyService = new KeyService();
//# sourceMappingURL=key.service.js.map