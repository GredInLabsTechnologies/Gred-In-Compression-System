
import { encodeVarint, decodeVarint, encodeRLE, decodeRLE } from '../gics-utils.js';

export class Codecs {

    // --- BITPACKING ---
    // Pack integers into tight bits. 
    // Requirement: All values must ideally fit in small N bits.
    // Logic: Find max bits needed, write bit_width (u8), then packed data.

    static encodeBitPack(values: number[]): Uint8Array {
        if (values.length === 0) return new Uint8Array(0);

        // 1. Determine Min/Max to handle offset? 
        // For Delta encoding, values can be negative.
        // Bitpacking works best on unsigned.
        // So allow offset shifting or ZigZag first?
        // Let's assume input is already Delta'd. We ZigZag them to make them positive.
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
        if (max === 0) bits = 1; // Minimum 1 bit for zeros? Or 0 bits if all zero?
        if (bits === 0) bits = 1;

        // Header: [bits (u8), count (u32)?] 
        // Or just [bits]. Count is known from Block Header nItems?
        // Ideally we just emit [bits] + data.

        // Packing
        // We pack into a buffer.
        // 8 items of 1 bit = 1 byte.
        // Size = ceil(count * bits / 8) + 1 (header)

        const dataBytes = Math.ceil((unsigned.length * bits) / 8);
        const result = new Uint8Array(1 + dataBytes);
        result[0] = bits;

        let bitPos = 0;
        // Optimization: bulk write if aligned? No, bitstream is generic.
        for (let i = 0; i < unsigned.length; i++) {
            const val = unsigned[i];
            // Write 'bits' bits of 'val' starting at 'bitPos'
            // We write into 'result' starting at byte 1

            // Allow simplified writing: pure JS bitwise logic
            // Supporting up to 32 bits width
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
            // Read 'bits' bits
            for (let b = 0; b < bits; b++) {
                const totalBit = bitPos + b;
                const byteIdx = 1 + (totalBit >> 3);
                const bitIdx = totalBit & 7;
                // Check bounds? data usually matches count logic
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
    // Wraps gics-utils RLE which does RLE + Varint
    // But GICS Utils RLE might expect raw values.
    // If we want RLE on Deltas, we feed Deltas.
    static encodeRLE(values: number[]): Uint8Array {
        // Utils encodeRLE does: [count, val]... then Varint encodes the stream.
        // It does NOT ZigZag the values inside automatically? 
        // encodeVarint DOES ZigZag.
        // So if we pass signed deltas to encodeRLE, and it calls encodeVarint, it's fine.
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
            // Check dictionary
            const idx = context.dictMap.get(val);
            if (idx !== undefined) {
                // Hit: (idx << 1) | 1
                output.push((idx << 1) | 1);
            } else {
                // Miss: (ZigZag(val) << 1) | 0
                const zz = (val >= 0) ? (val * 2) : (val * -2) - 1;
                output.push(zz << 1);
                // Update Context
                context.updateDictionary(val);
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
                    // Error state? Return 0 or last?
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
