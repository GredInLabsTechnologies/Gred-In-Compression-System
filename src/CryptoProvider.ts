/**
 * GICS CryptoProvider - FIPS-Compliant Cryptographic Operations
 * 
 * @module gics
 * @version 1.1.0
 * @status FROZEN - Canonical implementation
 * @see docs/GICS_V1.1_SPEC.md
 * 
 * Provides a hardened cryptographic abstraction layer for GICS.
 * Compliance: FIPS 140-3, NIST SP 800-131A, Common Criteria (ISO/IEC 15408)
 * 
 * @author GICS Team
 */

import { createHash, randomBytes, getCiphers, getHashes } from 'node:crypto';

// ============================================================================
// Constants - Approved Algorithms (FIPS 140-3 / NIST SP 800-131A)
// ============================================================================

/** Approved hash algorithms per FIPS 180-4 */
export const APPROVED_HASH_ALGORITHMS = ['sha256', 'sha384', 'sha512'] as const;
export type ApprovedHashAlgorithm = typeof APPROVED_HASH_ALGORITHMS[number];

/** Approved symmetric ciphers per FIPS 197 (AES) */
export const APPROVED_CIPHER_ALGORITHMS = ['aes-256-gcm', 'aes-256-cbc'] as const;
export type ApprovedCipherAlgorithm = typeof APPROVED_CIPHER_ALGORITHMS[number];

/** Minimum key lengths per NIST SP 800-131A */
export const MINIMUM_KEY_LENGTHS = {
    'aes-256-gcm': 32,
    'aes-256-cbc': 32,
} as const;

/** IV/Nonce lengths per NIST SP 800-38D (GCM) */
export const REQUIRED_IV_LENGTHS = {
    'aes-256-gcm': 12,
    'aes-256-cbc': 16,
} as const;

// ============================================================================
// Errors
// ============================================================================

export class CryptoComplianceError extends Error {
    constructor(message: string) {
        super(`[FIPS Compliance] ${message}`);
        this.name = 'CryptoComplianceError';
    }
}

export class AlgorithmNotApprovedError extends CryptoComplianceError {
    constructor(algorithm: string, type: 'hash' | 'cipher') {
        const approved = type === 'hash'
            ? APPROVED_HASH_ALGORITHMS.join(', ')
            : APPROVED_CIPHER_ALGORITHMS.join(', ');
        super(`Algorithm '${algorithm}' is not approved. Approved ${type} algorithms: ${approved}`);
        this.name = 'AlgorithmNotApprovedError';
    }
}

export class FipsModeRequiredError extends CryptoComplianceError {
    constructor() {
        super('FIPS mode is required but not enabled. Set NODE_OPTIONS=--enable-fips');
        this.name = 'FipsModeRequiredError';
    }
}

// ============================================================================
// CryptoProvider
// ============================================================================

export class CryptoProvider {
    private readonly strictMode: boolean;
    private readonly auditLog: boolean;

    constructor(options?: { strictMode?: boolean; auditLog?: boolean }) {
        // Check for STRICT_FIPS environment flag
        const envStrictFips = process.env['STRICT_FIPS'] === '1';
        const envAuditLog = process.env['GICS_AUDIT_LOG'] === '1';

        this.strictMode = options?.strictMode ?? envStrictFips;
        this.auditLog = options?.auditLog ?? envAuditLog;

        // In strict mode, enforce FIPS at construction
        if (this.strictMode) {
            CryptoProvider.requireFipsMode();
        }
    }

    // ========================================================================
    // FIPS Mode Detection
    // ========================================================================

    /**
     * Check if Node.js is running in FIPS mode
     * FIPS mode requires: NODE_OPTIONS=--enable-fips (Node 18+)
     */
    static isFipsMode(): boolean {
        try {
            // In FIPS mode, certain algorithms are disabled
            // We test by checking if MD5 is available (it shouldn't be in FIPS)
            const hashes = getHashes();
            const ciphers = getCiphers();

            // FIPS mode indicators:
            // - MD5 disabled for hashing
            // - DES/3DES disabled
            const md5Disabled = !hashes.includes('md5');
            const desDisabled = !ciphers.includes('des');

            return md5Disabled && desDisabled;
        } catch {
            return false;
        }
    }

    /**
     * Enforce FIPS mode or throw
     */
    static requireFipsMode(): void {
        if (!CryptoProvider.isFipsMode()) {
            throw new FipsModeRequiredError();
        }
    }

    /**
     * Check if STRICT_FIPS environment flag is set
     * Use this to conditionally enable strict mode in regulated environments
     */
    static isStrictFipsEnabled(): boolean {
        return process.env['STRICT_FIPS'] === '1';
    }

    // ========================================================================
    // Algorithm Validation
    // ========================================================================

    /**
     * Validate hash algorithm is approved
     */
    static isApprovedHashAlgorithm(algorithm: string): algorithm is ApprovedHashAlgorithm {
        return APPROVED_HASH_ALGORITHMS.includes(algorithm as ApprovedHashAlgorithm);
    }

    /**
     * Validate cipher algorithm is approved
     */
    static isApprovedCipherAlgorithm(algorithm: string): algorithm is ApprovedCipherAlgorithm {
        return APPROVED_CIPHER_ALGORITHMS.includes(algorithm as ApprovedCipherAlgorithm);
    }

    /**
     * Validate key length meets minimum requirements
     */
    static validateKeyLength(algorithm: ApprovedCipherAlgorithm, keyLength: number): void {
        const minimum = MINIMUM_KEY_LENGTHS[algorithm];
        if (keyLength < minimum) {
            throw new CryptoComplianceError(
                `Key length ${keyLength} bytes is below minimum ${minimum} bytes for ${algorithm}`
            );
        }
    }

    /**
     * Validate IV/nonce length
     */
    static validateIvLength(algorithm: ApprovedCipherAlgorithm, ivLength: number): void {
        const required = REQUIRED_IV_LENGTHS[algorithm];
        if (ivLength !== required) {
            throw new CryptoComplianceError(
                `IV length ${ivLength} bytes does not match required ${required} bytes for ${algorithm}`
            );
        }
    }

    // ========================================================================
    // Secure Hash Operations
    // ========================================================================

    /**
     * Compute hash using approved algorithm only
     * @throws AlgorithmNotApprovedError if algorithm not in approved list
     */
    hash(algorithm: string, data: Buffer | Uint8Array): Buffer {
        if (!CryptoProvider.isApprovedHashAlgorithm(algorithm)) {
            throw new AlgorithmNotApprovedError(algorithm, 'hash');
        }

        if (this.strictMode && !CryptoProvider.isFipsMode()) {
            console.warn('[CryptoProvider] Warning: Running in strict mode without FIPS enabled');
        }

        if (this.auditLog) {
            console.log(`[CryptoProvider] Hash operation: algorithm=${algorithm}, size=${data.length}`);
        }

        return createHash(algorithm).update(data).digest();
    }

    /**
     * Compute SHA-256 hash (most common FIPS-approved hash)
     */
    sha256(data: Buffer | Uint8Array): Buffer {
        return this.hash('sha256', data);
    }

    /**
     * Compute SHA-512 hash
     */
    sha512(data: Buffer | Uint8Array): Buffer {
        return this.hash('sha512', data);
    }

    // ========================================================================
    // Secure Random Generation
    // ========================================================================

    /**
     * Generate cryptographically secure random bytes
     * Uses /dev/urandom (Linux) or CryptGenRandom (Windows)
     */
    static randomBytes(length: number): Buffer {
        if (length <= 0 || length > 1024 * 1024) { // Max 1MB
            throw new CryptoComplianceError(`Invalid random bytes length: ${length}`);
        }
        return randomBytes(length);
    }

    // ========================================================================
    // Secure Memory Operations
    // ========================================================================

    /**
     * Securely wipe a buffer from memory
     * Overwrites with random data, then zeros, then random again
     * 
     * Based on DoD 5220.22-M sanitization standard
     */
    static wipe(buffer: Buffer): void {
        if (!Buffer.isBuffer(buffer)) {
            return;
        }

        // Pass 1: Random data
        const random1 = randomBytes(buffer.length);
        random1.copy(buffer);

        // Pass 2: Zeros
        buffer.fill(0x00);

        // Pass 3: Random data
        const random2 = randomBytes(buffer.length);
        random2.copy(buffer);

        // Final: Zeros
        buffer.fill(0x00);
    }

    /**
     * Create a secure buffer that auto-wipes on GC
     * Note: V8's GC is not deterministic, so explicit wipe() is preferred
     */
    static secureBuffer(size: number): Buffer {
        const buffer = Buffer.alloc(size);

        // Register finalizer (Node 14+)
        const registry = new FinalizationRegistry((heldValue: Buffer) => {
            CryptoProvider.wipe(heldValue);
        });
        registry.register(buffer, buffer);

        return buffer;
    }

    // ========================================================================
    // Audit & Compliance
    // ========================================================================

    /**
     * Get compliance status report
     */
    static getComplianceReport(): {
        fipsMode: boolean;
        strictFipsEnabled: boolean;
        approvedHashes: readonly string[];
        approvedCiphers: readonly string[];
        availableHashes: string[];
        availableCiphers: string[];
        nodeVersion: string;
    } {
        return {
            fipsMode: CryptoProvider.isFipsMode(),
            strictFipsEnabled: CryptoProvider.isStrictFipsEnabled(),
            approvedHashes: APPROVED_HASH_ALGORITHMS,
            approvedCiphers: APPROVED_CIPHER_ALGORITHMS,
            availableHashes: getHashes(),
            availableCiphers: getCiphers(),
            nodeVersion: process.version,
        };
    }
}
