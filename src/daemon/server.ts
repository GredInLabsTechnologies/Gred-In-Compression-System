import * as net from 'node:net';
import * as fs from 'node:fs/promises';
import { existsSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { MemTable } from './memtable.js';
import { createWALProvider, Operation, type WALBatchEntry, type WALFsyncMode, type WALProvider, type WALType } from './wal.js';
import { FileLock } from './file-lock.js';
import { GICSv2Encoder } from '../gics/encode.js';
import { GICSv2Decoder } from '../gics/decode.js';
import type { GenericSnapshot, SchemaProfile } from '../gics-types.js';
import { GICSSupervisor } from './supervisor.js';
import { ResilienceShell, GICSCircuitOpen, GICSTimeout, GICSUnavailable, type ResilienceConfig } from './resilience.js';
import { createBuiltinModuleSet, type BuiltinModuleSet } from './builtin-modules.js';
import type { GICSModuleRuntimeConfig } from './config.js';
import type { InferenceRequest, ModuleContext } from './module-registry.js';
import { StateIndex, type StateIndexEntry, type StateIndexTier, type StateIndexScanOptions } from './state-index.js';
import { isHiddenSystemKey, isSystemKey, makeIdempotencyKey, makeTombstoneKey } from './system-keys.js';
import { TelemetryCollector } from '../telemetry/collector.js';
import { durationSeconds, normalizeBooleanLabel, normalizeErrorType } from '../telemetry/utils.js';

export interface GICSDaemonConfig {
    socketPath: string;
    dataPath: string;
    tokenPath: string;
    walType?: WALType;
    walFsyncMode?: WALFsyncMode;
    walFsyncOnCommit?: boolean;
    walCheckpointEveryOps?: number;
    walCheckpointEveryMs?: number;
    walMaxSizeMB?: number;
    maxMemSizeBytes?: number;
    maxDirtyCount?: number;
    fileLockTimeoutMs?: number;
    warmRetentionMs?: number;
    coldRetentionMs?: number;
    coldEncryption?: boolean;
    coldPasswordEnvVar?: string;
    resilience?: ResilienceConfig;
    modules?: Record<string, GICSModuleRuntimeConfig>;
    defaultProfileScope?: string;
    configPath?: string;
}

interface SegmentDescriptor {
    filePath: string;
    tier: 'warm' | 'cold';
    system: boolean;
}

interface PutRecord {
    key: string;
    fields: Record<string, number | string>;
}

function stableStringify(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort((a, b) => a.localeCompare(b));
    return '{' + keys.map((key) => JSON.stringify(key) + ':' + stableStringify(obj[key])).join(',') + '}';
}

function hashPutManyPayload(records: PutRecord[], atomic: boolean, verify: boolean): string {
    return createHash('sha256').update(stableStringify({
        atomic,
        verify,
        records: records.map((record) => ({
            key: record.key,
            fields: Object.fromEntries(Object.entries(record.fields).sort((a, b) => a[0].localeCompare(b[0]))),
        })),
    })).digest('hex');
}

function cloneRecord(record: PutRecord): PutRecord {
    return {
        key: record.key,
        fields: { ...record.fields },
    };
}

export class GICSDaemon {
    private static readonly MAX_REQUEST_BYTES = 4 * 1024 * 1024;
    private static readonly LEGACY_INSIGHT_SEGMENT_PREFIX = 'insight-';
    private static readonly SYSTEM_SEGMENT_PREFIX = 'insight-';
    private static readonly PRESENCE_PREFIX = '__gics_p__';
    private static readonly STATE_INDEX_FILE = 'state-index.json';
    private static readonly WRITE_OPS = new Set(['put', 'putMany', 'delete', 'flush', 'compact', 'rotate', 'seedProfile', 'seedPolicy']);
    private static readonly READ_OPS = new Set([
        'get', 'getInsight', 'getInsights', 'getAccuracy', 'getCorrelations',
        'getClusters', 'getLeadingIndicators', 'getSeasonalPatterns', 'getForecast',
        'getAnomalies', 'getRecommendations', 'verify', 'verifyAudit', 'exportAudit',
        'infer', 'getProfile', 'getInferenceRuntime'
    ]);
    private static readonly SCAN_OPS = new Set(['scan', 'countPrefix', 'latestByPrefix', 'scanSummary']);
    private static readonly CONTROL_OPS = new Set([
        'ping', 'getStatus', 'getHealth', 'resetDegraded',
        'subscribe', 'unsubscribe', 'reportOutcome', 'recordOutcome', 'flushInference',
        'getTelemetry', 'getTelemetryEvents', 'pingVerbose',
    ]);

    private readonly server: net.Server;
    private readonly memTable: MemTable;
    private readonly wal: WALProvider;
    private readonly walPath: string;
    private readonly config: GICSDaemonConfig;
    private readonly token: string;
    private recoveredEntries = 0;
    private readonly walType: WALType;
    private readonly walFsyncMode: WALFsyncMode;
    private readonly walFsyncOnCommit: boolean;
    private readonly walCheckpointEveryOps: number;
    private readonly walCheckpointEveryMs: number;
    private readonly walMaxSizeMB: number;
    private readonly fileLockTimeoutMs: number;
    private readonly storageLockTarget: string;
    private readonly warmDirPath: string;
    private readonly coldDirPath: string;
    private readonly stateIndexPath: string;
    private readonly warmRetentionMs: number;
    private readonly coldRetentionMs: number;
    private readonly coldEncryption: boolean;
    private readonly coldPasswordEnvVar: string;
    private readonly stateIndex: StateIndex;
    private readonly supervisor = new GICSSupervisor();
    private readonly resilience: ResilienceShell;
    private readonly telemetry = new TelemetryCollector({ maxEvents: 512 });
    private readonly rpcInflight = new Map<string, number>();
    private readonly subscriptions = new Map<string, { socket: net.Socket; events: string[] }>();
    private readonly segmentCatalog = new Map<string, SegmentDescriptor>();
    private readonly modules: BuiltinModuleSet;
    private readonly moduleContext: ModuleContext;
    private daemonLock: FileLock | null = null;

    constructor(config: GICSDaemonConfig) {
        this.config = config;
        this.memTable = new MemTable({
            maxMemTableBytes: config.maxMemSizeBytes,
            maxDirtyRecords: config.maxDirtyCount,
        });
        this.walType = config.walType ?? 'binary';
        this.walFsyncMode = config.walFsyncMode ?? 'best_effort';
        this.walFsyncOnCommit = config.walFsyncOnCommit ?? true;
        this.walCheckpointEveryOps = config.walCheckpointEveryOps ?? 500;
        this.walCheckpointEveryMs = config.walCheckpointEveryMs ?? 30_000;
        this.walMaxSizeMB = config.walMaxSizeMB ?? 50;
        this.fileLockTimeoutMs = config.fileLockTimeoutMs ?? 5000;
        this.storageLockTarget = path.join(config.dataPath, 'segments.lock');
        this.warmDirPath = path.join(config.dataPath, 'warm');
        this.coldDirPath = path.join(config.dataPath, 'cold');
        this.stateIndexPath = path.join(config.dataPath, GICSDaemon.STATE_INDEX_FILE);
        this.warmRetentionMs = config.warmRetentionMs ?? (30 * 24 * 60 * 60 * 1000);
        this.coldRetentionMs = config.coldRetentionMs ?? (365 * 24 * 60 * 60 * 1000);
        this.coldEncryption = config.coldEncryption ?? false;
        this.coldPasswordEnvVar = config.coldPasswordEnvVar ?? 'GICS_COLD_KEY';
        this.stateIndex = new StateIndex(this.stateIndexPath);
        this.resilience = new ResilienceShell(config.resilience);

        const walFileName = this.walType === 'jsonl' ? 'gics.wal.jsonl' : 'gics.wal';
        const walPath = path.join(config.dataPath, walFileName);
        this.walPath = walPath;
        if (!existsSync(config.dataPath)) {
            mkdirSync(config.dataPath, { recursive: true });
            writeFileSync(walPath, '');
        }
        this.wal = createWALProvider(this.walType, walPath, {
            fsyncMode: this.walFsyncMode,
            fsyncOnCommit: this.walFsyncOnCommit,
            checkpointEveryOps: this.walCheckpointEveryOps,
            checkpointEveryMs: this.walCheckpointEveryMs,
            maxWalSizeMB: this.walMaxSizeMB,
            telemetry: this.telemetry,
        });

        const promptEnabled = this.resolveModuleEnabled('prompt-distiller', process.env.GICS_DISTILLER_ENABLED === 'true');
        const inferenceEnabled = this.resolveModuleEnabled('inference-engine', false);
        this.modules = createBuiltinModuleSet({
            dataPath: config.dataPath,
            enablePromptDistiller: promptEnabled,
            enableInferenceEngine: inferenceEnabled,
            defaultScope: config.defaultProfileScope ?? 'host:default',
            moduleConfigs: config.modules,
        });
        this.applyModuleOverrides();

        this.moduleContext = {
            emitEvent: (type, data) => this.emitEvent(type, data),
            upsertSystemRecord: async (key, fields) => {
                await this.upsertSystemRecord(key, fields);
            },
            now: () => Date.now(),
            getStateSnapshot: () => this.stateIndex.snapshotEntries(),
            telemetry: this.telemetry,
        };

        this.token = this.ensureToken();
        this.server = net.createServer((socket) => this.handleConnection(socket));
    }

    private resolveModuleEnabled(moduleId: string, defaultValue: boolean): boolean {
        const override = this.config.modules?.[moduleId]?.enabled;
        return override ?? defaultValue;
    }

    private applyModuleOverrides(): void {
        for (const module of this.modules.registry.list()) {
            const override = this.config.modules?.[module.manifest.id];
            if (override?.enabled !== undefined) {
                module.enabled = override.enabled;
            }
        }
    }

    private ensureToken(): string {
        if (existsSync(this.config.tokenPath)) {
            return readFileSync(this.config.tokenPath, 'utf8').trim();
        }
        const newToken = randomBytes(16).toString('hex');
        writeFileSync(this.config.tokenPath, newToken, { mode: 0o600 });
        console.log(`[GICS] Generated new security token at ${this.config.tokenPath}`);
        return newToken;
    }

    private setRpcInflight(method: string, delta: number): void {
        const next = Math.max(0, (this.rpcInflight.get(method) ?? 0) + delta);
        this.rpcInflight.set(method, next);
        this.telemetry.setGauge(
            'gics_rpc_inflight',
            next,
            { method },
            {
                unit: 'count',
                description: 'In-flight JSON-RPC requests currently being processed by the daemon.',
            },
        );
    }

    private async getWalSizeBytes(): Promise<number> {
        const stat = await fs.stat(this.walPath).catch(() => null);
        return stat?.size ?? 0;
    }

    private async measureTierStorage(dirPath: string): Promise<{ files: number; bytes: number }> {
        if (!existsSync(dirPath)) {
            return { files: 0, bytes: 0 };
        }
        const files = (await fs.readdir(dirPath)).filter((name) => name.endsWith('.gics'));
        let bytes = 0;
        for (const fileName of files) {
            const stat = await fs.stat(path.join(dirPath, fileName)).catch(() => null);
            bytes += stat?.size ?? 0;
        }
        return { files: files.length, bytes };
    }

    private refreshHotTelemetry(): void {
        const tierStats = this.getTierIndexStats();
        this.telemetry.setGauge('gics_memtable_entries', this.memTable.count, {}, {
            unit: 'count',
            description: 'Current number of entries held in the daemon memtable.',
        });
        this.telemetry.setGauge('gics_memtable_bytes', this.memTable.sizeBytes, {}, {
            unit: 'bytes',
            description: 'Current approximate memory footprint of the daemon memtable.',
        });
        this.telemetry.setGauge('gics_memtable_dirty_count', this.memTable.dirtyCount, {}, {
            unit: 'count',
            description: 'Current number of dirty entries waiting to be flushed from the memtable.',
        });
        this.telemetry.setGauge('gics_pending_ops', this.resilience.getPendingOps(), {}, {
            unit: 'count',
            description: 'Pending daemon operations tracked by the resilience shell.',
        });
        this.telemetry.setGauge('gics_tier_keys', tierStats.hotKeys, { tier: 'hot' }, {
            unit: 'count',
            description: 'Visible keys currently indexed in each daemon storage tier.',
        });
        this.telemetry.setGauge('gics_tier_keys', tierStats.warmKeys, { tier: 'warm' }, {
            unit: 'count',
            description: 'Visible keys currently indexed in each daemon storage tier.',
        });
        this.telemetry.setGauge('gics_tier_keys', tierStats.coldKeys, { tier: 'cold' }, {
            unit: 'count',
            description: 'Visible keys currently indexed in each daemon storage tier.',
        });
    }

    private async refreshStorageTelemetry(): Promise<void> {
        this.refreshHotTelemetry();
        const walSizeBytes = await this.getWalSizeBytes();
        this.telemetry.setGauge('gics_wal_size_bytes', walSizeBytes, {}, {
            unit: 'bytes',
            description: 'Current size on disk of the daemon write-ahead log.',
        });

        const warm = await this.measureTierStorage(this.warmDirPath);
        const cold = await this.measureTierStorage(this.coldDirPath);
        this.telemetry.setGauge('gics_segment_files', warm.files, { tier: 'warm' }, {
            unit: 'count',
            description: 'Number of persisted segment files in each storage tier.',
        });
        this.telemetry.setGauge('gics_segment_files', cold.files, { tier: 'cold' }, {
            unit: 'count',
            description: 'Number of persisted segment files in each storage tier.',
        });
        this.telemetry.setGauge('gics_storage_bytes', warm.bytes, { tier: 'warm' }, {
            unit: 'bytes',
            description: 'Bytes stored in persisted segment files for each storage tier.',
        });
        this.telemetry.setGauge('gics_storage_bytes', cold.bytes, { tier: 'cold' }, {
            unit: 'bytes',
            description: 'Bytes stored in persisted segment files for each storage tier.',
        });
    }

    async start(): Promise<void> {
        const daemonLock = new FileLock(this.storageLockTarget);
        await daemonLock.acquire('exclusive', this.fileLockTimeoutMs);
        this.daemonLock = daemonLock;

        try {
            await FileLock.withSharedLock(this.storageLockTarget, async () => {
                await this.loadOrRebuildStateIndex();
            }, this.fileLockTimeoutMs);

            await this.modules.registry.initAll(this.moduleContext);
            await this.modules.registry.restoreAll(this.moduleContext);

            console.log('[GICS] Replaying WAL...');
            this.recoveredEntries = 0;
            await this.wal.replay((op, key, payload) => {
                const timestamp = Date.now();
                if (op === Operation.PUT) {
                    this.memTable.put(key, payload as Record<string, number | string>);
                    this.stateIndex.recordPut(key, payload as Record<string, number | string>, { tier: 'hot', segmentRef: null, timestamp });
                    this.recoveredEntries++;
                } else if (op === Operation.DELETE) {
                    this.memTable.delete(key);
                    this.stateIndex.applyWALDelete(key, timestamp);
                    this.recoveredEntries++;
                }
            });
            this.memTable.resetDirty();
            console.log(`[GICS] WAL replayed. ${this.memTable.count} records loaded (${this.recoveredEntries} entries replayed).`);
            this.telemetry.incrementCounter(
                'gics_wal_replay_entries_total',
                {},
                this.recoveredEntries,
                'Entries replayed from the WAL during daemon startup.',
            );
            await this.refreshStorageTelemetry();

            await this.replayHotStateIntoModules();

            this.supervisor.registerHealthChecks({
                checkMemTable: () => {
                    try { return this.memTable.count >= 0; } catch { return false; }
                },
                checkWAL: () => {
                    try { return this.wal != null; } catch { return false; }
                },
                restartSubsystem: async () => {
                    try {
                        return this.memTable.count >= 0;
                    } catch {
                        return false;
                    }
                },
            });
            this.supervisor.start();

            if (process.platform !== 'win32' && existsSync(this.config.socketPath)) {
                await fs.unlink(this.config.socketPath);
            }

            await new Promise<void>((resolve, reject) => {
                const onError = (error: Error) => {
                    this.server.off('listening', onListening);
                    reject(error);
                };
                const onListening = () => {
                    this.server.off('error', onError);
                    console.log(`[GICS] Daemon listening on ${this.config.socketPath}`);
                    resolve();
                };
                this.server.once('error', onError);
                this.server.once('listening', onListening);
                this.server.listen(this.config.socketPath);
            });
        } catch (error) {
            await this.daemonLock?.release().catch(() => undefined);
            this.daemonLock = null;
            throw error;
        }
    }

    async stop(): Promise<void> {
        this.supervisor.stop();
        try {
            await this.stateIndex.save();
            await this.modules.registry.stopAll();
            await this.refreshStorageTelemetry();
            await new Promise<void>((resolve) => {
                this.server.close(() => {
                    console.log('[GICS] Daemon stopped.');
                    this.wal.close().then(resolve);
                });
            });
        } finally {
            await this.daemonLock?.release().catch(() => undefined);
            this.daemonLock = null;
        }
    }

    private applyHotPut(key: string, fields: Record<string, number | string>, timestamp: number): void {
        this.memTable.put(key, fields);
        this.stateIndex.recordPut(key, fields, {
            tier: 'hot',
            segmentRef: null,
            timestamp,
        });
        this.refreshHotTelemetry();
    }

    private applyHotDelete(
        key: string,
        tombstoneKey: string,
        tombstoneFields: Record<string, number | string>,
        timestamp: number,
    ): void {
        this.memTable.delete(key);
        this.memTable.put(tombstoneKey, tombstoneFields);
        this.stateIndex.recordDelete(key, {
            tier: 'hot',
            segmentRef: null,
            timestamp,
        });
        this.refreshHotTelemetry();
    }

    private async maybeAutoFlush(): Promise<Awaited<ReturnType<GICSDaemon['flushMemTableToWarm']>> | null> {
        const flushDecision = this.memTable.shouldFlush();
        if (!flushDecision.shouldFlush) {
            return null;
        }
        return await FileLock.withExclusiveLock(this.storageLockTarget, async () => {
            return this.flushMemTableToWarm('auto', flushDecision.reason);
        }, this.fileLockTimeoutMs);
    }

    private verifyHotRecord(key: string, fields: Record<string, number | string>): boolean {
        const entry = this.stateIndex.getVisible(key, isSystemKey(key));
        return entry?.fields != null && stableStringify(entry.fields) === stableStringify(fields);
    }

    private async withIdempotencyLock<T>(idempotencySystemKey: string, fn: () => Promise<T>): Promise<T> {
        const lockId = createHash('sha256').update(idempotencySystemKey).digest('hex');
        const lockTarget = path.join(this.config.dataPath, '.idempotency-locks', `${lockId}.lock`);
        return await FileLock.withExclusiveLock(lockTarget, fn, this.fileLockTimeoutMs);
    }

    private noteSyntheticScan(): Promise<void> {
        return this.modules.registry.onScan({ items: [], nextCursor: null }, this.moduleContext);
    }

    private async replayHotStateIntoModules(): Promise<void> {
        const records = this.memTable.scan().sort((a, b) => a.updated - b.updated);
        for (const record of records) {
            if (isHiddenSystemKey(record.key)) continue;
            await this.modules.registry.onWrite({
                key: record.key,
                fields: { ...record.fields },
                timestamp: record.updated,
            }, this.moduleContext);
        }
    }
    private handleConnection(socket: net.Socket): void {
        let buffer = '';

        socket.on('close', () => {
            for (const [subId, sub] of this.subscriptions) {
                if (sub.socket === socket) this.subscriptions.delete(subId);
            }
        });

        socket.on('data', async (data) => {
            buffer += data.toString();
            if (Buffer.byteLength(buffer, 'utf8') > GICSDaemon.MAX_REQUEST_BYTES) {
                this.telemetry.incrementCounter(
                    'gics_rpc_requests_total',
                    { method: '__connection__', result: 'error', error_type: 'request_too_large' },
                    1,
                    'JSON-RPC requests handled by the GICS daemon.',
                );
                this.telemetry.recordEvent('request_rejected', {
                    reason: 'request_too_large',
                    limitBytes: GICSDaemon.MAX_REQUEST_BYTES,
                });
                socket.write(JSON.stringify({
                    jsonrpc: '2.0',
                    id: null,
                    error: { code: -32010, message: 'Request too large' },
                }) + '\n');
                socket.destroy();
                buffer = '';
                return;
            }
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                const requestBytes = Buffer.byteLength(trimmed, 'utf8');

                let request: any;
                let method = '__parse__';
                try {
                    request = JSON.parse(trimmed);
                    method = typeof request?.method === 'string' ? request.method : '__invalid__';
                } catch {
                    const payload = JSON.stringify({
                        jsonrpc: '2.0',
                        id: null,
                        error: { code: -32700, message: 'Parse error' },
                    });
                    this.telemetry.observeHistogram('gics_request_bytes', requestBytes, { method }, {
                        unit: 'bytes',
                        description: 'Request payload sizes observed by the daemon JSON-RPC layer.',
                    });
                    this.telemetry.observeHistogram('gics_response_bytes', Buffer.byteLength(payload, 'utf8'), { method }, {
                        unit: 'bytes',
                        description: 'Response payload sizes emitted by the daemon JSON-RPC layer.',
                    });
                    this.telemetry.incrementCounter(
                        'gics_rpc_requests_total',
                        { method, result: 'error', error_type: 'parse_error' },
                        1,
                        'JSON-RPC requests handled by the GICS daemon.',
                    );
                    this.telemetry.recordEvent('request_rejected', { reason: 'parse_error' });
                    socket.write(payload + '\n');
                    continue;
                }

                this.telemetry.observeHistogram('gics_request_bytes', requestBytes, { method }, {
                    unit: 'bytes',
                    description: 'Request payload sizes observed by the daemon JSON-RPC layer.',
                });
                this.setRpcInflight(method, 1);
                const startedAt = Date.now();
                let response: any;
                try {
                    response = await this.handleRequest(request, socket);
                } catch (e: any) {
                    response = {
                        jsonrpc: '2.0',
                        id: request.id ?? null,
                        error: { code: -32603, message: e?.message ?? 'Internal error' },
                    };
                } finally {
                    this.setRpcInflight(method, -1);
                }

                const payload = JSON.stringify(response);
                const errorType = response?.error ? normalizeErrorType(response.error.message ?? response.error.code) : 'none';
                this.telemetry.observeHistogram('gics_response_bytes', Buffer.byteLength(payload, 'utf8'), { method }, {
                    unit: 'bytes',
                    description: 'Response payload sizes emitted by the daemon JSON-RPC layer.',
                });
                this.telemetry.observeHistogram('gics_rpc_duration_seconds', durationSeconds(startedAt), { method }, {
                    unit: 'seconds',
                    description: 'Latency of JSON-RPC methods executed by the daemon.',
                });
                this.telemetry.incrementCounter(
                    'gics_rpc_requests_total',
                    response?.error
                        ? { method, result: 'error', error_type: errorType }
                        : { method, result: 'ok', error_type: 'none' },
                    1,
                    'JSON-RPC requests handled by the GICS daemon.',
                );
                socket.write(payload + '\n');
            }
        });
    }

    private emitEvent(type: string, data: unknown): void {
        this.telemetry.recordEvent(type, data);
        for (const [subId, sub] of this.subscriptions) {
            if (!sub.events.includes(type)) continue;
            if (sub.socket.destroyed) {
                this.subscriptions.delete(subId);
                continue;
            }
            const event = JSON.stringify({
                jsonrpc: '2.0',
                method: 'event',
                params: { subscriptionId: subId, type, data },
            });
            sub.socket.write(event + '\n');
        }
    }

    private isSystemSegmentFile(name: string): boolean {
        return name.startsWith(GICSDaemon.SYSTEM_SEGMENT_PREFIX) || name.startsWith(GICSDaemon.LEGACY_INSIGHT_SEGMENT_PREFIX);
    }

    private async countSegmentFiles(): Promise<number> {
        return FileLock.withSharedLock(this.storageLockTarget, async () => {
            if (!existsSync(this.warmDirPath)) return 0;
            const files = await fs.readdir(this.warmDirPath);
            return files.filter((name) => name.endsWith('.gics') && !this.isSystemSegmentFile(name)).length;
        }, this.fileLockTimeoutMs);
    }

    private async countColdSegmentFiles(): Promise<number> {
        return FileLock.withSharedLock(this.storageLockTarget, async () => {
            if (!existsSync(this.coldDirPath)) return 0;
            const files = await fs.readdir(this.coldDirPath);
            return files.filter((name) => name.endsWith('.gics') && !this.isSystemSegmentFile(name)).length;
        }, this.fileLockTimeoutMs);
    }

    private async loadOrRebuildStateIndex(): Promise<void> {
        await fs.mkdir(this.warmDirPath, { recursive: true });
        await fs.mkdir(this.coldDirPath, { recursive: true });

        let loadedFromDisk = false;
        try {
            await this.stateIndex.load();
            loadedFromDisk = true;
        } catch (err: any) {
            console.warn(`[GICS] StateIndex load failed, rebuilding from segments: ${err.message}`);
            this.stateIndex.clear();
        }

        await this.rebuildSegmentCatalog();
        if (!loadedFromDisk || !this.validateStateIndexAgainstSegments()) {
            await this.rebuildStateIndexFromSegments();
            await this.stateIndex.save();
        }
    }

    private validateStateIndexAgainstSegments(): boolean {
        for (const entry of this.stateIndex.snapshotEntries()) {
            if (entry.tier === 'hot') continue;
            if (!entry.segmentRef) return false;
            if (!this.segmentCatalog.has(entry.segmentRef)) return false;
        }
        return true;
    }

    private async rebuildSegmentCatalog(): Promise<void> {
        this.segmentCatalog.clear();
        const loadTier = async (dir: string, tier: 'warm' | 'cold') => {
            if (!existsSync(dir)) return;
            const names = (await fs.readdir(dir)).filter((name) => name.endsWith('.gics')).sort((a, b) => a.localeCompare(b));
            for (const name of names) {
                const filePath = path.join(dir, name);
                this.segmentCatalog.set(filePath, {
                    filePath,
                    tier,
                    system: this.isSystemSegmentFile(name),
                });
            }
        };

        await loadTier(this.warmDirPath, 'warm');
        await loadTier(this.coldDirPath, 'cold');
    }

    private async rebuildStateIndexFromSegments(): Promise<void> {
        this.stateIndex.clear();
        const segments = Array.from(this.segmentCatalog.values()).sort((a, b) => a.filePath.localeCompare(b.filePath));
        for (const segment of segments) {
            const raw = await fs.readFile(segment.filePath);
            const snapshots = await this.decodeSnapshotsWithFallback(raw, segment.tier === 'cold');
            for (const snapshot of snapshots) {
                for (const [rawKey, rawFields] of snapshot.items.entries()) {
                    const key = String(rawKey);
                    const fields = this.restoreOriginalFieldShape(rawFields);
                    this.stateIndex.recordPut(key, fields, {
                        timestamp: snapshot.timestamp,
                        tier: segment.tier,
                        segmentRef: segment.filePath,
                    });
                }
            }
        }
    }

    private async decodeSnapshotsWithFallback(raw: Buffer, coldTier: boolean): Promise<GenericSnapshot<Record<string, number | string>>[]> {
        try {
            const decoder = new GICSv2Decoder(raw, { telemetry: this.telemetry });
            return await decoder.getAllGenericSnapshots();
        } catch {
            if (!coldTier) throw new Error('Failed to decode warm segment');
            const password = process.env[this.coldPasswordEnvVar] ?? '';
            if (!password) throw new Error(`Failed to decode cold segment and no ${this.coldPasswordEnvVar} provided`);
            const decoder = new GICSv2Decoder(raw, { password, telemetry: this.telemetry });
            return await decoder.getAllGenericSnapshots();
        }
    }

    private async querySnapshotsWithFallback(raw: Buffer, key: string, coldTier: boolean): Promise<GenericSnapshot<Record<string, number | string>>[]> {
        try {
            const decoder = new GICSv2Decoder(raw, { telemetry: this.telemetry });
            return await decoder.queryGeneric(key);
        } catch {
            if (!coldTier) throw new Error('Failed to query warm segment');
            const password = process.env[this.coldPasswordEnvVar] ?? '';
            if (!password) throw new Error(`Failed to query cold segment and no ${this.coldPasswordEnvVar} provided`);
            const decoder = new GICSv2Decoder(raw, { password, telemetry: this.telemetry });
            return await decoder.queryGeneric(key);
        }
    }

    private async hydrateEntryFromSegment(entry: StateIndexEntry): Promise<StateIndexEntry | null> {
        if (!entry.segmentRef) return null;
        const segment = this.segmentCatalog.get(entry.segmentRef);
        if (!segment) return null;
        const raw = await fs.readFile(entry.segmentRef);
        const snapshots = await this.querySnapshotsWithFallback(raw, entry.key, segment.tier === 'cold');

        let winner: { timestamp: number; fields: Record<string, number | string> } | null = null;
        for (const snapshot of snapshots) {
            const fields = snapshot.items.get(entry.key);
            if (!fields) continue;
            if (!winner || snapshot.timestamp >= winner.timestamp) {
                winner = { timestamp: snapshot.timestamp, fields: this.restoreOriginalFieldShape(fields) };
            }
        }

        if (!winner) return null;
        this.stateIndex.recordPut(entry.key, winner.fields, {
            timestamp: winner.timestamp,
            tier: segment.tier,
            segmentRef: entry.segmentRef,
        });
        return this.stateIndex.getVisible(entry.key, true);
    }

    private restoreOriginalFieldShape(fields: Record<string, number | string>): Record<string, number | string> {
        const restored: Record<string, number | string> = {};
        const presence = new Map<string, number>();

        for (const [key, value] of Object.entries(fields)) {
            if (!key.startsWith(GICSDaemon.PRESENCE_PREFIX)) {
                restored[key] = value;
                continue;
            }
            const target = key.slice(GICSDaemon.PRESENCE_PREFIX.length);
            presence.set(target, typeof value === 'number' ? value : Number(value));
        }

        for (const [fieldName, flag] of presence.entries()) {
            if (flag === 0) delete restored[fieldName];
        }
        return restored;
    }

    private serializeRecordWithPresence(fields: Record<string, number | string>): Record<string, number | string> {
        const out: Record<string, number | string> = { ...fields };
        for (const fieldName of Object.keys(fields)) {
            out[`${GICSDaemon.PRESENCE_PREFIX}${fieldName}`] = 1;
        }
        return out;
    }

    private inferSchemaAndSnapshot(records: Array<{ key: string; fields: Record<string, number | string>; updated: number }>): {
        schema: SchemaProfile;
        snapshot: GenericSnapshot<Record<string, number | string>>;
    } {
        const serialized = records.map((record) => this.serializeRecordWithPresence(record.fields));
        const inferredSchema = this.inferSchemaFromFields(serialized);

        const items = new Map<string, Record<string, number | string>>();
        let snapshotTimestamp = Date.now();
        for (const record of records) {
            snapshotTimestamp = Math.max(snapshotTimestamp, record.updated);
            items.set(record.key, this.serializeRecordWithPresence(record.fields));
        }

        return {
            schema: inferredSchema,
            snapshot: { timestamp: snapshotTimestamp, items },
        };
    }
    private inferSchemaFromFields(allFields: Array<Record<string, number | string>>): SchemaProfile {
        const fieldNames = new Set<string>();
        for (const fields of allFields) {
            for (const fieldName of Object.keys(fields)) {
                fieldNames.add(fieldName);
            }
        }

        const fields: SchemaProfile['fields'] = [];
        const sortedFieldNames = Array.from(fieldNames).sort((a, b) => a.localeCompare(b));
        for (const fieldName of sortedFieldNames) {
            const values = allFields
                .map((entry) => entry[fieldName])
                .filter((value): value is number | string => value != null);

            const isNumeric = values.every((value) => typeof value === 'number');
            if (isNumeric) {
                fields.push({
                    name: fieldName,
                    type: 'numeric',
                    codecStrategy: 'value',
                });
                continue;
            }

            const enumMap: Record<string, number> = { '__MISSING__': 0 };
            let idx = 1;
            const categoricalValues = Array.from(new Set(values.filter((value): value is string => typeof value === 'string'))).sort((a, b) => a.localeCompare(b));
            for (const value of categoricalValues) {
                if (!(value in enumMap)) {
                    enumMap[value] = idx++;
                }
            }

            fields.push({
                name: fieldName,
                type: 'categorical',
                codecStrategy: 'structural',
                enumMap,
            });
        }

        return {
            id: 'gics_daemon_memtable_v2',
            version: 2,
            itemIdType: 'string',
            fields,
        };
    }

    private async writeSegment(filePath: string, records: Array<{ key: string; fields: Record<string, number | string>; updated: number }>): Promise<number> {
        const { schema, snapshot } = this.inferSchemaAndSnapshot(records);
        const encoder = new GICSv2Encoder({ schema, telemetry: this.telemetry });
        await encoder.addSnapshot(snapshot);
        const packed = await encoder.finish();
        await fs.writeFile(filePath, packed);
        return packed.length;
    }

    private async flushMemTableToWarm(trigger: 'manual' | 'auto', reason: string | null = null): Promise<{
        recordsBeforeFlush: number;
        dirtyBeforeFlush: number;
        recordsFlushed: number;
        bytesWritten: number;
        segmentCreated: string | null;
        systemSegmentCreated: string | null;
        flushDurationMs: number;
        walTruncated: boolean;
        trigger: 'manual' | 'auto';
        reason: string | null;
    }> {
        const start = Date.now();
        const labels = { encrypted: 'false', schema_kind: 'generic' };
        try {
            const recordsBeforeFlush = this.memTable.count;
            const dirtyBeforeFlush = this.memTable.dirtyCount;

            if (recordsBeforeFlush === 0 || dirtyBeforeFlush === 0) {
                this.memTable.resetDirty();
                await this.wal.truncate();
                this.refreshHotTelemetry();
                this.telemetry.incrementCounter('gics_flush_total', { ...labels, result: 'ok' }, 1, 'Memtable flushes executed by the daemon.');
                this.telemetry.observeHistogram('gics_flush_duration_seconds', durationSeconds(start), labels, {
                    unit: 'seconds',
                    description: 'Latency of daemon memtable flushes.',
                });
                return {
                    recordsBeforeFlush,
                    dirtyBeforeFlush,
                    recordsFlushed: 0,
                    bytesWritten: 0,
                    segmentCreated: null,
                    systemSegmentCreated: null,
                    flushDurationMs: Date.now() - start,
                    walTruncated: true,
                    trigger,
                    reason,
                };
            }

            const dirtyRecords = this.memTable.scan().filter((record) => record.dirty);
            const userRecords = dirtyRecords.filter((record) => !isSystemKey(record.key));
            const systemRecordMap = new Map<string, { key: string; fields: Record<string, number | string>; updated: number }>();
            const now = Date.now();

            for (const record of dirtyRecords) {
                if (!isSystemKey(record.key)) continue;
                systemRecordMap.set(record.key, { key: record.key, fields: { ...record.fields }, updated: record.updated });
            }

            for (const [key, fields] of this.modules.nativeInsight.snapshotBehavioral()) {
                systemRecordMap.set(key, { key, fields, updated: now });
            }
            for (const [key, fields] of this.modules.nativeInsight.snapshotCorrelations()) {
                systemRecordMap.set(key, { key, fields, updated: now });
            }
            for (const [key, fields] of this.modules.nativeInsight.snapshotConfidence()) {
                systemRecordMap.set(key, { key, fields, updated: now });
            }

            await fs.mkdir(this.warmDirPath, { recursive: true });
            let userSegmentPath: string | null = null;
            let systemSegmentPath: string | null = null;
            let bytesWritten = 0;

            if (userRecords.length > 0) {
                userSegmentPath = path.join(this.warmDirPath, `warm-${Date.now()}-${randomBytes(4).toString('hex')}.gics`);
                bytesWritten += await this.writeSegment(userSegmentPath, userRecords.map((record) => ({
                    key: record.key,
                    fields: { ...record.fields },
                    updated: record.updated,
                })));
                for (const record of userRecords) {
                    this.stateIndex.recordPut(record.key, record.fields, {
                        timestamp: record.updated,
                        tier: 'warm',
                        segmentRef: userSegmentPath,
                    });
                }
                this.segmentCatalog.set(userSegmentPath, { filePath: userSegmentPath, tier: 'warm', system: false });
            }

            const systemRecords = Array.from(systemRecordMap.values());
            if (systemRecords.length > 0) {
                systemSegmentPath = path.join(this.warmDirPath, `${GICSDaemon.SYSTEM_SEGMENT_PREFIX}${Date.now()}-${randomBytes(4).toString('hex')}.gics`);
                bytesWritten += await this.writeSegment(systemSegmentPath, systemRecords);
                for (const record of systemRecords) {
                    this.stateIndex.recordPut(record.key, record.fields, {
                        timestamp: record.updated,
                        tier: 'warm',
                        segmentRef: systemSegmentPath,
                    });
                }
                this.segmentCatalog.set(systemSegmentPath, { filePath: systemSegmentPath, tier: 'warm', system: true });
            }

            this.memTable.clear();
            await this.wal.truncate();
            await this.stateIndex.save();

            await this.modules.registry.onFlush({
                trigger,
                recordsFlushed: dirtyRecords.length,
                bytesWritten,
                segmentCreated: userSegmentPath,
            }, this.moduleContext);

            const result = {
                recordsBeforeFlush,
                dirtyBeforeFlush,
                recordsFlushed: dirtyRecords.length,
                bytesWritten,
                segmentCreated: userSegmentPath,
                systemSegmentCreated: systemSegmentPath,
                flushDurationMs: Date.now() - start,
                walTruncated: true,
                trigger,
                reason,
            };
            this.telemetry.incrementCounter('gics_flush_total', { ...labels, result: 'ok' }, 1, 'Memtable flushes executed by the daemon.');
            this.telemetry.observeHistogram('gics_flush_duration_seconds', durationSeconds(start), labels, {
                unit: 'seconds',
                description: 'Latency of daemon memtable flushes.',
            });
            this.telemetry.incrementCounter('gics_flush_records_total', labels, dirtyRecords.length, 'Records written during daemon memtable flushes.');
            this.telemetry.incrementCounter('gics_flush_bytes_written_total', labels, bytesWritten, 'Bytes written during daemon memtable flushes.');
            await this.refreshStorageTelemetry();
            return result;
        } catch (error) {
            this.telemetry.incrementCounter(
                'gics_flush_total',
                { ...labels, result: 'error', error_type: normalizeErrorType(error) },
                1,
                'Memtable flushes executed by the daemon.',
            );
            this.telemetry.observeHistogram('gics_flush_duration_seconds', durationSeconds(start), labels, {
                unit: 'seconds',
                description: 'Latency of daemon memtable flushes.',
            });
            this.telemetry.recordEvent('flush_failed', {
                trigger,
                reason,
                errorType: normalizeErrorType(error),
            });
            throw error;
        }
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
        const startedAt = Date.now();
        try {
            await fs.mkdir(this.warmDirPath, { recursive: true });
            const warmFiles = (await fs.readdir(this.warmDirPath))
                .filter((name) => name.endsWith('.gics') && !this.isSystemSegmentFile(name))
                .sort((a, b) => a.localeCompare(b));

            if (warmFiles.length < 2) {
                return {
                    compacted: false,
                    reason: 'not_enough_segments',
                    segmentsMerged: 0,
                    recordsDeduplicated: 0,
                    bytesBefore: 0,
                    bytesAfter: 0,
                    spaceReclaimedBytes: 0,
                    outputSegment: null,
                };
            }

            const warmState = this.stateIndex.snapshotEntries()
                .filter((entry) => entry.tier === 'warm' && !entry.deleted && entry.fields && !isSystemKey(entry.key));

            const mergedRecords = warmState.map((entry) => ({
                key: entry.key,
                fields: { ...entry.fields! },
                updated: entry.timestamp,
            }));

            let bytesBefore = 0;
            const oldSegmentRefs: string[] = [];
            for (const fileName of warmFiles) {
                const filePath = path.join(this.warmDirPath, fileName);
                const stat = await fs.stat(filePath);
                bytesBefore += stat.size;
                oldSegmentRefs.push(filePath);
            }

            const outputSegment = path.join(this.warmDirPath, `compact-${Date.now()}-${randomBytes(4).toString('hex')}.gics`);
            const bytesAfter = await this.writeSegment(outputSegment, mergedRecords);

            for (const filePath of oldSegmentRefs) {
                await fs.unlink(filePath);
                this.segmentCatalog.delete(filePath);
            }
            this.segmentCatalog.set(outputSegment, { filePath: outputSegment, tier: 'warm', system: false });

            const remap = new Map<string, { tier: StateIndexTier; segmentRef: string | null }>();
            for (const oldRef of oldSegmentRefs) {
                remap.set(oldRef, { tier: 'warm', segmentRef: outputSegment });
            }
            this.stateIndex.remapSegments(remap);
            await this.stateIndex.save();

            await this.modules.registry.onCompact({ compacted: true, segmentsMerged: warmFiles.length }, this.moduleContext);
            this.telemetry.incrementCounter(
                'gics_compact_total',
                { result: 'ok' },
                1,
                'Warm-segment compactions executed by the daemon.',
            );
            this.telemetry.observeHistogram(
                'gics_compact_duration_seconds',
                durationSeconds(startedAt),
                {},
                {
                    unit: 'seconds',
                    description: 'Latency of warm-segment compactions.',
                },
            );
            await this.refreshStorageTelemetry();
            return {
                compacted: true,
                segmentsMerged: warmFiles.length,
                recordsDeduplicated: Math.max(0, warmFiles.length - 1),
                bytesBefore,
                bytesAfter,
                spaceReclaimedBytes: Math.max(0, bytesBefore - bytesAfter),
                outputSegment,
            };
        } catch (error) {
            this.telemetry.incrementCounter(
                'gics_compact_total',
                { result: 'error', error_type: normalizeErrorType(error) },
                1,
                'Warm-segment compactions executed by the daemon.',
            );
            this.telemetry.observeHistogram(
                'gics_compact_duration_seconds',
                durationSeconds(startedAt),
                {},
                {
                    unit: 'seconds',
                    description: 'Latency of warm-segment compactions.',
                },
            );
            this.telemetry.recordEvent('compact_failed', {
                errorType: normalizeErrorType(error),
            });
            throw error;
        }
    }
    private async reencodeForColdEncryption(inputPath: string, outputPath: string, password: string): Promise<number> {
        const raw = await fs.readFile(inputPath);
        const decoder = new GICSv2Decoder(raw, { telemetry: this.telemetry });
        await decoder.parseHeader();
        const schema = decoder.getSchema();
        const snapshots = await decoder.getAllGenericSnapshots();

        const encoder = new GICSv2Encoder({ schema, password, telemetry: this.telemetry });
        for (const snapshot of snapshots) {
            await encoder.addSnapshot(snapshot);
        }
        const encrypted = await encoder.finish();
        await fs.writeFile(outputPath, encrypted);
        return encrypted.length;
    }

    // eslint-disable-next-line sonarjs/cognitive-complexity
    private async rotateWarmToCold(): Promise<{
        rotated: boolean;
        filesArchived: number;
        filesDeleted: number;
        bytesArchived: number;
        archivedFiles: string[];
        deletedColdFiles: string[];
    }> {
        const startedAt = Date.now();
        try {
            await fs.mkdir(this.warmDirPath, { recursive: true });
            await fs.mkdir(this.coldDirPath, { recursive: true });

            const now = Date.now();
            const warmFiles = (await fs.readdir(this.warmDirPath)).filter((name) => name.endsWith('.gics'));
            const archivedFiles: string[] = [];
            let bytesArchived = 0;

            const password = process.env[this.coldPasswordEnvVar] ?? '';
            if (this.coldEncryption && !password) {
                throw new Error(`Cold encryption enabled but env var ${this.coldPasswordEnvVar} is missing`);
            }

            const remap = new Map<string, { tier: StateIndexTier; segmentRef: string | null }>();
            for (const fileName of warmFiles) {
                const warmPath = path.join(this.warmDirPath, fileName);
                const st = await fs.stat(warmPath);
                if ((now - st.mtimeMs) < this.warmRetentionMs) continue;

                const prefix = this.isSystemSegmentFile(fileName) ? GICSDaemon.SYSTEM_SEGMENT_PREFIX : 'cold-';
                const coldName = `${prefix}${Date.now()}-${randomBytes(4).toString('hex')}.gics`;
                const coldPath = path.join(this.coldDirPath, coldName);

                if (this.coldEncryption) {
                    bytesArchived += await this.reencodeForColdEncryption(warmPath, coldPath, password);
                    await fs.unlink(warmPath);
                } else {
                    await fs.rename(warmPath, coldPath);
                    bytesArchived += st.size;
                }

                archivedFiles.push(coldPath);
                this.segmentCatalog.delete(warmPath);
                this.segmentCatalog.set(coldPath, {
                    filePath: coldPath,
                    tier: 'cold',
                    system: this.isSystemSegmentFile(fileName),
                });
                remap.set(warmPath, { tier: 'cold', segmentRef: coldPath });
            }

            const deletedColdFiles: string[] = [];
            if (this.coldRetentionMs > 0) {
                const coldFiles = (await fs.readdir(this.coldDirPath)).filter((name) => name.endsWith('.gics'));
                for (const fileName of coldFiles) {
                    const coldPath = path.join(this.coldDirPath, fileName);
                    const st = await fs.stat(coldPath);
                    if ((now - st.mtimeMs) <= this.coldRetentionMs) continue;
                    await fs.unlink(coldPath);
                    deletedColdFiles.push(coldPath);
                    this.segmentCatalog.delete(coldPath);
                    this.stateIndex.removeEntriesForSegment(coldPath);
                }
            }

            if (remap.size > 0) {
                this.stateIndex.remapSegments(remap);
            }
            await this.stateIndex.save();
            await this.modules.registry.onRotate({
                rotated: archivedFiles.length > 0 || deletedColdFiles.length > 0,
                filesArchived: archivedFiles.length,
            }, this.moduleContext);
            this.telemetry.incrementCounter(
                'gics_rotate_total',
                { result: 'ok', encrypted: normalizeBooleanLabel(this.coldEncryption) },
                1,
                'Warm-to-cold rotation cycles executed by the daemon.',
            );
            this.telemetry.observeHistogram(
                'gics_rotate_duration_seconds',
                durationSeconds(startedAt),
                { encrypted: normalizeBooleanLabel(this.coldEncryption) },
                {
                    unit: 'seconds',
                    description: 'Latency of warm-to-cold rotation cycles.',
                },
            );
            await this.refreshStorageTelemetry();
            return {
                rotated: archivedFiles.length > 0 || deletedColdFiles.length > 0,
                filesArchived: archivedFiles.length,
                filesDeleted: deletedColdFiles.length,
                bytesArchived,
                archivedFiles,
                deletedColdFiles,
            };
        } catch (error) {
            this.telemetry.incrementCounter(
                'gics_rotate_total',
                { result: 'error', encrypted: normalizeBooleanLabel(this.coldEncryption), error_type: normalizeErrorType(error) },
                1,
                'Warm-to-cold rotation cycles executed by the daemon.',
            );
            this.telemetry.observeHistogram(
                'gics_rotate_duration_seconds',
                durationSeconds(startedAt),
                { encrypted: normalizeBooleanLabel(this.coldEncryption) },
                {
                    unit: 'seconds',
                    description: 'Latency of warm-to-cold rotation cycles.',
                },
            );
            this.telemetry.recordEvent('rotate_failed', {
                encrypted: this.coldEncryption,
                errorType: normalizeErrorType(error),
            });
            throw error;
        }
    }

    private async upsertSystemRecord(key: string, fields: Record<string, number | string>): Promise<void> {
        await this.wal.append(Operation.PUT, key, fields);
        this.applyHotPut(key, fields, Date.now());
    }

    private getTierIndexStats(): { hotKeys: number; warmKeys: number; coldKeys: number; } {
        let hotKeys = 0;
        let warmKeys = 0;
        let coldKeys = 0;
        for (const entry of this.stateIndex.snapshotEntries()) {
            if (entry.deleted || isHiddenSystemKey(entry.key)) continue;
            if (entry.tier === 'hot') hotKeys++;
            else if (entry.tier === 'warm') warmKeys++;
            else coldKeys++;
        }
        return { hotKeys, warmKeys, coldKeys };
    }

    private async handlePut(id: any, params: any): Promise<any> {
        if (this.supervisor.isDegraded()) {
            const buffered = this.supervisor.bufferWrite(params.key, params.fields);
            return { jsonrpc: '2.0', id, result: { ok: true, degraded: true, bufferedSeq: buffered.seq } };
        }

        const timestamp = Date.now();
        await this.modules.registry.beforeWrite({
            key: params.key,
            fields: { ...params.fields },
            timestamp,
        }, this.moduleContext);

        await this.wal.append(Operation.PUT, params.key, params.fields);
        this.applyHotPut(params.key, params.fields, timestamp);
        await this.modules.registry.onWrite({
            key: params.key,
            fields: { ...params.fields },
            timestamp,
        }, this.moduleContext);

        const behavior = this.modules.nativeInsight.getInsight(params.key) ?? undefined;
        const autoFlush = await this.maybeAutoFlush();
        if (!autoFlush) {
            return { jsonrpc: '2.0', id, result: { ok: true, behavior } };
        }

        return {
            jsonrpc: '2.0',
            id,
            result: {
                ok: true,
                behavior,
                autoFlushed: true,
                flush: autoFlush,
            },
        };
    }

    private async handleGet(id: any, params: any): Promise<any> {
        const key = String(params?.key ?? '');
        const includeSystem = Boolean(params?.includeSystem ?? isSystemKey(key));
        let entry = this.stateIndex.getVisible(key, includeSystem);
        if (!entry) {
            const rawEntry = this.stateIndex.getEntry(key);
            if (rawEntry && !rawEntry.fields && !rawEntry.deleted) {
                entry = await this.hydrateEntryFromSegment(rawEntry);
            }
        }
        if (!entry || entry.deleted || (!includeSystem && isHiddenSystemKey(entry.key)) || !entry.fields) {
            return { jsonrpc: '2.0', id, result: null };
        }

        if (entry.tier !== 'hot' && !isHiddenSystemKey(entry.key)) {
            this.modules.nativeInsight.coldStartBootstrap(entry.key);
        }
        await this.modules.registry.onRead({ key: entry.key, timestamp: Date.now() }, this.moduleContext);
        const behavior = isHiddenSystemKey(entry.key) ? null : this.modules.nativeInsight.getInsight(entry.key);
        return {
            jsonrpc: '2.0',
            id,
            result: {
                key: entry.key,
                fields: { ...entry.fields },
                tier: entry.tier,
                behavior,
            },
        };
    }

    private async handleDelete(id: any, params: any): Promise<any> {
        const key = String(params?.key ?? '');
        const timestamp = Date.now();
        const tombstoneKey = makeTombstoneKey(key);
        const tombstoneFields = {
            target_key: key,
            deleted_at_ms: timestamp,
        };

        await this.modules.registry.beforeDelete({
            key,
            timestamp,
            tombstoneKey,
        }, this.moduleContext);

        await this.wal.appendBatch([
            { op: Operation.DELETE, key, payload: {} },
            { op: Operation.PUT, key: tombstoneKey, payload: tombstoneFields },
        ]);
        this.applyHotDelete(key, tombstoneKey, tombstoneFields, timestamp);
        await this.modules.registry.onDelete({ key, timestamp, tombstoneKey }, this.moduleContext);
        return { jsonrpc: '2.0', id, result: { ok: true, tombstoneKey } };
    }

    private async handleScan(id: any, params: any): Promise<any> {
        const options: StateIndexScanOptions = {
            tiers: params?.tiers ?? 'all',
            includeSystem: Boolean(params?.includeSystem ?? false),
            limit: params?.limit,
            cursor: params?.cursor ?? null,
            mode: params?.mode ?? 'current',
        };
        const result = this.stateIndex.scan(String(params?.prefix ?? ''), options);
        await this.modules.registry.onScan(result, this.moduleContext);
        return {
            jsonrpc: '2.0',
            id,
            result: {
                items: result.items.map((item) => ({
                    key: item.key,
                    fields: item.fields,
                    tier: item.tier,
                    timestamp: item.timestamp,
                })),
                nextCursor: result.nextCursor,
            },
        };
    }
    private async handleReportOutcome(id: any, params: any): Promise<any> {
        const insightId = String(params?.insightId ?? '');
        const result = String(params?.result ?? '');
        const domain = params?.domain ? String(params.domain) : undefined;
        const decisionId = params?.decisionId ? String(params.decisionId) : undefined;
        const timestamp = Date.now();
        const outcomeEvent = {
            insightId: insightId || undefined,
            result,
            domain,
            decisionId,
            context: params?.context,
            metrics: params?.metrics,
            timestamp,
        };

        let disabled = false;
        if (insightId) {
            const recorded = this.modules.nativeInsight.recordOutcome(insightId, result as any);
            if (!recorded?.found) {
                return { jsonrpc: '2.0', id, error: { code: -32602, message: `Insight ${insightId} not found` } };
            }
            disabled = recorded.nowDisabled;
            if (!recorded.wasDisabled && recorded.nowDisabled) {
                this.emitEvent('insight_disabled', { insightId, result });
            }
        }

        await this.dispatchOutcomeToModules(outcomeEvent);

        return {
            jsonrpc: '2.0',
            id,
            result: {
                ok: true,
                insightId: insightId || undefined,
                decisionId,
                domain,
                result,
                recordedAt: timestamp,
                disabled,
            },
        };
    }

    private async handleRecommendations(id: any, params: any): Promise<any> {
        const predictive = this.modules.nativeInsight.getSignalRecommendations(params);
        const moduleRecommendations = await this.modules.registry.getRecommendations({
            domain: params?.domain,
            subject: params?.subject,
            limit: params?.limit,
        }, this.moduleContext);
        const limit = Math.max(0, Number(params?.limit ?? 0));
        const combined = [...predictive, ...moduleRecommendations];
        return { jsonrpc: '2.0', id, result: limit > 0 ? combined.slice(0, limit) : combined };
    }

    private async handleInfer(id: any, params: any): Promise<any> {
        const request: InferenceRequest = {
            domain: String(params?.domain ?? ''),
            objective: params?.objective ? String(params.objective) : undefined,
            subject: params?.subject ? String(params.subject) : undefined,
            context: params?.context ?? {},
            candidates: Array.isArray(params?.candidates) ? params.candidates : [],
        };
        if (!request.domain) {
            return { jsonrpc: '2.0', id, error: { code: -32602, message: 'infer requires domain' } };
        }
        const decision = await this.modules.registry.infer(request, this.moduleContext);
        return { jsonrpc: '2.0', id, result: decision };
    }

    private async handleGetProfile(id: any, params: any): Promise<any> {
        const scope = String(params?.scope ?? this.config.defaultProfileScope ?? 'host:default');
        const profile = await this.modules.registry.getProfile(scope, this.moduleContext);
        return { jsonrpc: '2.0', id, result: profile };
    }

    private async handleGetInferenceRuntime(id: any): Promise<any> {
        const inferenceModule = this.modules.inferenceEngine;
        if (!inferenceModule?.enabled) {
            return { jsonrpc: '2.0', id, error: { code: -32602, message: 'Inference engine is not enabled' } };
        }
        return { jsonrpc: '2.0', id, result: await inferenceModule.snapshot?.() ?? await inferenceModule.health?.() ?? null };
    }

    private async handleFlushInference(id: any): Promise<any> {
        const inferenceModule = this.modules.inferenceEngine;
        if (!inferenceModule || !inferenceModule.enabled || typeof inferenceModule.forceFlush !== 'function') {
            return { jsonrpc: '2.0', id, error: { code: -32602, message: 'Inference engine flush is unavailable' } };
        }
        await inferenceModule.forceFlush();
        return { jsonrpc: '2.0', id, result: { ok: true } };
    }

    private async handleSeedProfile(id: any, params: any): Promise<any> {
        const inferenceModule = this.modules.inferenceEngine;
        if (!inferenceModule || !inferenceModule.enabled || typeof inferenceModule.seedProfile !== 'function') {
            return { jsonrpc: '2.0', id, error: { code: -32602, message: 'Inference engine profile seeding is unavailable' } };
        }

        const scope = String(params?.scope ?? this.config.defaultProfileScope ?? 'host:default');
        const result = await inferenceModule.seedProfile({
            scope,
            hostFingerprint: params?.hostFingerprint ? String(params.hostFingerprint) : undefined,
            version: params?.version != null ? Number(params.version) : undefined,
            updatedAt: params?.updatedAt != null ? Number(params.updatedAt) : undefined,
            stats: params?.stats && typeof params.stats === 'object' ? params.stats : undefined,
            preferences: params?.preferences && typeof params.preferences === 'object' ? params.preferences : undefined,
            policyHints: params?.policyHints && typeof params.policyHints === 'object' ? params.policyHints : undefined,
        }, this.moduleContext);

        return { jsonrpc: '2.0', id, result };
    }

    private async handleSeedPolicy(id: any, params: any): Promise<any> {
        const inferenceModule = this.modules.inferenceEngine;
        if (!inferenceModule || !inferenceModule.enabled || typeof inferenceModule.seedPolicy !== 'function') {
            return { jsonrpc: '2.0', id, error: { code: -32602, message: 'Inference engine policy seeding is unavailable' } };
        }

        if (!params?.domain) {
            return { jsonrpc: '2.0', id, error: { code: -32602, message: 'seedPolicy requires domain' } };
        }

        const result = await inferenceModule.seedPolicy({
            domain: String(params.domain),
            scope: String(params?.scope ?? this.config.defaultProfileScope ?? 'host:default'),
            subject: params?.subject ? String(params.subject) : undefined,
            policyVersion: params?.policyVersion ? String(params.policyVersion) : undefined,
            profileVersion: params?.profileVersion ? String(params.profileVersion) : undefined,
            generatedAt: params?.generatedAt != null ? Number(params.generatedAt) : undefined,
            basis: Array.isArray(params?.basis) ? params.basis.map((value: unknown) => String(value)) : undefined,
            weights: params?.weights && typeof params.weights === 'object' ? params.weights : undefined,
            thresholds: params?.thresholds && typeof params.thresholds === 'object' ? params.thresholds : undefined,
            recommendedCandidateId: params?.recommendedCandidateId ? String(params.recommendedCandidateId) : undefined,
            payload: params?.payload && typeof params.payload === 'object' ? params.payload : undefined,
            evidenceKeys: Array.isArray(params?.evidenceKeys) ? params.evidenceKeys.map((value: unknown) => String(value)) : undefined,
        }, this.moduleContext);

        return { jsonrpc: '2.0', id, result };
    }

    private async handleGetTelemetry(id: any): Promise<any> {
        await this.refreshStorageTelemetry();
        return {
            jsonrpc: '2.0',
            id,
            result: this.telemetry.snapshot(),
        };
    }

    private async handlePutMany(id: any, params: any): Promise<any> {
        const rawRecords: Array<{ key?: unknown; fields?: unknown }> = Array.isArray(params?.records) ? params.records : [];
        if (rawRecords.length === 0) {
            return { jsonrpc: '2.0', id, error: { code: -32602, message: 'putMany requires a non-empty records array' } };
        }

        const records: PutRecord[] = rawRecords.map((entry, index) => {
            const key = typeof entry?.key === 'string' ? entry.key : '';
            const fields = entry?.fields && typeof entry.fields === 'object' && !Array.isArray(entry.fields)
                ? entry.fields as Record<string, number | string>
                : null;
            if (!key || !fields) {
                throw new Error(`Invalid putMany record at index ${index}`);
            }
            return cloneRecord({ key, fields });
        });

        const requestedAtomic = Boolean(params?.atomic ?? true);
        const verify = Boolean(params?.verify ?? false);
        const idempotencyKey = params?.idempotency_key ? String(params.idempotency_key) : (params?.idempotencyKey ? String(params.idempotencyKey) : null);
        const idempotencySystemKey = idempotencyKey ? makeIdempotencyKey(idempotencyKey) : null;
        const effectiveAtomic = idempotencySystemKey ? true : requestedAtomic;

        const executePutMany = async (): Promise<any> => {
            const requestHash = hashPutManyPayload(records, effectiveAtomic, verify);

            let idempotencyFields: Record<string, number | string> | null = null;
            if (idempotencySystemKey) {
                const existing = this.stateIndex.getVisible(idempotencySystemKey, true);
                const existingHash = typeof existing?.fields?.request_hash === 'string' ? existing.fields.request_hash : null;
                if (existingHash && existingHash !== requestHash) {
                    return {
                        jsonrpc: '2.0',
                        id,
                        error: { code: -32602, message: `Idempotency key ${idempotencyKey} was already used with a different payload` },
                    };
                }
                if (existingHash === requestHash) {
                    return {
                        jsonrpc: '2.0',
                        id,
                        result: {
                            ok: true,
                            count: records.length,
                            atomic: effectiveAtomic,
                            verified: verify,
                            idempotencyKey,
                            deduplicated: true,
                        },
                    };
                }

                // Crash-safe dedupe needs the idempotency marker and all records in one WAL batch.
                idempotencyFields = {
                    operation: 'putMany',
                    request_hash: requestHash,
                    record_count: records.length,
                    atomic: effectiveAtomic ? 1 : 0,
                    verify: verify ? 1 : 0,
                    processed_at_ms: Date.now(),
                    first_key: records[0]!.key,
                    last_key: records[records.length - 1]!.key,
                };
            }

            const timestamp = Date.now();
            for (const record of records) {
                await this.modules.registry.beforeWrite({
                    key: record.key,
                    fields: { ...record.fields },
                    timestamp,
                }, this.moduleContext);
            }

            const walEntries: WALBatchEntry[] = records.map((record) => ({
                op: Operation.PUT,
                key: record.key,
                payload: { ...record.fields },
            }));
            if (idempotencySystemKey && idempotencyFields) {
                walEntries.push({
                    op: Operation.PUT,
                    key: idempotencySystemKey,
                    payload: { ...idempotencyFields },
                });
            }

            if (effectiveAtomic) {
                await this.wal.appendBatch(walEntries);
            } else {
                for (const entry of walEntries) {
                    await this.wal.append(entry.op, entry.key, entry.payload);
                }
            }

            for (const record of records) {
                this.applyHotPut(record.key, record.fields, timestamp);
            }
            if (idempotencySystemKey && idempotencyFields) {
                this.applyHotPut(idempotencySystemKey, idempotencyFields, timestamp);
            }

            for (const record of records) {
                await this.modules.registry.onWrite({
                    key: record.key,
                    fields: { ...record.fields },
                    timestamp,
                }, this.moduleContext);
            }

            if (verify) {
                for (const record of records) {
                    if (!this.verifyHotRecord(record.key, record.fields)) {
                        throw new Error(`putMany verification failed for key ${record.key}`);
                    }
                }
            }

            const autoFlush = await this.maybeAutoFlush();
            return {
                jsonrpc: '2.0',
                id,
                result: {
                    ok: true,
                    count: records.length,
                    atomic: effectiveAtomic,
                    verified: verify,
                    idempotencyKey: idempotencyKey ?? undefined,
                    deduplicated: false,
                    autoFlushed: autoFlush != null,
                    flush: autoFlush ?? undefined,
                },
            };
        };

        if (idempotencySystemKey) {
            return await this.withIdempotencyLock(idempotencySystemKey, executePutMany);
        }
        return await executePutMany();
    }

    private async handleCountPrefix(id: any, params: any): Promise<any> {
        const options: StateIndexScanOptions = {
            tiers: params?.tiers ?? 'all',
            includeSystem: Boolean(params?.includeSystem ?? false),
            mode: params?.mode ?? 'current',
        };
        await this.noteSyntheticScan();
        return {
            jsonrpc: '2.0',
            id,
            result: {
                prefix: String(params?.prefix ?? ''),
                count: this.stateIndex.countPrefix(String(params?.prefix ?? ''), options),
            },
        };
    }

    private async handleLatestByPrefix(id: any, params: any): Promise<any> {
        const options: StateIndexScanOptions = {
            tiers: params?.tiers ?? 'all',
            includeSystem: Boolean(params?.includeSystem ?? false),
            mode: params?.mode ?? 'current',
        };
        await this.noteSyntheticScan();
        return {
            jsonrpc: '2.0',
            id,
            result: this.stateIndex.latestByPrefix(String(params?.prefix ?? ''), options),
        };
    }

    private async handleScanSummary(id: any, params: any): Promise<any> {
        const options: StateIndexScanOptions = {
            tiers: params?.tiers ?? 'all',
            includeSystem: Boolean(params?.includeSystem ?? false),
            mode: params?.mode ?? 'current',
        };
        await this.noteSyntheticScan();
        return {
            jsonrpc: '2.0',
            id,
            result: this.stateIndex.scanSummary(String(params?.prefix ?? ''), options),
        };
    }

    private async handleGetTelemetryEvents(id: any, params: any): Promise<any> {
        const limit = Math.min(500, Math.max(0, Number(params?.limit ?? 100)));
        const type = params?.type ? String(params.type) : undefined;
        return {
            jsonrpc: '2.0',
            id,
            result: {
                events: this.telemetry.getEvents(limit, type),
            },
        };
    }

    private async buildVerbosePingResult(): Promise<Record<string, unknown>> {
        await this.refreshStorageTelemetry();
        const segments = await this.countSegmentFiles();
        const coldSegments = await this.countColdSegmentFiles();
        const tierStats = this.getTierIndexStats();
        return {
            status: 'ok',
            uptime: process.uptime(),
            count: this.memTable.count,
            memtableSize: this.memTable.sizeBytes,
            memtable_size: this.memTable.sizeBytes,
            dirtyCount: this.memTable.dirtyCount,
            recoveredEntries: this.recoveredEntries,
            walType: this.walType,
            walFsyncMode: this.walFsyncMode,
            walFsyncOnCommit: this.walFsyncOnCommit,
            walCheckpointEveryOps: this.walCheckpointEveryOps,
            walCheckpointEveryMs: this.walCheckpointEveryMs,
            walMaxSizeMB: this.walMaxSizeMB,
            segments,
            coldSegments,
            tiers: {
                hot: tierStats.hotKeys,
                warmSegments: segments,
                coldSegments,
            },
            tierIndex: {
                warmKeys: tierStats.warmKeys,
                coldKeys: tierStats.coldKeys,
            },
            insightsTracked: this.modules.nativeInsight.getInsights().length,
            supervisorState: this.supervisor.getState(),
        };
    }

    private async dispatchOutcomeToModules(event: {
        insightId?: string;
        result?: string;
        domain?: string;
        decisionId?: string;
        context?: unknown;
        metrics?: Record<string, number>;
        timestamp: number;
    }): Promise<void> {
        for (const module of this.modules.registry.enabled()) {
            if (module.manifest.id === 'native-insight') continue;
            await module.onOutcome?.(event, this.moduleContext);
        }
    }

    private async handleRequest(request: any, socket?: net.Socket): Promise<any> {
        const { method, params, id, token } = request;

        if (!method || typeof method !== 'string') {
            this.telemetry.recordEvent('request_rejected', { reason: 'invalid_request' });
            return {
                jsonrpc: '2.0',
                id: id ?? null,
                error: { code: -32600, message: 'Invalid Request' },
            };
        }

        if (token !== this.token && method !== 'ping') {
            this.telemetry.recordEvent('request_rejected', {
                reason: 'unauthorized',
                method,
            });
            return { jsonrpc: '2.0', id, error: { code: -32000, message: 'Unauthorized' } };
        }

        try {
            const exec = () => this.executeMethod(method, params, id, socket);
            if (GICSDaemon.CONTROL_OPS.has(method)) {
                return await exec();
            }
            if (GICSDaemon.WRITE_OPS.has(method)) {
                return await this.resilience.executeWrite(exec);
            }
            if (GICSDaemon.SCAN_OPS.has(method)) {
                return await this.resilience.executeScan(exec);
            }
            if (GICSDaemon.READ_OPS.has(method)) {
                return await this.resilience.executeRead(exec);
            }
            return await exec();
        } catch (e: any) {
            if (e instanceof GICSCircuitOpen) {
                return { jsonrpc: '2.0', id, error: { code: -32001, message: e.message, data: e.metadata } };
            }
            if (e instanceof GICSTimeout) {
                return { jsonrpc: '2.0', id, error: { code: -32002, message: e.message, data: e.metadata } };
            }
            if (e instanceof GICSUnavailable) {
                return { jsonrpc: '2.0', id, error: { code: -32003, message: e.message, data: e.metadata } };
            }
            return { jsonrpc: '2.0', id, error: { code: -32603, message: e.message } };
        }
    }

    // eslint-disable-next-line sonarjs/cognitive-complexity
    private async executeMethod(method: string, params: any, id: any, socket?: net.Socket): Promise<any> {
        try {
            // eslint-disable-next-line sonarjs/max-switch-cases
            switch (method) {
                case 'getStatus':
                    return { jsonrpc: '2.0', id, result: { ...this.supervisor.getStatus(), circuitState: this.resilience.getCircuitState(), pendingOps: this.resilience.getPendingOps() } };

                case 'resetDegraded': {
                    if (!this.supervisor.isDegraded()) {
                        return { jsonrpc: '2.0', id, error: { code: -32602, message: 'Daemon is not in DEGRADED state' } };
                    }
                    const resetOk = await this.supervisor.resetDegraded();
                    if (resetOk) {
                        const walKeys = new Set<string>();
                        this.memTable.scan('').forEach((record) => walKeys.add(record.key));
                        const flushResult = this.supervisor.flushBuffer(
                            (key) => walKeys.has(key),
                            (key, fields) => {
                                this.memTable.put(key, fields);
                                this.stateIndex.recordPut(key, fields, { tier: 'hot', segmentRef: null, timestamp: Date.now() });
                            }
                        );
                        return { jsonrpc: '2.0', id, result: { ok: true, flush: flushResult } };
                    }
                    return { jsonrpc: '2.0', id, error: { code: -32603, message: 'Failed to exit DEGRADED state' } };
                }

                case 'put':
                    return await this.handlePut(id, params);

                case 'putMany':
                    return await this.handlePutMany(id, params);

                case 'get':
                    return await this.handleGet(id, params);

                case 'getInsight':
                    return { jsonrpc: '2.0', id, result: this.modules.nativeInsight.getInsight(String(params?.key ?? '')) };

                case 'getInsights': {
                    const lifecycle = params?.lifecycle;
                    return { jsonrpc: '2.0', id, result: this.modules.nativeInsight.getInsights(lifecycle ? { lifecycle } : undefined) };
                }

                case 'recordOutcome':
                case 'reportOutcome':
                    return await this.handleReportOutcome(id, params);

                case 'subscribe': {
                    const subEvents = Array.isArray(params?.events) ? params.events as string[] : [];
                    const subscriptionId = `sub_${Date.now()}_${randomBytes(3).toString('hex')}`;
                    if (socket) {
                        this.subscriptions.set(subscriptionId, { socket, events: subEvents });
                    }
                    return { jsonrpc: '2.0', id, result: { subscriptionId, events: subEvents } };
                }

                case 'unsubscribe': {
                    const unsubId = String(params?.subscriptionId ?? '');
                    const deleted = this.subscriptions.delete(unsubId);
                    return { jsonrpc: '2.0', id, result: { ok: deleted } };
                }

                case 'getAccuracy':
                    return { jsonrpc: '2.0', id, result: this.modules.nativeInsight.getAccuracy(params?.insightType, params?.scope) };

                case 'getCorrelations':
                    return { jsonrpc: '2.0', id, result: this.modules.nativeInsight.getCorrelations(params?.key) };

                case 'getClusters':
                    return { jsonrpc: '2.0', id, result: this.modules.nativeInsight.getClusters() };

                case 'getLeadingIndicators':
                    return { jsonrpc: '2.0', id, result: this.modules.nativeInsight.getLeadingIndicators(params?.key) };

                case 'getSeasonalPatterns':
                    return { jsonrpc: '2.0', id, result: this.modules.nativeInsight.getSeasonalPatterns(params?.key) };

                case 'getForecast':
                    return { jsonrpc: '2.0', id, result: this.modules.nativeInsight.getForecast(String(params?.key ?? ''), String(params?.field ?? ''), params?.horizon) };

                case 'getAnomalies':
                    return { jsonrpc: '2.0', id, result: this.modules.nativeInsight.getAnomalies(params?.since) };

                case 'getRecommendations':
                    return await this.handleRecommendations(id, params);

                case 'infer':
                    return await this.handleInfer(id, params);

                case 'getProfile':
                    return await this.handleGetProfile(id, params);

                case 'getInferenceRuntime':
                    return await this.handleGetInferenceRuntime(id);

                case 'flushInference':
                    return await this.handleFlushInference(id);

                case 'seedProfile':
                    return await this.handleSeedProfile(id, params);

                case 'seedPolicy':
                    return await this.handleSeedPolicy(id, params);

                case 'getTelemetry':
                    return await this.handleGetTelemetry(id);

                case 'getTelemetryEvents':
                    return await this.handleGetTelemetryEvents(id, params);

                case 'delete':
                    return await this.handleDelete(id, params);

                case 'scan':
                    return await this.handleScan(id, params);

                case 'countPrefix':
                    return await this.handleCountPrefix(id, params);

                case 'latestByPrefix':
                    return await this.handleLatestByPrefix(id, params);

                case 'scanSummary':
                    return await this.handleScanSummary(id, params);

                case 'verify': {
                    const tier = params?.tier as 'warm' | 'cold' | undefined;
                    return FileLock.withSharedLock(this.storageLockTarget, async () => {
                        const details: Array<{ file: string; tier: string; valid: boolean; error?: string }> = [];
                        const tiers: Array<'warm' | 'cold'> = tier ? [tier] : ['warm', 'cold'];
                        for (const currentTier of tiers) {
                            const dir = currentTier === 'warm' ? this.warmDirPath : this.coldDirPath;
                            if (!existsSync(dir)) continue;
                            const files = (await fs.readdir(dir)).filter((name) => name.endsWith('.gics'));
                            for (const fileName of files) {
                                const filePath = path.join(dir, fileName);
                                try {
                                    const raw = await fs.readFile(filePath);
                                    const decoder = currentTier === 'cold' && (process.env[this.coldPasswordEnvVar] ?? '')
                                        ? new GICSv2Decoder(raw, { password: process.env[this.coldPasswordEnvVar], telemetry: this.telemetry })
                                        : new GICSv2Decoder(raw, { telemetry: this.telemetry });
                                    const valid = await decoder.verifyIntegrityOnly();
                                    details.push({ file: fileName, tier: currentTier, valid });
                                } catch (e: any) {
                                    details.push({ file: fileName, tier: currentTier, valid: false, error: e.message });
                                }
                            }
                        }
                        return { jsonrpc: '2.0', id, result: { valid: details.every((item) => item.valid), details } };
                    }, this.fileLockTimeoutMs);
                }

                case 'flush':
                    return FileLock.withExclusiveLock(this.storageLockTarget, async () => {
                        const flushResult = await this.flushMemTableToWarm('manual');
                        return { jsonrpc: '2.0', id, result: { ok: true, ...flushResult } };
                    }, this.fileLockTimeoutMs);

                case 'compact':
                    return FileLock.withExclusiveLock(this.storageLockTarget, async () => {
                        const compaction = await this.compactWarmSegments();
                        return { jsonrpc: '2.0', id, result: { ok: true, ...compaction } };
                    }, this.fileLockTimeoutMs);

                case 'rotate':
                    return FileLock.withExclusiveLock(this.storageLockTarget, async () => {
                        const rotation = await this.rotateWarmToCold();
                        return { jsonrpc: '2.0', id, result: { ok: true, ...rotation } };
                    }, this.fileLockTimeoutMs);

                case 'verifyAudit': {
                    const auditResult = await this.modules.auditChain.verify();
                    return { jsonrpc: '2.0', id, result: auditResult };
                }

                case 'exportAudit': {
                    const auditLines = await this.modules.auditChain.export();
                    return { jsonrpc: '2.0', id, result: { entries: auditLines } };
                }

                case 'getHealth': {
                    const healthStart = Date.now();
                    await this.refreshStorageTelemetry();
                    const tierStats = this.getTierIndexStats();
                    const modulesHealth = await this.modules.registry.health();
                    const auditHealth = await this.modules.auditChain.health();
                    const health: any = {
                        status: 'ok',
                        timestamp: Date.now(),
                        uptime: process.uptime(),
                        supervisor: this.supervisor.getStatus(),
                        memTable: {
                            count: this.memTable.count,
                            sizeBytes: this.memTable.sizeBytes,
                            dirtyCount: this.memTable.dirtyCount,
                        },
                        wal: {
                            type: this.walType,
                            fsyncMode: this.walFsyncMode,
                            maxSizeMB: this.walMaxSizeMB,
                            recoveredEntries: this.recoveredEntries,
                        },
                        insights: {
                            tracked: this.modules.nativeInsight.getInsights().length,
                            recommendations: this.modules.nativeInsight.getSignalRecommendations().length,
                        },
                        tiers: {
                            warmKeys: tierStats.warmKeys,
                            coldKeys: tierStats.coldKeys,
                        },
                        auditChain: {
                            entries: Number(auditHealth.entries ?? 0),
                            lastVerifyValid: auditHealth.lastVerifyValid ?? null,
                        },
                        resilience: {
                            circuitState: this.resilience.getCircuitState(),
                            pendingOps: this.resilience.getPendingOps(),
                        },
                        modules: modulesHealth,
                    };

                    if (this.modules.promptDistiller) {
                        try {
                            health.distiller = await this.modules.promptDistiller.health();
                        } catch {
                            health.distiller = { error: 'unavailable' };
                        }
                    }

                    health.responseTimeMs = Date.now() - healthStart;
                    return { jsonrpc: '2.0', id, result: health };
                }

                case 'ping': {
                    return {
                        jsonrpc: '2.0',
                        id,
                        result: {
                            status: 'ok',
                            version: '1.3.4',
                            service: 'gics-core',
                            timestamp: Date.now(),
                        },
                    };
                }

                case 'pingVerbose':
                    return {
                        jsonrpc: '2.0',
                        id,
                        result: await this.buildVerbosePingResult(),
                    };

                default:
                    return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } };
            }
        } catch (e: any) {
            return { jsonrpc: '2.0', id, error: { code: -32603, message: e.message } };
        }
    }
}
