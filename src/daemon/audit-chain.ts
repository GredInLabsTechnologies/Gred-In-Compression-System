/**
 * AuditChain — Phase 7: Merkle Hash Chain
 *
 * Append-only log con hash encadenado para auditabilidad tamper-evident.
 * Cada mutación genera un AuditEntry con SHA-256 encadenado.
 */

import * as fs from 'fs/promises';
import { createHash } from 'crypto';
import { existsSync, createWriteStream, WriteStream } from 'fs';

export interface AuditEntry {
    sequence: number;
    timestamp: number;
    actor: string;
    action: string;
    target: string;
    payload: string;
    prevHash: string;
    hash: string;
}

export interface MerkleCheckpoint {
    sequence: number;
    timestamp: number;
    merkleRoot: string;
    batchSize: number;
}

export interface AuditChainConfig {
    filePath: string;
    checkpointInterval?: number; // default: 1000
}

function sha256(input: string): string {
    return createHash('sha256').update(input, 'utf8').digest('hex');
}

function computeEntryHash(entry: Omit<AuditEntry, 'hash'>): string {
    const canonical = [
        entry.sequence,
        entry.timestamp,
        entry.actor,
        entry.action,
        entry.target,
        entry.payload,
        entry.prevHash,
    ].join('|');
    return sha256(canonical);
}

function computeMerkleRoot(hashes: string[]): string {
    if (hashes.length === 0) return sha256('');
    if (hashes.length === 1) return hashes[0];

    const nextLevel: string[] = [];
    for (let i = 0; i < hashes.length; i += 2) {
        const left = hashes[i];
        const right = i + 1 < hashes.length ? hashes[i + 1] : left;
        nextLevel.push(sha256(left + right));
    }
    return computeMerkleRoot(nextLevel);
}

export class AuditChain {
    private readonly filePath: string;
    private readonly checkpointPath: string;
    private readonly checkpointInterval: number;
    private writeStream: WriteStream | null = null;
    private sequence = 0;
    private prevHash = '';
    private batchHashes: string[] = [];
    private initPromise: Promise<void> | null = null;
    private totalEntries = 0;
    private lastVerifyResult: { valid: boolean; corrupted: number[] } | null = null;

    constructor(config: AuditChainConfig) {
        this.filePath = config.filePath;
        this.checkpointPath = `${config.filePath}.ckpt`;
        this.checkpointInterval = config.checkpointInterval ?? 1000;
    }

    async initialize(): Promise<void> {
        if (this.initPromise) return this.initPromise;
        this.initPromise = this._initialize();
        return this.initPromise;
    }

    private async _initialize(): Promise<void> {
        if (existsSync(this.filePath)) {
            const raw = await fs.readFile(this.filePath, 'utf8');
            const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
            this.totalEntries = 0;
            for (const line of lines) {
                try {
                    const entry = JSON.parse(line) as AuditEntry;
                    this.totalEntries++;
                    if (entry.sequence > this.sequence) {
                        this.sequence = entry.sequence;
                        this.prevHash = entry.hash;
                    }
                } catch {
                    // Corrupted line, skip
                }
            }
        }

        this.writeStream = createWriteStream(this.filePath, { flags: 'a' });
    }

    async append(
        actor: string,
        action: string,
        target: string,
        payload: Record<string, any>
    ): Promise<AuditEntry> {
        await this.initialize();

        const payloadStr = JSON.stringify(payload);
        const payloadHash = payloadStr.length > 1024 ? sha256(payloadStr) : payloadStr;

        const entry: Omit<AuditEntry, 'hash'> = {
            sequence: ++this.sequence,
            timestamp: Date.now(),
            actor,
            action,
            target,
            payload: payloadHash,
            prevHash: this.prevHash,
        };

        const hash = computeEntryHash(entry);
        const fullEntry: AuditEntry = { ...entry, hash };

        this.prevHash = hash;
        this.batchHashes.push(hash);
        this.totalEntries++;

        return new Promise((resolve, reject) => {
            this.writeStream!.write(JSON.stringify(fullEntry) + '\n', (err) => {
                if (err) return reject(err);
                this.maybeCheckpoint().catch(() => {}); // Best-effort
                resolve(fullEntry);
            });
        });
    }

    private async maybeCheckpoint(): Promise<void> {
        if (this.batchHashes.length < this.checkpointInterval) return;

        const merkleRoot = computeMerkleRoot(this.batchHashes);
        const checkpoint: MerkleCheckpoint = {
            sequence: this.sequence,
            timestamp: Date.now(),
            merkleRoot,
            batchSize: this.batchHashes.length,
        };

        await fs.appendFile(this.checkpointPath, JSON.stringify(checkpoint) + '\n', 'utf8');
        this.batchHashes = [];
    }

    async verify(): Promise<{ valid: boolean; totalEntries: number; corrupted: number[]; chainBroken: boolean }> {
        await this.initialize();

        if (!existsSync(this.filePath)) {
            return { valid: true, totalEntries: 0, corrupted: [], chainBroken: false };
        }

        const raw = await fs.readFile(this.filePath, 'utf8');
        const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);

        let expectedPrevHash = '';
        const corrupted: number[] = [];
        let chainBroken = false;

        for (const line of lines) {
            try {
                const entry = JSON.parse(line) as AuditEntry;
                const recomputed = computeEntryHash({
                    sequence: entry.sequence,
                    timestamp: entry.timestamp,
                    actor: entry.actor,
                    action: entry.action,
                    target: entry.target,
                    payload: entry.payload,
                    prevHash: entry.prevHash,
                });

                if (recomputed !== entry.hash) {
                    corrupted.push(entry.sequence);
                }

                if (entry.prevHash !== expectedPrevHash) {
                    chainBroken = true;
                }

                expectedPrevHash = entry.hash;
            } catch {
                // Invalid JSON, skip
            }
        }

        const result = {
            valid: corrupted.length === 0 && !chainBroken,
            totalEntries: lines.length,
            corrupted,
            chainBroken,
        };
        this.lastVerifyResult = { valid: result.valid, corrupted: [...result.corrupted] };
        return result;
    }

    getQuickStats(): { totalEntries: number; lastVerifyValid: boolean | null } {
        return {
            totalEntries: this.totalEntries,
            lastVerifyValid: this.lastVerifyResult?.valid ?? null,
        };
    }

    async export(): Promise<string[]> {
        await this.initialize();

        if (!existsSync(this.filePath)) return [];

        const raw = await fs.readFile(this.filePath, 'utf8');
        return raw.split('\n').map(l => l.trim()).filter(Boolean);
    }

    async close(): Promise<void> {
        if (!this.writeStream) return;
        return new Promise((resolve) => {
            this.writeStream!.end(() => {
                this.writeStream = null;
                resolve();
            });
        });
    }
}
