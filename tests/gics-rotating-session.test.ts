import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Snapshot } from '../src/gics-types.js';
import { GICS } from '../src/index.js';

function createSnapshot(index: number, itemCount: number): Snapshot {
    const items = new Map<number, { price: number; quantity: number }>();
    for (let itemId = 1; itemId <= itemCount; itemId++) {
        items.set(itemId, {
            price: 50_000 + itemId + (index % 37),
            quantity: 1 + (itemId % 9),
        });
    }
    return {
        timestamp: 1_700_500_000_000 + index,
        items,
    };
}

describe('GICS rotating sessions', () => {
    it('rotates files deterministically, keeps continuity, and reads the full session', async () => {
        const sessionDir = await fs.mkdtemp(join(tmpdir(), 'gics-rotator-basic-'));
        try {
            const rotator = await GICS.RotatingEncoder.create({
                sessionDir,
                sessionId: 'session-basic',
                flushEverySnapshots: 2,
                maxSnapshotsPerFile: 5,
                maxSegmentsPerFile: 4096,
                maxFileBytes: 64 * 1024 * 1024,
                maxFileDurationMs: 24 * 60 * 60 * 1000,
                encoderOptions: { segmentSizeLimit: 220 },
            });

            for (let i = 0; i < 13; i++) {
                await rotator.addSnapshot(createSnapshot(i, 5));
            }
            const sealedManifest = await rotator.seal();

            expect(sealedManifest.files.length).toBeGreaterThanOrEqual(3);
            expect(sealedManifest.files[0].path).toBe('session-basic.part-000001.gics');
            for (let i = 1; i < sealedManifest.files.length; i++) {
                expect(sealedManifest.files[i].startSeedHash).toBe(sealedManifest.files[i - 1].endRootHash);
            }

            const manifestPath = rotator.getManifestPath();
            const verifyOk = await GICS.verifySession(manifestPath);
            expect(verifyOk).toBe(true);

            const decoded = await GICS.readSession(manifestPath);
            expect(decoded.length).toBe(13);
            expect(decoded[0].timestamp).toBe(1_700_500_000_000);
            expect(decoded[decoded.length - 1].timestamp).toBe(1_700_500_000_012);
        } finally {
            await fs.rm(sessionDir, { recursive: true, force: true });
        }
    });

    it('supports adaptive rotation triggers without breaking verification', async () => {
        const sessionDir = await fs.mkdtemp(join(tmpdir(), 'gics-rotator-adaptive-'));
        try {
            const rotator = await GICS.RotatingEncoder.create({
                sessionDir,
                sessionId: 'session-adaptive',
                flushEverySnapshots: 1,
                maxSnapshotsPerFile: 1000,
                maxSegmentsPerFile: 4096,
                maxFileBytes: 512 * 1024 * 1024,
                maxFileDurationMs: 24 * 60 * 60 * 1000,
                adaptive: {
                    enabled: true,
                    heapHighWaterMB: 0.001,
                    consecutiveBreachesToRotate: 1,
                    cooldownFlushes: 0,
                    ratioDropPct: 100,
                    latencyPerSnapshotUsBudget: 1_000_000,
                },
                encoderOptions: { segmentSizeLimit: 180 },
            });

            for (let i = 0; i < 6; i++) {
                await rotator.addSnapshot(createSnapshot(i, 4));
            }
            const manifest = await rotator.seal();

            expect(manifest.files.length).toBeGreaterThan(1);
            expect(manifest.files.some((entry) => entry.rotationReason.startsWith('adaptive:'))).toBe(true);
            expect(await GICS.verifySession(rotator.getManifestPath())).toBe(true);
        } finally {
            await fs.rm(sessionDir, { recursive: true, force: true });
        }
    });

    it('resumes sessions and marks invalid tail files as orphaned', async () => {
        const sessionDir = await fs.mkdtemp(join(tmpdir(), 'gics-rotator-resume-'));
        const manifestPath = resolve(sessionDir, 'session-resume.manifest.json');
        try {
            const first = await GICS.RotatingEncoder.create({
                sessionDir,
                sessionId: 'session-resume',
                manifestPath,
                flushEverySnapshots: 2,
                maxSnapshotsPerFile: 4,
                maxSegmentsPerFile: 4096,
                maxFileBytes: 512 * 1024 * 1024,
                maxFileDurationMs: 24 * 60 * 60 * 1000,
                encoderOptions: { segmentSizeLimit: 220 },
            });
            for (let i = 0; i < 10; i++) {
                await first.addSnapshot(createSnapshot(i, 6));
            }
            await first.seal();

            const before = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as {
                files: Array<{ path: string }>;
            };
            const tailRelativePath = before.files[before.files.length - 1].path;
            const tailAbsolutePath = resolve(sessionDir, tailRelativePath);
            const tailBytes = await fs.readFile(tailAbsolutePath);
            await fs.writeFile(tailAbsolutePath, tailBytes.subarray(0, Math.max(1, tailBytes.length - 5)));

            const resumed = await GICS.RotatingEncoder.resumeSession(manifestPath, {
                flushEverySnapshots: 2,
                maxSnapshotsPerFile: 4,
                encoderOptions: { segmentSizeLimit: 220 },
            });
            for (let i = 10; i < 14; i++) {
                await resumed.addSnapshot(createSnapshot(i, 6));
            }
            const resumedManifest = await resumed.seal();

            expect(resumedManifest.files.some((entry) => entry.orphaned)).toBe(true);
            expect(await GICS.verifySession(manifestPath)).toBe(true);

            const decoded = await GICS.readSession(manifestPath);
            const expectedSnapshots = resumedManifest.files
                .filter((entry) => !entry.orphaned)
                .reduce((sum, entry) => sum + entry.snapshots, 0);
            expect(decoded.length).toBe(expectedSnapshots);
        } finally {
            await fs.rm(sessionDir, { recursive: true, force: true });
        }
    });
});
