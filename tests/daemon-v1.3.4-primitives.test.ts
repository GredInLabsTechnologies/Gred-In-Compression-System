import * as fs from 'fs/promises';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { GICSDaemon, type GICSDaemonConfig } from '../src/daemon/server.js';

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gics-134-primitives-'));
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

async function sendRequest(socketPath: string, request: Record<string, unknown>): Promise<any> {
    return new Promise((resolve, reject) => {
        const client = net.connect(socketPath, () => {
            client.write(JSON.stringify({ jsonrpc: '2.0', ...request }) + '\n');
        });

        let buffer = '';
        client.on('data', (data) => {
            buffer += data.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            if (lines.length === 0) return;
            client.end();
            resolve(JSON.parse(lines[0]!));
        });
        client.on('error', reject);
    });
}

describe('Daemon 1.3.4 primitives and IPC', () => {
    it('putMany supports idempotency and prefix summaries', async () => {
        await withTempDir(async (dir) => {
            const config: GICSDaemonConfig = {
                socketPath: makeSocketPath('gics-putmany'),
                dataPath: path.join(dir, 'data'),
                tokenPath: path.join(dir, 'token.txt'),
                walType: 'binary',
            };
            const daemon = new GICSDaemon(config);
            await daemon.start();

            try {
                const token = (await fs.readFile(config.tokenPath, 'utf8')).trim();
                const payload = {
                    records: [
                        { key: 'orders:1', fields: { value: 10, stage: 'new' } },
                        { key: 'orders:2', fields: { value: 20, stage: 'new' } },
                    ],
                    atomic: true,
                    idempotency_key: 'batch-1',
                    verify: true,
                };

                const first = await sendRequest(config.socketPath, {
                    method: 'putMany',
                    params: payload,
                    id: 1,
                    token,
                });
                expect(first.result.ok).toBe(true);
                expect(first.result.count).toBe(2);
                expect(first.result.deduplicated).toBe(false);

                const repeated = await sendRequest(config.socketPath, {
                    method: 'putMany',
                    params: payload,
                    id: 2,
                    token,
                });
                expect(repeated.result.ok).toBe(true);
                expect(repeated.result.deduplicated).toBe(true);

                const count = await sendRequest(config.socketPath, {
                    method: 'countPrefix',
                    params: { prefix: 'orders:' },
                    id: 3,
                    token,
                });
                expect(count.result.count).toBe(2);

                const latest = await sendRequest(config.socketPath, {
                    method: 'latestByPrefix',
                    params: { prefix: 'orders:' },
                    id: 4,
                    token,
                });
                expect(latest.result.key).toBe('orders:2');

                const summary = await sendRequest(config.socketPath, {
                    method: 'scanSummary',
                    params: { prefix: 'orders:' },
                    id: 5,
                    token,
                });
                expect(summary.result.count).toBe(2);
                expect(summary.result.tiers.hot).toBe(2);
                expect(summary.result.latestKey).toBe('orders:2');
            } finally {
                await daemon.stop();
            }
        });
    });

    it('delete persists tombstone atomically across restart', async () => {
        await withTempDir(async (dir) => {
            const config: GICSDaemonConfig = {
                socketPath: makeSocketPath('gics-delete-atomic'),
                dataPath: path.join(dir, 'data'),
                tokenPath: path.join(dir, 'token.txt'),
                walType: 'binary',
            };

            const daemonA = new GICSDaemon(config);
            await daemonA.start();
            const token = (await fs.readFile(config.tokenPath, 'utf8')).trim();

            await sendRequest(config.socketPath, {
                method: 'put',
                params: { key: 'users:1', fields: { score: 7 } },
                id: 1,
                token,
            });
            await sendRequest(config.socketPath, {
                method: 'delete',
                params: { key: 'users:1' },
                id: 2,
                token,
            });
            await daemonA.stop();

            const daemonB = new GICSDaemon(config);
            await daemonB.start();
            try {
                const read = await sendRequest(config.socketPath, {
                    method: 'get',
                    params: { key: 'users:1' },
                    id: 3,
                    token,
                });
                expect(read.result).toBeNull();

                const tombstones = await sendRequest(config.socketPath, {
                    method: 'countPrefix',
                    params: { prefix: '_sys|tombstone|', includeSystem: true },
                    id: 4,
                    token,
                });
                expect(tombstones.result.count).toBe(1);
            } finally {
                await daemonB.stop();
            }
        });
    });

    it('exposes anonymous minimal ping and authenticated pingVerbose', async () => {
        await withTempDir(async (dir) => {
            const config: GICSDaemonConfig = {
                socketPath: makeSocketPath('gics-ping'),
                dataPath: path.join(dir, 'data'),
                tokenPath: path.join(dir, 'token.txt'),
                walType: 'binary',
            };
            const daemon = new GICSDaemon(config);
            await daemon.start();

            try {
                const token = (await fs.readFile(config.tokenPath, 'utf8')).trim();

                const ping = await sendRequest(config.socketPath, {
                    method: 'ping',
                    id: 1,
                });
                expect(ping.result.status).toBe('ok');
                expect(ping.result.version).toBe('1.3.4');
                expect(ping.result.count).toBeUndefined();

                const verboseUnauthorized = await sendRequest(config.socketPath, {
                    method: 'pingVerbose',
                    id: 2,
                });
                expect(verboseUnauthorized.error.message).toBe('Unauthorized');

                const pingVerbose = await sendRequest(config.socketPath, {
                    method: 'pingVerbose',
                    id: 3,
                    token,
                });
                expect(pingVerbose.result.status).toBe('ok');
                expect(pingVerbose.result.walType).toBe('binary');
                expect(typeof pingVerbose.result.count).toBe('number');
            } finally {
                await daemon.stop();
            }
        });
    });

    it('rejects a second daemon on the same storage path', async () => {
        await withTempDir(async (dir) => {
            const dataPath = path.join(dir, 'data');
            const tokenPath = path.join(dir, 'token.txt');
            const daemonA = new GICSDaemon({
                socketPath: makeSocketPath('gics-lock-a'),
                dataPath,
                tokenPath,
                walType: 'binary',
            });
            const daemonB = new GICSDaemon({
                socketPath: makeSocketPath('gics-lock-b'),
                dataPath,
                tokenPath,
                walType: 'binary',
                fileLockTimeoutMs: 80,
            });

            await daemonA.start();
            try {
                await expect(daemonB.start()).rejects.toThrow(/exclusive lock/i);
            } finally {
                await daemonA.stop();
            }
        });
    });
});
