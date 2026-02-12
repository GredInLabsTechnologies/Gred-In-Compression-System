
import { encodeVarint, decodeVarint, encodeRLE, decodeRLE } from '../gics-utils.js';
import { ContextV0 } from './context.js';

export class Codecs {

    // --- BITPACKING ---
    // Pack integers into tight bits. 
    // Requirement: All values must ideally fit in small N bits.
    // Logic: Find max bits needed, write bit_width (u8), then packed data.

    static encodeBitPack(values: number[]): Uint8Array {
        if (values.length === 0) return new Uint8Array(0);

        // 1. ZigZag encode to handle negative values and make them positive.
        const unsigned = values.map(v => (v >= 0 ? v * 2 : (Math.abs(v) * 2) - 1));

        // Find max
        let max = 0;
        for (const u of unsigned) {
            if (u > max) max = u;
        }

        // Determine bit width (support up to 53 bits for JS safe integers)
        let bits = 0;
        let tempMax = max;
        while (tempMax > 0) {
            tempMax = Math.floor(tempMax / 2);
            bits++;
        }
        if (max === 0) bits = 1;

        const dataBytes = Math.ceil((unsigned.length * bits) / 8);
        const result = new Uint8Array(1 + dataBytes);
        result[0] = bits;

        let bitPos = 0;
        for (const val of unsigned) {
            let currentVal = val;
            for (let b = 0; b < bits; b++) {
                const bit = currentVal % 2;
                if (bit) {
                    const totalBit = bitPos + b;
                    const byteIdx = 1 + Math.floor(totalBit / 8);
                    const bitIdx = totalBit % 8;
                    result[byteIdx] |= (1 << bitIdx);
                }
                currentVal = Math.floor(currentVal / 2);
            }
            bitPos += bits;
        }

        return result;
    }

    static decodeBitPack(data: Uint8Array, count: number): number[] {
        if (data.length === 0) return [];
        const bits = data[0];
        const result: number[] = [];

        let bitPos = 0;
        for (let i = 0; i < count; i++) {
            let val = 0;
            let powerOfTwo = 1;
            for (let b = 0; b < bits; b++) {
                const totalBit = bitPos + b;
                const byteIdx = 1 + Math.floor(totalBit / 8);
                const bitIdx = totalBit % 8;
                if (byteIdx < data.length) {
                    const bit = (data[byteIdx] >> bitIdx) & 1;
                    if (bit) {
                        val += powerOfTwo;
                    }
                }
                powerOfTwo *= 2;
            }
            bitPos += bits;

            // Undo ZigZag
            const decoded = (val % 2 === 0) ? (val / 2) : -((val + 1) / 2);
            result.push(decoded);
        }

        return result;
    }

    // --- RLE ZIGZAG ---
    static encodeRLE(values: number[]): Uint8Array {
        return encodeRLE(values);
    }

    static decodeRLE(data: Uint8Array): number[] {
        return decodeRLE(data);
    }

    // --- DICT VARINT ---
    // Mixed stream: Dictionary Index OR Literal (Varint)
    // Format: Varint encoded integers.
    // LSB=1 -> Dictionary Hit. Value // 2 is Index.
    // LSB=0 -> Literal. Value // 2 is ZigZag(Delta). Update Dict.

    static encodeDict(values: number[], context: ContextV0): Uint8Array {
        if (values.length === 0) return new Uint8Array(0);

        const output: number[] = [];
        for (const val of values) {
            const idx = context.dictMap.get(val);
            if (idx === undefined) {
                // Miss: (ZigZag(val) * 2) + 0
                const zz = (val >= 0) ? (val * 2) : (Math.abs(val) * 2) - 1;
                output.push(zz * 2);
                context.updateDictionary(val);
            } else {
                // Hit: (idx * 2) + 1
                output.push((idx * 2) + 1);
            }
        }

        return encodeVarint(output);
    }

    static decodeDict(data: Uint8Array, context: ContextV0): number[] {
        if (data.length === 0) return [];
        const raw = decodeVarint(data);
        const result: number[] = [];

        for (const r of raw) {
            if (r % 2 === 1) {
                // Hit
                const idx = Math.floor(r / 2);
                if (idx < context.dictionary.length) {
                    result.push(context.dictionary[idx]);
                } else {
                    result.push(0);
                }
            } else {
                // Miss
                const zz = r / 2;
                const val = (zz % 2 === 0) ? (zz / 2) : -((zz + 1) / 2);
                result.push(val);
                context.updateDictionary(val);
            }
        }
        return result;
    }

    // --- FIXED64 LE ---
    static encodeFixed64(values: number[]): Uint8Array {
        const result = new Uint8Array(values.length * 8);
        const view = new DataView(result.buffer);
        for (let i = 0; i < values.length; i++) {
            // Preserve exact IEEE-754 bits for true float round-trip safety.
            view.setFloat64(i * 8, values[i], true);
        }
        return result;
    }

    static decodeFixed64(data: Uint8Array, count: number): number[] {
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

        // Try Float64 first (current encoding format).
        const floatResult: number[] = [];
        let hasNormalFloat = false;
        for (let i = 0; i < count; i++) {
            const v = view.getFloat64(i * 8, true);
            floatResult.push(v);
            // A "normal" Float64: not NaN, not subnormal, not zero
            // If at least one normal value exists, this is genuine Float64 data.
            if (v === v && (v === 0 || Math.abs(v) >= 2.2e-308)) {
                hasNormalFloat = true;
            }
        }
        if (hasNormalFloat || count === 0) return floatResult;

        // All values are NaN or subnormal → legacy BigInt64 encoding (pre-9db2b66).
        // Small integers stored as BigInt64 produce subnormal/NaN when read as Float64.
        const result: number[] = [];
        for (let i = 0; i < count; i++) {
            result.push(Number(view.getBigInt64(i * 8, true)));
        }
        return result;
    }
}
