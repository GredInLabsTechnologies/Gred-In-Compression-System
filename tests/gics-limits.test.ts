import { GICS } from '../src/index.js';
import { GICSv2Encoder } from '../src/gics/encode.js';
import { GICSv2Decoder } from '../src/gics/decode.js';
import { calculateCRC32 } from '../src/gics/integrity.js';
import { IntegrityError, LimitExceededError } from '../src/gics/errors.js';

const HEAVY_LIMITS = process.env.GICS_HEAVY_LIMITS === '1';

describe('GICS system limits', () => {
    it('handles a high snapshot count without integrity loss', async () => {
        const encoder = new GICSv2Encoder();
        const total = 20_000;

        for (let i = 0; i < total; i++) {
            await encoder.addSnapshot({
                timestamp: 1_700_000_000_000 + i,
                items: new Map([[1, { price: 1_000 + (i % 17), quantity: 1 }]]),
            });
            if (i > 0 && i % 2_000 === 0) await encoder.flush();
        }

        const bytes = await encoder.finish();
        const decoded = await GICS.unpack(bytes);
        expect(decoded.length).toBe(total);
        expect(await GICS.verify(bytes)).toBe(true);
    });

    it('handles snapshots with thousands of items', async () => {
        const items = new Map<number, { price: number; quantity: number }>();
        for (let id = 1; id <= 5_000; id++) {
            items.set(id, { price: 10_000 + id, quantity: 1 + (id % 3) });
        }

        const snapshots = [
            { timestamp: 1_701_000_000_000, items },
            { timestamp: 1_701_000_000_001, items: new Map(items) },
        ];

        const packed = await GICS.pack(snapshots);
        const decoded = await GICS.unpack(packed);
        expect(decoded.length).toBe(2);
        expect(decoded[0].items.size).toBe(5_000);
    });

    const heavyIt = HEAVY_LIMITS ? it : it.skip;
    heavyIt('supports configurable heavy stress for snapshot and item counts', async () => {
        const totalSnapshots = Number(process.env.GICS_LIMITS_HEAVY_SNAPSHOTS ?? '120000');
        const itemCount = Number(process.env.GICS_LIMITS_HEAVY_ITEMS ?? '15000');
        const flushEvery = Number(process.env.GICS_LIMITS_HEAVY_FLUSH_EVERY ?? '5000');

        const encoder = new GICSv2Encoder();
        for (let i = 0; i < totalSnapshots; i++) {
            const items = new Map<number, { price: number; quantity: number }>();
            for (let id = 1; id <= itemCount; id++) {
                items.set(id, {
                    price: 1_000_000 + id + (i % 17),
                    quantity: 1 + (id % 5),
                });
            }
            await encoder.addSnapshot({
                timestamp: 1_706_000_000_000 + i,
                items,
            });
            if (i > 0 && i % flushEvery === 0) await encoder.flush();
        }

        const bytes = await encoder.finish();
        const decoded = await GICS.unpack(bytes);
        expect(decoded.length).toBe(totalSnapshots);
        expect(decoded[0].items.size).toBe(itemCount);
        expect(await GICS.verify(bytes)).toBe(true);
    }, 120_000);

    it('rejects malicious section length tampering (limit or integrity path)', async () => {
        const encoder = new GICSv2Encoder();
        await encoder.addSnapshot({
            timestamp: 1000,
            items: new Map([[1, { price: 100, quantity: 1 }]]),
        });
        const valid = await encoder.finish();

        // Section uncompressedLen offset: fileHeader(14) + streamId(1)+outer(1)+blockCount(2) = 18
        // write absurd value to trigger decoder limit guard.
        const corrupted = Buffer.from(valid);
        corrupted.writeUInt32LE(0x7fffffff, 18);

        // Recompute segment CRC so failure path reaches decompression guard.
        const segmentStart = 14;
        const footerStart = corrupted.length - 37 - 36;
        const segmentBody = corrupted.subarray(segmentStart, footerStart);
        const newCrc = calculateCRC32(segmentBody);
        corrupted.writeUInt32LE(newCrc, footerStart + 32);

        const decoder = new GICSv2Decoder(corrupted);
        await expect(decoder.getAllSnapshots()).rejects.toThrow(
            expect.objectContaining({
                name: expect.stringMatching(/^(LimitExceededError|IntegrityError)$/),
            }),
        );
    });
});
