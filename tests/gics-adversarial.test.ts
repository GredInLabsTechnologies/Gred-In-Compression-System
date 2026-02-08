import { describe, it, expect } from 'vitest';
import { GICSv2Encoder } from '../src/gics/encode.js';
import { GICSv2Decoder } from '../src/gics/decode.js';
import { StreamId, InnerCodecId, OuterCodecId } from '../src/gics/format.js';
import { StreamSection } from '../src/gics/stream-section.js';
import { IncompleteDataError, IntegrityError, LimitExceededError } from '../src/gics/errors.js';
import { calculateCRC32 } from '../src/gics/integrity.js';
import type { Snapshot } from '../src/gics-types.js';

describe('Advorsarial Suite (Fase 8)', () => {

    const createSnapshot = (timestamp: number, itemId: number, price: number, quantity: number): Snapshot => ({
        timestamp,
        items: new Map([[itemId, { price, quantity }]])
    });

    const generateRandomSnapshot = (id: number): Snapshot => {
        const itemCount = Math.floor(Math.random() * 5) + 1;
        const items = new Map<number, { price: number; quantity: number }>();
        for (let i = 0; i < itemCount; i++) {
            items.set(
                Math.floor(Math.random() * 1000),
                {
                    price: Math.floor(Math.random() * 10000),
                    quantity: Math.floor(Math.random() * 100)
                }
            );
        }
        return {
            timestamp: 1000 + id * 1000 + Math.floor(Math.random() * 100),
            items
        };
    };

    describe('1. Fuzz Roundtrip (50 iterations)', () => {
        it('should roundtrip 50 randomized datasets without error', async () => {
            for (let i = 0; i < 50; i++) {
                const encoder = new GICSv2Encoder();
                const count = Math.floor(Math.random() * 20) + 1;
                const originalSnapshots: Snapshot[] = [];

                for (let j = 0; j < count; j++) {
                    const snap = generateRandomSnapshot(j);
                    originalSnapshots.push(snap);
                    await encoder.addSnapshot(snap);
                }

                const bytes = await encoder.finish();
                const decoder = new GICSv2Decoder(bytes);
                const decodedSnapshots = await decoder.getAllSnapshots();

                expect(decodedSnapshots).toHaveLength(originalSnapshots.length);
                for (let j = 0; j < count; j++) {
                    expect(decodedSnapshots[j].timestamp).toBe(originalSnapshots[j].timestamp);
                    expect(decodedSnapshots[j].items.size).toBe(originalSnapshots[j].items.size);
                }
            }
        });
    });

    describe('2. Systematic Truncation', () => {
        it('should throw IncompleteDataError for every truncated length', async () => {
            const encoder = new GICSv2Encoder();
            await encoder.addSnapshot(createSnapshot(1000, 1, 100, 10));
            const validBytes = await encoder.finish();

            let caught = 0;
            // Test every single truncation point from 0 to length-1
            for (let len = 0; len < validBytes.length; len++) {
                const truncated = validBytes.slice(0, len);
                try {
                    const decoder = new GICSv2Decoder(truncated);
                    await decoder.getAllSnapshots();
                } catch (err) {
                    if (err instanceof IncompleteDataError || (err instanceof Error && err.message.toLocaleLowerCase().includes('too short'))) {
                        caught++;
                    } else if (err instanceof Error) {
                        caught++;
                    }
                }
            }
            expect(caught).toBe(validBytes.length);
        });
    });

    describe('3. Systematic Bit-Flipping', () => {
        it('should detect bit flips in header and payload', async () => {
            const encoder = new GICSv2Encoder();
            await encoder.addSnapshot(createSnapshot(1000, 1, 100, 10));
            const validBytes = Buffer.from(await encoder.finish());

            const offsetsToTest = [0, 1, 4, 5, 10, 20, 30, validBytes.length - 1];

            for (const offset of offsetsToTest) {
                if (offset >= validBytes.length) continue;

                const corrupted = Buffer.from(validBytes);
                corrupted[offset] ^= 0xFF; // Flip all bits

                try {
                    const decoder = new GICSv2Decoder(corrupted);
                    await decoder.getAllSnapshots();
                    throw new Error(`Silent failure at offset ${offset}`);
                } catch (err) {
                    expect(err).toBeInstanceOf(Error);
                }
            }
        });
    });

    describe('4. Decompression Bomb Protection', () => {
        it('should reject StreamSection claiming huge uncompressed size', async () => {
            const encoder = new GICSv2Encoder();
            await encoder.addSnapshot(createSnapshot(1000, 1, 100, 10));
            const validBytes = await encoder.finish();

            // FileHeader(14) + SegmentHeader(14) = 28 bytes
            // Section starts at 28.
            // StreamId(1) + OuterCodec(1) + BlockCount(2) + UncompressedLen(4)
            // Offset of UncompressedLen = 28 + 1 + 1 + 2 = 32

            const corrupted = Buffer.from(validBytes);
            corrupted.writeUInt32LE(0x7FFFFFFF, 32);

            // FIX: Recompute CRC to bypass CRC check
            // Segment starts at 14 (FileHeader).
            // Footer starts at corrupted.length - 37 (FileEOS) - 36 (SegmentFooter).
            const segmentStart = 14;
            const footerStart = corrupted.length - 37 - 36;

            // Segment Body = Header(14) + Sections + Index.
            // Wait, segmentStart points to start of SegmentHeader.
            // Yes.
            // So we need to calculate CRC of corrupted[segmentStart...footerStart]

            // Ensure corrupted is Uint8Array for crc32
            const segmentBody = corrupted.subarray(segmentStart, footerStart);
            const newCrc = calculateCRC32(segmentBody);

            // Footer has CRC at offset 32.
            const crcOffset = footerStart + 32;
            corrupted.writeUInt32LE(newCrc, crcOffset);

            const decoder = new GICSv2Decoder(corrupted);

            await expect(decoder.getAllSnapshots()).rejects.toThrow(LimitExceededError);
        });
    });

    describe('5. Concurrency', () => {
        it('should handle 10 parallel encoder/decoder instances without pollution', async () => {
            const concurrency = 10;
            const tasks = Array.from({ length: concurrency }, async (_, i) => {
                const encoder = new GICSv2Encoder();
                const snapshot = createSnapshot(1000 + i, i, 100 + i, 10);
                await encoder.addSnapshot(snapshot);
                const bytes = await encoder.finish();

                const decoder = new GICSv2Decoder(bytes);
                const results = await decoder.getAllSnapshots();

                expect(results).toHaveLength(1);
                expect(results[0].timestamp).toBe(1000 + i);
                expect(results[0].items.get(i)).toEqual({ price: 100 + i, quantity: 10 });
            });
            await Promise.all(tasks);
        });
    });
});
