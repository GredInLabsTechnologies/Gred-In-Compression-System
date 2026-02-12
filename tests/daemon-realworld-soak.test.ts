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
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gics-daemon-soak-'));
    try {
        await run(dir);
    } finally {
        let lastError: unknown;
        for (let i = 0; i < 8; i++) {
            try {
                await fs.rm(dir, { recursive: true, force: true });
                lastError = undefined;
                break;
            } catch (e) {
                lastError = e;
                await new Promise((resolve) => setTimeout(resolve, 25 * (i + 1)));
            }
        }

        if (lastError) {
            throw lastError;
        }
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

async function sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

function createRng(seed: number): () => number {
    let x = seed >>> 0;
    return () => {
        x = (1664525 * x + 1013904223) >>> 0;
        return x / 0x100000000;
    };
}

describe('GICSDaemon real-world soak / fault-line test', () => {
    it.each(['binary', 'jsonl'] as const)(
        'survive mixed continuous load + maintenance + restart (%s)',
        async (walType) => {
            await withTempDir(async (baseDir) => {
                const dataPath = path.join(baseDir, 'data');
                const tokenPath = path.join(baseDir, '.gics_token');
                const socketPathA = makeSocketPath(`soak-a-${walType}`);

                const daemonA = new GICSDaemon({
                    socketPath: socketPathA,
                    dataPath,
                    tokenPath,
                    walType,
                    maxDirtyCount: 25,
                    warmRetentionMs: 0,
                    coldRetentionMs: 365 * 24 * 60 * 60 * 1000,
                    coldEncryption: false,
                });

                await daemonA.start();
                const token = (await fs.readFile(tokenPath, 'utf8')).trim();

                const rng = createRng(0xC0FFEE);
                const keyPool = Array.from({ length: 120 }, (_, i) => `rw:key:${i}`);

                let reqId = 1;
                const nextId = () => reqId++;

                const call = async (
                    method: string,
                    params?: Record<string, unknown>,
                    attempts = 6
                ) => {
                    let lastError: RpcResponse['error'];
                    for (let i = 0; i < attempts; i++) {
                        const response = await rpcCall(socketPathA, {
                            method,
                            params,
                            id: nextId(),
                            token,
                        });
                        if (!response.error) {
                            return response.result;
                        }

                        const msg = response.error.message ?? '';
                        const isLockContention =
                            msg.includes('Timed out acquiring') ||
                            msg.includes('Failed to acquire') ||
                            msg.includes('exclusive.lock') ||
                            msg.includes('EPERM: operation not permitted');

                        if (!isLockContention) {
                            expect(response.error).toBeUndefined();
                            return response.result;
                        }

                        lastError = response.error;
                        await sleep(20 * (i + 1));
                    }

                    expect(lastError).toBeUndefined();
                    return null;
                };

                const workers = 3;
                const opsPerWorker = 120;

                await Promise.all(
                    Array.from({ length: workers }, async (_, workerId) => {
                        for (let i = 0; i < opsPerWorker; i++) {
                            const roll = rng();
                            const key = keyPool[Math.floor(rng() * keyPool.length)]!;

                            if (roll < 0.65) {
                                await call('put', {
                                    key,
                                    fields: {
                                        score: Math.floor(rng() * 10_000),
                                        drift: Math.floor(rng() * 1_000),
                                        tag: `w${workerId}`,
                                    },
                                });
                            } else if (roll < 0.85) {
                                const result = await call('get', { key });
                                if (result !== null) {
                                    expect(typeof result.key).toBe('string');
                                    expect(result.fields).toBeTruthy();
                                }
                            } else if (roll < 0.95) {
                                await call('delete', { key });
                            } else {
                                // Maintenance pressure while workload is active.
                                await call('flush');
                                await call('compact');
                                await call('rotate');
                            }

                            if (i % 30 === 0) {
                                const ping = await call('ping');
                                expect(ping.status).toBe('ok');
                                expect(typeof ping.count).toBe('number');
                            }
                        }
                    })
                );

                // Stabilization phase: write deterministic truth-set.
                const expected = new Map<string, Record<string, number | string>>();
                for (let i = 0; i < 40; i++) {
                    const key = `truth:key:${i}`;
                    const fields = {
                        score: i * 10,
                        version: 1,
                        tag: 'truth',
                    };
                    expected.set(key, fields);
                    await call('put', { key, fields });
                }

                await call('flush');
                await call('compact');
                await call('rotate');

                const verifyA = await call('verify');
                expect(verifyA.valid).toBe(true);
                expect(Array.isArray(verifyA.details)).toBe(true);

                await daemonA.stop();

                // Restart: validate durability / reconstruction after realistic pressure.
                const socketPathB = makeSocketPath(`soak-b-${walType}`);
                const daemonB = new GICSDaemon({
                    socketPath: socketPathB,
                    dataPath,
                    tokenPath,
                    walType,
                    maxDirtyCount: 25,
                    warmRetentionMs: 0,
                    coldRetentionMs: 365 * 24 * 60 * 60 * 1000,
                    coldEncryption: false,
                });

                await daemonB.start();

                let restartId = 10_000;
                const callAfterRestart = async (method: string, params?: Record<string, unknown>) => {
                    const response = await rpcCall(socketPathB, {
                        method,
                        params,
                        id: restartId++,
                        token,
                    });
                    expect(response.error).toBeUndefined();
                    return response.result;
                };

                for (const [key, fields] of expected.entries()) {
                    const record = await callAfterRestart('get', { key });
                    expect(record).not.toBeNull();
                    // Hard invariant: expected fields must survive exactly after restart.
                    // If extra fields appear here, it likely indicates field-merge leakage.
                    expect(record.fields).toEqual(fields);
                    expect(['warm', 'cold', 'hot']).toContain(record.tier);
                }

                const verifyB = await callAfterRestart('verify');
                expect(verifyB.valid).toBe(true);

                const pingB = await callAfterRestart('ping');
                expect(pingB.status).toBe('ok');
                expect(typeof pingB.tiers?.warmSegments).toBe('number');
                expect(typeof pingB.tiers?.coldSegments).toBe('number');

                await daemonB.stop();
            });
        },
        120_000
    );
});
