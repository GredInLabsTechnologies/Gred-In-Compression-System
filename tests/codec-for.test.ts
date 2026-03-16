import { GICS } from '../src/index.js';
import { GICSv2Encoder } from '../src/gics/encode.js';
import { Codecs } from '../src/gics/codecs.js';
import { encodeVarint } from '../src/gics-utils.js';
import { StreamId } from '../src/gics/format.js';
import type { Snapshot } from '../src/gics-types.js';

describe('Codec FOR_BITPACK', () => {
    it('roundtrips integer arrays with negatives and wide ranges', () => {
        const values = [-20, -18, -17, -17, -15, 0, 3, 4, 1000, 2000, -5, -4, -3, -2, -1];

        const encoded = Codecs.encodeFOR(values);
        const decoded = Codecs.decodeFOR(encoded, values.length);

        expect(decoded).toEqual(values);
    });

    it('encodes constant blocks with bitWidth=0 and decodes exactly', () => {
        const values = new Array(64).fill(-42);

        const encoded = Codecs.encodeFOR(values);
        const decoded = Codecs.decodeFOR(encoded, values.length);

        expect(encoded.length).toBeGreaterThanOrEqual(2); // [min varint][bitwidth]
        expect(decoded).toEqual(values);
    });

    it('is competitive on favorable narrow-range VALUE integer deltas', () => {
        // Favorable pattern: deltas clustered in a narrow band.
        const deltas = Array.from({ length: 256 }, (_, i) => 1000 + (i % 8));

        const forSize = Codecs.encodeFOR(deltas).length;
        const varintSize = encodeVarint(deltas).length;

        expect(forSize).toBeLessThan(varintSize);
    });

    it('keeps full roundtrip integrity when FOR_BITPACK is used in VALUE stream', async () => {
        const snapshots: Snapshot[] = [];
        for (let i = 0; i < 80; i++) {
            snapshots.push({
                timestamp: 1_700_300_000_000 + i,
                items: new Map([
                    [1, { price: 1_000 + (i % 7), quantity: 10 + (i % 3) }],
                    [2, { price: 2_000 + (i % 5), quantity: 20 + (i % 4) }],
                ]),
            });
        }

        const encoder = new GICSv2Encoder({ blockSize: 40 });
        for (const s of snapshots) await encoder.addSnapshot(s);
        const packed = await encoder.finish();

        const decoded = await GICS.unpack(packed);
        expect(decoded).toEqual(snapshots);
    });

    it('beats plain varint size on narrow residual distributions', () => {
        const values = Array.from({ length: 256 }, (_, i) => 50_000 + (i % 8));
        const forEncoded = Codecs.encodeFOR(values);

        // Baseline: plain varint over same integer values.
        const varintBaseline = encodeVarint(values);

        // Practical assertion: FOR should be meaningfully compact for narrow range blocks
        // (sanity bound vs uncompressed 8-byte representation)
        expect(forEncoded.length).toBeLessThan(values.length * 8);
        expect(forEncoded.length).toBeLessThan(varintBaseline.length);
    });

    it('keeps roundtrip correctness on wide-range values where FOR may not be best', () => {
        const values = Array.from({ length: 512 }, (_, i) => {
            const base = (i + 1) * (i + 1) * 97;
            return (i % 2 === 0 ? -1 : 1) * base;
        });
        const encoded = Codecs.encodeFOR(values);
        const decoded = Codecs.decodeFOR(encoded, values.length);

        expect(encoded.length).toBeGreaterThan(0);
        expect(decoded).toEqual(values);
    });

    it('keeps deterministic VALUE codec selection sequence across repeated runs', async () => {
        const snapshots: Snapshot[] = [];
        for (let i = 0; i < 96; i++) {
            snapshots.push({
                timestamp: 1_700_400_000_000 + i,
                items: new Map([
                    [1, { price: 3_000 + (i % 8), quantity: 5 }],
                    [2, { price: 4_000 + (i % 8), quantity: 7 }],
                ]),
            });
        }

        const run = async () => {
            const encoder = new GICSv2Encoder({ blockSize: 32 });
            for (const s of snapshots) await encoder.addSnapshot(s);
            await encoder.finish();
            const valueBlocks = (encoder.getTelemetry()?.blocks ?? []).filter((b) => b.stream_id === StreamId.VALUE);
            return valueBlocks.map((b) => b.codec).join('|');
        };

        const a = await run();
        const b = await run();

        expect(a.length).toBeGreaterThan(0);
        expect(a).toBe(b);
    });
});
