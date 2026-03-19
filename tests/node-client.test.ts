import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { GICSDaemon } from '../src/daemon/server.js';
import { GICSNodeClient, verifyGICSFile } from '../src/clients/node.js';
import { GICSv2Encoder } from '../src/gics/encode.js';

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gics-node-client-'));
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

describe('Official Node SDK', () => {
    it('supports putMany and prefix summaries through the typed client', async () => {
        await withTempDir(async (dir) => {
            const socketPath = makeSocketPath('gics-node-sdk');
            const tokenPath = path.join(dir, 'gics.token');
            const daemon = new GICSDaemon({
                socketPath,
                dataPath: path.join(dir, 'data'),
                tokenPath,
                walType: 'binary',
            });

            await daemon.start();
            try {
                const client = new GICSNodeClient({ socketPath, tokenPath });
                const putMany = await client.putMany([
                    { key: 'sdk:1', fields: { value: 1 } },
                    { key: 'sdk:2', fields: { value: 2 } },
                ], { atomic: true, idempotencyKey: 'sdk-batch', verify: true });

                expect(putMany.ok).toBe(true);

                const count = await client.countPrefix('sdk:');
                expect(count.count).toBe(2);

                const summary = await client.scanSummary('sdk:');
                expect(summary.count).toBe(2);
                expect(summary.tiers.hot).toBe(2);

                const latest = await client.latestByPrefix('sdk:');
                expect(latest?.key).toBe('sdk:2');

                const ping = await client.ping();
                expect(ping.version).toBe('1.3.4');

                const pingVerbose = await client.pingVerbose();
                expect(pingVerbose.walType).toBe('binary');
            } finally {
                await daemon.stop();
            }
        });
    });

    it('upgrades idempotent putMany calls to atomic durability when requested otherwise', async () => {
        await withTempDir(async (dir) => {
            const socketPath = makeSocketPath('gics-node-sdk-idempotent');
            const tokenPath = path.join(dir, 'gics.token');
            const daemon = new GICSDaemon({
                socketPath,
                dataPath: path.join(dir, 'data'),
                tokenPath,
                walType: 'binary',
            });

            await daemon.start();
            try {
                const client = new GICSNodeClient({ socketPath, tokenPath });
                const first = await client.putMany([
                    { key: 'sdk:idem:1', fields: { value: 1 } },
                    { key: 'sdk:idem:2', fields: { value: 2 } },
                ], { atomic: false, idempotencyKey: 'sdk-idem', verify: true });

                expect(first.ok).toBe(true);
                expect(first.atomic).toBe(true);

                const repeated = await client.putMany([
                    { key: 'sdk:idem:1', fields: { value: 1 } },
                    { key: 'sdk:idem:2', fields: { value: 2 } },
                ], { atomic: false, idempotencyKey: 'sdk-idem', verify: true });

                expect(repeated.deduplicated).toBe(true);
                expect(repeated.atomic).toBe(true);
            } finally {
                await daemon.stop();
            }
        });
    });

    it('verifies standalone GICS files without the daemon', async () => {
        await withTempDir(async (dir) => {
            const outputPath = path.join(dir, 'sample.gics');
            const encoder = new GICSv2Encoder({
                schema: {
                    id: 'node_sdk_verify',
                    version: 1,
                    itemIdType: 'string',
                    fields: [{ name: 'value', type: 'numeric', codecStrategy: 'value' }],
                },
            });
            await encoder.addSnapshot({
                timestamp: 1,
                items: new Map([['item:1', { value: 42 }]]),
            });
            await fs.writeFile(outputPath, await encoder.finish());

            await expect(verifyGICSFile(outputPath)).resolves.toBe(true);
        });
    });
});
