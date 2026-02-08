
import { encodeVarint, decodeVarint, encodeRLE, decodeRLE } from '../gics-utils.js';

export class Codecs {

    // --- BITPACKING ---
    // Pack integers into tight bits. 
    // Requirement: All values must ideally fit in small N bits.
    // Logic: Find max bits needed, write bit_width (u8), then packed data.

    static encodeBitPack(values: number[]): Uint8Array {
        if (values.length === 0) return new Uint8Array(0);

        // 1. ZigZag encode to handle negative values and make them positive.
        const unsigned = values.map(v => (v >= 0 ? v * 2 : (v * -2) - 1));

        // Find max
        let max = 0;
        for (const u of unsigned) {
            if (u > max) max = u;
        }

        // Determine bit width
        let bits = 0;
        while ((1 << bits) <= max && bits < 32) {
            bits++;
        }
        if (max === 0) bits = 1;
        if (bits === 0) bits = 1;

        const dataBytes = Math.ceil((unsigned.length * bits) / 8);
        const result = new Uint8Array(1 + dataBytes);
        result[0] = bits;

        let bitPos = 0;
        for (const val of unsigned) {
            for (let b = 0; b < bits; b++) {
                const bit = (val >> b) & 1;
                if (bit) {
                    const totalBit = bitPos + b;
                    const byteIdx = 1 + (totalBit >> 3);
                    const bitIdx = totalBit & 7;
                    result[byteIdx] |= (1 << bitIdx);
                }
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
            for (let b = 0; b < bits; b++) {
                const totalBit = bitPos + b;
                const byteIdx = 1 + (totalBit >> 3);
                const bitIdx = totalBit & 7;
                if (byteIdx < data.length) {
                    const bit = (data[byteIdx] >> bitIdx) & 1;
                    if (bit) {
                        val |= (1 << b);
                    }
                }
            }
            bitPos += bits;

            // Undo ZigZag
            const decoded = (val >>> 1) ^ -(val & 1);
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
    // LSB=1 -> Dictionary Hit. Value >> 1 is Index.
    // LSB=0 -> Literal. Value >> 1 is ZigZag(Delta). Update Dict.

    static encodeDict(values: number[], context: any): Uint8Array {
        if (values.length === 0) return new Uint8Array(0);

        const output: number[] = [];
        for (const val of values) {
            const idx = context.dictMap.get(val);
            if (idx === undefined) {
                // Miss: (ZigZag(val) << 1) | 0
                const zz = (val >= 0) ? (val * 2) : (val * -2) - 1;
                output.push(zz << 1);
                context.updateDictionary(val);
            } else {
                // Hit: (idx << 1) | 1
                output.push((idx << 1) | 1);
            }
        }

        return encodeVarint(output);
    }

    static decodeDict(data: Uint8Array, context: any): number[] {
        if (data.length === 0) return [];
        const raw = decodeVarint(data);
        const result: number[] = [];

        for (const r of raw) {
            if (r & 1) {
                // Hit
                const idx = r >>> 1;
                if (idx < context.dictionary.length) {
                    result.push(context.dictionary[idx]);
                } else {
                    result.push(0);
                }
            } else {
                // Miss
                const zz = r >>> 1;
                const val = (zz >>> 1) ^ -(zz & 1);
                result.push(val);
                context.updateDictionary(val);
            }
        }
        return result;
    }
}
