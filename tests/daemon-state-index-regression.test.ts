import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as net from 'net';
import { GICSDaemon, type GICSDaemonConfig } from '../src/daemon/server.js';
import { GICSv2Decoder } from '../src/gics/decode.js';

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gics-state-index-test-'));
    try {
        await run(dir);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
}

function makeSocketPath(name: string): string {
    return process.platform === 'win32'
        ? `\\\\.\\pipe\\${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`
        : path.join(os.tmpdir(), `${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
}

async function rpcCall(socketPath: string, request: Record<string, unknown>): Promise<any> {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection(socketPath, () => {
            socket.write(JSON.stringify({ jsonrpc: '2.0', ...request }) + '\n');
        });

        let buffer = '';
        socket.on('data', (data) => {
            buffer += data.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            if (lines.length === 0) return;
            socket.end();
            resolve(JSON.parse(lines[0]!));
        });
        socket.on('error', reject);
    });
}

describe('GICSDaemon StateIndex regressions', () => {
    it('scan(prefix) includes WARM records after flush + restart', async () => {
        await withTempDir(async (baseDir) => {
            const dataPath = path.join(baseDir, 'data');
            const tokenPath = path.join(baseDir, '.gics_token');
            const socketPath = makeSocketPath('gics-state-scan');

            const daemonA = new GICSDaemon({ socketPath, dataPath, tokenPath, walType: 'binary' });
            await daemonA.start();
            const token = (await fs.readFile(tokenPath, 'utf8')).trim();

            await rpcCall(socketPath, {
                method: 'put',
                params: { key: 'probe:item:1', fields: { value: 7, tag: 'warm' } },
                id: 1,
                token,
            });
            await rpcCall(socketPath, { method: 'flush', id: 2, token });
            await daemonA.stop();

            const daemonB = new GICSDaemon({ socketPath, dataPath, tokenPath, walType: 'binary' });
            await daemonB.start();

            const scan = await rpcCall(socketPath, {
                method: 'scan',
                params: { prefix: 'probe:' },
                id: 3,
                token,
            });

            expect(scan.error).toBeUndefined();
            expect(scan.result.items).toHaveLength(1);
            expect(scan.result.items[0].key).toBe('probe:item:1');
            expect(scan.result.items[0].fields).toEqual({ value: 7, tag: 'warm' });
            expect(scan.result.items[0].tier).toBe('warm');

            await daemonB.stop();
        });
    });

    it('delete persists tombstones so flushed values do not resurrect after restart', async () => {
        await withTempDir(async (baseDir) => {
            const dataPath = path.join(baseDir, 'data');
            const tokenPath = path.join(baseDir, '.gics_token');
            const socketPath = makeSocketPath('gics-state-delete');

            const daemonA = new GICSDaemon({ socketPath, dataPath, tokenPath, walType: 'binary' });
            await daemonA.start();
            const token = (await fs.readFile(tokenPath, 'utf8')).trim();

            await rpcCall(socketPath, {
                method: 'put',
                params: { key: 'probe:delete:1', fields: { value: 10 } },
                id: 10,
                token,
            });
            await rpcCall(socketPath, { method: 'flush', id: 11, token });
            await rpcCall(socketPath, {
                method: 'delete',
                params: { key: 'probe:delete:1' },
                id: 12,
                token,
            });
            await rpcCall(socketPath, { method: 'flush', id: 13, token });
            await daemonA.stop();

            const daemonB = new GICSDaemon({ socketPath, dataPath, tokenPath, walType: 'binary' });
            await daemonB.start();

            const get = await rpcCall(socketPath, {
                method: 'get',
                params: { key: 'probe:delete:1' },
                id: 14,
                token,
            });
            expect(get.result).toBeNull();

            const scan = await rpcCall(socketPath, {
                method: 'scan',
                params: { prefix: 'probe:delete:' },
                id: 15,
                token,
            });
            expect(scan.result.items).toEqual([]);

            const hiddenScan = await rpcCall(socketPath, {
                method: 'scan',
                params: { prefix: '_sys|tombstone|', includeSystem: true },
                id: 16,
                token,
            });
            expect(hiddenScan.result.items.length).toBeGreaterThan(0);

            await daemonB.stop();
        });
    });

    it('rebuilds StateIndex from segments when the persisted index is corrupt', async () => {
        await withTempDir(async (baseDir) => {
            const dataPath = path.join(baseDir, 'data');
            const tokenPath = path.join(baseDir, '.gics_token');
            const socketPath = makeSocketPath('gics-state-rebuild');

            const daemonA = new GICSDaemon({ socketPath, dataPath, tokenPath, walType: 'binary' });
            await daemonA.start();
            const token = (await fs.readFile(tokenPath, 'utf8')).trim();

            await rpcCall(socketPath, {
                method: 'put',
                params: { key: 'probe:rebuild:1', fields: { value: 22, tag: 'persisted' } },
                id: 20,
                token,
            });
            await rpcCall(socketPath, { method: 'flush', id: 21, token });
            await daemonA.stop();

            await fs.writeFile(path.join(dataPath, 'state-index.json'), '{broken json', 'utf8');

            const daemonB = new GICSDaemon({ socketPath, dataPath, tokenPath, walType: 'binary' });
            await daemonB.start();

            const get = await rpcCall(socketPath, {
                method: 'get',
                params: { key: 'probe:rebuild:1' },
                id: 22,
                token,
            });
            expect(get.error).toBeUndefined();
            expect(get.result?.fields).toEqual({ value: 22, tag: 'persisted' });
            expect(get.result?.tier).toBe('warm');

            await daemonB.stop();
        });
    });

    it('infer is deterministic for the same input and writes hidden system records', async () => {
        await withTempDir(async (baseDir) => {
            const dataPath = path.join(baseDir, 'data');
            const tokenPath = path.join(baseDir, '.gics_token');
            const socketPath = makeSocketPath('gics-infer');

            const daemon = new GICSDaemon({
                socketPath,
                dataPath,
                tokenPath,
                walType: 'binary',
                modules: {
                    'inference-engine': { enabled: true },
                },
            });
            await daemon.start();
            const token = (await fs.readFile(tokenPath, 'utf8')).trim();

            const params = {
                domain: 'ops.provider_select',
                objective: 'low_latency',
                subject: 'gimo',
                context: { latencyMs: 120, successRate: 0.95 },
                candidates: [
                    { id: 'haiku', latencyMs: 90, cost: 1, successRate: 0.91 },
                    { id: 'sonnet', latencyMs: 130, cost: 2, successRate: 0.97 },
                    { id: 'opus', latencyMs: 180, cost: 4, successRate: 0.99 },
                ],
            };

            const inferA = await rpcCall(socketPath, { method: 'infer', params, id: 30, token });
            const inferB = await rpcCall(socketPath, { method: 'infer', params, id: 31, token });

            expect(inferA.error).toBeUndefined();
            expect(inferB.error).toBeUndefined();
            expect(inferA.result.domain).toBe('ops.provider_select');
            expect(inferA.result.ranking).toEqual(inferB.result.ranking);
            expect(inferA.result.recommended.id).toBe(inferB.result.recommended.id);

            const hiddenDefault = await rpcCall(socketPath, {
                method: 'scan',
                params: { prefix: '_infer|' },
                id: 32,
                token,
            });
            expect(hiddenDefault.result.items).toEqual([]);

            const hiddenSystem = await rpcCall(socketPath, {
                method: 'scan',
                params: { prefix: '_infer|', includeSystem: true },
                id: 33,
                token,
            });
            expect(hiddenSystem.result.items.length).toBeGreaterThan(0);

            const profile = await rpcCall(socketPath, {
                method: 'getProfile',
                params: { scope: 'host:default' },
                id: 34,
                token,
            });
            expect(profile.error).toBeUndefined();
            expect(profile.result.scope).toBe('host:default');

            await rpcCall(socketPath, {
                method: 'put',
                params: { key: 'probe:no-full-decode', fields: { value: 1 } },
                id: 35,
                token,
            });
            await rpcCall(socketPath, { method: 'flush', id: 36, token });
            await daemon.stop();

            const originalGetAll = GICSv2Decoder.prototype.getAllGenericSnapshots;
            GICSv2Decoder.prototype.getAllGenericSnapshots = async function (): Promise<any> {
                throw new Error('full decode should not happen on point get');
            };

            try {
                const daemonB = new GICSDaemon({ socketPath, dataPath, tokenPath, walType: 'binary' });
                await daemonB.start();

                const get = await rpcCall(socketPath, {
                    method: 'get',
                    params: { key: 'probe:no-full-decode' },
                    id: 37,
                    token,
                });
                expect(get.error).toBeUndefined();
                expect(get.result?.fields).toEqual({ value: 1 });

                await daemonB.stop();
            } finally {
                GICSv2Decoder.prototype.getAllGenericSnapshots = originalGetAll;
            }
        });
    });
});
