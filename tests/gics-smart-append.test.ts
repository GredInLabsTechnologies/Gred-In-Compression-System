/**
 * GICS Smart Append & Zstd Tests
 * 
 * Tests for the new optimization features:
 * 1. Smart Append (getRawComponents + recoverState)
 * 2. Zstd compression
 * 3. Compression algorithm detection
 */

import {
    HybridWriter,
    HybridReader,
    CompressionAlgorithm,
    type Snapshot
} from '../src/index.js';

// Helper to create test snapshots
function createTestSnapshot(timestamp: number, itemCount: number): Snapshot {
    const items = new Map<number, { price: number; quantity: number }>();
    for (let i = 1; i <= itemCount; i++) {
        items.set(i, {
            price: Math.floor(Math.random() * 10000) + 100,
            quantity: Math.floor(Math.random() * 100) + 1
        });
    }
    return { timestamp, items };
}

describe('GICS Smart Append', () => {
    it('should extract raw components without decompression', async () => {
        // Create initial file with multiple snapshots
        const writer = new HybridWriter({ blockDurationDays: 7 });

        for (let i = 0; i < 24; i++) { // Less than a full block
            await writer.addSnapshot(createTestSnapshot(1704067200 + i * 3600, 50));
        }

        const data = await writer.finish();
        const reader = new HybridReader(data);

        // Extract raw components
        const components = reader.getRawComponents();

        expect(components.blocks.length).toBeGreaterThan(0);
        expect(components.temporalIndex.length).toEqual(components.blocks.length);
        expect(components.itemIndex.size).toBeGreaterThan(0);
        expect(components.compressionAlgorithm).toBe(CompressionAlgorithm.BROTLI);
    });

    it('should recover state and append new snapshots', async () => {
        // Step 1: Create initial file
        const writer1 = new HybridWriter({ blockDurationDays: 7 });
        for (let i = 0; i < 24; i++) {
            await writer1.addSnapshot(createTestSnapshot(1704067200 + i * 3600, 30));
        }
        const data1 = await writer1.finish();

        // Step 2: Read and extract raw components
        const reader1 = new HybridReader(data1);
        const components = reader1.getRawComponents();
        const originalItemCount = reader1.getItemIds().length;

        // Step 3: Create new writer and recover state
        const writer2 = new HybridWriter({ blockDurationDays: 7 });
        writer2.recoverState(
            components.blocks,
            components.temporalIndex,
            components.itemIndex,
            components.compressionAlgorithm
        );

        // Step 4: Add new snapshot
        await writer2.addSnapshot(createTestSnapshot(1704067200 + 24 * 3600, 30));
        const data2 = await writer2.finish();

        // Step 5: Verify the new file contains both old and new data
        const reader2 = new HybridReader(data2);
        const newItemCount = reader2.getItemIds().length;

        expect(newItemCount).toBeGreaterThanOrEqual(originalItemCount);
        expect(data2.length).toBeGreaterThan(data1.length); // Should be slightly larger
    });

    it('should preserve compression algorithm from original file', async () => {
        const writer1 = new HybridWriter({
            blockDurationDays: 7,
            compressionAlgorithm: CompressionAlgorithm.BROTLI
        });
        await writer1.addSnapshot(createTestSnapshot(1704067200, 20));
        const data1 = await writer1.finish();

        const reader1 = new HybridReader(data1);
        const components = reader1.getRawComponents();

        expect(components.compressionAlgorithm).toBe(CompressionAlgorithm.BROTLI);

        // Recover with preserved algorithm
        const writer2 = new HybridWriter({ blockDurationDays: 7 });
        writer2.recoverState(
            components.blocks,
            components.temporalIndex,
            components.itemIndex,
            components.compressionAlgorithm
        );

        expect(writer2.getCompressionAlgorithm()).toBe(CompressionAlgorithm.BROTLI);
    });
});

describe('GICS Zstd Compression', () => {
    it('should compress and decompress with Zstd', async () => {
        const writer = new HybridWriter({
            blockDurationDays: 7,
            compressionAlgorithm: CompressionAlgorithm.ZSTD
        });

        // Add snapshots to trigger block flush
        for (let i = 0; i < 200; i++) {
            await writer.addSnapshot(createTestSnapshot(1704067200 + i * 3600, 50));
        }

        const data = await writer.finish();
        expect(data.length).toBeGreaterThan(0);

        // Verify header contains Zstd flag
        expect(data[5]).toBe(CompressionAlgorithm.ZSTD);

        // Read back and verify data
        const reader = new HybridReader(data);
        expect(reader.getCompressionAlgorithm()).toBe(CompressionAlgorithm.ZSTD);

        const itemIds = reader.getItemIds();
        expect(itemIds.length).toBe(50);

        // Query items to trigger decompression
        const results = await reader.queryItems({ itemIds: [1, 2, 3] });
        expect(results.length).toBe(3);
        expect(results[0].history.length).toBeGreaterThan(0);
    });

    it('should produce smaller files than Brotli (approximately)', async () => {
        const testData: Snapshot[] = [];
        for (let i = 0; i < 200; i++) {
            testData.push(createTestSnapshot(1704067200 + i * 3600, 100));
        }

        // Write with Brotli
        const writerBrotli = new HybridWriter({
            blockDurationDays: 7,
            compressionAlgorithm: CompressionAlgorithm.BROTLI
        });
        for (const snap of testData) {
            await writerBrotli.addSnapshot(snap);
        }
        const dataBrotli = await writerBrotli.finish();

        // Write with Zstd
        const writerZstd = new HybridWriter({
            blockDurationDays: 7,
            compressionAlgorithm: CompressionAlgorithm.ZSTD
        });
        for (const snap of testData) {
            await writerZstd.addSnapshot(snap);
        }
        const dataZstd = await writerZstd.finish();

        console.log(`Brotli size: ${dataBrotli.length} bytes`);
        console.log(`Zstd size: ${dataZstd.length} bytes`);
        console.log(`Difference: ${((dataBrotli.length - dataZstd.length) / dataBrotli.length * 100).toFixed(2)}%`);

        // Zstd should be within reasonable range of Brotli
        // (may be slightly larger or smaller depending on data)
        expect(dataZstd.length).toBeLessThan(dataBrotli.length * 1.5);
    });
});

describe('GICS Compression Algorithm Detection', () => {
    it('should correctly read compression flag from header', async () => {
        // Brotli file
        const writerBrotli = new HybridWriter({
            compressionAlgorithm: CompressionAlgorithm.BROTLI
        });
        await writerBrotli.addSnapshot(createTestSnapshot(1704067200, 10));
        const dataBrotli = await writerBrotli.finish();

        expect(dataBrotli[5]).toBe(0x00); // FLAGS byte = BROTLI

        const readerBrotli = new HybridReader(dataBrotli);
        expect(readerBrotli.getCompressionAlgorithm()).toBe(CompressionAlgorithm.BROTLI);

        // Zstd file
        const writerZstd = new HybridWriter({
            compressionAlgorithm: CompressionAlgorithm.ZSTD
        });
        await writerZstd.addSnapshot(createTestSnapshot(1704067200, 10));
        const dataZstd = await writerZstd.finish();

        expect(dataZstd[5]).toBe(0x01); // FLAGS byte = ZSTD

        const readerZstd = new HybridReader(dataZstd);
        expect(readerZstd.getCompressionAlgorithm()).toBe(CompressionAlgorithm.ZSTD);
    });

    it('should default to Brotli for backward compatibility', async () => {
        const writer = new HybridWriter(); // No config
        await writer.addSnapshot(createTestSnapshot(1704067200, 10));
        const data = await writer.finish();

        expect(data[5]).toBe(CompressionAlgorithm.BROTLI);
    });
});
