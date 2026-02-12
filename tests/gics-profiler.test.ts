import { CompressionProfiler, type ProfileResult } from '../src/index.js';
import type { Snapshot } from '../src/gics-types.js';

function makeTrendSnapshots(count: number): Snapshot[] {
    const snapshots: Snapshot[] = [];
    const baseTime = 1700000000;
    for (let i = 0; i < count; i++) {
        const items = new Map<number, { price: number; quantity: number }>();
        items.set(1, { price: 10_000 + i * 3, quantity: 1 });
        snapshots.push({ timestamp: baseTime + i * 60, items });
    }
    return snapshots;
}

function makeVolatileSnapshots(count: number): Snapshot[] {
    const snapshots: Snapshot[] = [];
    const baseTime = 1700000000;
    for (let i = 0; i < count; i++) {
        const items = new Map<number, { price: number; quantity: number }>();
        items.set(1, { price: 20_000 + ((i * 17) % 101) - 50, quantity: 2 + (i % 3) });
        snapshots.push({ timestamp: baseTime + i * 60, items });
    }
    return snapshots;
}

function makeMultiItemSnapshots(count: number, itemCount: number): Snapshot[] {
    const snapshots: Snapshot[] = [];
    const baseTime = 1700000000;
    for (let i = 0; i < count; i++) {
        const items = new Map<number, { price: number; quantity: number }>();
        for (let j = 1; j <= itemCount; j++) {
            items.set(j, { price: 1000 * j + i * 10 + j, quantity: 50 + (i % 5 === 0 ? j : 0) });
        }
        snapshots.push({ timestamp: baseTime + i * 60, items });
    }
    return snapshots;
}

function assertValidResult(result: ProfileResult, mode: 'quick' | 'deep', sampleSize: number) {
    expect(result.compressionLevel).toBeGreaterThanOrEqual(1);
    expect(result.compressionLevel).toBeLessThanOrEqual(22);
    expect(result.blockSize).toBeGreaterThanOrEqual(128);
    expect(result.bestRatio).toBeGreaterThan(1);
    expect(result.bestEncodeMs).toBeGreaterThan(0);

    const expectedTrials = mode === 'quick' ? 6 : 30;
    expect(result.trials.length).toBe(expectedTrials);

    for (const t of result.trials) {
        expect(t.ratio).toBeGreaterThan(0);
        expect(t.outputBytes).toBeGreaterThan(0);
        expect(t.inputBytes).toBeGreaterThan(0);
        expect(t.encodeMs).toBeGreaterThan(0);
    }

    expect(result.meta.sampleSize).toBe(sampleSize);
    expect(result.meta.mode).toBe(mode);
    expect(result.meta.sampleHash).toMatch(/^[0-9a-f]{16}$/);
    expect(result.meta.encoderVersion).toBeTruthy();
    expect(result.meta.date).toBeTruthy();
}

describe('CompressionProfiler', () => {
    it('profiles trend data (quick mode)', async () => {
        const sample = makeTrendSnapshots(200);
        const result = await CompressionProfiler.profile(sample, 'quick');

        assertValidResult(result, 'quick', 200);
        // Trend data is highly compressible — ratio should exceed baseline
        expect(result.bestRatio).toBeGreaterThan(5);
    }, 30_000);

    it('profiles volatile data (quick mode)', async () => {
        const sample = makeVolatileSnapshots(200);
        const result = await CompressionProfiler.profile(sample, 'quick');

        assertValidResult(result, 'quick', 200);
        // Volatile data is less compressible but still positive ratio
        expect(result.bestRatio).toBeGreaterThan(1);
    }, 30_000);

    it('profiles multi-item data (quick mode)', async () => {
        const sample = makeMultiItemSnapshots(200, 10);
        const result = await CompressionProfiler.profile(sample, 'quick');

        assertValidResult(result, 'quick', 200);
        // Multi-item benefits from item-major layout, should compress well
        expect(result.bestRatio).toBeGreaterThan(5);
    }, 30_000);

    it('best trial has highest ratio among all trials', async () => {
        const sample = makeTrendSnapshots(100);
        const result = await CompressionProfiler.profile(sample, 'quick');

        const maxRatio = Math.max(...result.trials.map(t => t.ratio));
        // Best should be within rounding of the top ratio
        expect(result.bestRatio).toBeCloseTo(maxRatio, 1);
    }, 30_000);

    it('rejects empty sample', async () => {
        await expect(CompressionProfiler.profile([])).rejects.toThrow('sample must not be empty');
    });

    it('preset matching works when config aligns', async () => {
        const sample = makeTrendSnapshots(100);
        const result = await CompressionProfiler.profile(sample, 'quick');

        // If the best config matches a preset, it should be named
        if (result.compressionLevel === 3 && result.blockSize === 1000) {
            expect(result.preset).toBe('balanced');
        } else if (result.compressionLevel === 1 && result.blockSize === 1000) {
            // No preset at L1/B1000 — null is correct
            expect(result.preset).toBeNull();
        }
        // Otherwise, any value is valid
    }, 30_000);
});
