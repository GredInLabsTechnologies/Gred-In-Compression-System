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
export const enum KdfId {
    PBKDF2_SHA256 = 0x01,
    ARGON2ID = 0x02,  // Reserved for future
}

/** Digest Algorithm Identifiers */
export const enum DigestId {
    SHA256 = 0x01,
    SHA512 = 0x02,
}

/** Current KDF Configuration */
export const KDF_CONFIG = {
    id: KdfId.PBKDF2_SHA256,
    iterations: 600_000,  // Phase 2: Hardened from 100k
    keyLen: 32,           // AES-256 requires 32 bytes
    digest: 'sha256' as const,
    digestId: DigestId.SHA256,
} as const;

export const SALT_LEN = 16;            // 128-bit salt
export const IV_LEN = 12;              // GCM standard IV length
export const AUTH_TAG_LEN = 16;        // GCM standard tag length
export const FILE_NONCE_LEN = 12;       // Phase 2: For deterministic IV
export const AUTH_VERIFY_LEN = 32;     // HMAC-SHA256 output

// Legacy exports for backward compatibility
export const KDF_ITERATIONS = KDF_CONFIG.iterations;
export const KDF_KEYLEN = KDF_CONFIG.keyLen;
export const KDF_DIGEST = KDF_CONFIG.digest;

// ============================================================================
// Errors
// ============================================================================

export class LockedError extends Error {
    constructor(message: string = 'GICS KeyStore is locked. Provide password to unlock.') {
        super(message);
        this.name = 'LockedError';
    }
}

// ============================================================================
// Service
// ============================================================================

class KeyService {
    private masterKey: Buffer | null = null;
    private isLocked: boolean = true;

    /**
     * Check if the vault has a valid key loaded
     */
    isAuthenticated(): boolean {
        return !this.isLocked && this.masterKey !== null;
    }

    /**
     * Unlock the vault by deriving the key from a password
     * @param password User-provided password
     * @param salt File-specific salt (16 bytes)
     * @param iterations Optional custom iterations (for reading old files)
     */
    async unlock(password: string, salt: Buffer, iterations?: number): Promise<void> {
        // SECURITY: Never log passwords (even partially). Keep logs metadata-only.
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
            this.masterKey = await pbkdf2Async(
                password,
                salt,
                iters,
                KDF_CONFIG.keyLen,
                KDF_CONFIG.digest
            );
            this.isLocked = false;
        } catch (error) {
            this.lock();
            throw error;
        }
    }

    /**
     * Lock the vault and wipe the key from memory
     */
    lock(): void {
        if (this.masterKey) {
            // Robust wipe based on DoD 5220.22-M
            const len = this.masterKey.length;

            // Pass 1: Random
            randomBytes(len).copy(this.masterKey);
            // Pass 2: Zeros
            this.masterKey.fill(0);
            // Pass 3: Random
            randomBytes(len).copy(this.masterKey);
            // Final: Zeros
            this.masterKey.fill(0);

            this.masterKey = null;
        }
        this.isLocked = true;
    }

    /**
     * Get the master key for encryption/decryption operations.
     * Throws if locked.
     */
    getKey(): Buffer {
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
    generateAuthVerify(salt: Buffer, headerFixed: Buffer): Buffer {
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
    verifyAuthVerify(expected: Buffer, salt: Buffer, headerFixed: Buffer): boolean {
        if (this.isLocked || !this.masterKey) {
            throw new LockedError('Cannot verify authVerify without unlocked key');
        }
        if (expected.length !== AUTH_VERIFY_LEN) {
            return false;
        }

        const computed = this.generateAuthVerify(salt, headerFixed);

        try {
            return timingSafeEqual(expected, computed);
        } catch {
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
    generateSalt(): Buffer {
        return randomBytes(SALT_LEN);
    }

    /**
     * Generate a new random file nonce (for deterministic IV)
     */
    generateFileNonce(): Buffer {
        return randomBytes(FILE_NONCE_LEN);
    }

    /**
     * Generate deterministic IV from file nonce + block index
     * IV = fileNonce(8 bytes) + blockIndex(4 bytes LE)
     */
    generateDeterministicIV(fileNonce: Buffer, blockIndex: number): Buffer {
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
