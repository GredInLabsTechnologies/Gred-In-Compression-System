import * as fs from 'fs/promises';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { GICSDaemon } from '../src/daemon/server.js';

type RpcRequest = {
    method: string;
    params?: Record<string, unknown>;
    id: number;
    token?: string;
};

type RpcResponse = {
    id: number;
    result?: any;
    error?: { code: number; message: string; };
};

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gics-daemon-recovery-'));
    try {
        await run(dir);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
}

function makeSocketPath(testId: string): string {
    if (process.platform === 'win32') {
        return `\\\\.\\pipe\\gics-${testId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
    return path.join(os.tmpdir(), `gics-${testId}-${Date.now()}.sock`);
}

async function rpcCall(socketPath: string, request: RpcRequest): Promise<RpcResponse> {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection(socketPath);
        let buffer = '';

        socket.on('connect', () => {
            socket.write(JSON.stringify(request) + '\n');
        });

        socket.on('data', (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.trim()) continue;
                const response = JSON.parse(line) as RpcResponse;
                socket.end();
                resolve(response);
                return;
            }
        });

        socket.on('error', (err) => reject(err));
    });
}

async function rawLineCall(socketPath: string, rawLine: string): Promise<any> {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection(socketPath);
        let buffer = '';

        socket.on('connect', () => {
            socket.write(rawLine + '\n');
        });

        socket.on('data', (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.trim()) continue;
                socket.end();
                resolve(JSON.parse(line));
                return;
            }
        });

        socket.on('error', (err) => reject(err));
    });
}

async function openPingConnection(socketPath: string, id: number): Promise<RpcResponse> {
    return rpcCall(socketPath, { method: 'ping', id });
}

function stripPresenceFields(fields: Record<string, number | string> | undefined): Record<string, number | string> | undefined {
    if (!fields) return fields;
    const out: Record<string, number | string> = {};
    for (const [k, v] of Object.entries(fields)) {
        if (k.startsWith('__gics_p__')) continue;
        out[k] = v;
    }
    return out;
}

describe('GICSDaemon WAL recovery (Phase 1.2 bootstrap)', () => {
    it.each(['binary', 'jsonl'] as const)('reconstruye MemTable tras reinicio usando WAL (%s)', async (walType) => {
        await withTempDir(async (baseDir) => {
            const dataPath = path.join(baseDir, 'data');
            const tokenPath = path.join(baseDir, '.gics_token');
            const socketPathA = makeSocketPath(`recovery-a-${walType}`);

            const daemonA = new GICSDaemon({
                socketPath: socketPathA,
                dataPath,
                tokenPath,
                walType
            });

            await daemonA.start();
            const token = (await fs.readFile(tokenPath, 'utf8')).trim();

            const put1 = await rpcCall(socketPathA, {
                method: 'put',
                params: { key: 'item:1', fields: { score: 10, tag: 'hot' } },
                id: 1,
                token
            });
            expect(put1.error).toBeUndefined();

            const put2 = await rpcCall(socketPathA, {
                method: 'put',
                params: { key: 'item:2', fields: { score: 22, tag: 'warm' } },
                id: 2,
                token
            });
            expect(put2.error).toBeUndefined();

            await daemonA.stop();

            const socketPathB = makeSocketPath(`recovery-b-${walType}`);
            const daemonB = new GICSDaemon({
                socketPath: socketPathB,
                dataPath,
                tokenPath,
                walType
            });

            await daemonB.start();

            const ping = await rpcCall(socketPathB, {
                method: 'ping',
                id: 3
            });
            expect(ping.error).toBeUndefined();
            expect(ping.result?.recoveredEntries).toBe(2);
            expect(ping.result?.walType).toBe(walType);

            const get1 = await rpcCall(socketPathB, {
                method: 'get',
                params: { key: 'item:1' },
                id: 4,
                token
            });
            expect(get1.error).toBeUndefined();
            expect(get1.result?.fields).toEqual({ score: 10, tag: 'hot' });

            const get2 = await rpcCall(socketPathB, {
                method: 'get',
                params: { key: 'item:2' },
                id: 5,
                token
            });
            expect(get2.error).toBeUndefined();
            expect(get2.result?.fields).toEqual({ score: 22, tag: 'warm' });

            await daemonB.stop();
        });
    });

    it('flush limpia dirtyCount y trunca WAL', async () => {
        await withTempDir(async (baseDir) => {
            const dataPath = path.join(baseDir, 'data');
            const tokenPath = path.join(baseDir, '.gics_token');
            const socketPath = makeSocketPath('flush-binary');

            const daemon = new GICSDaemon({
                socketPath,
                dataPath,
                tokenPath,
                walType: 'binary'
            });

            await daemon.start();
            const token = (await fs.readFile(tokenPath, 'utf8')).trim();

            const put = await rpcCall(socketPath, {
                method: 'put',
                params: { key: 'flush:item', fields: { value: 1, tag: 'dirty' } },
                id: 10,
                token
            });
            expect(put.error).toBeUndefined();

            const prePing = await rpcCall(socketPath, { method: 'ping', id: 11 });
            expect(prePing.error).toBeUndefined();
            expect(prePing.result?.dirtyCount).toBeGreaterThan(0);

            const flush = await rpcCall(socketPath, { method: 'flush', id: 12, token });
            expect(flush.error).toBeUndefined();
            expect(flush.result?.ok).toBe(true);
            expect(flush.result?.walTruncated).toBe(true);
            expect(flush.result?.dirtyBeforeFlush).toBeGreaterThan(0);
            expect(flush.result?.recordsFlushed).toBeGreaterThan(0);
            expect(flush.result?.bytesWritten).toBeGreaterThan(0);
            expect(typeof flush.result?.flushDurationMs).toBe('number');
            expect(flush.result?.segmentCreated).toBeTruthy();

            const postPing = await rpcCall(socketPath, { method: 'ping', id: 13 });
            expect(postPing.error).toBeUndefined();
            expect(postPing.result?.dirtyCount).toBe(0);
            expect(postPing.result?.segments).toBeGreaterThan(0);

            await daemon.stop();

            const walPath = path.join(dataPath, 'gics.wal');
            const stats = await fs.stat(walPath);
            expect(stats.size).toBe(0);

            const warmDir = path.join(dataPath, 'warm');
            const warmFiles = await fs.readdir(warmDir);
            expect(warmFiles.some((name) => name.endsWith('.gics'))).toBe(true);
        });
    });

    it('put puede disparar auto-flush por threshold de dirtyCount', async () => {
        await withTempDir(async (baseDir) => {
            const dataPath = path.join(baseDir, 'data');
            const tokenPath = path.join(baseDir, '.gics_token');
            const socketPath = makeSocketPath('autoflush-dirty-threshold');

            const daemon = new GICSDaemon({
                socketPath,
                dataPath,
                tokenPath,
                walType: 'binary',
                maxDirtyCount: 0 // dirtyCount=1 after first put => auto-flush
            });

            await daemon.start();
            const token = (await fs.readFile(tokenPath, 'utf8')).trim();

            const put = await rpcCall(socketPath, {
                method: 'put',
                params: { key: 'auto:item', fields: { value: 7, tag: 'auto' } },
                id: 70,
                token
            });

            expect(put.error).toBeUndefined();
            expect(put.result?.ok).toBe(true);
            expect(put.result?.autoFlushed).toBe(true);
            expect(put.result?.flush?.reason).toBe('dirty');
            expect(put.result?.flush?.recordsFlushed).toBeGreaterThan(0);
            expect(put.result?.flush?.segmentCreated).toBeTruthy();

            const ping = await rpcCall(socketPath, { method: 'ping', id: 71 });
            expect(ping.error).toBeUndefined();
            expect(ping.result?.dirtyCount).toBe(0);
            expect(ping.result?.segments).toBeGreaterThan(0);

            await daemon.stop();
        });
    });

    it('compact fusiona segmentos WARM y aplica last-writer-wins por key', async () => {
        await withTempDir(async (baseDir) => {
            const dataPath = path.join(baseDir, 'data');
            const tokenPath = path.join(baseDir, '.gics_token');
            const socketPath = makeSocketPath('compact-warm-segments');

            const daemon = new GICSDaemon({
                socketPath,
                dataPath,
                tokenPath,
                walType: 'binary'
            });

            await daemon.start();
            const token = (await fs.readFile(tokenPath, 'utf8')).trim();

            // Segmento 1
            await rpcCall(socketPath, {
                method: 'put',
                params: { key: 'item:shared', fields: { value: 1, tag: 'old' } },
                id: 80,
                token
            });
            await rpcCall(socketPath, {
                method: 'put',
                params: { key: 'item:a', fields: { value: 10, tag: 'a' } },
                id: 81,
                token
            });
            const flush1 = await rpcCall(socketPath, { method: 'flush', id: 82, token });
            expect(flush1.error).toBeUndefined();
            expect(flush1.result?.ok).toBe(true);

            // Segmento 2 (actualiza item:shared)
            await rpcCall(socketPath, {
                method: 'put',
                params: { key: 'item:shared', fields: { value: 2, tag: 'new' } },
                id: 83,
                token
            });
            await rpcCall(socketPath, {
                method: 'put',
                params: { key: 'item:b', fields: { value: 20, tag: 'b' } },
                id: 84,
                token
            });
            const flush2 = await rpcCall(socketPath, { method: 'flush', id: 85, token });
            expect(flush2.error).toBeUndefined();
            expect(flush2.result?.ok).toBe(true);

            const preCompactPing = await rpcCall(socketPath, { method: 'ping', id: 86 });
            expect(preCompactPing.error).toBeUndefined();
            expect(preCompactPing.result?.segments).toBeGreaterThanOrEqual(2);

            const compact = await rpcCall(socketPath, { method: 'compact', id: 87, token });
            expect(compact.error).toBeUndefined();
            expect(compact.result?.ok).toBe(true);
            expect(compact.result?.compacted).toBe(true);
            expect(compact.result?.segmentsMerged).toBeGreaterThanOrEqual(2);
            expect(compact.result?.outputSegment).toBeTruthy();

            const postCompactPing = await rpcCall(socketPath, { method: 'ping', id: 88 });
            expect(postCompactPing.error).toBeUndefined();
            expect(postCompactPing.result?.segments).toBe(1);

            const warmDir = path.join(dataPath, 'warm');
            const warmFiles = (await fs.readdir(warmDir)).filter((name) => name.endsWith('.gics') && !name.startsWith('insight-'));
            expect(warmFiles.length).toBe(1);

            // Verifica LWW decodificando el segmento compactado
            const compactedPath = path.join(warmDir, warmFiles[0]);
            const compactedBytes = await fs.readFile(compactedPath);
            const { GICSv2Decoder } = await import('../src/gics/decode.js');
            const decoder = new GICSv2Decoder(compactedBytes);
            const snapshots = await decoder.getAllGenericSnapshots();
            expect(snapshots.length).toBeGreaterThan(0);
            const latest = snapshots[snapshots.length - 1];
            expect(stripPresenceFields(latest.items.get('item:shared'))).toEqual({ value: 2, tag: 'new' });

            await daemon.stop();
        });
    });

    it('rotate mueve segmentos WARM a COLD y actualiza ping.tiers', async () => {
        await withTempDir(async (baseDir) => {
            const dataPath = path.join(baseDir, 'data');
            const tokenPath = path.join(baseDir, '.gics_token');
            const socketPath = makeSocketPath('rotate-warm-cold');

            const daemon = new GICSDaemon({
                socketPath,
                dataPath,
                tokenPath,
                walType: 'binary',
                warmRetentionMs: 0,
                coldRetentionMs: 0,
                coldEncryption: false
            });

            await daemon.start();
            const token = (await fs.readFile(tokenPath, 'utf8')).trim();

            await rpcCall(socketPath, {
                method: 'put',
                params: { key: 'rotate:item', fields: { value: 11, tag: 'warm' } },
                id: 90,
                token
            });
            await rpcCall(socketPath, { method: 'flush', id: 91, token });

            const pre = await rpcCall(socketPath, { method: 'ping', id: 92 });
            expect(pre.error).toBeUndefined();
            expect(pre.result?.segments).toBeGreaterThan(0);

            const rotate = await rpcCall(socketPath, { method: 'rotate', id: 93, token });
            expect(rotate.error).toBeUndefined();
            expect(rotate.result?.ok).toBe(true);
            expect(rotate.result?.filesArchived).toBeGreaterThan(0);

            const post = await rpcCall(socketPath, { method: 'ping', id: 94 });
            expect(post.error).toBeUndefined();
            expect(post.result?.segments).toBe(0);
            expect(post.result?.coldSegments).toBeGreaterThan(0);
            expect(post.result?.tiers?.warmSegments).toBe(0);
            expect(post.result?.tiers?.coldSegments).toBeGreaterThan(0);

            await daemon.stop();
        });
    });

    it('rotate con coldEncryption escribe archivo COLD cifrado', async () => {
        await withTempDir(async (baseDir) => {
            const dataPath = path.join(baseDir, 'data');
            const tokenPath = path.join(baseDir, '.gics_token');
            const socketPath = makeSocketPath('rotate-cold-encryption');

            const envVar = 'GICS_COLD_KEY_TEST';
            const prev = process.env[envVar];
            process.env[envVar] = 'super-secret-cold-pass';

            try {
                const daemon = new GICSDaemon({
                    socketPath,
                    dataPath,
                    tokenPath,
                    walType: 'binary',
                    warmRetentionMs: 0,
                    coldRetentionMs: 365 * 24 * 60 * 60 * 1000,
                    coldEncryption: true,
                    coldPasswordEnvVar: envVar
                });

                await daemon.start();
                const token = (await fs.readFile(tokenPath, 'utf8')).trim();

                await rpcCall(socketPath, {
                    method: 'put',
                    params: { key: 'secure:item', fields: { value: 77, tag: 'secure' } },
                    id: 95,
                    token
                });
                await rpcCall(socketPath, { method: 'flush', id: 96, token });

                const rotate = await rpcCall(socketPath, { method: 'rotate', id: 97, token });
                expect(rotate.error).toBeUndefined();
                expect(rotate.result?.ok).toBe(true);
                expect(rotate.result?.filesArchived).toBeGreaterThan(0);

                const coldDir = path.join(dataPath, 'cold');
                const coldFiles = (await fs.readdir(coldDir)).filter((name) => name.endsWith('.gics'));
                expect(coldFiles.length).toBeGreaterThan(0);

                const coldBytes = await fs.readFile(path.join(coldDir, coldFiles[0]));
                const { GICSv2Decoder } = await import('../src/gics/decode.js');

                const wrongDecoder = new GICSv2Decoder(coldBytes, { password: 'wrong-pass' });
                await expect(wrongDecoder.getAllGenericSnapshots()).rejects.toThrow();

                const okDecoder = new GICSv2Decoder(coldBytes, { password: 'super-secret-cold-pass' });
                const snapshots = await okDecoder.getAllGenericSnapshots();
                expect(snapshots.length).toBeGreaterThan(0);
                const latest = snapshots[snapshots.length - 1];
                expect(stripPresenceFields(latest.items.get('secure:item'))).toEqual({ value: 77, tag: 'secure' });

                await daemon.stop();
            } finally {
                if (prev === undefined) delete process.env[envVar];
                else process.env[envVar] = prev;
            }
        });
    });

    it('get enruta HOT→WARM→COLD según disponibilidad', async () => {
        await withTempDir(async (baseDir) => {
            const dataPath = path.join(baseDir, 'data');
            const tokenPath = path.join(baseDir, '.gics_token');
            const socketPath = makeSocketPath('tier-routing-get');

            const daemon = new GICSDaemon({
                socketPath,
                dataPath,
                tokenPath,
                walType: 'binary',
                warmRetentionMs: 0,
                coldRetentionMs: 365 * 24 * 60 * 60 * 1000,
                coldEncryption: false
            });

            await daemon.start();
            const token = (await fs.readFile(tokenPath, 'utf8')).trim();

            // HOT
            await rpcCall(socketPath, {
                method: 'put',
                params: { key: 'routing:item', fields: { value: 1, tag: 'hot' } },
                id: 98,
                token
            });
            const hotGet = await rpcCall(socketPath, {
                method: 'get',
                params: { key: 'routing:item' },
                id: 99,
                token
            });
            expect(hotGet.error).toBeUndefined();
            expect(hotGet.result?.tier).toBe('hot');

            // WARM
            await rpcCall(socketPath, { method: 'flush', id: 100, token });

            // Reinicio para vaciar HOT y forzar resolución desde segmentos WARM
            await daemon.stop();
            const daemon2 = new GICSDaemon({
                socketPath,
                dataPath,
                tokenPath,
                walType: 'binary',
                warmRetentionMs: 0,
                coldRetentionMs: 365 * 24 * 60 * 60 * 1000,
                coldEncryption: false
            });
            await daemon2.start();

            const warmGet = await rpcCall(socketPath, {
                method: 'get',
                params: { key: 'routing:item' },
                id: 101,
                token
            });
            expect(warmGet.error).toBeUndefined();
            expect(warmGet.result?.tier).toBe('warm');

            // COLD
            await rpcCall(socketPath, { method: 'rotate', id: 102, token });
            const coldGet = await rpcCall(socketPath, {
                method: 'get',
                params: { key: 'routing:item' },
                id: 103,
                token
            });
            expect(coldGet.error).toBeUndefined();
            expect(coldGet.result?.tier).toBe('cold');
            expect(coldGet.result?.fields).toEqual({ value: 1, tag: 'hot' });

            await daemon2.stop();
        });
    });

    it('ping reporta walFsyncMode configurado', async () => {
        await withTempDir(async (baseDir) => {
            const dataPath = path.join(baseDir, 'data');
            const tokenPath = path.join(baseDir, '.gics_token');
            const socketPath = makeSocketPath('fsync-mode');

            const daemon = new GICSDaemon({
                socketPath,
                dataPath,
                tokenPath,
                walType: 'jsonl',
                walFsyncMode: 'strict'
            });

            await daemon.start();

            const ping = await rpcCall(socketPath, { method: 'ping', id: 20 });
            expect(ping.error).toBeUndefined();
            expect(ping.result?.walType).toBe('jsonl');
            expect(ping.result?.walFsyncMode).toBe('strict');

            await daemon.stop();
        });
    });

    it('IPC responde JSON-RPC 2.0 y errores estándar de protocolo', async () => {
        await withTempDir(async (baseDir) => {
            const dataPath = path.join(baseDir, 'data');
            const tokenPath = path.join(baseDir, '.gics_token');
            const socketPath = makeSocketPath('ipc-jsonrpc');

            const daemon = new GICSDaemon({
                socketPath,
                dataPath,
                tokenPath,
                walType: 'binary'
            });

            await daemon.start();

            const ping = await rpcCall(socketPath, {
                method: 'ping',
                id: 30
            });
            expect((ping as any).jsonrpc).toBe('2.0');
            expect(ping.error).toBeUndefined();
            expect(ping.result?.segments).toBe(0);
            expect(ping.result?.memtable_size).toBeTypeOf('number');

            const invalid = await rawLineCall(socketPath, JSON.stringify({ id: 31 }));
            expect(invalid.jsonrpc).toBe('2.0');
            expect(invalid.error?.code).toBe(-32600);

            const parseError = await rawLineCall(socketPath, '{"method":"ping"');
            expect(parseError.jsonrpc).toBe('2.0');
            expect(parseError.error?.code).toBe(-32700);

            await daemon.stop();
        });
    });

    it('IPC exige token para escritura pero permite ping sin token', async () => {
        await withTempDir(async (baseDir) => {
            const dataPath = path.join(baseDir, 'data');
            const tokenPath = path.join(baseDir, '.gics_token');
            const socketPath = makeSocketPath('ipc-auth');

            const daemon = new GICSDaemon({
                socketPath,
                dataPath,
                tokenPath,
                walType: 'binary'
            });

            await daemon.start();

            const unauthorizedPut = await rpcCall(socketPath, {
                method: 'put',
                params: { key: 'auth:item', fields: { score: 1 } },
                id: 40
            });
            expect((unauthorizedPut as any).jsonrpc).toBe('2.0');
            expect(unauthorizedPut.error?.code).toBe(-32000);

            const pingNoToken = await rpcCall(socketPath, {
                method: 'ping',
                id: 41
            });
            expect((pingNoToken as any).jsonrpc).toBe('2.0');
            expect(pingNoToken.error).toBeUndefined();
            expect(pingNoToken.result?.status).toBe('ok');

            await daemon.stop();
        });
    });

    it('IPC acepta múltiples readers simultáneos (ping concurrente)', async () => {
        await withTempDir(async (baseDir) => {
            const dataPath = path.join(baseDir, 'data');
            const tokenPath = path.join(baseDir, '.gics_token');
            const socketPath = makeSocketPath('ipc-concurrency-readers');

            const daemon = new GICSDaemon({
                socketPath,
                dataPath,
                tokenPath,
                walType: 'binary'
            });

            await daemon.start();

            const responses = await Promise.all([
                openPingConnection(socketPath, 50),
                openPingConnection(socketPath, 51),
                openPingConnection(socketPath, 52),
                openPingConnection(socketPath, 53),
                openPingConnection(socketPath, 54)
            ]);

            for (const response of responses) {
                expect((response as any).jsonrpc).toBe('2.0');
                expect(response.error).toBeUndefined();
                expect(response.result?.status).toBe('ok');
            }

            await daemon.stop();
        });
    });

    it('Insight API base: getInsight/getInsights/reportOutcome/getAccuracy/subscribe/unsubscribe', async () => {
        await withTempDir(async (baseDir) => {
            const dataPath = path.join(baseDir, 'data');
            const tokenPath = path.join(baseDir, '.gics_token');
            const socketPath = makeSocketPath('insight-api-base');

            const daemon = new GICSDaemon({
                socketPath,
                dataPath,
                tokenPath,
                walType: 'binary'
            });

            await daemon.start();
            const token = (await fs.readFile(tokenPath, 'utf8')).trim();

            for (let i = 0; i < 6; i++) {
                const put = await rpcCall(socketPath, {
                    method: 'put',
                    params: { key: 'insight:item', fields: { score: 10 + i, tag: 'alpha' } },
                    id: 200 + i,
                    token
                });
                expect(put.error).toBeUndefined();
                expect(put.result?.behavior?.key).toBe('insight:item');
            }

            const getInsight = await rpcCall(socketPath, {
                method: 'getInsight',
                params: { key: 'insight:item' },
                id: 201,
                token
            });
            expect(getInsight.error).toBeUndefined();
            expect(getInsight.result?.key).toBe('insight:item');
            expect(getInsight.result?.writeCount).toBeGreaterThan(0);

            const getInsights = await rpcCall(socketPath, {
                method: 'getInsights',
                id: 202,
                token
            });
            expect(getInsights.error).toBeUndefined();
            expect(Array.isArray(getInsights.result)).toBe(true);
            expect(getInsights.result.some((item: any) => item.key === 'insight:item')).toBe(true);

            const recs = await rpcCall(socketPath, {
                method: 'getRecommendations',
                id: 203,
                token
            });
            expect(recs.error).toBeUndefined();
            expect(Array.isArray(recs.result)).toBe(true);
            expect(recs.result.length).toBeGreaterThan(0);

            const firstInsightId = String(recs.result[0]?.insightId ?? '');
            expect(firstInsightId.length).toBeGreaterThan(0);

            const reportOutcome = await rpcCall(socketPath, {
                method: 'reportOutcome',
                params: {
                    insightId: firstInsightId,
                    result: 'followed_success',
                    context: 'basic smoke'
                },
                id: 204,
                token
            });
            expect(reportOutcome.error).toBeUndefined();
            expect(reportOutcome.result?.ok).toBe(true);
            expect(reportOutcome.result?.insightId).toBe(firstInsightId);

            const accuracy = await rpcCall(socketPath, {
                method: 'getAccuracy',
                id: 205,
                token
            });
            expect(accuracy.error).toBeUndefined();
            expect(Array.isArray(accuracy.result)).toBe(true);
            expect(accuracy.result.length).toBeGreaterThan(0);

            const subscribe = await rpcCall(socketPath, {
                method: 'subscribe',
                params: { events: ['anomaly_detected', 'recommendation_new'] },
                id: 206,
                token
            });
            expect(subscribe.error).toBeUndefined();
            expect(typeof subscribe.result?.subscriptionId).toBe('string');

            const unsubscribe = await rpcCall(socketPath, {
                method: 'unsubscribe',
                params: { subscriptionId: subscribe.result?.subscriptionId },
                id: 207,
                token
            });
            expect(unsubscribe.error).toBeUndefined();
            expect(typeof unsubscribe.result?.ok).toBe('boolean');

            const verify = await rpcCall(socketPath, {
                method: 'verify',
                id: 208,
                token
            });
            expect(verify.error).toBeUndefined();
            expect(typeof verify.result?.valid).toBe('boolean');
            expect(Array.isArray(verify.result?.details)).toBe(true);

            await daemon.stop();
        });
    });

    it('persiste insights en segmentos y los restaura tras reinicio', async () => {
        await withTempDir(async (baseDir) => {
            const dataPath = path.join(baseDir, 'data');
            const tokenPath = path.join(baseDir, '.gics_token');
            const socketPathA = makeSocketPath('insight-persistence-a');

            const daemonA = new GICSDaemon({
                socketPath: socketPathA,
                dataPath,
                tokenPath,
                walType: 'binary'
            });

            await daemonA.start();
            const token = (await fs.readFile(tokenPath, 'utf8')).trim();

            // Generate behavior + recommendation
            for (let i = 0; i < 10; i++) {
                const put = await rpcCall(socketPathA, {
                    method: 'put',
                    params: { key: 'persist:item', fields: { score: i * 10 } },
                    id: 300 + i,
                    token
                });
                expect(put.error).toBeUndefined();
            }

            const recs = await rpcCall(socketPathA, {
                method: 'getRecommendations',
                id: 320,
                token
            });
            expect(recs.error).toBeUndefined();
            expect(Array.isArray(recs.result)).toBe(true);
            expect(recs.result.length).toBeGreaterThan(0);

            const insightId = String(recs.result[0]?.insightId ?? '');
            const outcome = await rpcCall(socketPathA, {
                method: 'reportOutcome',
                params: { insightId, result: 'followed_success' },
                id: 321,
                token
            });
            expect(outcome.error).toBeUndefined();
            expect(outcome.result?.ok).toBe(true);

            const flush = await rpcCall(socketPathA, { method: 'flush', id: 322, token });
            expect(flush.error).toBeUndefined();
            expect(flush.result?.ok).toBe(true);

            await daemonA.stop();

            const socketPathB = makeSocketPath('insight-persistence-b');
            const daemonB = new GICSDaemon({
                socketPath: socketPathB,
                dataPath,
                tokenPath,
                walType: 'binary'
            });

            await daemonB.start();

            const restoredInsight = await rpcCall(socketPathB, {
                method: 'getInsight',
                params: { key: 'persist:item' },
                id: 330,
                token
            });
            expect(restoredInsight.error).toBeUndefined();
            expect(restoredInsight.result?.key).toBe('persist:item');
            expect(restoredInsight.result?.writeCount).toBeGreaterThan(0);

            const restoredAccuracy = await rpcCall(socketPathB, {
                method: 'getAccuracy',
                id: 331,
                token
            });
            expect(restoredAccuracy.error).toBeUndefined();
            expect(Array.isArray(restoredAccuracy.result)).toBe(true);
            expect(restoredAccuracy.result.length).toBeGreaterThan(0);

            // _insight/* records must not leak to user scan
            const scan = await rpcCall(socketPathB, {
                method: 'scan',
                params: { prefix: '_insight/' },
                id: 332,
                token
            });
            expect(scan.error).toBeUndefined();
            expect(Array.isArray(scan.result?.items)).toBe(true);
            expect(scan.result.items.length).toBe(0);

            await daemonB.stop();
        });
    });
});
