import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { GICSv2Encoder } from './encode.js';
import { GICSv2Decoder } from './decode.js';
import { FILE_EOS_SIZE, GICS_ENC_HEADER_SIZE_V3, GICS_EOS_MARKER, GICS_FLAGS_V3, GICS_HEADER_SIZE_V3 } from './format.js';
import { SegmentHeader } from './segment.js';
import type { GenericSnapshot, Snapshot } from '../gics-types.js';
import type {
    GICSv2AdaptiveRotationOptions,
    GICSv2RotationOptions,
    GICSSessionFileEntry,
    GICSSessionManifest,
    GICSSessionReadOptions
} from './types.js';

type SessionSnapshot = Snapshot | GenericSnapshot<Record<string, number | string>>;

type ResolvedAdaptiveOptions = Required<GICSv2AdaptiveRotationOptions>;

type ResolvedRotationOptions = {
    sessionDir: string;
    sessionId: string;
    manifestPath: string;
    flushEverySnapshots: number;
    maxFileBytes: number;
    maxSnapshotsPerFile: number;
    maxSegmentsPerFile: number;
    maxFileDurationMs: number;
    adaptive: ResolvedAdaptiveOptions;
    encoderOptions: NonNullable<GICSv2RotationOptions['encoderOptions']>;
};

type SessionValidationSummary = {
    ok: boolean;
    filesChecked: number;
    orphanedSkipped: number;
    lastRootHash: string | null;
};

const ZERO_HASH_HEX = '00'.repeat(32);

function normalizeHashHex(value: string | null | undefined): string | null {
    if (!value) return null;
    const normalized = value.toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(normalized)) {
        throw new Error(`Invalid hash format: "${value}"`);
    }
    return normalized;
}

function toHex(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString('hex');
}

function resolveRotationOptions(options: GICSv2RotationOptions): ResolvedRotationOptions {
    const sessionDir = path.resolve(options.sessionDir);
    const sessionId = options.sessionId ?? `gics-session-${Date.now()}`;
    const manifestPath = path.resolve(options.manifestPath ?? path.join(sessionDir, `${sessionId}.manifest.json`));
    const adaptiveDefaults: ResolvedAdaptiveOptions = {
        enabled: true,
        ewmaAlpha: 0.25,
        latencyPerSnapshotUsBudget: 4000,
        ratioDropPct: 25,
        heapHighWaterMB: 768,
        consecutiveBreachesToRotate: 3,
        cooldownFlushes: 2,
    };
    const adaptive = { ...adaptiveDefaults, ...options.adaptive };
    return {
        sessionDir,
        sessionId,
        manifestPath,
        flushEverySnapshots: options.flushEverySnapshots ?? 1024,
        maxFileBytes: options.maxFileBytes ?? 512 * 1024 * 1024,
        maxSnapshotsPerFile: options.maxSnapshotsPerFile ?? 1_000_000,
        maxSegmentsPerFile: options.maxSegmentsPerFile ?? 4096,
        maxFileDurationMs: options.maxFileDurationMs ?? 24 * 60 * 60 * 1000,
        adaptive,
        encoderOptions: options.encoderOptions ?? {},
    };
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
    const dir = path.dirname(filePath);
    await fs.promises.mkdir(dir, { recursive: true });
    const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    await fs.promises.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await fs.promises.rename(tempPath, filePath);
}

async function sha256File(filePath: string): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
        const hash = createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('data', (chunk) => {
            hash.update(chunk);
        });
        stream.on('error', (error) => reject(error));
        stream.on('end', () => resolve(hash.digest('hex')));
    });
}

function countSegmentsFromData(encoded: Uint8Array): number {
    if (encoded.length < GICS_HEADER_SIZE_V3 + FILE_EOS_SIZE) {
        return 0;
    }
    const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);
    const flags = view.getUint32(5, true);
    let pos = GICS_HEADER_SIZE_V3;
    if ((flags & GICS_FLAGS_V3.ENCRYPTED) !== 0) {
        pos += GICS_ENC_HEADER_SIZE_V3;
    }
    if ((flags & GICS_FLAGS_V3.HAS_SCHEMA) !== 0) {
        if (pos + 4 > encoded.length - FILE_EOS_SIZE) {
            return 0;
        }
        const schemaLen = view.getUint32(pos, true);
        pos += 4 + schemaLen;
    }

    const dataEnd = encoded.length - FILE_EOS_SIZE;
    let count = 0;
    while (pos + 14 <= dataEnd) {
        const header = SegmentHeader.deserialize(encoded.subarray(pos, pos + 14));
        if (header.totalLength <= 0 || pos + header.totalLength > dataEnd) {
            break;
        }
        count++;
        pos += header.totalLength;
    }
    return count;
}

function extractRootHashHexFromEos(encoded: Uint8Array): string {
    if (encoded.length < FILE_EOS_SIZE) {
        throw new Error('Invalid GICS file: missing EOS.');
    }
    const eosStart = encoded.length - FILE_EOS_SIZE;
    if (encoded[eosStart] !== GICS_EOS_MARKER) {
        throw new Error('Invalid GICS file: EOS marker not found.');
    }
    return toHex(encoded.subarray(eosStart + 1, eosStart + 33));
}

function estimateSnapshotRawBytes(snapshot: SessionSnapshot): number {
    let total = 16;
    for (const [itemId, values] of snapshot.items.entries()) {
        total += 8 + String(itemId).length;
        if (typeof values === 'object' && values != null) {
            for (const [fieldName, fieldValue] of Object.entries(values as Record<string, number | string>)) {
                total += fieldName.length + 4;
                total += typeof fieldValue === 'number' ? 8 : String(fieldValue).length;
            }
        } else {
            total += 8;
        }
    }
    return total;
}

function relativeManifestFilePath(sessionDir: string, absolutePath: string): string {
    const relative = path.relative(sessionDir, absolutePath);
    return relative === '' ? path.basename(absolutePath) : relative;
}

function partFileName(sessionId: string, seq: number): string {
    return `${sessionId}.part-${String(seq).padStart(6, '0')}.gics`;
}

async function readManifestFromPath(manifestPath: string): Promise<GICSSessionManifest> {
    const content = await fs.promises.readFile(manifestPath, 'utf8');
    const parsed = JSON.parse(content) as GICSSessionManifest;
    if (parsed.formatVersion !== 1) {
        throw new Error(`Unsupported session manifest formatVersion: ${String((parsed as { formatVersion?: unknown }).formatVersion)}`);
    }
    parsed.lastRootHash = normalizeHashHex(parsed.lastRootHash);
    parsed.files = (parsed.files ?? []).map((entry) => ({
        ...entry,
        startSeedHash: normalizeHashHex(entry.startSeedHash) ?? ZERO_HASH_HEX,
        endRootHash: normalizeHashHex(entry.endRootHash) ?? ZERO_HASH_HEX,
        sha256: entry.sha256.toLowerCase(),
    }));
    parsed.files.sort((a, b) => a.seq - b.seq);
    return parsed;
}

function getValidationCandidates(manifest: GICSSessionManifest, options: { includeOrphaned: boolean; maxFiles: number; }) {
    return manifest.files
        .filter((entry) => options.includeOrphaned || !entry.orphaned)
        .slice(0, options.maxFiles > 0 ? options.maxFiles : manifest.files.length);
}

async function validateSingleEntry(
    entry: GICSSessionFileEntry,
    previousRoot: string,
    sessionDir: string,
    options: { decoderOptions: NonNullable<GICSSessionReadOptions['decoderOptions']>; }
): Promise<string> {
    if (entry.startSeedHash !== previousRoot) {
        throw new Error(`Session continuity mismatch at seq=${entry.seq}: expected startSeedHash=${previousRoot}, got ${entry.startSeedHash}`);
    }

    const absolute = path.resolve(sessionDir, entry.path);
    const encoded = await fs.promises.readFile(absolute);

    const actualRoot = extractRootHashHexFromEos(encoded);
    if (actualRoot !== entry.endRootHash) {
        throw new Error(`EOS root mismatch at seq=${entry.seq}: manifest=${entry.endRootHash}, file=${actualRoot}`);
    }

    const actualSha = createHash('sha256').update(encoded).digest('hex');
    if (actualSha !== entry.sha256) {
        throw new Error(`SHA256 mismatch at seq=${entry.seq}: manifest=${entry.sha256}, file=${actualSha}`);
    }

    const decoder = new GICSv2Decoder(encoded, options.decoderOptions);
    const ok = await decoder.verifyIntegrityOnly();
    if (!ok) {
        throw new Error(`Integrity verification failed at seq=${entry.seq}`);
    }

    return entry.endRootHash;
}

async function validateSessionManifest(
    manifest: GICSSessionManifest,
    sessionDir: string,
    options: Required<Pick<GICSSessionReadOptions, 'strict' | 'includeOrphaned' | 'maxFiles'>> & {
        decoderOptions: NonNullable<GICSSessionReadOptions['decoderOptions']>;
    }
): Promise<SessionValidationSummary> {
    const candidates = getValidationCandidates(manifest, options);
    let previousRoot = ZERO_HASH_HEX;
    let checked = 0;
    const orphanedSkipped = manifest.files.filter((entry) => !!entry.orphaned).length;

    for (const entry of candidates) {
        try {
            previousRoot = await validateSingleEntry(entry, previousRoot, sessionDir, options);
            checked++;
        } catch (error) {
            if (options.strict) throw error;
            return { ok: false, filesChecked: checked, orphanedSkipped, lastRootHash: previousRoot };
        }
    }

    const manifestLastRoot = normalizeHashHex(manifest.lastRootHash);
    if (manifestLastRoot && checked > 0 && manifestLastRoot !== previousRoot) {
        if (options.strict) {
            throw new Error(`Manifest lastRootHash mismatch: manifest=${manifestLastRoot}, computed=${previousRoot}`);
        }
        return { ok: false, filesChecked: checked, orphanedSkipped, lastRootHash: previousRoot };
    }

    return {
        ok: true,
        filesChecked: checked,
        orphanedSkipped,
        lastRootHash: checked > 0 ? previousRoot : manifestLastRoot,
    };
}

export class GICSv2RotatingEncoder {
    private readonly options: ResolvedRotationOptions;
    private readonly manifest: GICSSessionManifest;
    private encoder: GICSv2Encoder | null = null;
    private handle: fs.promises.FileHandle | null = null;
    private currentSeq = 0;
    private currentPartAbsolutePath = '';
    private currentFileOpenedAtMs = Date.now();
    private currentFileSnapshots = 0;
    private currentFileSegments = 0;
    private currentFileBytes = 0;
    private currentFileFirstTs: number | null = null;
    private currentFileLastTs: number | null = null;
    private currentSeedHash = ZERO_HASH_HEX;
    private bufferedSnapshots = 0;
    private bufferedRawBytes = 0;
    private ewmaLatencyUs: number | null = null;
    private ewmaRatio: number | null = null;
    private bestRatioEwma = 0;
    private adaptiveBreaches = 0;
    private flushesSinceRotation = 0;
    private closed = false;
    private readonly rotationReasonCounts = new Map<string, number>();

    private constructor(options: ResolvedRotationOptions, manifest: GICSSessionManifest) {
        this.options = options;
        this.manifest = manifest;
        this.currentSeedHash = normalizeHashHex(manifest.lastRootHash) ?? ZERO_HASH_HEX;
    }

    static async create(options: GICSv2RotationOptions): Promise<GICSv2RotatingEncoder> {
        const resolved = resolveRotationOptions(options);
        await fs.promises.mkdir(resolved.sessionDir, { recursive: true });
        const exists = await fs.promises.stat(resolved.manifestPath).then(() => true).catch(() => false);
        if (exists) {
            throw new Error(`Manifest already exists at ${resolved.manifestPath}. Use resumeSession().`);
        }

        const manifest: GICSSessionManifest = {
            sessionId: resolved.sessionId,
            formatVersion: 1,
            createdAt: new Date().toISOString(),
            closedAt: null,
            files: [],
            lastCommittedSeq: 0,
            lastRootHash: null,
        };
        const instance = new GICSv2RotatingEncoder(resolved, manifest);
        await instance.persistManifest();
        await instance.openNewPart(1);
        return instance;
    }

    static async resumeSession(manifestPath: string, options: Partial<GICSv2RotationOptions> = {}): Promise<GICSv2RotatingEncoder> {
        const absoluteManifestPath = path.resolve(manifestPath);
        const manifest = await readManifestFromPath(absoluteManifestPath);
        const sessionDir = path.dirname(absoluteManifestPath);
        const resolved = resolveRotationOptions({
            sessionDir,
            sessionId: manifest.sessionId,
            manifestPath: absoluteManifestPath,
            ...options,
        });

        let previousRoot = ZERO_HASH_HEX;
        let lastCommittedSeq = 0;
        let lastRootHash: string | null = null;
        let foundInvalidTail = false;

        for (const entry of manifest.files) {
            if (entry.orphaned) {
                continue;
            }
            const absolute = path.resolve(sessionDir, entry.path);
            const validation = await fs.promises.readFile(absolute)
                .then((bytes) => {
                    const root = extractRootHashHexFromEos(bytes);
                    const sha = createHash('sha256').update(bytes).digest('hex');
                    return { ok: root === entry.endRootHash && sha === entry.sha256, root };
                })
                .catch(() => ({ ok: false, root: '' }));

            if (!validation.ok || entry.startSeedHash !== previousRoot) {
                foundInvalidTail = true;
                entry.orphaned = true;
                continue;
            }
            previousRoot = validation.root;
            lastCommittedSeq = entry.seq;
            lastRootHash = entry.endRootHash;
        }

        if (foundInvalidTail) {
            for (const entry of manifest.files) {
                if (entry.seq > lastCommittedSeq) {
                    entry.orphaned = true;
                }
            }
        }
        manifest.lastCommittedSeq = lastCommittedSeq;
        manifest.lastRootHash = lastRootHash;
        manifest.closedAt = null;

        const instance = new GICSv2RotatingEncoder(resolved, manifest);
        await instance.persistManifest();
        await instance.openNewPart(lastCommittedSeq + 1);
        return instance;
    }

    getManifestPath(): string {
        return this.options.manifestPath;
    }

    getManifest(): GICSSessionManifest {
        return structuredClone(this.manifest);
    }

    getRotationReasonCounts(): Record<string, number> {
        return Object.fromEntries(this.rotationReasonCounts.entries());
    }

    async addSnapshot(snapshot: SessionSnapshot): Promise<void> {
        this.ensureWritable();
        if (!this.encoder) {
            throw new Error('RotatingEncoder has no active encoder instance.');
        }

        await this.encoder.addSnapshot(snapshot);
        this.currentFileSnapshots++;
        this.currentFileFirstTs ??= snapshot.timestamp;
        this.currentFileLastTs = snapshot.timestamp;
        this.bufferedSnapshots++;
        this.bufferedRawBytes += estimateSnapshotRawBytes(snapshot);

        if (this.bufferedSnapshots >= this.options.flushEverySnapshots) {
            await this.flushAndEvaluate('auto_flush');
            return;
        }

        if (this.currentFileSnapshots >= this.options.maxSnapshotsPerFile) {
            await this.flushAndEvaluate('hard_limit_snapshot');
        }
    }

    async flush(): Promise<void> {
        this.ensureWritable();
        await this.flushAndEvaluate('manual_flush');
    }

    async rotateNow(reason: string = 'manual_rotate'): Promise<void> {
        this.ensureWritable();
        await this.rotate(reason);
    }

    async seal(): Promise<GICSSessionManifest> {
        if (this.closed) {
            return this.getManifest();
        }
        await this.flushBuffered();
        await this.finalizeCurrentPart('seal');
        this.manifest.closedAt = new Date().toISOString();
        await this.persistManifest();
        this.closed = true;
        return this.getManifest();
    }

    private ensureWritable(): void {
        if (this.closed) {
            throw new Error('RotatingEncoder is already sealed.');
        }
    }

    private async flushBuffered(): Promise<void> {
        if (!this.encoder) {
            throw new Error('RotatingEncoder has no active encoder.');
        }
        if (this.bufferedSnapshots === 0) {
            return;
        }

        const beforeBytes = this.encoder.getFileOffset();
        const started = process.hrtime.bigint();
        await this.encoder.flush();
        const elapsedUs = Number(process.hrtime.bigint() - started) / 1000;
        const writtenBytes = Math.max(0, this.encoder.getFileOffset() - beforeBytes);
        const flushedSnapshots = this.bufferedSnapshots;
        const flushedRawBytes = this.bufferedRawBytes;
        const flushedSegments = this.encoder.getLastFlushSegmentCount();

        this.currentFileBytes = this.encoder.getFileOffset();
        this.currentFileSegments += flushedSegments;
        this.flushesSinceRotation++;

        const latencyPerSnapshotUs = elapsedUs / Math.max(1, flushedSnapshots);
        const ratio = flushedRawBytes / Math.max(1, writtenBytes);
        this.updateAdaptiveEwma(latencyPerSnapshotUs, ratio);

        this.bufferedSnapshots = 0;
        this.bufferedRawBytes = 0;
    }

    private updateAdaptiveEwma(latencyUs: number, ratio: number): void {
        const alpha = this.options.adaptive.ewmaAlpha;
        if (this.ewmaLatencyUs === null) {
            this.ewmaLatencyUs = latencyUs;
        } else {
            this.ewmaLatencyUs = (alpha * latencyUs) + ((1 - alpha) * this.ewmaLatencyUs);
        }
        
        if (this.ewmaRatio === null) {
            this.ewmaRatio = ratio;
        } else {
            this.ewmaRatio = (alpha * ratio) + ((1 - alpha) * this.ewmaRatio);
        }
        
        if (this.ewmaRatio > this.bestRatioEwma) {
            this.bestRatioEwma = this.ewmaRatio;
        }
    }

    private async flushAndEvaluate(trigger: string): Promise<void> {
        await this.flushBuffered();
        const reason = this.pickRotationReason();
        if (reason) {
            await this.rotate(reason);
        } else if (trigger === 'hard_limit_snapshot' && this.currentFileSnapshots >= this.options.maxSnapshotsPerFile) {
            await this.rotate('hard:maxSnapshotsPerFile');
        }
    }

    private pickRotationReason(): string | null {
        if (this.currentFileBytes >= this.options.maxFileBytes) {
            return 'hard:maxFileBytes';
        }
        if (this.currentFileSnapshots >= this.options.maxSnapshotsPerFile) {
            return 'hard:maxSnapshotsPerFile';
        }
        if (this.currentFileSegments >= this.options.maxSegmentsPerFile) {
            return 'hard:maxSegmentsPerFile';
        }
        if ((Date.now() - this.currentFileOpenedAtMs) >= this.options.maxFileDurationMs) {
            return 'hard:maxFileDurationMs';
        }

        const adaptive = this.options.adaptive;
        if (!adaptive.enabled) {
            this.adaptiveBreaches = 0;
            return null;
        }

        if (this.flushesSinceRotation < adaptive.cooldownFlushes) {
            this.adaptiveBreaches = 0;
            return null;
        }

        const breaches: string[] = [];
        const heapMb = process.memoryUsage().heapUsed / 1024 / 1024;
        if (heapMb >= adaptive.heapHighWaterMB) {
            breaches.push('heap');
        }
        if (this.ewmaLatencyUs !== null && this.ewmaLatencyUs > adaptive.latencyPerSnapshotUsBudget) {
            breaches.push('latency');
        }
        if (this.ewmaRatio !== null && this.bestRatioEwma > 0) {
            const drop = ((this.bestRatioEwma - this.ewmaRatio) / this.bestRatioEwma) * 100;
            if (drop >= adaptive.ratioDropPct) {
                breaches.push('ratio');
            }
        }

        if (breaches.length === 0) {
            this.adaptiveBreaches = 0;
            return null;
        }

        this.adaptiveBreaches++;
        if (this.adaptiveBreaches < adaptive.consecutiveBreachesToRotate) {
            return null;
        }

        this.adaptiveBreaches = 0;
        return `adaptive:${breaches.join('+')}`;
    }

    private async rotate(reason: string): Promise<void> {
        if (this.currentFileSnapshots === 0 && this.bufferedSnapshots === 0) {
            return;
        }
        await this.flushBuffered();
        await this.finalizeCurrentPart(reason);
        this.rotationReasonCounts.set(reason, (this.rotationReasonCounts.get(reason) ?? 0) + 1);
        this.flushesSinceRotation = 0;
        this.adaptiveBreaches = 0;
        await this.openNewPart(this.currentSeq + 1);
    }

    private async finalizeCurrentPart(rotationReason: string): Promise<void> {
        if (!this.encoder || !this.handle) {
            return;
        }
        if (this.currentFileSnapshots === 0 && this.bufferedSnapshots === 0) {
            const absolutePath = this.currentPartAbsolutePath;
            await this.handle.close();
            this.handle = null;
            this.encoder = null;
            await fs.promises.unlink(absolutePath).catch(() => {});
            return;
        }
        const eosBytes = await this.encoder.seal();
        const endRootHash = toHex(eosBytes.subarray(1, 33));
        this.currentFileBytes = this.encoder.getFileOffset();
        const absolutePath = this.currentPartAbsolutePath;
        await this.handle.close();
        this.handle = null;
        this.encoder = null;

        const relativePath = relativeManifestFilePath(this.options.sessionDir, absolutePath);
        const sha256 = await sha256File(absolutePath);
        let segmentCount = this.currentFileSegments;
        if (segmentCount <= 0 && this.currentFileSnapshots > 0) {
            const encoded = await fs.promises.readFile(absolutePath);
            segmentCount = countSegmentsFromData(encoded);
        }

        const entry: GICSSessionFileEntry = {
            path: relativePath,
            seq: this.currentSeq,
            firstTs: this.currentFileFirstTs,
            lastTs: this.currentFileLastTs,
            snapshots: this.currentFileSnapshots,
            bytes: this.currentFileBytes,
            segmentCount,
            startSeedHash: this.currentSeedHash,
            endRootHash,
            sha256,
            rotationReason,
        };

        this.manifest.files.push(entry);
        this.manifest.files.sort((a, b) => a.seq - b.seq);
        this.manifest.lastCommittedSeq = entry.seq;
        this.manifest.lastRootHash = endRootHash;
        await this.persistManifest();
        this.currentSeedHash = endRootHash;
    }

    private async openNewPart(seq: number): Promise<void> {
        const fileName = partFileName(this.options.sessionId, seq);
        const absolutePath = path.resolve(this.options.sessionDir, fileName);
        await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true });
        this.handle = await fs.promises.open(absolutePath, 'w+');
        this.encoder = await GICSv2Encoder.openFile(this.handle, {
            ...this.options.encoderOptions,
            autoFlushThreshold: 0,
        });
        this.currentSeq = seq;
        this.currentPartAbsolutePath = absolutePath;
        this.currentFileOpenedAtMs = Date.now();
        this.currentFileSnapshots = 0;
        this.currentFileSegments = 0;
        this.currentFileBytes = 0;
        this.currentFileFirstTs = null;
        this.currentFileLastTs = null;
        this.bufferedSnapshots = 0;
        this.bufferedRawBytes = 0;
    }

    private async persistManifest(): Promise<void> {
        await atomicWriteJson(this.options.manifestPath, this.manifest);
    }
}

export async function readSession(
    manifestPath: string,
    options: GICSSessionReadOptions = {}
): Promise<Snapshot[]> {
    const strict = options.strict ?? true;
    const integrityOnly = options.integrityOnly ?? false;
    const includeOrphaned = options.includeOrphaned ?? false;
    const maxFiles = options.maxFiles ?? 0;
    const decoderOptions = options.decoderOptions ?? {};
    const absoluteManifestPath = path.resolve(manifestPath);
    const sessionDir = path.dirname(absoluteManifestPath);
    const manifest = await readManifestFromPath(absoluteManifestPath);

    const validation = await validateSessionManifest(manifest, sessionDir, {
        strict,
        includeOrphaned,
        maxFiles,
        decoderOptions,
    });
    if (!validation.ok && strict) {
        throw new Error('Session verification failed.');
    }

    if (integrityOnly) {
        return [];
    }

    const snapshots: Snapshot[] = [];
    const files = manifest.files
        .filter((entry) => includeOrphaned || !entry.orphaned)
        .slice(0, maxFiles > 0 ? maxFiles : manifest.files.length);
    for (const entry of files) {
        const absolute = path.resolve(sessionDir, entry.path);
        const encoded = await fs.promises.readFile(absolute);
        const decoded = await new GICSv2Decoder(encoded, decoderOptions).getAllSnapshots();
        snapshots.push(...decoded);
    }
    return snapshots;
}

export async function verifySession(
    manifestPath: string,
    options: GICSSessionReadOptions = {}
): Promise<boolean> {
    const strict = options.strict ?? true;
    const includeOrphaned = options.includeOrphaned ?? false;
    const maxFiles = options.maxFiles ?? 0;
    const decoderOptions = options.decoderOptions ?? {};
    const absoluteManifestPath = path.resolve(manifestPath);
    const sessionDir = path.dirname(absoluteManifestPath);
    const manifest = await readManifestFromPath(absoluteManifestPath);
    const summary = await validateSessionManifest(manifest, sessionDir, {
        strict,
        includeOrphaned,
        maxFiles,
        decoderOptions,
    });
    return summary.ok;
}
