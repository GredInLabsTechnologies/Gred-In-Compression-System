import * as fs from 'node:fs/promises';
import { createWriteStream, existsSync, readFileSync, WriteStream } from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

export enum Operation {
    PUT = 0x01,
    DELETE = 0x02
}

export type WALPayload = Record<string, number | string>;

export type WALType = 'binary' | 'jsonl';
export type WALFsyncMode = 'strict' | 'best_effort';

export interface WALProviderOptions {
    fsyncMode?: WALFsyncMode;
    fsyncOnCommit?: boolean;
    checkpointEveryOps?: number;
    checkpointEveryMs?: number;
    maxWalSizeMB?: number;
}

export interface WALProvider {
    append(op: Operation, key: string, payload: WALPayload): Promise<void>;
    replay(handler: (op: Operation, key: string, payload: WALPayload) => void): Promise<void>;
    truncate(): Promise<void>;
    close(): Promise<void>;
}

const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    CRC_TABLE[i] = c;
}

function crc32(buffer: Buffer): number {
    let crc = 0xFFFFFFFF;
    for (const byte of buffer) {
        crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xFF];
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

function sha256Hex(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
}

function isIgnorableFsyncError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const maybeErrno = error as NodeJS.ErrnoException;
    return maybeErrno.code === 'EPERM' || maybeErrno.code === 'EINVAL' || maybeErrno.code === 'ENOTSUP';
}

function stableStringify(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort((a, b) => a.localeCompare(b));
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

type StateEntry = { lsn: bigint; payload: WALPayload };
type StateMap = Map<string, StateEntry>;

interface V2Checkpoint {
    version: 2;
    lsn: string;
    timestamp: number;
    sha256: string;
    state: Record<string, WALPayload>;
}

const BIN_MAGIC = Buffer.from('GWV2', 'ascii');
const BIN_VERSION = 2;

abstract class BaseWALProvider implements WALProvider {
    protected readonly filePath: string;
    protected readonly checkpointPath: string;
    protected writeStream: WriteStream | null = null;
    protected readonly fsyncMode: WALFsyncMode;
    protected readonly fsyncOnCommit: boolean;
    protected readonly checkpointEveryOps: number;
    protected readonly checkpointEveryMs: number;
    protected readonly maxWalSizeBytes: number;

    protected lastLsn: bigint = 0n;
    protected opsSinceCheckpoint = 0;
    protected lastCheckpointAt = 0;
    protected state: StateMap = new Map();
    private initPromise: Promise<void> | null = null;
    private fsyncWarningLogged = false;
    private mutationQueue: Promise<void> = Promise.resolve();

    constructor(filePath: string, options: WALProviderOptions = {}) {
        this.filePath = filePath;
        this.checkpointPath = `${filePath}.ckpt`;
        this.fsyncMode = options.fsyncMode ?? 'best_effort';
        this.fsyncOnCommit = options.fsyncOnCommit ?? true;
        this.checkpointEveryOps = Math.max(1, options.checkpointEveryOps ?? 500);
        this.checkpointEveryMs = Math.max(1000, options.checkpointEveryMs ?? 30000);
        this.maxWalSizeBytes = Math.max(0.001, options.maxWalSizeMB ?? 50) * 1024 * 1024;
    }

    protected async ensureInitialized(): Promise<void> {
        this.initPromise ??= this.initialize();
            // removed
        // removed
        await this.initPromise;
    }

    private async initialize(): Promise<void> {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        await this.ensureWalReady();
        await this.loadStateFromWal();
        this.lastCheckpointAt = Date.now();
    }

    protected abstract ensureWalReady(): Promise<void>;
    protected abstract loadStateFromWal(): Promise<void>;
    protected abstract appendEntry(lsn: bigint, op: Operation, key: string, payload: WALPayload, timestamp: number): Promise<void>;
    protected abstract replayTail(afterLsn: bigint, handler: (op: Operation, key: string, payload: WALPayload, lsn: bigint) => void): Promise<void>;
    protected abstract compactToState(): Promise<void>;

    protected async ensureOpen(): Promise<void> {
        this.writeStream ??= createWriteStream(this.filePath, { flags: 'a' });
    }

    protected async closeStream(): Promise<void> {
        if (!this.writeStream) return;
        await new Promise<void>((resolve, reject) => {
            this.writeStream!.end((err?: Error | null) => {
                if (err) reject(err);
                else resolve();
            });
        });
        this.writeStream = null;
    }

    private async enqueueMutation<T>(task: () => Promise<T>): Promise<T> {
        const run = this.mutationQueue.then(task, task);
        this.mutationQueue = run.then(() => undefined, () => undefined);
        return run;
    }

    protected async fsyncFile(): Promise<void> {
        if (!this.fsyncOnCommit) return;
        const handle = await fs.open(this.filePath, 'r');
        try {
            await handle.sync();
        } catch (error) {
            if (this.fsyncMode === 'strict' || !isIgnorableFsyncError(error)) {
                throw error;
            }
            if (!this.fsyncWarningLogged) {
                this.fsyncWarningLogged = true;
                console.warn('[WAL] fsync not supported/allowed on this filesystem. Continuing without durable sync.');
            }
        } finally {
            await handle.close();
        }
    }

    protected applyState(op: Operation, key: string, payload: WALPayload, lsn: bigint): void {
        if (op === Operation.PUT) {
            this.state.set(key, { lsn, payload: { ...payload } });
        } else if (op === Operation.DELETE) {
            this.state.delete(key);
        }
    }

    protected async maybeCheckpointAndCompact(): Promise<void> {
        const now = Date.now();
        const shouldCheckpoint =
            this.opsSinceCheckpoint >= this.checkpointEveryOps ||
            now - this.lastCheckpointAt >= this.checkpointEveryMs;

        if (!shouldCheckpoint) return;

        const orderedState: Record<string, WALPayload> = {};
        for (const key of Array.from(this.state.keys()).sort((a, b) => a.localeCompare(b))) {
            orderedState[key] = { ...this.state.get(key)!.payload };
        }

        const stateRaw = stableStringify(orderedState);
        const checkpoint: V2Checkpoint = {
            version: 2,
            lsn: this.lastLsn.toString(),
            timestamp: now,
            sha256: sha256Hex(stateRaw),
            state: orderedState
        };
        await fs.appendFile(this.checkpointPath, `${JSON.stringify(checkpoint)}\n`, 'utf8');

        this.opsSinceCheckpoint = 0;
        this.lastCheckpointAt = now;

        const st = await fs.stat(this.filePath).catch(() => null);
        if (st && st.size > this.maxWalSizeBytes) {
            await this.compactToState();
        }
    }

    protected async loadCheckpoint(): Promise<{ lsn: bigint; state: Record<string, WALPayload> } | null> {
        if (!existsSync(this.checkpointPath)) return null;
        const raw = await fs.readFile(this.checkpointPath, 'utf8');
        const lines = raw.split('\n').map((x) => x.trim()).filter(Boolean);
        for (let i = lines.length - 1; i >= 0; i--) {
            try {
                const parsed = JSON.parse(lines[i]) as V2Checkpoint;
                if (parsed.version !== 2 || !parsed.state || !parsed.sha256) continue;
                const computed = sha256Hex(stableStringify(parsed.state));
                if (computed !== parsed.sha256) {
                    console.warn('[WAL] Invalid checkpoint hash detected. Falling back to previous checkpoint.');
                    continue;
                }
                return { lsn: BigInt(parsed.lsn), state: parsed.state };
            } catch {
                console.warn('[WAL] Invalid checkpoint entry. Falling back to previous checkpoint.');
            }
        }
        return null;
    }

    async append(op: Operation, key: string, payload: WALPayload): Promise<void> {
        await this.enqueueMutation(async () => {
            await this.ensureInitialized();
            await this.ensureOpen();

            const nextLsn = this.lastLsn + 1n;
            const ts = Date.now();
            await this.appendEntry(nextLsn, op, key, payload, ts);
            await this.fsyncFile();

            this.lastLsn = nextLsn;
            this.opsSinceCheckpoint++;
            this.applyState(op, key, payload, nextLsn);
            await this.maybeCheckpointAndCompact();
        });
    }

    async replay(handler: (op: Operation, key: string, payload: WALPayload) => void): Promise<void> {
        await this.ensureInitialized();

        const checkpoint = await this.loadCheckpoint();
        let checkpointLsn = 0n;

        if (checkpoint) {
            checkpointLsn = checkpoint.lsn;
            const ordered = Object.keys(checkpoint.state).sort((a, b) => a.localeCompare(b));
            for (const key of ordered) {
                handler(Operation.PUT, key, checkpoint.state[key]);
            }
        }

        await this.replayTail(checkpointLsn, (op, key, payload) => {
            handler(op, key, payload);
        });
    }

    async truncate(): Promise<void> {
        await this.enqueueMutation(async () => {
            await this.ensureInitialized();
            await this.closeStream();
            await fs.writeFile(this.filePath, '');
            await fs.writeFile(this.checkpointPath, '');
            this.lastLsn = 0n;
            this.opsSinceCheckpoint = 0;
            this.state.clear();
        });
    }

    async close(): Promise<void> {
        await this.enqueueMutation(async () => {
            await this.closeStream();
        });
    }
}

type BinaryParsedEntry = {
    op: Operation;
    key: string;
    payload: WALPayload;
    lsn: bigint;
};

function parseBinaryV1Entries(buffer: Buffer): BinaryParsedEntry[] {
    const out: BinaryParsedEntry[] = [];
    let offset = 0;
    let lsn = 0n;

    while (offset < buffer.length) {
        const start = offset;
        if (offset + 1 + 2 > buffer.length) break;
        const op = buffer.readUInt8(offset++);
        const keyLen = buffer.readUInt16LE(offset);
        offset += 2;
        if (offset + keyLen + 4 > buffer.length) break;
        const key = buffer.toString('utf8', offset, offset + keyLen);
        offset += keyLen;
        const valLen = buffer.readUInt32LE(offset);
        offset += 4;
        if (offset + valLen + 4 > buffer.length) break;
        const payloadRaw = buffer.toString('utf8', offset, offset + valLen);
        offset += valLen;
        const storedCrc = buffer.readUInt32LE(offset);
        offset += 4;

        const entryBytes = buffer.subarray(start, offset - 4);
        if (crc32(entryBytes) !== storedCrc) {
            console.warn(`[WAL] CRC mismatch at offset ${start}. Skipping corrupted entry.`);
            continue;
        }

        try {
            lsn += 1n;
            out.push({ op: op as Operation, key, payload: JSON.parse(payloadRaw), lsn });
        } catch {
            console.warn(`[WAL] Failed to parse payload at offset ${start}. Skipping entry.`);
        }
    }

    return out;
}

function parseBinaryV2Entries(buffer: Buffer): BinaryParsedEntry[] {
    const out: BinaryParsedEntry[] = [];
    let offset = BIN_MAGIC.length + 1;
    while (offset < buffer.length) {
        const start = offset;
        if (offset + 8 + 8 + 1 + 2 > buffer.length) break;

        const lsn = buffer.readBigUInt64LE(offset);
        offset += 8;
        offset += 8; // timestamp
        const op = buffer.readUInt8(offset++);
        const keyLen = buffer.readUInt16LE(offset);
        offset += 2;
        if (offset + keyLen + 4 > buffer.length) break;
        const key = buffer.toString('utf8', offset, offset + keyLen);
        offset += keyLen;
        const valLen = buffer.readUInt32LE(offset);
        offset += 4;
        if (offset + valLen + 4 > buffer.length) break;
        const payloadRaw = buffer.toString('utf8', offset, offset + valLen);
        offset += valLen;
        const storedCrc = buffer.readUInt32LE(offset);
        offset += 4;

        const entryBytes = buffer.subarray(start, offset - 4);
        if (crc32(entryBytes) !== storedCrc) {
            console.warn(`[WAL] CRC mismatch at offset ${start}. Skipping corrupted entry.`);
            continue;
        }

        try {
            out.push({ op: op as Operation, key, payload: JSON.parse(payloadRaw), lsn });
        } catch {
            console.warn(`[WAL] Failed to parse v2 payload at offset ${start}. Skipping entry.`);
        }
    }
    return out;
}

export class BinaryWALProvider extends BaseWALProvider {
    protected async ensureWalReady(): Promise<void> {
        if (!existsSync(this.filePath)) {
            await fs.writeFile(this.filePath, Buffer.concat([BIN_MAGIC, Buffer.from([BIN_VERSION])]));
            return;
        }

        const st = await fs.stat(this.filePath);
        if (st.size === 0) {
            await fs.writeFile(this.filePath, Buffer.concat([BIN_MAGIC, Buffer.from([BIN_VERSION])]));
            return;
        }

        const current = await fs.readFile(this.filePath);
        const hasV2Header = current.length >= BIN_MAGIC.length + 1
            && current.subarray(0, BIN_MAGIC.length).equals(BIN_MAGIC)
            && current.readUInt8(BIN_MAGIC.length) === BIN_VERSION;

        if (!hasV2Header) {
            // v1 -> v2 migration in place
            const entries = parseBinaryV1Entries(current);
            const header = Buffer.concat([BIN_MAGIC, Buffer.from([BIN_VERSION])]);
            const chunks: Buffer[] = [header];
            for (const entry of entries) {
                chunks.push(this.encodeBinaryV2(entry.lsn, Date.now(), entry.op, entry.key, entry.payload));
            }
            await fs.writeFile(this.filePath, Buffer.concat(chunks));
        }
    }

    private encodeBinaryV2(lsn: bigint, timestamp: number, op: Operation, key: string, payload: WALPayload): Buffer {
        const keyBuf = Buffer.from(key, 'utf8');
        const valBuf = Buffer.from(JSON.stringify(payload), 'utf8');
        const bodyLen = 8 + 8 + 1 + 2 + keyBuf.length + 4 + valBuf.length;
        const body = Buffer.alloc(bodyLen);
        let offset = 0;
        body.writeBigUInt64LE(lsn, offset);
        offset += 8;
        body.writeBigUInt64LE(BigInt(timestamp), offset);
        offset += 8;
        body.writeUInt8(op, offset++);
        body.writeUInt16LE(keyBuf.length, offset);
        offset += 2;
        keyBuf.copy(body, offset);
        offset += keyBuf.length;
        body.writeUInt32LE(valBuf.length, offset);
        offset += 4;
        valBuf.copy(body, offset);

        const out = Buffer.alloc(body.length + 4);
        body.copy(out);
        out.writeUInt32LE(crc32(body), body.length);
        return out;
    }

    protected async loadStateFromWal(): Promise<void> {
        if (!existsSync(this.filePath)) return;
        const raw = await fs.readFile(this.filePath);
        if (raw.length === 0) return;

        const entries = parseBinaryV2Entries(raw);
        for (const e of entries) {
            if (e.lsn > this.lastLsn) this.lastLsn = e.lsn;
            this.applyState(e.op, e.key, e.payload, e.lsn);
        }
    }

    protected async appendEntry(lsn: bigint, op: Operation, key: string, payload: WALPayload, timestamp: number): Promise<void> {
        const encoded = this.encodeBinaryV2(lsn, timestamp, op, key, payload);
        await new Promise<void>((resolve, reject) => {
            this.writeStream!.write(encoded, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }

    protected async replayTail(afterLsn: bigint, handler: (op: Operation, key: string, payload: WALPayload, lsn: bigint) => void): Promise<void> {
        if (!existsSync(this.filePath)) return;
        const raw = await fs.readFile(this.filePath);
        if (raw.length === 0) return;
        const entries = parseBinaryV2Entries(raw);
        for (const e of entries) {
            if (e.lsn <= afterLsn) continue;
            handler(e.op, e.key, e.payload, e.lsn);
        }
    }

    protected async compactToState(): Promise<void> {
        if (this.writeStream) {
            await this.closeStream();
        }
        const tempPath = `${this.filePath}.tmp`;
        const chunks: Buffer[] = [Buffer.concat([BIN_MAGIC, Buffer.from([BIN_VERSION])])];
        const entries = Array.from(this.state.entries())
            .map(([key, value]) => ({ key, ...value }))
            .sort((a, b) => (a.lsn < b.lsn ? -1 : 1));
        for (const e of entries) {
            chunks.push(this.encodeBinaryV2(e.lsn, Date.now(), Operation.PUT, e.key, e.payload));
        }
        await fs.writeFile(tempPath, Buffer.concat(chunks));
        await fs.rename(tempPath, this.filePath);
        await this.ensureOpen();
    }
}

interface JsonlV2Entry {
    version: 2;
    lsn: string;
    timestamp: number;
    op: Operation;
    key: string;
    payload: WALPayload;
    crc32: number;
}

interface JsonlV1Entry {
    op: Operation;
    key: string;
    payload: WALPayload;
    crc32: number;
}

export class JsonlWALProvider extends BaseWALProvider {
    protected async ensureWalReady(): Promise<void> {
        if (!existsSync(this.filePath)) {
            await fs.writeFile(this.filePath, `${JSON.stringify({ __wal: 'gics', version: 2 })}\n`, 'utf8');
            return;
        }

        const raw = await fs.readFile(this.filePath, 'utf8');
        if (!raw.trim()) {
            await fs.writeFile(this.filePath, `${JSON.stringify({ __wal: 'gics', version: 2 })}\n`, 'utf8');
            return;
        }

        const lines = raw.split('\n').map((x) => x.trim()).filter(Boolean);
        try {
            const first = JSON.parse(lines[0]) as Record<string, unknown>;
            if (first.__wal === 'gics' && first.version === 2) return;
        } catch {
            // falls through to migration
        }

        // v1 -> v2 migration
        let lsn = 0n;
        const out = [`${JSON.stringify({ __wal: 'gics', version: 2 })}`];
        for (const line of lines) {
            try {
                const entry = JSON.parse(line) as JsonlV1Entry;
                const base = { op: entry.op, key: entry.key, payload: entry.payload };
                const computed = crc32(Buffer.from(JSON.stringify(base), 'utf8'));
                if (computed !== entry.crc32) {
                    console.warn('[WAL] JSONL CRC mismatch. Skipping corrupted entry.');
                    continue;
                }
                lsn += 1n;
                const payload = { lsn: lsn.toString(), timestamp: Date.now(), ...base };
                const checksum = crc32(Buffer.from(stableStringify(payload), 'utf8'));
                out.push(JSON.stringify({ version: 2, ...payload, crc32: checksum }));
            } catch {
                console.warn('[WAL] Invalid JSONL entry during migration. Skipping.');
            }
        }
        await fs.writeFile(this.filePath, `${out.join('\n')}\n`, 'utf8');
    }

    private parseAllV2(): Array<{ op: Operation; key: string; payload: WALPayload; lsn: bigint }> {
        if (!existsSync(this.filePath)) return [];
        const raw = readFileSync(this.filePath, 'utf8');
        const lines = raw.split('\n').map((x) => x.trim()).filter(Boolean);
        const out: Array<{ op: Operation; key: string; payload: WALPayload; lsn: bigint }> = [];
        for (const line of lines) {
            try {
                const parsed = JSON.parse(line) as Record<string, unknown>;
                if (parsed.__wal === 'gics') continue;
                const entry = parsed as unknown as JsonlV2Entry;
                const base = {
                    lsn: entry.lsn,
                    timestamp: entry.timestamp,
                    op: entry.op,
                    key: entry.key,
                    payload: entry.payload
                };
                const computed = crc32(Buffer.from(stableStringify(base), 'utf8'));
                if (computed !== entry.crc32) {
                    console.warn('[WAL] JSONL CRC mismatch. Skipping corrupted entry.');
                    continue;
                }
                out.push({ op: entry.op, key: entry.key, payload: entry.payload, lsn: BigInt(entry.lsn) });
            } catch {
                console.warn('[WAL] Invalid JSONL entry. Skipping.');
            }
        }
        return out;
    }

    protected async loadStateFromWal(): Promise<void> {
        const entries = this.parseAllV2();
        for (const e of entries) {
            if (e.lsn > this.lastLsn) this.lastLsn = e.lsn;
            this.applyState(e.op, e.key, e.payload, e.lsn);
        }
    }

    protected async appendEntry(lsn: bigint, op: Operation, key: string, payload: WALPayload, timestamp: number): Promise<void> {
        const base = { lsn: lsn.toString(), timestamp, op, key, payload };
        const line = JSON.stringify({ version: 2, ...base, crc32: crc32(Buffer.from(stableStringify(base), 'utf8')) }) + '\n';
        await new Promise<void>((resolve, reject) => {
            this.writeStream!.write(line, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }

    protected async replayTail(afterLsn: bigint, handler: (op: Operation, key: string, payload: WALPayload, lsn: bigint) => void): Promise<void> {
        const entries = this.parseAllV2();
        for (const e of entries) {
            if (e.lsn <= afterLsn) continue;
            handler(e.op, e.key, e.payload, e.lsn);
        }
    }

    protected async compactToState(): Promise<void> {
        if (this.writeStream) {
            await this.closeStream();
        }

        const lines: string[] = [JSON.stringify({ __wal: 'gics', version: 2 })];
        const entries = Array.from(this.state.entries())
            .map(([key, value]) => ({ key, ...value }))
            .sort((a, b) => (a.lsn < b.lsn ? -1 : 1));
        for (const e of entries) {
            const base = {
                lsn: e.lsn.toString(),
                timestamp: Date.now(),
                op: Operation.PUT,
                key: e.key,
                payload: e.payload
            };
            lines.push(JSON.stringify({ version: 2, ...base, crc32: crc32(Buffer.from(stableStringify(base), 'utf8')) }));
        }
        const tempPath = `${this.filePath}.tmp`;
        await fs.writeFile(tempPath, `${lines.join('\n')}\n`, 'utf8');
        await fs.rename(tempPath, this.filePath);
        await this.ensureOpen();
    }
}

export function createWALProvider(type: WALType, filePath: string, options: WALProviderOptions = {}): WALProvider {
    if (type === 'jsonl') {
        return new JsonlWALProvider(filePath, options);
    }
    return new BinaryWALProvider(filePath, options);
}
