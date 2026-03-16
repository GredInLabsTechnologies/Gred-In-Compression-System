import { GICS } from '../src/index.js';
import { GICSv2Encoder } from '../src/gics/encode.js';
import { Codecs } from '../src/gics/codecs.js';
import { InnerCodecId, StreamId } from '../src/gics/format.js';
import type { Snapshot } from '../src/gics-types.js';

function sameNumberSemantics(actual: number, expected: number): boolean {
    if (Number.isNaN(expected)) return Number.isNaN(actual);
    return Object.is(actual, expected);
}

function makeDeterministicRng(seed = 0xC0FFEE): () => number {
    let state = seed >>> 0;
    return () => {
        state = (1664525 * state + 1013904223) >>> 0;
        return state / 0x1_0000_0000;
    };
}

describe('Codec XOR_FLOAT', () => {
    it('roundtrips constant float deltas exactly', () => {
        const deltas = new Array(256).fill(0.125);
        const encoded = Codecs.encodeXorFloat(deltas);
        const decoded = Codecs.decodeXorFloat(encoded, deltas.length);

        expect(decoded).toHaveLength(deltas.length);
        for (let i = 0; i < deltas.length; i++) {
            expect(sameNumberSemantics(decoded[i], deltas[i])).toBe(true);
        }
    });

    it('roundtrips linear-trend float deltas exactly', () => {
        const deltas = Array.from({ length: 256 }, (_, i) => 100 + i * 0.0001);
        const encoded = Codecs.encodeXorFloat(deltas);
        const decoded = Codecs.decodeXorFloat(encoded, deltas.length);

        expect(decoded).toHaveLength(deltas.length);
        for (let i = 0; i < deltas.length; i++) {
            expect(sameNumberSemantics(decoded[i], deltas[i])).toBe(true);
        }
    });

    it('roundtrips volatile/random deterministic float deltas exactly', () => {
        const rnd = makeDeterministicRng(0xFACEB00C);
        const deltas = Array.from({ length: 512 }, () => (rnd() - 0.5) * 10_000);

        const encoded = Codecs.encodeXorFloat(deltas);
        const decoded = Codecs.decodeXorFloat(encoded, deltas.length);

        expect(decoded).toHaveLength(deltas.length);
        for (let i = 0; i < deltas.length; i++) {
            expect(sameNumberSemantics(decoded[i], deltas[i])).toBe(true);
        }
    });

    it('roundtrips float deltas bit-a-bit for finite values', () => {
        const deltas = [
            0,
            0,
            0.1,
            0.2,
            0.20000000000000004,
            -123.456,
            Number.MIN_VALUE,
            -Number.MIN_VALUE,
            Number.MAX_VALUE,
            -Number.MAX_VALUE,
        ];

        const encoded = Codecs.encodeXorFloat(deltas);
        const decoded = Codecs.decodeXorFloat(encoded, deltas.length);

        expect(decoded).toHaveLength(deltas.length);
        for (let i = 0; i < deltas.length; i++) {
            expect(sameNumberSemantics(decoded[i], deltas[i])).toBe(true);
        }
    });

    it('produces smaller payload than FIXED64 on favorable float deltas', () => {
        const deltas = Array.from({ length: 512 }, (_, i) => 1_000 + i * 0.0001);
        const xorSize = Codecs.encodeXorFloat(deltas).length;
        const fixedSize = Codecs.encodeFixed64(deltas).length;

        expect(xorSize).toBeLessThan(fixedSize);
    });

    it('uses XOR_FLOAT for favorable finite float sequences', async () => {
        const snapshots: Snapshot[] = [];
        for (let i = 0; i < 256; i++) {
            snapshots.push({
                timestamp: 1_700_000_000_000 + i,
                items: new Map([
                    [1, { price: 1000 + i * 0.01, quantity: 1 }],
                    [2, { price: 1000 + i * 0.01 + 0.001, quantity: 2 }],
                ]),
            });
        }

        const encoder = new GICSv2Encoder({ blockSize: 256 });
        for (const s of snapshots) await encoder.addSnapshot(s);
        await encoder.finish();

        const blocks = encoder.getTelemetry()?.blocks ?? [];
        const valueBlocks = blocks.filter((b) => b.stream_id === StreamId.VALUE);

        expect(valueBlocks.length).toBeGreaterThan(0);
        expect(valueBlocks.some((b) => b.codec === InnerCodecId.XOR_FLOAT)).toBe(true);
    });

    it('falls back to absolute FIXED64 for non-finite sequences', async () => {
        const snapshots: Snapshot[] = [
            {
                timestamp: 1,
                items: new Map([
                    [1, { price: Number.NaN, quantity: 1 }],
                    [2, { price: Number.POSITIVE_INFINITY, quantity: 2 }],
                ]),
            },
            {
                timestamp: 2,
                items: new Map([
                    [1, { price: Number.NEGATIVE_INFINITY, quantity: 1 }],
                    [2, { price: Number.NaN, quantity: 2 }],
                ]),
            },
        ];

        const encoder = new GICSv2Encoder();
        for (const s of snapshots) await encoder.addSnapshot(s);
        const packed = await encoder.finish();
        const telemetry = encoder.getTelemetry();
        const valueBlocks = (telemetry?.blocks ?? []).filter((b) => b.stream_id === StreamId.VALUE);

        expect(valueBlocks.length).toBeGreaterThan(0);
        expect(valueBlocks.some((b) => b.codec === InnerCodecId.FIXED64_LE)).toBe(true);

        const decoded = await GICS.unpack(packed);
        expect(Number.isNaN(decoded[0].items.get(1)!.price)).toBe(true);
        expect(decoded[0].items.get(2)!.price).toBe(Number.POSITIVE_INFINITY);
        expect(decoded[1].items.get(1)!.price).toBe(Number.NEGATIVE_INFINITY);
        expect(Number.isNaN(decoded[1].items.get(2)!.price)).toBe(true);
    });

    it('keeps deterministic codec selection sequence for float blocks', async () => {
        const snapshots: Snapshot[] = [];
        for (let i = 0; i < 64; i++) {
            snapshots.push({
                timestamp: 1_700_100_000_000 + i,
                items: new Map([
                    [1, { price: 10 + i * 0.5, quantity: 1 }],
                    [2, { price: 20 + i * 0.125, quantity: 2 }],
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

    it.todo('FASE 10: CLI e2e se valida en tests/cli.test.ts (no bloquea FASE 3 de codecs)');
});
