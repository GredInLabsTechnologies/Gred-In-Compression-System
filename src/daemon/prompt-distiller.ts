/**
 * PromptDistiller — Phase 1.3.3 Feature: Retention + Compression
 *
 * Implements a 3-tier retention policy for volatile data (prompts, traces, logs):
 * - RAW (0-7 days): Full data, instant access
 * - COMPRESSED (7-30 days): Delta-encoded + zstd, <10ms access
 * - DISTILLED (30+ days): Metadata only (~200 bytes), permanent
 *
 * Features:
 * - Emergency purge when disk > 90%
 * - READ-ONLY mode during disk full
 * - Reversible compression (RAW → COMPRESSED)
 * - Irreversible distillation (COMPRESSED → DISTILLED)
 */

import * as fs from 'fs/promises';
import { existsSync, statSync, readdirSync } from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { ZstdCodec } from 'zstd-codec';

interface ZstdSimple {
    compress(data: Uint8Array, level: number): Uint8Array | null;
    decompress(data: Uint8Array): Uint8Array | null;
}

interface ZstdInstance {
    Simple: new () => ZstdSimple;
}

let zstdInstance: ZstdInstance | null = null;

async function getZstd(): Promise<ZstdInstance> {
    if (zstdInstance) return zstdInstance;
    return new Promise((resolve) => {
        ZstdCodec.run((zstd: ZstdInstance) => {
            zstdInstance = zstd;
            resolve(zstd);
        });
    });
}

async function zstdCompress(data: Uint8Array, level: number = 3): Promise<Uint8Array> {
    const zstd = await getZstd();
    const simple = new zstd.Simple();
    const compressed = simple.compress(data, level);
    if (!compressed) throw new Error('Zstd compression failed');
    return compressed;
}

async function zstdDecompress(data: Uint8Array): Promise<Uint8Array> {
    const zstd = await getZstd();
    const simple = new zstd.Simple();
    const decompressed = simple.decompress(data);
    if (!decompressed) throw new Error('Zstd decompression failed');
    return decompressed;
}

/**
 * Decompress data, auto-detecting format (zstd or legacy gzip).
 * Zstd magic: 0x28 0xB5 0x2F 0xFD
 * Gzip magic: 0x1F 0x8B
 */
async function decompressAuto(data: Uint8Array): Promise<Uint8Array> {
    if (data.length >= 4 && data[0] === 0x28 && data[1] === 0xB5 && data[2] === 0x2F && data[3] === 0xFD) {
        return zstdDecompress(data);
    }
    if (data.length >= 2 && data[0] === 0x1F && data[1] === 0x8B) {
        // Legacy gzip format — decompress using zlib
        const { gunzipSync } = await import('zlib');
        return new Uint8Array(gunzipSync(Buffer.from(data)));
    }
    throw new Error('Unknown compressed format (neither zstd nor gzip)');
}

export interface DistilledRecord {
    originalKey: string;
    timestamp: number;
    contentHash: string;  // SHA-256 of original content
    tokenCount: number;
    modelUsed: string;
    taskType: string;
    success: boolean;
    latencyMs: number;
    costUsd: number;
}

export interface PromptRecord {
    key: string;
    content: string;
    metadata: {
        tokenCount: number;
        modelUsed: string;
        taskType: string;
        success: boolean;
        latencyMs: number;
        costUsd: number;
    };
    timestamp: number;
}

export interface PromptDistillerConfig {
    dataPath: string;
    rawRetentionMs?: number;        // 0-7 days default
    compressedRetentionMs?: number; // 7-30 days default
    diskCheckIntervalMs?: number;   // 5 minutes default
    diskThresholdPercent?: number;  // 90% default
    emergencyPurgeEnabled?: boolean; // true default
    autoClassifyOnInit?: boolean;    // true default - classify existing data on initialize
    maxDiskUsageMB?: number;         // 500 default - fallback limit for own directories
}

export interface TierStats {
    tier: 'raw' | 'compressed' | 'distilled';
    recordCount: number;
    sizeBytes: number;
    oldestTimestamp: number;
    newestTimestamp: number;
}

export interface PurgeResult {
    purged: boolean;
    reason?: string;
    bytesFreed: number;
    recordsRemoved: number;
    recordsCompressed: number;
    recordsDistilled: number;
    durationMs: number;
}

const RAW_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;      // 7 days
const COMPRESSED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const DISK_CHECK_INTERVAL_MS = 5 * 60 * 1000;          // 5 minutes
const DISK_THRESHOLD_PERCENT = 90;

export class PromptDistiller {
    private readonly rawDir: string;
    private readonly compressedDir: string;
    private readonly distilledDir: string;
    private readonly rawRetentionMs: number;
    private readonly compressedRetentionMs: number;
    private readonly diskCheckIntervalMs: number;
    private readonly diskThresholdPercent: number;
    private readonly emergencyPurgeEnabled: boolean;
    private readonly autoClassifyOnInit: boolean;
    private readonly maxDiskUsageMB: number;
    private isReadOnly = false;
    private diskCheckTimer: NodeJS.Timeout | null = null;
    private lastDiskCheck = 0;

    constructor(config: PromptDistillerConfig) {
        this.rawDir = path.join(config.dataPath, 'distiller-raw');
        this.compressedDir = path.join(config.dataPath, 'distiller-compressed');
        this.distilledDir = path.join(config.dataPath, 'distiller-distilled');
        this.rawRetentionMs = config.rawRetentionMs ?? RAW_RETENTION_MS;
        this.compressedRetentionMs = config.compressedRetentionMs ?? COMPRESSED_RETENTION_MS;
        this.diskCheckIntervalMs = config.diskCheckIntervalMs ?? DISK_CHECK_INTERVAL_MS;
        this.diskThresholdPercent = config.diskThresholdPercent ?? DISK_THRESHOLD_PERCENT;
        this.emergencyPurgeEnabled = config.emergencyPurgeEnabled ?? true;
        this.autoClassifyOnInit = config.autoClassifyOnInit ?? true;
        this.maxDiskUsageMB = config.maxDiskUsageMB ?? 500;
    }

    async initialize(): Promise<void> {
        await fs.mkdir(this.rawDir, { recursive: true });
        await fs.mkdir(this.compressedDir, { recursive: true });
        await fs.mkdir(this.distilledDir, { recursive: true });

        // Classify existing data on first run (if enabled)
        if (this.autoClassifyOnInit) {
            await this.classifyExistingData();
        }

        // Start periodic disk check
        if (this.emergencyPurgeEnabled) {
            this.startDiskMonitoring();
        }
    }

    async stop(): Promise<void> {
        if (this.diskCheckTimer) {
            clearInterval(this.diskCheckTimer);
            this.diskCheckTimer = null;
        }
    }

    /**
     * Store a new prompt record in RAW tier
     */
    async store(record: PromptRecord): Promise<void> {
        if (this.isReadOnly) {
            throw new Error('PromptDistiller is in READ-ONLY mode due to disk space');
        }

        const fileName = `${record.timestamp}-${this.sanitizeKey(record.key)}.json`;
        const filePath = path.join(this.rawDir, fileName);

        try {
            await fs.writeFile(filePath, JSON.stringify(record), 'utf8');
        } catch (err: any) {
            // If disk full during write, enter READ-ONLY mode
            if (err.code === 'ENOSPC') {
                this.isReadOnly = true;
                throw new Error('Disk full: PromptDistiller entering READ-ONLY mode');
            }
            throw err;
        }
    }

    /**
     * Retrieve a record (searches all tiers)
     */
    async retrieve(key: string, timestamp?: number): Promise<PromptRecord | DistilledRecord | null> {
        // Try RAW first (fastest)
        const rawResult = await this.searchTier('raw', key, timestamp);
        if (rawResult) return rawResult;

        // Try COMPRESSED (decompress)
        const compressedResult = await this.searchTier('compressed', key, timestamp);
        if (compressedResult) return compressedResult;

        // Try DISTILLED (metadata only)
        const distilledResult = await this.searchTier('distilled', key, timestamp);
        return distilledResult;
    }

    /**
     * Get statistics for all tiers
     */
    async getStats(): Promise<TierStats[]> {
        const stats: TierStats[] = [];

        for (const tier of ['raw', 'compressed', 'distilled'] as const) {
            const tierStats = await this.getTierStats(tier);
            stats.push(tierStats);
        }

        return stats;
    }

    /**
     * Run retention policy (compress old RAW, distill old COMPRESSED)
     */
    async runRetentionPolicy(): Promise<{
        compressed: number;
        distilled: number;
        bytesFreed: number;
    }> {
        const now = Date.now();
        let compressed = 0;
        let distilled = 0;
        let bytesFreed = 0;

        // Phase 1: RAW → COMPRESSED (7+ days old)
        const rawFiles = await this.listFiles(this.rawDir);
        for (const file of rawFiles) {
            const filePath = path.join(this.rawDir, file);
            const stats = statSync(filePath);

            // Use timestamp from filename, not mtime
            const timestamp = this.extractTimestamp(file);
            const age = now - timestamp;

            if (age >= this.rawRetentionMs) {
                const beforeSize = stats.size;
                await this.compressRecord(filePath);
                compressed++;
                bytesFreed += beforeSize;
            }
        }

        // Phase 2: COMPRESSED → DISTILLED (30+ days old)
        const compressedFiles = await this.listFiles(this.compressedDir);
        for (const file of compressedFiles) {
            const filePath = path.join(this.compressedDir, file);
            const stats = statSync(filePath);

            // Use timestamp from filename, not mtime
            const timestamp = this.extractTimestamp(file);
            const age = now - timestamp;

            if (age >= this.compressedRetentionMs) {
                const beforeSize = stats.size;
                await this.distillRecord(filePath);
                distilled++;
                bytesFreed += beforeSize;
            }
        }

        return { compressed, distilled, bytesFreed };
    }

    /**
     * Emergency purge when disk > threshold
     */
    async emergencyPurge(): Promise<PurgeResult> {
        const start = Date.now();
        const diskUsage = await this.getDiskUsagePercent();

        if (diskUsage < this.diskThresholdPercent) {
            return {
                purged: false,
                reason: 'disk_usage_below_threshold',
                bytesFreed: 0,
                recordsRemoved: 0,
                recordsCompressed: 0,
                recordsDistilled: 0,
                durationMs: Date.now() - start
            };
        }

        let bytesFreed = 0;
        let recordsRemoved = 0;
        let recordsCompressed = 0;
        let recordsDistilled = 0;

        // Step 1: Compress all RAW > 3 days
        const now = Date.now();
        const rawFiles = await this.listFiles(this.rawDir);
        for (const file of rawFiles) {
            const filePath = path.join(this.rawDir, file);
            const stats = statSync(filePath);

            // Use timestamp from filename, not mtime
            const timestamp = this.extractTimestamp(file);
            const age = now - timestamp;

            if (age >= 3 * 24 * 60 * 60 * 1000) { // 3 days
                const beforeSize = stats.size;
                await this.compressRecord(filePath);
                recordsCompressed++;
                bytesFreed += beforeSize;
            }
        }

        // Check again
        const diskUsage2 = await this.getDiskUsagePercent();
        if (diskUsage2 < this.diskThresholdPercent) {
            return {
                purged: true,
                reason: 'compressed_raw_3d',
                bytesFreed,
                recordsRemoved,
                recordsCompressed,
                recordsDistilled,
                durationMs: Date.now() - start
            };
        }

        // Step 2: Distill all COMPRESSED > 15 days
        const compressedFiles = await this.listFiles(this.compressedDir);
        for (const file of compressedFiles) {
            const filePath = path.join(this.compressedDir, file);
            const stats = statSync(filePath);

            // Use timestamp from filename, not mtime
            const timestamp = this.extractTimestamp(file);
            const age = now - timestamp;

            if (age >= 15 * 24 * 60 * 60 * 1000) { // 15 days
                const beforeSize = stats.size;
                await this.distillRecord(filePath);
                recordsDistilled++;
                bytesFreed += beforeSize;
            }
        }

        // Check again
        const diskUsage3 = await this.getDiskUsagePercent();
        if (diskUsage3 < this.diskThresholdPercent) {
            return {
                purged: true,
                reason: 'distilled_compressed_15d',
                bytesFreed,
                recordsRemoved,
                recordsCompressed,
                recordsDistilled,
                durationMs: Date.now() - start
            };
        }

        // Step 3: Aggregate distilled records (weekly groups)
        const distilledFiles = await this.listFiles(this.distilledDir);
        const weekGroups = new Map<number, string[]>();

        for (const file of distilledFiles) {
            const timestamp = this.extractTimestamp(file);
            const week = Math.floor(timestamp / (7 * 24 * 60 * 60 * 1000));
            if (!weekGroups.has(week)) weekGroups.set(week, []);
            weekGroups.get(week)!.push(file);
        }

        for (const [_week, files] of weekGroups) {
            if (files.length > 1) {
                // Aggregate into single file
                const aggregated: DistilledRecord[] = [];
                for (const file of files) {
                    const filePath = path.join(this.distilledDir, file);
                    const content = await fs.readFile(filePath, 'utf8');
                    const record = JSON.parse(content) as DistilledRecord;
                    aggregated.push(record);
                    await fs.unlink(filePath);
                    recordsRemoved++;
                }

                // Write aggregated file
                const firstTimestamp = Math.min(...aggregated.map(r => r.timestamp));
                const aggFileName = `${firstTimestamp}-aggregated.json`;
                const aggFilePath = path.join(this.distilledDir, aggFileName);
                await fs.writeFile(aggFilePath, JSON.stringify(aggregated), 'utf8');
            }
        }

        return {
            purged: true,
            reason: 'full_emergency_purge',
            bytesFreed,
            recordsRemoved,
            recordsCompressed,
            recordsDistilled,
            durationMs: Date.now() - start
        };
    }

    get readOnly(): boolean {
        return this.isReadOnly;
    }

    // --- Private Methods ---

    private async compressRecord(rawFilePath: string): Promise<void> {
        try {
            const content = await fs.readFile(rawFilePath, 'utf8');
            const record = JSON.parse(content) as PromptRecord;

            // Compress with zstd (aligned with architecture spec)
            const compressed = await zstdCompress(Buffer.from(content, 'utf8'));

            // Preserve timestamp in filename
            const baseName = path.basename(rawFilePath, '.json');
            const fileName = `${baseName}.zst`;
            const compressedPath = path.join(this.compressedDir, fileName);

            await fs.writeFile(compressedPath, compressed);
            await fs.unlink(rawFilePath);
        } catch (err) {
            console.warn(`[PromptDistiller] Failed to compress ${rawFilePath}:`, err);
            // On failure, data stays in RAW tier (safe)
        }
    }

    private async distillRecord(compressedFilePath: string): Promise<void> {
        try {
            const compressed = await fs.readFile(compressedFilePath);
            const decompressed = await decompressAuto(new Uint8Array(compressed));
            const content = Buffer.from(decompressed).toString('utf8');
            const record = JSON.parse(content) as PromptRecord;

            const distilled: DistilledRecord = {
                originalKey: record.key,
                timestamp: record.timestamp,
                contentHash: createHash('sha256').update(record.content).digest('hex'),
                tokenCount: record.metadata.tokenCount,
                modelUsed: record.metadata.modelUsed,
                taskType: record.metadata.taskType,
                success: record.metadata.success,
                latencyMs: record.metadata.latencyMs,
                costUsd: record.metadata.costUsd
            };

            // Preserve timestamp in filename — strip both .zst and legacy .gz
            const ext = compressedFilePath.endsWith('.gz') ? '.gz' : '.zst';
            const baseName = path.basename(compressedFilePath, ext);
            const fileName = `${baseName}.distilled.json`;
            const distilledPath = path.join(this.distilledDir, fileName);

            await fs.writeFile(distilledPath, JSON.stringify(distilled), 'utf8');
            await fs.unlink(compressedFilePath);
        } catch (err) {
            console.warn(`[PromptDistiller] Failed to distill ${compressedFilePath}:`, err);
            // On failure, data stays in COMPRESSED tier (safe)
        }
    }

    private async searchTier(
        tier: 'raw' | 'compressed' | 'distilled',
        key: string,
        timestamp?: number
    ): Promise<PromptRecord | DistilledRecord | null> {
        const dir = tier === 'raw' ? this.rawDir : tier === 'compressed' ? this.compressedDir : this.distilledDir;
        const files = await this.listFiles(dir);

        for (const file of files) {
            if (timestamp && !file.startsWith(`${timestamp}-`)) continue;
            if (!file.includes(this.sanitizeKey(key))) continue;

            const filePath = path.join(dir, file);

            try {
                if (tier === 'raw') {
                    const content = await fs.readFile(filePath, 'utf8');
                    return JSON.parse(content) as PromptRecord;
                } else if (tier === 'compressed') {
                    const compressed = await fs.readFile(filePath);
                    const decompressed = await decompressAuto(new Uint8Array(compressed));
                    const content = Buffer.from(decompressed).toString('utf8');
                    return JSON.parse(content) as PromptRecord;
                } else {
                    const content = await fs.readFile(filePath, 'utf8');
                    const parsed = JSON.parse(content);
                    // Could be single or array (aggregated)
                    if (Array.isArray(parsed)) {
                        return parsed.find(r => r.originalKey === key) ?? null;
                    }
                    return parsed as DistilledRecord;
                }
            } catch {
                continue;
            }
        }

        return null;
    }

    private async getTierStats(tier: 'raw' | 'compressed' | 'distilled'): Promise<TierStats> {
        const dir = tier === 'raw' ? this.rawDir : tier === 'compressed' ? this.compressedDir : this.distilledDir;
        const allFiles = await this.listFiles(dir);

        // Filter files by tier type
        const files = allFiles.filter(f => {
            if (tier === 'raw') return f.endsWith('.json') && !f.includes('aggregated') && !f.includes('distilled');
            if (tier === 'compressed') return f.endsWith('.zst') || f.endsWith('.gz');
            if (tier === 'distilled') return f.endsWith('.distilled.json') || f.includes('aggregated');
            return false;
        });

        let recordCount = 0;
        let sizeBytes = 0;
        let oldestTimestamp = Infinity;
        let newestTimestamp = 0;

        for (const file of files) {
            const filePath = path.join(dir, file);
            const stats = statSync(filePath);
            sizeBytes += stats.size;

            const timestamp = this.extractTimestamp(file);
            if (timestamp < oldestTimestamp) oldestTimestamp = timestamp;
            if (timestamp > newestTimestamp) newestTimestamp = timestamp;

            // Count records (aggregated files may contain multiple)
            if (file.includes('aggregated')) {
                try {
                    const content = await fs.readFile(filePath, 'utf8');
                    const parsed = JSON.parse(content);
                    recordCount += Array.isArray(parsed) ? parsed.length : 1;
                } catch {
                    recordCount++;
                }
            } else {
                recordCount++;
            }
        }

        return {
            tier,
            recordCount,
            sizeBytes,
            oldestTimestamp: oldestTimestamp === Infinity ? 0 : oldestTimestamp,
            newestTimestamp
        };
    }

    private async listFiles(dir: string): Promise<string[]> {
        try {
            return await fs.readdir(dir);
        } catch {
            return [];
        }
    }

    private async getDiskUsagePercent(): Promise<number> {
        try {
            // Primary: use fs.statfs (Node 18.15+)
            const fsStats = await fs.statfs(this.rawDir);
            if (fsStats.blocks > 0) {
                return (1 - fsStats.bfree / fsStats.blocks) * 100;
            }
        } catch {
            // statfs not available or failed — fall through to fallback
        }

        try {
            // Fallback: sum own directory sizes vs maxDiskUsageMB
            const totalBytes = this.sumDirSizeSync(this.rawDir)
                + this.sumDirSizeSync(this.compressedDir)
                + this.sumDirSizeSync(this.distilledDir);
            const limitBytes = this.maxDiskUsageMB * 1024 * 1024;
            if (limitBytes <= 0) return 0;
            return (totalBytes / limitBytes) * 100;
        } catch {
            return 0;
        }
    }

    private sumDirSizeSync(dir: string): number {
        if (!existsSync(dir)) return 0;
        let total = 0;
        for (const file of readdirSync(dir)) {
            try {
                total += statSync(path.join(dir, file)).size;
            } catch { /* skip unreadable files */ }
        }
        return total;
    }

    private sanitizeKey(key: string): string {
        return key.replace(/[^a-zA-Z0-9_-]/g, '_');
    }

    private extractTimestamp(fileName: string): number {
        const match = fileName.match(/^(\d+)-/);
        return match ? parseInt(match[1], 10) : 0;
    }

    private async classifyExistingData(): Promise<void> {
        // On first run, classify any existing files into correct tiers
        const now = Date.now();

        // Check RAW for old files
        const rawFiles = await this.listFiles(this.rawDir);
        for (const file of rawFiles) {
            const filePath = path.join(this.rawDir, file);

            // Use timestamp from filename, not mtime
            const timestamp = this.extractTimestamp(file);
            const age = now - timestamp;

            if (age >= this.rawRetentionMs && age < this.compressedRetentionMs) {
                await this.compressRecord(filePath);
            } else if (age >= this.compressedRetentionMs) {
                // Direct to distilled
                await this.compressRecord(filePath);
                const compressedPath = path.join(this.compressedDir, file.replace('.json', '.zst'));
                if (existsSync(compressedPath)) {
                    await this.distillRecord(compressedPath);
                }
            }
        }

        // Check COMPRESSED for old files
        const compressedFiles = await this.listFiles(this.compressedDir);
        for (const file of compressedFiles) {
            const filePath = path.join(this.compressedDir, file);

            // Use timestamp from filename, not mtime
            const timestamp = this.extractTimestamp(file);
            const age = now - timestamp;

            if (age >= this.compressedRetentionMs) {
                await this.distillRecord(filePath);
            }
        }
    }

    private startDiskMonitoring(): void {
        this.diskCheckTimer = setInterval(async () => {
            const now = Date.now();
            if (now - this.lastDiskCheck < this.diskCheckIntervalMs) return;

            this.lastDiskCheck = now;
            const diskUsage = await this.getDiskUsagePercent();

            if (diskUsage >= this.diskThresholdPercent) {
                console.warn(`[PromptDistiller] Disk usage at ${diskUsage}% - triggering emergency purge`);
                const result = await this.emergencyPurge();
                console.log(`[PromptDistiller] Emergency purge completed: ${JSON.stringify(result)}`);

                // If still full after purge, enter READ-ONLY
                const postPurgeDiskUsage = await this.getDiskUsagePercent();
                if (postPurgeDiskUsage >= this.diskThresholdPercent) {
                    this.isReadOnly = true;
                    console.error('[PromptDistiller] READ-ONLY mode: disk still full after emergency purge');
                }
            } else if (this.isReadOnly && diskUsage < this.diskThresholdPercent - 10) {
                // Exit READ-ONLY when disk usage drops below threshold - 10%
                this.isReadOnly = false;
                console.log('[PromptDistiller] Exiting READ-ONLY mode: disk space recovered');
            }
        }, this.diskCheckIntervalMs);
    }
}
