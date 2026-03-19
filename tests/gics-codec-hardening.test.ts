import { Codecs } from '../src/gics/codecs.js';
import { ContextV0 } from '../src/gics/context.js';
import { IntegrityError } from '../src/gics/errors.js';
import { encodeVarint } from '../src/gics-utils.js';

function encodeBigInt64Payload(values: bigint[]): Uint8Array {
    const bytes = new Uint8Array(values.length * 8);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < values.length; i++) {
        view.setBigInt64(i * 8, values[i], true);
    }
    return bytes;
}

function encodeFloat64Payload(values: number[]): Uint8Array {
    const bytes = new Uint8Array(values.length * 8);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < values.length; i++) {
        view.setFloat64(i * 8, values[i], true);
    }
    return bytes;
}

describe('GICS codec hardening', () => {
    it('decodeDict rejects dictionary hits that point outside the dictionary', () => {
        const payload = encodeVarint([199]); // idx=99 hit
        const context = new ContextV0('codec-hardening');

        expect(() => Codecs.decodeDict(payload, context)).toThrow(IntegrityError);
    });

    it('decodeFOR rejects empty payloads', () => {
        expect(() => Codecs.decodeFOR(new Uint8Array(0), 3)).toThrow(IntegrityError);
    });

    it('decodeFOR rejects truncated payloads', () => {
        const encoded = Codecs.encodeFOR([100, 101, 102, 103]);
        const truncated = encoded.subarray(0, encoded.length - 1);

        expect(() => Codecs.decodeFOR(truncated, 4)).toThrow(IntegrityError);
    });

    it('decodeFixed64 can recover legacy BigInt64 payloads when every value is a safe integer', () => {
        const payload = encodeBigInt64Payload([10000n, 19950n, 1234n]);

        expect(Codecs.decodeFixed64(payload, 3, { allowLegacyIntFallback: true })).toEqual([10000, 19950, 1234]);
    });

    it('decodeFixed64 preserves explicit float markers when legacy fallback is enabled', () => {
        const payload = encodeFloat64Payload([Number.NaN, 0, Number.MIN_VALUE]);
        const decoded = Codecs.decodeFixed64(payload, 3, { allowLegacyIntFallback: true });

        expect(Number.isNaN(decoded[0])).toBe(true);
        expect(Object.is(decoded[1], 0)).toBe(true);
        expect(decoded[2]).toBe(Number.MIN_VALUE);
    });
});
