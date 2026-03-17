import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Snapshot } from '../src/gics-types.js';
import { GICSv2Decoder } from '../src/gics/decode.js';
import { GICSv2Encoder } from '../src/gics/encode.js';

function createSnapshot(index: number, itemCount: number): Snapshot {
    const items = new Map<number, { price: number; quantity: number }>();
    for (let itemId = 1; itemId <= itemCount; itemId++) {
        items.set(itemId, {
            price: 10_000 + itemId + (index % 41),
            quantity: 1 + (itemId % 11),
        });
    }
    return {
        timestamp: 1_700_000_000_000 + index,
        items,
    };
}

describe('GICS streaming flush behavior', () => {
    it('keeps in-memory flush backward compatible by returning full flush bytes', async () => {
        const encoder = new GICSv2Encoder({ segmentSizeLimit: 220 });

        for (let i = 0; i < 12; i++) {
            await encoder.addSnapshot(createSnapshot(i, 4));
        }
        const firstFlush = await encoder.flush();
        expect(firstFlush.length).toBeGreaterThan(0);

        for (let i = 12; i < 20; i++) {
            await encoder.addSnapshot(createSnapshot(i, 4));
        }
        const secondFlush = await encoder.flush();
        expect(secondFlush.length).toBeGreaterThan(0);

        const sealed = await encoder.seal();
        expect(sealed.subarray(0, firstFlush.length)).toEqual(firstFlush);
        expect(sealed.subarray(firstFlush.length, firstFlush.length + secondFlush.length)).toEqual(secondFlush);
        expect(sealed.length).toBeGreaterThan(firstFlush.length + secondFlush.length);

        const decoded = await new GICSv2Decoder(sealed).getAllSnapshots();
        expect(decoded.length).toBe(20);
    });

    it('autoFlushThreshold triggers an internal flush once the threshold is reached', async () => {
        const encoder = new GICSv2Encoder({
            autoFlushThreshold: 3,
            segmentSizeLimit: 200,
        });

        await encoder.addSnapshot(createSnapshot(0, 3));
        await encoder.addSnapshot(createSnapshot(1, 3));
        expect(encoder.getTelemetry()).toBeNull();

        await encoder.addSnapshot(createSnapshot(2, 3));
        expect(encoder.getTelemetry()).not.toBeNull();

        for (let i = 3; i < 7; i++) {
            await encoder.addSnapshot(createSnapshot(i, 3));
        }

        const data = await encoder.seal();
        const decoded = await new GICSv2Decoder(data).getAllSnapshots();
        expect(decoded.length).toBe(7);
    });

    it('streams file-mode flushes directly to disk without aggregating all segment bytes', async () => {
        const tempPath = join(tmpdir(), `gics-streaming-flush-${Date.now()}.gics`);
        let handle: fs.FileHandle | null = null;

        try {
            handle = await fs.open(tempPath, 'w+');
            const encoder = await GICSv2Encoder.openFile(handle, {
                segmentSizeLimit: 300,
                maxSnapshotsPerSegment: 32,
                autoFlushThreshold: 0,
            });

            for (let i = 0; i < 150; i++) {
                await encoder.addSnapshot(createSnapshot(i, 6));
            }
            const firstFlush = await encoder.flush();
            const firstStat = await handle.stat();
            expect(firstFlush.length).toBeGreaterThan(0);
            expect(firstStat.size).toBeGreaterThan(firstFlush.length);

            for (let i = 150; i < 300; i++) {
                await encoder.addSnapshot(createSnapshot(i, 6));
            }
            const secondFlush = await encoder.flush();
            const secondStat = await handle.stat();
            expect(secondStat.size).toBeGreaterThan(firstStat.size);
            expect(secondStat.size - firstStat.size).toBeGreaterThanOrEqual(secondFlush.length);

            await encoder.sealToFile();
            await handle.close();
            handle = null;

            const encoded = await fs.readFile(tempPath);
            const decoded = await new GICSv2Decoder(encoded).getAllSnapshots();
            expect(decoded.length).toBe(300);
        } finally {
            if (handle) await handle.close();
            await fs.unlink(tempPath).catch(() => {});
        }
    });

    it('keeps peak heap growth below 100MB for 10K+ snapshots in streaming file mode', async () => {
        const tempPath = join(tmpdir(), `gics-streaming-heap-${Date.now()}.gics`);
        let handle: fs.FileHandle | null = null;

        try {
            handle = await fs.open(tempPath, 'w+');
            const encoder = await GICSv2Encoder.openFile(handle, {
                autoFlushThreshold: 256,
                maxSnapshotsPerSegment: 256,
                maxItemsPerSegment: 256 * 32,
            });

            const gc = (globalThis as { gc?: () => void }).gc;
            if (gc) gc();

            const baselineHeap = process.memoryUsage().heapUsed;
            let peakHeap = baselineHeap;

            for (let i = 0; i < 10_240; i++) {
                await encoder.addSnapshot(createSnapshot(i, 32));
                if (i % 128 === 0) {
                    if (gc) gc();
                    peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
                }
            }

            await encoder.sealToFile();
            peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
            const peakGrowth = peakHeap - baselineHeap;
            expect(peakHeap).toBeLessThan(100 * 1024 * 1024);
            expect(peakGrowth).toBeLessThan(100 * 1024 * 1024);

            const encoded = await fs.readFile(tempPath);
            const verifyOnly = await new GICSv2Decoder(encoded).verifyIntegrityOnly();
            expect(verifyOnly).toBe(true);
        } finally {
            if (handle) await handle.close();
            await fs.unlink(tempPath).catch(() => {});
        }
    }, 180_000);
});
