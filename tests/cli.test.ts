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

const execFileAsync = promisify(execFile);

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gics-cli-test-'));
    try {
        await run(dir);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
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
});
