/**
 * CLI Tool Tests (Phase 10)
 *
 * Verifies:
 * - encode + decode roundtrip
 * - verify valid file
 * - info displays file metadata
 * - error exit codes (1 for errors, 2 for usage)
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GICSDaemon } from '../src/daemon/server.js';

const execFileAsync = promisify(execFile);

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gics-cli-test-'));
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

describe('CLI Tool (Phase 10)', () => {
    const cliPath = path.resolve('dist/src/cli/index.js');

    it('encode + decode roundtrip preserves data', async () => {
        await withTempDir(async (dir) => {
            const inputPath = path.join(dir, 'input.json');
            const encodedPath = path.join(dir, 'output.gics');
            const decodedPath = path.join(dir, 'output.decoded.json');

            const testData = {
                schema: {
                    id: 'test_schema',
                    version: 1,
                    itemIdType: 'string' as const,
                    fields: [{ name: 'value', type: 'numeric' as const, codecStrategy: 'value' as const }],
                },
                snapshots: [
                    { timestamp: 1000, items: new Map([['item1', { value: 100 }]]) },
                    { timestamp: 2000, items: new Map([['item1', { value: 200 }]]) },
                ],
            };

            // Convert Map to plain object for JSON serialization
            const jsonData = {
                ...testData,
                snapshots: testData.snapshots.map(s => ({
                    timestamp: s.timestamp,
                    items: Object.fromEntries(s.items),
                })),
            };

            await fs.writeFile(inputPath, JSON.stringify(jsonData));

            // Encode
            const { stdout: encodeOut } = await execFileAsync('node', [cliPath, 'encode', inputPath, '-o', encodedPath]);
            expect(encodeOut).toContain('Encoded');

            // Decode
            const { stdout: decodeOut } = await execFileAsync('node', [cliPath, 'decode', encodedPath, '-o', decodedPath]);
            expect(decodeOut).toContain('Decoded');

            // Verify roundtrip
            const decoded = JSON.parse(await fs.readFile(decodedPath, 'utf8'));
            expect(decoded.schema.id).toBe('test_schema');
            expect(decoded.snapshots.length).toBe(2);
        });
    });

    it('verify returns 0 for valid file', async () => {
        await withTempDir(async (dir) => {
            const inputPath = path.join(dir, 'input.json');
            const encodedPath = path.join(dir, 'output.gics');

            const testData = {
                schema: {
                    id: 'valid_test',
                    version: 1,
                    itemIdType: 'string' as const,
                    fields: [{ name: 'value', type: 'numeric' as const, codecStrategy: 'value' as const }],
                },
                snapshots: [
                    { timestamp: 1000, items: { item1: { value: 42 } } },
                ],
            };

            await fs.writeFile(inputPath, JSON.stringify(testData));
            await execFileAsync('node', [cliPath, 'encode', inputPath, '-o', encodedPath]);

            const { stdout } = await execFileAsync('node', [cliPath, 'verify', encodedPath]);
            expect(stdout).toContain('Integrity valid');
        });
    });

    it('info displays file metadata', async () => {
        await withTempDir(async (dir) => {
            const inputPath = path.join(dir, 'input.json');
            const encodedPath = path.join(dir, 'output.gics');

            const testData = {
                schema: {
                    id: 'info_test',
                    version: 1,
                    itemIdType: 'string' as const,
                    fields: [{ name: 'value', type: 'numeric' as const, codecStrategy: 'value' as const }],
                },
                snapshots: [
                    { timestamp: 1000, items: { item1: { value: 100 } } },
                    { timestamp: 2000, items: { item2: { value: 200 } } },
                ],
            };

            await fs.writeFile(inputPath, JSON.stringify(testData));
            await execFileAsync('node', [cliPath, 'encode', inputPath, '-o', encodedPath]);

            const { stdout } = await execFileAsync('node', [cliPath, 'info', encodedPath]);
            expect(stdout).toContain('info_test');
            expect(stdout).toMatch(/Snapshots\s*│\s*2/);
        });
    });

    it('returns exit code 1 on invalid file', async () => {
        await withTempDir(async (dir) => {
            const invalidPath = path.join(dir, 'invalid.gics');
            await fs.writeFile(invalidPath, 'not a valid gics file');

            try {
                await execFileAsync('node', [cliPath, 'verify', invalidPath]);
                throw new Error('Expected command to fail');
            } catch (err: any) {
                expect(err.code).toBe(1);
            }
        });
    });

    it('returns exit code 2 for usage errors', async () => {
        try {
            await execFileAsync('node', [cliPath, 'encode']); // Missing required argument
            throw new Error('Expected command to fail with usage error');
        } catch (err: any) {
            expect(err.code).toBe(2);
        }
    });

    it('info supports machine-readable JSON output', async () => {
        await withTempDir(async (dir) => {
            const inputPath = path.join(dir, 'input.json');
            const encodedPath = path.join(dir, 'output.gics');

            const testData = {
                schema: {
                    id: 'info_json_test',
                    version: 1,
                    itemIdType: 'string' as const,
                    fields: [{ name: 'value', type: 'numeric' as const, codecStrategy: 'value' as const }],
                },
                snapshots: [
                    { timestamp: 1000, items: { item1: { value: 100 } } },
                ],
            };

            await fs.writeFile(inputPath, JSON.stringify(testData));
            await execFileAsync('node', [cliPath, 'encode', inputPath, '-o', encodedPath]);

            const { stdout } = await execFileAsync('node', [cliPath, 'info', encodedPath, '--json']);
            const parsed = JSON.parse(stdout);
            expect(parsed.schema.id).toBe('info_json_test');
            expect(parsed.snapshots).toBe(1);
            expect(parsed.totalItems).toBe(1);
        });
    });

    it('module enable/disable persists daemon module config', async () => {
        await withTempDir(async (dir) => {
            const configPath = path.join(dir, 'gics.config.json');

            const enable = await execFileAsync('node', [cliPath, 'module', 'enable', 'inference-engine', '--config', configPath]);
            expect(enable.stdout).toContain('inference-engine: enabled');

            const status = await execFileAsync('node', [cliPath, 'module', 'status', '--config', configPath]);
            expect(status.stdout).toContain('inference-engine');
            expect(status.stdout).toContain('enabled');

            const disable = await execFileAsync('node', [cliPath, 'module', 'disable', 'inference-engine', '--config', configPath]);
            expect(disable.stdout).toContain('inference-engine: disabled');

            const raw = JSON.parse(await fs.readFile(configPath, 'utf8'));
            expect(raw.modules['inference-engine'].enabled).toBe(false);
        });
    });

    it('rpc emits machine-readable JSON for daemon automation', async () => {
        await withTempDir(async (dir) => {
            const dataPath = path.join(dir, 'data');
            const tokenPath = path.join(dir, 'gics.token');
            const socketPath = makeSocketPath('gics-cli-rpc');
            const daemon = new GICSDaemon({ socketPath, dataPath, tokenPath, walType: 'binary' });

            await daemon.start();
            try {
                const put = await execFileAsync('node', [
                    cliPath,
                    'rpc',
                    'put',
                    '--socket-path', socketPath,
                    '--token-path', tokenPath,
                    '--params-json', JSON.stringify({ key: 'script:item:1', fields: { value: 42, tag: 'ok' } }),
                ]);
                expect(JSON.parse(put.stdout).ok).toBe(true);

                const scan = await execFileAsync('node', [
                    cliPath,
                    'rpc',
                    'scan',
                    '--socket-path', socketPath,
                    '--token-path', tokenPath,
                    '--params-json', JSON.stringify({ prefix: 'script:' }),
                    '--pretty',
                ]);
                const parsed = JSON.parse(scan.stdout);
                expect(parsed.items).toHaveLength(1);
                expect(parsed.items[0].key).toBe('script:item:1');
                expect(parsed.items[0].fields).toEqual({ value: 42, tag: 'ok' });
            } finally {
                await daemon.stop();
            }
        });
    });

    it('rpc surfaces daemon errors as JSON for scripts', async () => {
        await withTempDir(async (dir) => {
            const dataPath = path.join(dir, 'data');
            const tokenPath = path.join(dir, 'gics.token');
            const socketPath = makeSocketPath('gics-cli-rpc-error');
            const daemon = new GICSDaemon({ socketPath, dataPath, tokenPath, walType: 'binary' });

            await daemon.start();
            try {
                await expect(execFileAsync('node', [
                    cliPath,
                    'rpc',
                    'missingMethod',
                    '--socket-path', socketPath,
                    '--token-path', tokenPath,
                ])).rejects.toMatchObject({ code: 1 });

                try {
                    await execFileAsync('node', [
                        cliPath,
                        'rpc',
                        'missingMethod',
                        '--socket-path', socketPath,
                        '--token-path', tokenPath,
                    ]);
                } catch (err: any) {
                    const parsed = JSON.parse(err.stdout);
                    expect(parsed.error.message).toBe('Method not found');
                }
            } finally {
                await daemon.stop();
            }
        });
    });

    it('inference commands expose machine-readable decisions and runtime health', async () => {
        await withTempDir(async (dir) => {
            const dataPath = path.join(dir, 'data');
            const tokenPath = path.join(dir, 'gics.token');
            const socketPath = makeSocketPath('gics-cli-inference');
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
            try {
                const infer = await execFileAsync('node', [
                    cliPath,
                    'inference',
                    'infer',
                    '--socket-path', socketPath,
                    '--token-path', tokenPath,
                    '--domain', 'ops.provider_select',
                    '--subject', 'gimo',
                    '--context-json', JSON.stringify({ scope: 'host:default' }),
                    '--candidates-json', JSON.stringify([
                        { id: 'haiku', latencyMs: 90, cost: 0.2 },
                        { id: 'sonnet', latencyMs: 110, cost: 0.3 },
                    ]),
                    '--json',
                ]);
                const decision = JSON.parse(infer.stdout);
                expect(decision.domain).toBe('ops.provider_select');
                expect(Array.isArray(decision.ranking)).toBe(true);

                const health = await execFileAsync('node', [
                    cliPath,
                    'inference',
                    'health',
                    '--socket-path', socketPath,
                    '--token-path', tokenPath,
                    '--json',
                ]);
                const runtime = JSON.parse(health.stdout);
                expect(runtime.enabled).toBe(true);
                expect(runtime.defaultScope).toBe('host:default');

                const flush = await execFileAsync('node', [
                    cliPath,
                    'inference',
                    'flush',
                    '--socket-path', socketPath,
                    '--token-path', tokenPath,
                    '--json',
                ]);
                expect(JSON.parse(flush.stdout).ok).toBe(true);
            } finally {
                await daemon.stop();
            }
        });
    });
});
