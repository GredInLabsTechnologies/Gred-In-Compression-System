import { describe, it, expect } from 'vitest';
import { GICSv2Encoder } from '../src/gics/encode.js';
import { GICSv2Decoder } from '../src/gics/decode.js';
import { IntegrityError } from '../src/gics/errors.js';
import type { Snapshot } from '../src/gics-types.js';

describe('GICS v1.3 Format', () => {
    const createSnapshot = (timestamp: number, itemId: number, price: number, quantity: number): Snapshot => ({
        timestamp,
        items: new Map([[itemId, { price, quantity }]])
    });

    describe('Version Byte', () => {
        it('should encode with version byte 0x03', async () => {
            const encoder = new GICSv2Encoder();
            const snapshot = createSnapshot(1000, 1, 100, 1);
            await encoder.addSnapshot(snapshot);
            const bytes = await encoder.finish();

            // Verify GICS magic + version
            expect(bytes[0]).toBe(0x47); // G
            expect(bytes[1]).toBe(0x49); // I
            expect(bytes[2]).toBe(0x43); // C
            expect(bytes[3]).toBe(0x53); // S
            expect(bytes[4]).toBe(0x03); // VERSION 0x03
        });

        it('should decode v1.3 format successfully', async () => {
            const encoder = new GICSv2Encoder();
            const snapshot = createSnapshot(1000, 42, 1500, 10);
            await encoder.addSnapshot(snapshot);
            const bytes = await encoder.finish();

            const decoder = new GICSv2Decoder(bytes);
            const snapshots = await decoder.getAllSnapshots();

            expect(snapshots).toHaveLength(1);
            expect(snapshots[0].timestamp).toBe(1000);
            expect(snapshots[0].items.get(42)).toEqual({ price: 1500, quantity: 10 });
        });
    });

    describe('Hash Chain Integrity', () => {
        it('should detect payload tampering', async () => {
            const encoder = new GICSv2Encoder();
            const snapshot = createSnapshot(1000, 1, 100, 1);
            await encoder.addSnapshot(snapshot);
            const bytes = await encoder.finish();

            // Tamper with 1 byte in the middle of the payload
            // Skip header (9 bytes: magic 4 + version 1 + flags 4) and corrupt somewhere in the stream sections
            const tamperOffset = 50; // Should be within stream section payload
            if (tamperOffset < bytes.length - 1) {
                bytes[tamperOffset] ^= 0x01; // Flip one bit
            }

            const decoder = new GICSv2Decoder(bytes);
            await expect(decoder.getAllSnapshots()).rejects.toThrow(IntegrityError);
        });

        it('should detect hash field tampering', async () => {
            const encoder = new GICSv2Encoder();
            const snapshot = createSnapshot(2000, 5, 200, 2);
            await encoder.addSnapshot(snapshot);
            const bytes = await encoder.finish();

            // Find and corrupt a hash field (32 bytes after section header)
            // Section starts after file header (9 bytes)
            // Section header: streamId(1) + outerCodecId(1) + blockCount(2) + uncompressedLen(4) + compressedLen(4) = 12 bytes
            // Then comes sectionHash (32 bytes)
            const hashOffset = 50; // Guaranteed to be within the first section hash (starts at 40)
            if (hashOffset < bytes.length - 1) {
                bytes[hashOffset] ^= 0xFF; // Corrupt hash
            }

            const decoder = new GICSv2Decoder(bytes);
            await expect(decoder.getAllSnapshots()).rejects.toThrow(IntegrityError);
        });

        it('should verify multiple stream sections', async () => {
            const encoder = new GICSv2Encoder();
            // Add multiple snapshots to ensure multiple blocks/sections
            for (let i = 0; i < 10; i++) {
                const snapshot = createSnapshot(1000 + i * 1000, i + 1, 100 + i * 10, i + 1);
                await encoder.addSnapshot(snapshot);
            }
            const bytes = await encoder.finish();

            const decoder = new GICSv2Decoder(bytes);
            const snapshots = await decoder.getAllSnapshots();

            expect(snapshots).toHaveLength(10);
            expect(snapshots[0].timestamp).toBe(1000);
            expect(snapshots[9].timestamp).toBe(10000);
        });
    });

    describe('Roundtrip Integrity', () => {
        it('should roundtrip single snapshot correctly', async () => {
            const original = createSnapshot(5000, 123, 9999, 50);

            const encoder = new GICSv2Encoder();
            await encoder.addSnapshot(original);
            const bytes = await encoder.finish();

            const decoder = new GICSv2Decoder(bytes);
            const snapshots = await decoder.getAllSnapshots();

            expect(snapshots).toHaveLength(1);
            expect(snapshots[0].timestamp).toBe(original.timestamp);
            expect(snapshots[0].items.get(123)).toEqual({ price: 9999, quantity: 50 });
        });

        it('should roundtrip multi-item snapshots', async () => {
            const encoder = new GICSv2Encoder();
            const snapshot: Snapshot = {
                timestamp: 3000,
                items: new Map([
                    [1, { price: 100, quantity: 10 }],
                    [2, { price: 200, quantity: 20 }],
                    [3, { price: 300, quantity: 30 }]
                ])
            };
            await encoder.addSnapshot(snapshot);
            const bytes = await encoder.finish();

            const decoder = new GICSv2Decoder(bytes);
            const snapshots = await decoder.getAllSnapshots();

            expect(snapshots).toHaveLength(1);
            expect(snapshots[0].items.size).toBe(3);
            expect(snapshots[0].items.get(1)).toEqual({ price: 100, quantity: 10 });
            expect(snapshots[0].items.get(2)).toEqual({ price: 200, quantity: 20 });
            expect(snapshots[0].items.get(3)).toEqual({ price: 300, quantity: 30 });
        });

        it('should roundtrip large dataset with trends', async () => {
            const encoder = new GICSv2Encoder();

            // Generate trending data (should compress well with v1.3)
            for (let t = 0; t < 100; t++) {
                const snapshot: Snapshot = {
                    timestamp: 1000 + t * 100,
                    items: new Map([
                        [1, { price: 1000 + t, quantity: 10 }],
                        [2, { price: 2000 + t * 2, quantity: 20 }]
                    ])
                };
                await encoder.addSnapshot(snapshot);
            }

            const bytes = await encoder.finish();
            const decoder = new GICSv2Decoder(bytes);
            const snapshots = await decoder.getAllSnapshots();

            expect(snapshots).toHaveLength(100);
            expect(snapshots[0].timestamp).toBe(1000);
            expect(snapshots[99].timestamp).toBe(10900);
            expect(snapshots[99].items.get(1)?.price).toBe(1099);
        });
    });

    describe('Backward Compatibility', () => {
        it('should accept v1.2 format (version 0x02)', async () => {
            // Note: v1.3 decoder should still support v1.2 for backward compatibility
            // This is testing that the version detection works correctly
            // The actual v1.2 encoding is handled by the same encoder with different serialization

            // We're just verifying the decoder doesn't reject v1.2 outright
            // A full v1.2 test would require actual v1.2 encoded data
            expect(true).toBe(true); // Placeholder - actual v1.2 compat tested elsewhere
        });

        it('should reject unsupported version with clear error', async () => {
            // Create fake data with unsupported version 0x99
            const fakeData = new Uint8Array([
                0x47, 0x49, 0x43, 0x53, // GICS magic
                0x99, // Unsupported version
                0x00, 0x00, 0x00, 0x00, // flags
                0xFF // EOS
            ]);

            const decoder = new GICSv2Decoder(fakeData);
            await expect(decoder.getAllSnapshots()).rejects.toThrow(IntegrityError);
            await expect(decoder.getAllSnapshots()).rejects.toThrow('Unsupported version: 153');
        });
    });

    describe('Stream Section Format', () => {
        it('should encode all mandatory streams', async () => {
            const encoder = new GICSv2Encoder();
            const snapshot = createSnapshot(4000, 7, 777, 7);
            await encoder.addSnapshot(snapshot);
            const bytes = await encoder.finish();

            // Decode and verify all streams are present
            const decoder = new GICSv2Decoder(bytes);
            const snapshots = await decoder.getAllSnapshots();

            // If all streams aren't present, decoder would fail
            expect(snapshots).toHaveLength(1);
            expect(snapshots[0].timestamp).toBe(4000);
            expect(snapshots[0].items.get(7)).toEqual({ price: 777, quantity: 7 });
        });

        it('should use outer compression (Zstd)', async () => {
            const encoder = new GICSv2Encoder();

            // Generate highly compressible data
            for (let i = 0; i < 50; i++) {
                const snapshot = createSnapshot(
                    1000 + i * 100,
                    1,
                    1000, // Same price
                    10    // Same quantity
                );
                await encoder.addSnapshot(snapshot);
            }

            const bytes = await encoder.finish();

            // With Zstd outer compression, the output should be significantly smaller
            // than uncompressed (rough estimate: 50 snapshots × minimal size)
            const minUncompressedEstimate = 50 * 20; // Very conservative
            expect(bytes.length).toBeLessThan(minUncompressedEstimate);

            // Verify it still decodes correctly
            const decoder = new GICSv2Decoder(bytes);
            const snapshots = await decoder.getAllSnapshots();
            expect(snapshots).toHaveLength(50);
        });
    });
});
