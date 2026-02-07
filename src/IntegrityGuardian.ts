/**
 * GICS IntegrityGuardian - Infrastructure-Grade File Integrity
 * 
 * @module gics
 * @version 1.1.0
 * @status FROZEN - Canonical implementation
 * @see docs/GICS_V1.1_SPEC.md
 * 
 * Provides SHA-256 based verification for GICS files beyond CRC32.
 * Use cases: Cloud sync verification, long-term archive validation, tamper detection.
 * 
 * @author GICS Team
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';

// ============================================================================
// Configuration
// ============================================================================

export interface IntegrityConfig {
    /** Hash algorithm (default: sha256) */
    algorithm?: 'sha256' | 'sha512';
    /** Save manifest alongside GICS files (default: true) */
    saveManifest?: boolean;
}

export interface FileIntegrityRecord {
    /** File path (relative or absolute) */
    path: string;
    /** File size in bytes */
    size: number;
    /** SHA-256 hash of file contents */
    hash: string;
    /** Algorithm used */
    algorithm: string;
    /** Timestamp of last verification */
    verifiedAt: number;
}

export interface IntegrityManifest {
    /** Version of manifest format */
    version: 1;
    /** When manifest was created */
    createdAt: number;
    /** Map of filename → integrity record */
    files: Record<string, FileIntegrityRecord>;
}

export interface VerificationResult {
    /** Did all files pass verification? */
    valid: boolean;
    /** Files that passed */
    passed: string[];
    /** Files that failed with reason */
    failed: Array<{ path: string; reason: string }>;
    /** Total time taken in ms */
    durationMs: number;
}

// ============================================================================
// IntegrityGuardian
// ============================================================================

export class IntegrityGuardian {
    private readonly algorithm: 'sha256' | 'sha512';
    private readonly saveManifest: boolean;

    constructor(config?: IntegrityConfig) {
        this.algorithm = config?.algorithm ?? 'sha256';
        this.saveManifest = config?.saveManifest ?? true;
    }

    /**
     * Calculate hash of a buffer
     */
    hashBuffer(data: Uint8Array | Buffer): string {
        return createHash(this.algorithm).update(data).digest('hex');
    }

    /**
     * Calculate hash of a file
     */
    async hashFile(filePath: string): Promise<FileIntegrityRecord> {
        const data = await fs.readFile(filePath);
        const stats = await fs.stat(filePath);

        return {
            path: filePath,
            size: stats.size,
            hash: this.hashBuffer(data),
            algorithm: this.algorithm,
            verifiedAt: Date.now()
        };
    }

    /**
     * Create integrity manifest for a directory of GICS files
     */
    async createManifest(directory: string): Promise<IntegrityManifest> {
        const files = await fs.readdir(directory);
        const gicsFiles = files.filter(f => f.endsWith('.gics'));

        const manifest: IntegrityManifest = {
            version: 1,
            createdAt: Date.now(),
            files: {}
        };

        for (const filename of gicsFiles) {
            const filePath = `${directory}/${filename}`;
            const record = await this.hashFile(filePath);
            manifest.files[filename] = record;
        }

        if (this.saveManifest) {
            const manifestPath = `${directory}/gics.manifest.json`;
            await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
        }

        return manifest;
    }

    /**
     * Verify files against a manifest
     */
    async verifyManifest(
        manifest: IntegrityManifest,
        directory: string
    ): Promise<VerificationResult> {
        const start = Date.now();
        const passed: string[] = [];
        const failed: Array<{ path: string; reason: string }> = [];

        for (const [filename, expected] of Object.entries(manifest.files)) {
            const filePath = `${directory}/${filename}`;

            try {
                const actual = await this.hashFile(filePath);

                if (actual.hash === expected.hash) {
                    if (actual.size !== expected.size) {
                        failed.push({
                            path: filename,
                            reason: `Size mismatch: expected ${expected.size}, got ${actual.size}`
                        });
                    } else {
                        passed.push(filename);
                    }
                } else {
                    failed.push({
                        path: filename,
                        reason: `Hash mismatch: expected ${expected.hash.substring(0, 16)}..., got ${actual.hash.substring(0, 16)}...`
                    });
                }
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Unknown error';
                failed.push({ path: filename, reason: `File read error: ${message}` });
            }
        }

        return {
            valid: failed.length === 0,
            passed,
            failed,
            durationMs: Date.now() - start
        };
    }

    /**
     * Load manifest from file
     */
    async loadManifest(manifestPath: string): Promise<IntegrityManifest> {
        const content = await fs.readFile(manifestPath, 'utf-8');
        return JSON.parse(content) as IntegrityManifest;
    }

    /**
     * Quick verification of a single file against expected hash
     */
    async verifyFile(filePath: string, expectedHash: string): Promise<boolean> {
        try {
            const record = await this.hashFile(filePath);
            return record.hash === expectedHash;
        } catch {
            return false;
        }
    }

    /**
     * Verify in-memory buffer against expected hash
     */
    verifyBuffer(data: Uint8Array | Buffer, expectedHash: string): boolean {
        return this.hashBuffer(data) === expectedHash;
    }
}
