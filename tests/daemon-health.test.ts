/**
 * Health Endpoint Tests (Phase 13)
 *
 * Verifies:
 * - getHealth returns comprehensive metrics
 * - Response time < 100ms
 * - All metric fields present and valid
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { GICSDaemon, type GICSDaemonConfig } from '../src/daemon/server.js';
import * as net from 'net';

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gics-health-test-'));
    try {
        await run(dir);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
}

async function sendRequest(socketPath: string, request: any): Promise<any> {
    return new Promise((resolve, reject) => {
        const client = net.connect(socketPath, () => {
            client.write(JSON.stringify(request) + '\n');
        });

        let buffer = '';
        client.on('data', (data) => {
            buffer += data.toString();
            const lines = buffer.split('\n');
            if (lines.length > 1) {
                const response = JSON.parse(lines[0]);
                client.end();
                resolve(response);
            }
        });

        client.on('error', reject);
    });
}

describe('Health Endpoint (Phase 13)', () => {
    it('getHealth returns comprehensive metrics in <100ms', async () => {
        await withTempDir(async (dir) => {
            const socketPath = process.platform === 'win32'
                ? `\\\\.\\pipe\\gics-health-test-${Date.now()}`
                : path.join(dir, 'gics.sock');

            const config: GICSDaemonConfig = {
                socketPath,
                dataPath: dir,
                tokenPath: path.join(dir, 'token.txt'),
                walType: 'binary',
            };

            const daemon = new GICSDaemon(config);
            await daemon.start();

            const token = (await fs.readFile(config.tokenPath, 'utf8')).trim();

            // Write some data to populate metrics
            for (let i = 0; i < 10; i++) {
                await sendRequest(socketPath, {
                    jsonrpc: '2.0',
                    method: 'put',
                    params: { key: `item_${i}`, fields: { value: i } },
                    token,
                    id: i,
                });
            }

            // Call getHealth
            const start = Date.now();
            const healthRes = await sendRequest(socketPath, {
                jsonrpc: '2.0',
                method: 'getHealth',
                params: {},
                token,
                id: 'health',
            });
            const elapsed = Date.now() - start;

            // Verify response time
            expect(elapsed).toBeLessThan(100);

            // Verify result structure
            const health = healthRes.result;
            expect(health.status).toBe('ok');
            expect(health.timestamp).toBeGreaterThan(0);
            expect(health.uptime).toBeGreaterThan(0);
            expect(health.responseTimeMs).toBeLessThan(100);

            // Verify memTable metrics
            expect(health.memTable).toBeDefined();
            expect(health.memTable.count).toBeGreaterThan(0);
            expect(health.memTable.sizeBytes).toBeGreaterThan(0);
            expect(health.memTable.dirtyCount).toBeGreaterThanOrEqual(0);

            // Verify WAL metrics
            expect(health.wal).toBeDefined();
            expect(health.wal.type).toBe('binary');
            expect(health.wal.fsyncMode).toBeDefined();

            // Verify insights metrics
            expect(health.insights).toBeDefined();
            expect(health.insights.tracked).toBeGreaterThan(0);
            expect(typeof health.insights.recommendations).toBe('number');

            // Verify tiers metrics
            expect(health.tiers).toBeDefined();
            expect(typeof health.tiers.warmKeys).toBe('number');
            expect(typeof health.tiers.coldKeys).toBe('number');

            // Verify supervisor metrics
            expect(health.supervisor).toBeDefined();
            expect(health.supervisor.state).toBeDefined();

            // Verify audit chain metrics
            expect(health.auditChain).toBeDefined();
            expect(typeof health.auditChain.valid).toBe('boolean');
            expect(typeof health.auditChain.entries).toBe('number');

            await daemon.stop();
        });
    }, 15000);

    it('getHealth with PromptDistiller enabled includes distiller metrics', async () => {
        await withTempDir(async (dir) => {
            const socketPath = process.platform === 'win32'
                ? `\\\\.\\pipe\\gics-health-distiller-${Date.now()}`
                : path.join(dir, 'gics.sock');

            // Enable distiller
            process.env.GICS_DISTILLER_ENABLED = 'true';

            const config: GICSDaemonConfig = {
                socketPath,
                dataPath: dir,
                tokenPath: path.join(dir, 'token.txt'),
                walType: 'binary',
            };

            const daemon = new GICSDaemon(config);
            await daemon.start();

            const token = (await fs.readFile(config.tokenPath, 'utf8')).trim();

            const healthRes = await sendRequest(socketPath, {
                jsonrpc: '2.0',
                method: 'getHealth',
                params: {},
                token,
                id: 'health_distiller',
            });

            const health = healthRes.result;

            // Verify distiller metrics present
            expect(health.distiller).toBeDefined();
            expect(Array.isArray(health.distiller.tiers) || health.distiller.error).toBeTruthy();

            await daemon.stop();
            delete process.env.GICS_DISTILLER_ENABLED;
        });
    }, 15000);

    it('getHealth works even with minimal data', async () => {
        await withTempDir(async (dir) => {
            const socketPath = process.platform === 'win32'
                ? `\\\\.\\pipe\\gics-health-minimal-${Date.now()}`
                : path.join(dir, 'gics.sock');

            const config: GICSDaemonConfig = {
                socketPath,
                dataPath: dir,
                tokenPath: path.join(dir, 'token.txt'),
                walType: 'jsonl',
            };

            const daemon = new GICSDaemon(config);
            await daemon.start();

            const token = (await fs.readFile(config.tokenPath, 'utf8')).trim();

            // Call getHealth immediately without any data
            const healthRes = await sendRequest(socketPath, {
                jsonrpc: '2.0',
                method: 'getHealth',
                params: {},
                token,
                id: 'health_minimal',
            });

            const health = healthRes.result;

            // Should still return valid structure
            expect(health.status).toBe('ok');
            expect(health.memTable.count).toBe(0);
            expect(health.insights.tracked).toBe(0);
            expect(health.responseTimeMs).toBeLessThan(100);

            await daemon.stop();
        });
    }, 15000);
});
