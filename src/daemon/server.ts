import * as net from 'net';
import * as fs from 'fs/promises';
import { existsSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import * as path from 'path';
import { MemTable } from './memtable.js';
import { createWALProvider, Operation, type WALFsyncMode, type WALProvider, type WALType } from './wal.js';
import { FileLock } from './file-lock.js';
import { GICSv2Encoder } from '../gics/encode.js';
import { GICSv2Decoder } from '../gics/decode.js';
import type { GenericSnapshot, SchemaProfile } from '../gics-types.js';
import { InsightTracker, type LifecycleStage } from '../insight/tracker.js';
import { CorrelationAnalyzer } from '../insight/correlation.js';
import { PredictiveSignals } from '../insight/signals.js';
import { ConfidenceTracker, type OutcomeResult } from '../insight/confidence.js';
import { InsightPersistence } from '../insight/persistence.js';

export interface GICSDaemonConfig {
    socketPath: string;
    dataPath: string;
    tokenPath: string;
    walType?: WALType;
    walFsyncMode?: WALFsyncMode;
    maxMemSizeBytes?: number;
    maxDirtyCount?: number;
    fileLockTimeoutMs?: number;
    warmRetentionMs?: number;
    coldRetentionMs?: number;
    coldEncryption?: boolean;
    coldPasswordEnvVar?: string;
}

export class GICSDaemon {
    private server: net.Server;
    private memTable: MemTable;
    private wal: WALProvider;
    private config: GICSDaemonConfig;
    private token: string;
    private recoveredEntries: number = 0;
    private readonly walType: WALType;
    private readonly walFsyncMode: WALFsyncMode;
    private readonly fileLockTimeoutMs: number;
    private readonly storageLockTarget: string;
    private readonly warmDirPath: string;
    private readonly coldDirPath: string;
    private readonly warmRetentionMs: number;
    private readonly coldRetentionMs: number;
    private readonly coldEncryption: boolean;
    private readonly coldPasswordEnvVar: string;
    private readonly tierIndexWarm = new Map<string, Set<string>>();
    private readonly tierIndexCold = new Map<string, Set<string>>();
    private readonly insightTracker = new InsightTracker();
    private readonly correlationAnalyzer = new CorrelationAnalyzer();
    private readonly predictiveSignals = new PredictiveSignals();
    private readonly confidenceTracker = new ConfidenceTracker();
    private readonly insightPersistence = new InsightPersistence();
    private readonly subscriptions = new Map<string, { socket: net.Socket; events: string[] }>();
    private static readonly INSIGHT_SEGMENT_PREFIX = 'insight-';
    private static readonly PRESENCE_PREFIX = '__gics_p__';

    constructor(config: GICSDaemonConfig) {
        this.config = config;
        this.memTable = new MemTable({
            maxMemTableBytes: config.maxMemSizeBytes,
            maxDirtyRecords: config.maxDirtyCount
        });
        this.walType = config.walType ?? 'binary';
        this.walFsyncMode = config.walFsyncMode ?? 'best_effort';
        this.fileLockTimeoutMs = config.fileLockTimeoutMs ?? 5000;
        this.storageLockTarget = path.join(config.dataPath, 'segments');
        this.warmDirPath = path.join(config.dataPath, 'warm');
        this.coldDirPath = path.join(config.dataPath, 'cold');
        this.warmRetentionMs = config.warmRetentionMs ?? (30 * 24 * 60 * 60 * 1000);
        this.coldRetentionMs = config.coldRetentionMs ?? (365 * 24 * 60 * 60 * 1000);
        this.coldEncryption = config.coldEncryption ?? false;
        this.coldPasswordEnvVar = config.coldPasswordEnvVar ?? 'GICS_COLD_KEY';

        const walFileName = this.walType === 'jsonl' ? 'gics.wal.jsonl' : 'gics.wal';
        const walPath = path.join(config.dataPath, walFileName);
        if (!existsSync(config.dataPath)) {
            mkdirSync(config.dataPath, { recursive: true });
            writeFileSync(walPath, ''); // Ensure file exists
        }
        this.wal = createWALProvider(this.walType, walPath, { fsyncMode: this.walFsyncMode });

        this.token = this.ensureToken();
        this.server = net.createServer((socket) => this.handleConnection(socket));
    }

    private ensureToken(): string {
        if (existsSync(this.config.tokenPath)) {
            return readFileSync(this.config.tokenPath, 'utf8').trim();
        } else {
            const newToken = Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2);
            writeFileSync(this.config.tokenPath, newToken, { mode: 0o600 });
            console.log(`[GICS] Generated new security token at ${this.config.tokenPath}`);
            return newToken;
        }
    }

    async start(): Promise<void> {
        // 1. Replay WAL to restore state
        console.log('[GICS] Replaying WAL...');
        this.recoveredEntries = 0;
        await this.wal.replay((op, key, payload) => {
            if (op === Operation.PUT) {
                this.memTable.put(key, payload);
                this.insightTracker.onWrite(key, Date.now(), payload);
                this.recoveredEntries++;
            } else if (op === Operation.DELETE) {
                this.memTable.delete(key);
                this.recoveredEntries++;
            }
        });
        this.memTable.resetDirty(); // WAL replay records are not dirty in MemTable sense (already persisted in WAL)
        console.log(`[GICS] WAL replayed. ${this.memTable.count} records loaded (${this.recoveredEntries} entries replayed).`);

        await FileLock.withSharedLock(this.storageLockTarget, async () => {
            await this.rebuildTierIndex();
            const restored = await this.restoreInsightsFromSegments();
            if (restored.total > 0) {
                console.log(`[GICS] Restored insights from segments: behavioral=${restored.behavioral}, confidence=${restored.confidence}`);
            }
        }, this.fileLockTimeoutMs);

        // 2. Start listening
        if (process.platform !== 'win32' && existsSync(this.config.socketPath)) {
            await fs.unlink(this.config.socketPath);
        }

        return new Promise((resolve) => {
            this.server.listen(this.config.socketPath, () => {
                console.log(`[GICS] Daemon listening on ${this.config.socketPath}`);
                resolve();
            });
        });
    }

    async stop(): Promise<void> {
        return new Promise((resolve) => {
            this.server.close(() => {
                console.log('[GICS] Daemon stopped.');
                this.wal.close().then(resolve);
            });
        });
    }

    private handleConnection(socket: net.Socket): void {
        let buffer = '';

        socket.on('close', () => {
            // Clean up subscriptions for this socket
            for (const [subId, sub] of this.subscriptions) {
                if (sub.socket === socket) this.subscriptions.delete(subId);
            }
        });

        socket.on('data', async (data) => {
            buffer += data.toString();

            const lines = buffer.split('\n');
            buffer = lines.pop() || ''; // Keep last partial line

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;

                let request: any;
                try {
                    request = JSON.parse(trimmed);
                } catch {
                    socket.write(JSON.stringify({
                        jsonrpc: '2.0',
                        id: null,
                        error: { code: -32700, message: 'Parse error' }
                    }) + '\n');
                    continue;
                }

                try {
                    const response = await this.handleRequest(request, socket);
                    socket.write(JSON.stringify(response) + '\n');
                } catch (e: any) {
                    socket.write(JSON.stringify({
                        jsonrpc: '2.0',
                        id: request.id ?? null,
                        error: { code: -32603, message: e?.message ?? 'Internal error' }
                    }) + '\n');
                }
            }
        });
    }

    private emitEvent(type: string, data: any): void {
        for (const [subId, sub] of this.subscriptions) {
            if (!sub.events.includes(type)) continue;
            if (sub.socket.destroyed) {
                this.subscriptions.delete(subId);
                continue;
            }
            const event = JSON.stringify({
                jsonrpc: '2.0',
                method: 'event',
                params: { subscriptionId: subId, type, data }
            });
            sub.socket.write(event + '\n');
        }
    }

    private async countSegmentFiles(): Promise<number> {
        return FileLock.withSharedLock(this.storageLockTarget, async () => {
            if (!existsSync(this.warmDirPath)) return 0;
            const files = await fs.readdir(this.warmDirPath);
            return files.filter((name) => name.endsWith('.gics') && !name.startsWith(GICSDaemon.INSIGHT_SEGMENT_PREFIX)).length;
        }, this.fileLockTimeoutMs);
    }

    private async countColdSegmentFiles(): Promise<number> {
        return FileLock.withSharedLock(this.storageLockTarget, async () => {
            if (!existsSync(this.coldDirPath)) return 0;
            const files = await fs.readdir(this.coldDirPath);
            return files.filter((name) => name.endsWith('.gics') && !name.startsWith(GICSDaemon.INSIGHT_SEGMENT_PREFIX)).length;
        }, this.fileLockTimeoutMs);
    }

    private async rebuildTierIndex(): Promise<void> {
        this.tierIndexWarm.clear();
        this.tierIndexCold.clear();

        await fs.mkdir(this.warmDirPath, { recursive: true });
        await fs.mkdir(this.coldDirPath, { recursive: true });

        const warmFiles = (await fs.readdir(this.warmDirPath))
            .filter((name) => name.endsWith('.gics') && !name.startsWith(GICSDaemon.INSIGHT_SEGMENT_PREFIX))
            .map((name) => path.join(this.warmDirPath, name));
        const coldFiles = (await fs.readdir(this.coldDirPath))
            .filter((name) => name.endsWith('.gics') && !name.startsWith(GICSDaemon.INSIGHT_SEGMENT_PREFIX))
            .map((name) => path.join(this.coldDirPath, name));

        for (const filePath of warmFiles) {
            await this.indexFileKeys(filePath, 'warm');
        }
        for (const filePath of coldFiles) {
            await this.indexFileKeys(filePath, 'cold');
        }
    }

    private async decodeSnapshotsWithFallback(raw: Buffer, coldTier: boolean): Promise<GenericSnapshot<Record<string, number | string>>[]> {
        try {
            const decoder = new GICSv2Decoder(raw);
            return await decoder.getAllGenericSnapshots();
        } catch {
            if (!coldTier) throw new Error('Failed to decode warm segment');
            const password = process.env[this.coldPasswordEnvVar] ?? '';
            if (!password) throw new Error(`Failed to decode cold segment and no ${this.coldPasswordEnvVar} provided`);
            const decoder = new GICSv2Decoder(raw, { password });
            return await decoder.getAllGenericSnapshots();
        }
    }

    private async indexFileKeys(filePath: string, tier: 'warm' | 'cold'): Promise<void> {
        const raw = await fs.readFile(filePath);
        const snapshots = await this.decodeSnapshotsWithFallback(raw, tier === 'cold');

        for (const snapshot of snapshots) {
            for (const key of snapshot.items.keys()) {
                const strKey = String(key);
                const index = tier === 'warm' ? this.tierIndexWarm : this.tierIndexCold;
                if (!index.has(strKey)) index.set(strKey, new Set<string>());
                index.get(strKey)!.add(filePath);
            }
        }
    }

    private async resolveFromTier(
        key: string,
        tier: 'warm' | 'cold'
    ): Promise<{ key: string; fields: Record<string, number | string>; tier: 'warm' | 'cold' } | null> {
        if (InsightPersistence.isInsightKey(key)) return null;
        const index = tier === 'warm' ? this.tierIndexWarm : this.tierIndexCold;
        const candidateFiles = Array.from(index.get(key) ?? []);
        if (candidateFiles.length === 0) return null;

        let winner: { ts: number; fields: Record<string, number | string> } | null = null;

        for (const filePath of candidateFiles) {
            const raw = await fs.readFile(filePath);
            const snapshots = await this.decodeSnapshotsWithFallback(raw, tier === 'cold');
            for (const snapshot of snapshots) {
                const fields = snapshot.items.get(key);
                if (!fields) continue;
                if (!winner || snapshot.timestamp >= winner.ts) {
                    winner = { ts: snapshot.timestamp, fields: { ...fields } };
                }
            }
        }

        if (!winner) return null;
        return { key, fields: this.restoreOriginalFieldShape(winner.fields), tier };
    }

    private restoreOriginalFieldShape(fields: Record<string, number | string>): Record<string, number | string> {
        const restored: Record<string, number | string> = {};
        const presence = new Map<string, number>();

        for (const [k, v] of Object.entries(fields)) {
            if (!k.startsWith(GICSDaemon.PRESENCE_PREFIX)) {
                restored[k] = v;
                continue;
            }

            const target = k.slice(GICSDaemon.PRESENCE_PREFIX.length);
            presence.set(target, typeof v === 'number' ? v : Number(v));
        }

        for (const [fieldName, flag] of presence.entries()) {
            if (flag === 0) {
                delete restored[fieldName];
            }
        }

        return restored;
    }

    private inferSchemaAndSnapshot(records: ReturnType<MemTable['scan']>): {
        schema: SchemaProfile;
        snapshot: GenericSnapshot<Record<string, number | string>>;
    } {
        const serialized = records.map((rec) => this.serializeRecordWithPresence(rec.fields));
        const inferredSchema = this.inferSchemaFromFields(serialized);

        const items = new Map<string, Record<string, number | string>>();
        let snapshotTimestamp = Date.now();

        for (const rec of records) {
            snapshotTimestamp = Math.max(snapshotTimestamp, rec.updated);
            items.set(rec.key, this.serializeRecordWithPresence(rec.fields));
        }

        return {
            schema: inferredSchema,
            snapshot: {
                timestamp: snapshotTimestamp,
                items
            }
        };
    }

    private serializeRecordWithPresence(fields: Record<string, number | string>): Record<string, number | string> {
        const out: Record<string, number | string> = { ...fields };
        const keySet = new Set(Object.keys(fields));

        for (const fieldName of keySet) {
            out[`${GICSDaemon.PRESENCE_PREFIX}${fieldName}`] = 1;
        }

        return out;
    }

    private inferSchemaFromFields(allFields: Array<Record<string, number | string>>): SchemaProfile {
        const fieldNames = new Set<string>();
        for (const fields of allFields) {
            for (const fieldName of Object.keys(fields)) {
                fieldNames.add(fieldName);
            }
        }

        const fields: SchemaProfile['fields'] = [];
        const sortedFieldNames = Array.from(fieldNames).sort();

        for (const fieldName of sortedFieldNames) {
            const values = allFields
                .map((fields) => fields[fieldName])
                .filter((v): v is number | string => v !== undefined);

            const isNumeric = values.every((v) => typeof v === 'number');
            if (isNumeric) {
                fields.push({
                    name: fieldName,
                    type: 'numeric',
                    codecStrategy: 'value'
                });
                continue;
            }

            const enumMap: Record<string, number> = { '__MISSING__': 0 };
            let idx = 1;
            const categoricalValues = Array.from(
                new Set(values.filter((v): v is string => typeof v === 'string'))
            ).sort();

            for (const value of categoricalValues) {
                if (enumMap[value] === undefined) {
                    enumMap[value] = idx++;
                }
            }

            fields.push({
                name: fieldName,
                type: 'categorical',
                codecStrategy: 'structural',
                enumMap
            });
        }

        return {
            id: 'gics_daemon_memtable_v1',
            version: 1,
            itemIdType: 'string',
            fields
        };
    }

    private coldStartBootstrap(key: string): void {
        if (this.insightTracker.getInsight(key)) return;

        const similar = this.correlationAnalyzer.findSimilarKeys(key);
        if (similar.length > 0) {
            const cluster = this.correlationAnalyzer.getClusterForKey(similar[0]!);
            if (cluster) {
                const mean = this.correlationAnalyzer.getClusterMeanBehavior(cluster, this.insightTracker);
                this.insightTracker.bootstrapFromCluster(key, mean);
                return;
            }
        }

        this.insightTracker.bootstrapRecord(key);
    }

    private async collectInsightRecordsFromTier(tier: 'warm' | 'cold'): Promise<Map<string, Record<string, number | string>>> {
        const dir = tier === 'warm' ? this.warmDirPath : this.coldDirPath;
        const latest = new Map<string, { ts: number; fields: Record<string, number | string> }>();
        if (!existsSync(dir)) return new Map();

        const files = (await fs.readdir(dir))
            .filter((f) => f.endsWith('.gics'))
            .sort();

        for (const fileName of files) {
            const filePath = path.join(dir, fileName);
            const raw = await fs.readFile(filePath);
            const snapshots = await this.decodeSnapshotsWithFallback(raw, tier === 'cold');
            for (const snapshot of snapshots) {
                for (const [key, fields] of snapshot.items.entries()) {
                    const strKey = String(key);
                    if (!InsightPersistence.isInsightKey(strKey)) continue;
                    const prev = latest.get(strKey);
                    if (!prev || snapshot.timestamp >= prev.ts) {
                        latest.set(strKey, { ts: snapshot.timestamp, fields: { ...fields } });
                    }
                }
            }
        }

        const out = new Map<string, Record<string, number | string>>();
        for (const [key, value] of latest.entries()) {
            out.set(key, value.fields);
        }
        return out;
    }

    private async restoreInsightsFromSegments(): Promise<{ behavioral: number; confidence: number; total: number; }> {
        const warm = await this.collectInsightRecordsFromTier('warm');
        const cold = await this.collectInsightRecordsFromTier('cold');

        const merged = new Map<string, Record<string, number | string>>();
        for (const [k, v] of warm) merged.set(k, v);
        for (const [k, v] of cold) merged.set(k, v);

        const behavioral = this.insightPersistence.restoreBehavioral(merged, this.insightTracker);
        const confidence = this.insightPersistence.restoreConfidence(merged, this.confidenceTracker);
        return { behavioral, confidence, total: behavioral + confidence };
    }

    private async compactWarmSegments(): Promise<{
        compacted: boolean;
        reason?: string;
        segmentsMerged: number;
        recordsDeduplicated: number;
        bytesBefore: number;
        bytesAfter: number;
        spaceReclaimedBytes: number;
        outputSegment: string | null;
    }> {
        await fs.mkdir(this.warmDirPath, { recursive: true });
        const warmFiles = (await fs.readdir(this.warmDirPath))
            .filter((name) => name.endsWith('.gics') && !name.startsWith(GICSDaemon.INSIGHT_SEGMENT_PREFIX))
            .sort();

        if (warmFiles.length < 2) {
            return {
                compacted: false,
                reason: 'not_enough_segments',
                segmentsMerged: 0,
                recordsDeduplicated: 0,
                bytesBefore: 0,
                bytesAfter: 0,
                spaceReclaimedBytes: 0,
                outputSegment: null
            };
        }

        const latestByKey = new Map<string, { fields: Record<string, number | string>; timestamp: number }>();
        let recordsSeen = 0;
        let bytesBefore = 0;

        for (const fileName of warmFiles) {
            const filePath = path.join(this.warmDirPath, fileName);
            const raw = await fs.readFile(filePath);
            bytesBefore += raw.length;

            const decoder = new GICSv2Decoder(raw);
            const snapshots = await decoder.getAllGenericSnapshots();

            for (const snapshot of snapshots) {
                for (const [key, fields] of snapshot.items.entries()) {
                    recordsSeen++;
                    latestByKey.set(String(key), {
                        fields: { ...fields },
                        timestamp: snapshot.timestamp
                    });
                }
            }
        }

        const mergedEntries = Array.from(latestByKey.entries()).map(([key, payload]) => ({ key, ...payload }));
        const mergedFields = mergedEntries.map((entry) => entry.fields);
        const schema = this.inferSchemaFromFields(mergedFields);

        const mergedSnapshot: GenericSnapshot<Record<string, number | string>> = {
            timestamp: Date.now(),
            items: new Map(mergedEntries.map((entry) => [entry.key, entry.fields]))
        };

        const encoder = new GICSv2Encoder({ schema });
        await encoder.addSnapshot(mergedSnapshot);
        const compactedBytes = await encoder.finish();

        const outputName = `compact-${Date.now()}-${Math.random().toString(36).slice(2)}.gics`;
        const outputPath = path.join(this.warmDirPath, outputName);
        await fs.writeFile(outputPath, compactedBytes);

        for (const fileName of warmFiles) {
            await fs.unlink(path.join(this.warmDirPath, fileName));
        }

        await this.rebuildTierIndex();

        return {
            compacted: true,
            segmentsMerged: warmFiles.length,
            recordsDeduplicated: Math.max(0, recordsSeen - latestByKey.size),
            bytesBefore,
            bytesAfter: compactedBytes.length,
            spaceReclaimedBytes: Math.max(0, bytesBefore - compactedBytes.length),
            outputSegment: outputPath
        };
    }

    private async reencodeForColdEncryption(inputPath: string, outputPath: string, password: string): Promise<number> {
        const raw = await fs.readFile(inputPath);
        const decoder = new GICSv2Decoder(raw);
        await decoder.parseHeader();
        const schema = decoder.getSchema();
        const snapshots = await decoder.getAllGenericSnapshots();

        const encoder = new GICSv2Encoder({ schema, password });
        for (const snapshot of snapshots) {
            await encoder.addSnapshot(snapshot);
        }
        const encrypted = await encoder.finish();
        await fs.writeFile(outputPath, encrypted);
        return encrypted.length;
    }

    private async rotateWarmToCold(): Promise<{
        rotated: boolean;
        filesArchived: number;
        filesDeleted: number;
        bytesArchived: number;
        archivedFiles: string[];
        deletedColdFiles: string[];
    }> {
        await fs.mkdir(this.warmDirPath, { recursive: true });
        await fs.mkdir(this.coldDirPath, { recursive: true });

        const now = Date.now();
        const warmFiles = (await fs.readdir(this.warmDirPath))
            .filter((name) => name.endsWith('.gics') && !name.startsWith(GICSDaemon.INSIGHT_SEGMENT_PREFIX));
        const archivedFiles: string[] = [];
        let bytesArchived = 0;

        const password = process.env[this.coldPasswordEnvVar] ?? '';
        if (this.coldEncryption && !password) {
            throw new Error(`Cold encryption enabled but env var ${this.coldPasswordEnvVar} is missing`);
        }

        for (const fileName of warmFiles) {
            const warmPath = path.join(this.warmDirPath, fileName);
            const st = await fs.stat(warmPath);
            if ((now - st.mtimeMs) < this.warmRetentionMs) continue;

            const coldName = `cold-${Date.now()}-${Math.random().toString(36).slice(2)}.gics`;
            const coldPath = path.join(this.coldDirPath, coldName);

            if (this.coldEncryption) {
                const written = await this.reencodeForColdEncryption(warmPath, coldPath, password);
                bytesArchived += written;
                await fs.unlink(warmPath);
            } else {
                await fs.rename(warmPath, coldPath);
                bytesArchived += st.size;
            }

            archivedFiles.push(coldPath);
        }

        const deletedColdFiles: string[] = [];
        if (this.coldRetentionMs > 0) {
            const coldFiles = (await fs.readdir(this.coldDirPath)).filter((name) => name.endsWith('.gics'));
            for (const fileName of coldFiles) {
                const coldPath = path.join(this.coldDirPath, fileName);
                const st = await fs.stat(coldPath);
                if ((now - st.mtimeMs) > this.coldRetentionMs) {
                    await fs.unlink(coldPath);
                    deletedColdFiles.push(coldPath);
                }
            }
        }

        await this.rebuildTierIndex();

        return {
            rotated: archivedFiles.length > 0 || deletedColdFiles.length > 0,
            filesArchived: archivedFiles.length,
            filesDeleted: deletedColdFiles.length,
            bytesArchived,
            archivedFiles,
            deletedColdFiles
        };
    }

    private async flushMemTableToWarm(trigger: 'manual' | 'auto', reason: string | null = null): Promise<{
        recordsBeforeFlush: number;
        dirtyBeforeFlush: number;
        recordsFlushed: number;
        bytesWritten: number;
        segmentCreated: string | null;
        flushDurationMs: number;
        walTruncated: boolean;
        trigger: 'manual' | 'auto';
        reason: string | null;
    }> {
        const start = Date.now();
        const recordsBeforeFlush = this.memTable.count;
        const dirtyBeforeFlush = this.memTable.dirtyCount;

        if (recordsBeforeFlush === 0 || dirtyBeforeFlush === 0) {
            this.memTable.resetDirty();
            await this.wal.truncate();
            return {
                recordsBeforeFlush,
                dirtyBeforeFlush,
                recordsFlushed: 0,
                bytesWritten: 0,
                segmentCreated: null,
                flushDurationMs: Date.now() - start,
                walTruncated: true,
                trigger,
                reason
            };
        }

        const behavioral = this.insightPersistence.snapshotBehavioral(this.insightTracker);
        const correlations = this.insightPersistence.snapshotCorrelations(this.correlationAnalyzer);
        const confidence = this.insightPersistence.snapshotConfidence(this.confidenceTracker);

        const records = this.memTable
            .scan()
            .filter((r) => !InsightPersistence.isInsightKey(r.key));
        const { schema, snapshot } = this.inferSchemaAndSnapshot(records);
        const encoder = new GICSv2Encoder({ schema });
        await encoder.addSnapshot(snapshot);
        const packed = await encoder.finish();

        await fs.mkdir(this.warmDirPath, { recursive: true });
        const segmentName = `warm-${Date.now()}-${Math.random().toString(36).slice(2)}.gics`;
        const segmentPath = path.join(this.warmDirPath, segmentName);
        await fs.writeFile(segmentPath, packed);

        const insightItems = new Map<string, Record<string, number | string>>();
        for (const [key, fields] of behavioral) insightItems.set(key, fields);
        for (const [key, fields] of correlations) insightItems.set(key, fields);
        for (const [key, fields] of confidence) insightItems.set(key, fields);

        if (insightItems.size > 0) {
            const insightSchema = this.inferSchemaFromFields(Array.from(insightItems.values()));
            const insightSnapshot: GenericSnapshot<Record<string, number | string>> = {
                timestamp: Date.now(),
                items: insightItems,
            };
            const insightEncoder = new GICSv2Encoder({ schema: insightSchema });
            await insightEncoder.addSnapshot(insightSnapshot);
            const insightPacked = await insightEncoder.finish();
            const insightSegmentName = `${GICSDaemon.INSIGHT_SEGMENT_PREFIX}${Date.now()}.gics`;
            await fs.writeFile(path.join(this.warmDirPath, insightSegmentName), insightPacked);
        }

        await this.rebuildTierIndex();

        this.memTable.resetDirty();
        await this.wal.truncate();

        return {
            recordsBeforeFlush,
            dirtyBeforeFlush,
            recordsFlushed: records.length,
            bytesWritten: packed.length,
            segmentCreated: segmentPath,
            flushDurationMs: Date.now() - start,
            walTruncated: true,
            trigger,
            reason
        };
    }

    private async handleRequest(request: any, socket?: net.Socket): Promise<any> {
        const { method, params, id, token } = request;

        if (!method || typeof method !== 'string') {
            return {
                jsonrpc: '2.0',
                id: id ?? null,
                error: { code: -32600, message: 'Invalid Request' }
            };
        }

        if (token !== this.token && method !== 'ping') {
            return { jsonrpc: '2.0', id, error: { code: -32000, message: 'Unauthorized' } };
        }

        try {
            switch (method) {
                case 'put': {
                    await this.wal.append(Operation.PUT, params.key, params.fields);
                    this.memTable.put(params.key, params.fields);
                    const putTs = Date.now();
                    const prevBehavior = this.insightTracker.getInsight(params.key);
                    const prevCorrelations = this.correlationAnalyzer.getCorrelations();
                    const prevCorrelationSet = new Set(prevCorrelations.map((c) => `${c.itemA}|${c.itemB}`));
                    const prevClusterSet = new Set(this.correlationAnalyzer.getClusters().map((c) => c.id));
                    const writeBehavior = this.insightTracker.onWrite(params.key, putTs, params.fields);
                    this.correlationAnalyzer.onItemUpdate(params.key, params.fields, putTs);
                    this.correlationAnalyzer.setLifecycleHint(params.key, writeBehavior.lifecycle);
                    const signalResult = this.predictiveSignals.onBehaviorUpdate(writeBehavior, params.fields);

                    // Emit events to subscribers
                    if (prevBehavior && prevBehavior.lifecycle !== writeBehavior.lifecycle) {
                        this.emitEvent('lifecycle_change', { key: params.key, from: prevBehavior.lifecycle, to: writeBehavior.lifecycle });
                    }
                    for (const anomaly of signalResult.newAnomalies) {
                        this.emitEvent('anomaly_detected', anomaly);
                    }
                    for (const rec of signalResult.newRecommendations) {
                        this.emitEvent('recommendation_new', rec);
                    }

                    const nextCorrelations = this.correlationAnalyzer.getCorrelations();
                    for (const corr of nextCorrelations) {
                        const corrId = `${corr.itemA}|${corr.itemB}`;
                        if (!prevCorrelationSet.has(corrId)) {
                            this.emitEvent('correlation_discovered', corr);
                        }
                    }

                    const nextClusterSet = new Set(this.correlationAnalyzer.getClusters().map((c) => c.id));
                    for (const id of nextClusterSet) {
                        if (!prevClusterSet.has(id)) this.emitEvent('cluster_formed', { clusterId: id });
                    }
                    for (const id of prevClusterSet) {
                        if (!nextClusterSet.has(id)) this.emitEvent('cluster_dissolved', { clusterId: id });
                    }

                    const flushDecision = this.memTable.shouldFlush();
                    if (!flushDecision.shouldFlush) {
                        return { jsonrpc: '2.0', id, result: { ok: true, behavior: writeBehavior } };
                    }

                    const autoFlush = await FileLock.withExclusiveLock(this.storageLockTarget, async () => {
                        return this.flushMemTableToWarm('auto', flushDecision.reason);
                    }, this.fileLockTimeoutMs);

                    return {
                        jsonrpc: '2.0',
                        id,
                        result: {
                            ok: true,
                            behavior: writeBehavior,
                            autoFlushed: true,
                            flush: autoFlush
                        }
                    };
                }

                case 'get': {
                    const record = this.memTable.get(params.key);
                    if (record) {
                        const behavior = this.insightTracker.onRead(params.key);
                        return { jsonrpc: '2.0', id, result: { key: record.key, fields: record.fields, tier: 'hot', behavior } };
                    }

                    const warmRecord = await FileLock.withSharedLock(this.storageLockTarget, async () => {
                        return this.resolveFromTier(params.key, 'warm');
                    }, this.fileLockTimeoutMs);
                    if (warmRecord) {
                        this.coldStartBootstrap(params.key);
                        const behavior = this.insightTracker.onRead(params.key);
                        return { jsonrpc: '2.0', id, result: { ...warmRecord, behavior } };
                    }

                    const coldRecord = await FileLock.withSharedLock(this.storageLockTarget, async () => {
                        return this.resolveFromTier(params.key, 'cold');
                    }, this.fileLockTimeoutMs);
                    if (coldRecord) {
                        this.coldStartBootstrap(params.key);
                        const behavior = this.insightTracker.onRead(params.key);
                        return { jsonrpc: '2.0', id, result: { ...coldRecord, behavior } };
                    }
                    return { jsonrpc: '2.0', id, result: null };
                }

                case 'getInsight':
                    return {
                        jsonrpc: '2.0',
                        id,
                        result: this.insightTracker.getInsight(String(params?.key ?? ''))
                    };

                case 'getInsights': {
                    const lifecycle = params?.lifecycle as LifecycleStage | undefined;
                    return {
                        jsonrpc: '2.0',
                        id,
                        result: this.insightTracker.getInsights(lifecycle ? { lifecycle } : undefined)
                    };
                }

                case 'reportOutcome': {
                    const outcomeInsightId = String(params?.insightId ?? '');
                    const outcomeResult = String(params?.result ?? '') as OutcomeResult;
                    const recorded = this.predictiveSignals.recordOutcome(outcomeInsightId, outcomeResult, this.confidenceTracker);
                    if (!recorded) {
                        return { jsonrpc: '2.0', id, error: { code: -32602, message: `Insight ${outcomeInsightId} not found` } };
                    }
                    return {
                        jsonrpc: '2.0',
                        id,
                        result: { ok: true, insightId: outcomeInsightId, result: outcomeResult, recordedAt: Date.now() }
                    };
                }

                case 'subscribe': {
                    const subEvents = Array.isArray(params?.events) ? params.events as string[] : [];
                    const subscriptionId = `sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
                    if (socket) {
                        this.subscriptions.set(subscriptionId, { socket, events: subEvents });
                    }
                    return {
                        jsonrpc: '2.0',
                        id,
                        result: { subscriptionId, events: subEvents }
                    };
                }

                case 'unsubscribe': {
                    const unsubId = String(params?.subscriptionId ?? '');
                    const deleted = this.subscriptions.delete(unsubId);
                    return { jsonrpc: '2.0', id, result: { ok: deleted } };
                }

                case 'getAccuracy':
                    return {
                        jsonrpc: '2.0',
                        id,
                        result: this.confidenceTracker.getAccuracy(params?.insightType, params?.scope)
                    };

                case 'getCorrelations':
                    return {
                        jsonrpc: '2.0',
                        id,
                        result: this.correlationAnalyzer.getCorrelations(params?.key)
                    };

                case 'getClusters':
                    return {
                        jsonrpc: '2.0',
                        id,
                        result: this.correlationAnalyzer.getClusters()
                    };

                case 'getLeadingIndicators':
                    return {
                        jsonrpc: '2.0',
                        id,
                        result: this.correlationAnalyzer.getLeadingIndicators(params?.key)
                    };

                case 'getSeasonalPatterns':
                    return {
                        jsonrpc: '2.0',
                        id,
                        result: this.correlationAnalyzer.getSeasonalPatterns(params?.key)
                    };

                case 'getForecast': {
                    const fKey = String(params?.key ?? '');
                    const fField = String(params?.field ?? '');
                    const fBehavior = this.insightTracker.getInsight(fKey);
                    if (!fBehavior) return { jsonrpc: '2.0', id, result: null };
                    return {
                        jsonrpc: '2.0',
                        id,
                        result: this.predictiveSignals.getForecast(fBehavior, fField, params?.horizon)
                    };
                }

                case 'getAnomalies':
                    return {
                        jsonrpc: '2.0',
                        id,
                        result: this.predictiveSignals.getAnomalies(params?.since)
                    };

                case 'getRecommendations':
                    return {
                        jsonrpc: '2.0',
                        id,
                        result: this.predictiveSignals.getRecommendations(params)
                    };

                case 'delete':
                    await this.wal.append(Operation.DELETE, params.key, {});
                    this.memTable.delete(params.key);
                    return { jsonrpc: '2.0', id, result: { ok: true } };

                case 'scan':
                    const results = this.memTable
                        .scan(params.prefix)
                        .filter((r) => !InsightPersistence.isInsightKey(r.key));
                    return { jsonrpc: '2.0', id, result: { items: results.map(r => ({ key: r.key, fields: r.fields })) } };

                case 'verify': {
                    const tier = params?.tier as 'warm' | 'cold' | undefined;
                    return FileLock.withSharedLock(this.storageLockTarget, async () => {
                        const details: Array<{ file: string; tier: string; valid: boolean; error?: string }> = [];
                        const tiers: Array<'warm' | 'cold'> = tier ? [tier] : ['warm', 'cold'];
                        for (const t of tiers) {
                            const dir = t === 'warm' ? this.warmDirPath : this.coldDirPath;
                            if (!existsSync(dir)) continue;
                            const files = (await fs.readdir(dir)).filter(f => f.endsWith('.gics'));
                            for (const f of files) {
                                const filePath = path.join(dir, f);
                                try {
                                    const raw = await fs.readFile(filePath);
                                    const decoder = t === 'cold' && (process.env[this.coldPasswordEnvVar] ?? '')
                                        ? new GICSv2Decoder(raw, { password: process.env[this.coldPasswordEnvVar] })
                                        : new GICSv2Decoder(raw);
                                    const valid = await decoder.verifyIntegrityOnly();
                                    details.push({ file: f, tier: t, valid });
                                } catch (e: any) {
                                    details.push({ file: f, tier: t, valid: false, error: e.message });
                                }
                            }
                        }
                        const allValid = details.every((d) => d.valid);
                        return { jsonrpc: '2.0', id, result: { valid: allValid, details } };
                    }, this.fileLockTimeoutMs);
                }

                case 'flush': {
                    // Phase 2.1 flush: MemTable -> WARM segment + WAL truncate.
                    return FileLock.withExclusiveLock(this.storageLockTarget, async () => {
                        const flushResult = await this.flushMemTableToWarm('manual');

                        return {
                            jsonrpc: '2.0',
                            id,
                            result: {
                                ok: true,
                                ...flushResult
                            }
                        };
                    }, this.fileLockTimeoutMs);
                }

                case 'compact': {
                    return FileLock.withExclusiveLock(this.storageLockTarget, async () => {
                        const compaction = await this.compactWarmSegments();
                        return {
                            jsonrpc: '2.0',
                            id,
                            result: {
                                ok: true,
                                ...compaction
                            }
                        };
                    }, this.fileLockTimeoutMs);
                }

                case 'rotate': {
                    return FileLock.withExclusiveLock(this.storageLockTarget, async () => {
                        const rotation = await this.rotateWarmToCold();
                        return {
                            jsonrpc: '2.0',
                            id,
                            result: {
                                ok: true,
                                ...rotation
                            }
                        };
                    }, this.fileLockTimeoutMs);
                }

                case 'ping':
                    const segments = await this.countSegmentFiles();
                    const coldSegments = await this.countColdSegmentFiles();
                    return {
                        jsonrpc: '2.0',
                        id,
                        result: {
                            status: 'ok',
                            uptime: process.uptime(),
                            count: this.memTable.count,
                            memtableSize: this.memTable.sizeBytes,
                            memtable_size: this.memTable.sizeBytes,
                            dirtyCount: this.memTable.dirtyCount,
                            recoveredEntries: this.recoveredEntries,
                            walType: this.walType,
                            walFsyncMode: this.walFsyncMode,
                            segments,
                            coldSegments,
                            tiers: {
                                hot: this.memTable.count,
                                warmSegments: segments,
                                coldSegments
                            },
                            tierIndex: {
                                warmKeys: this.tierIndexWarm.size,
                                coldKeys: this.tierIndexCold.size
                            },
                            insightsTracked: this.insightTracker.count
                        }
                    };

                default:
                    return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } };
            }
        } catch (e: any) {
            return { jsonrpc: '2.0', id, error: { code: -32603, message: e.message } };
        }
    }
}
