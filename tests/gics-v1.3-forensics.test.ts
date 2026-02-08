import { describe, it, expect } from 'vitest';
import { GICSv2Encoder } from '../src/gics/encode.js';
import { GICSv2Decoder } from '../src/gics/decode.js';
import { IntegrityError } from '../src/gics/errors.js';
import { GICS } from '../src/index.js';

describe('GICS v1.3 Forensics & Verification', () => {
    const snapshots = [
        {
            timestamp: 1625091200000,
            items: new Map([[1, { price: 100, quantity: 10 }]])
        },
        {
            timestamp: 1625091201000,
            items: new Map([[1, { price: 101, quantity: 12 }], [2, { price: 50, quantity: 5 }]])
        }
    ];

    it('should verify file integrity without decompression', async () => {
        const bytes = await GICS.pack(snapshots);
        const isValid = await GICS.verify(bytes);
        expect(isValid).toBe(true);
    });

    it('should fail verification if CRC is tampered', async () => {
        const bytes = await GICS.pack(snapshots);
        const tampered = new Uint8Array(bytes);
        // Tamper with segment data (after header 14 bytes)
        tampered[20] ^= 0xFF;

        const isValid = await GICS.verify(tampered);
        expect(isValid).toBe(false);
    });

    it('should fail if cross-stream lengths mismatch (Manual Trigger)', async () => {
        // This test requires a way to produce inconsistent streams.
        // We can mock the decoder's decompressAndDecode to return inconsistent lengths.
        const bytes = await GICS.pack(snapshots);
        const decoder = new GICSv2Decoder(bytes);

        // Monkey patch reconstructSnapshots (private, so use any)
        const original = (decoder as any).reconstructSnapshots;
        (decoder as any).reconstructSnapshots = function (time: any, lengths: any, ids: any, prices: any, qtys: any) {
            // Force mismatch
            return original.call(this, time, [1], ids, prices, qtys);
        };

        await expect(decoder.getAllSnapshots()).rejects.toThrow(/Cross-stream mismatch/);
    });

    it('should detect sum(snapshotLen) != itemIds.length', async () => {
        const bytes = await GICS.pack(snapshots);
        const decoder = new GICSv2Decoder(bytes);

        const original = (decoder as any).reconstructSnapshots;
        (decoder as any).reconstructSnapshots = function (time: any, lengths: any, ids: any, prices: any, qtys: any) {
            // Must have same length as time (2) to pass first check
            return original.call(this, time, [100, 200], ids, prices, qtys);
        };

        await expect(decoder.getAllSnapshots()).rejects.toThrow(/Sum of SNAPSHOT_LEN/);
    });
});
