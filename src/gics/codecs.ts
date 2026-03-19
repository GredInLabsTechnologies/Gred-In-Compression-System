
import { encodeVarint, decodeVarint, decodeVarintAt, encodeRLE, decodeRLE } from '../gics-utils.js';
import { ContextV0 } from './context.js';
import { IntegrityError } from './errors.js';

interface DecodeFixed64Options {
    allowLegacyIntFallback?: boolean;
}

export class Codecs {

    private static readonly FLOAT64_BYTES = 8;

    private static floatToBits(value: number): bigint {
        const buf = new ArrayBuffer(Codecs.FLOAT64_BYTES);
        const view = new DataView(buf);
        view.setFloat64(0, value, true);
        return view.getBigUint64(0, true);
    }

    private static bitsToFloat(bits: bigint): number {
        const buf = new ArrayBuffer(Codecs.FLOAT64_BYTES);
        const view = new DataView(buf);
        view.setBigUint64(0, bits, true);
        return view.getFloat64(0, true);
    }

    private static leadingZeros64(x: bigint): number {
        if (x === 0n) return 64;
        for (let i = 63; i >= 0; i--) {
            if (((x >> BigInt(i)) & 1n) === 1n) {
                return 63 - i;
            }
        }
        return 64;
    }

    private static trailingZeros64(x: bigint): number {
        if (x === 0n) return 64;
        for (let i = 0; i < 64; i++) {
            if (((x >> BigInt(i)) & 1n) === 1n) {
                return i;
            }
        }
        return 64;
    }

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
                    throw new IntegrityError(`GICS v1.3: Dictionary index ${idx} out of range (${context.dictionary.length})`);
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

    static decodeFixed64(data: Uint8Array, count: number, options: DecodeFixed64Options = {}): number[] {
        if (data.length !== count * Codecs.FLOAT64_BYTES) {
            throw new IntegrityError(`GICS v1.3: FIXED64 payload length ${data.length} does not match item count ${count}`);
        }
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const allowLegacyIntFallback = options.allowLegacyIntFallback ?? false;

        // Try Float64 first (current encoding format).
        const floatResult: number[] = [];
        let hasStrongFloatSignal = false;
        for (let i = 0; i < count; i++) {
            const v = view.getFloat64(i * 8, true);
            floatResult.push(v);
            // Preserve explicit float markers. Leave NaN undecided so legacy
            // integer payloads that decode to mixed subnormal/NaN patterns can
            // still fall back if their BigInt interpretation is fully safe.
            if ((!Number.isNaN(v) && !Number.isFinite(v)) || v === 0 || Math.abs(v) >= 2.2250738585072014e-308) {
                hasStrongFloatSignal = true;
            }
        }
        if (!allowLegacyIntFallback || hasStrongFloatSignal || count === 0) return floatResult;

        // All values are NaN or subnormal → legacy BigInt64 encoding (pre-9db2b66).
        // Small integers stored as BigInt64 produce subnormal/NaN when read as Float64.
        const result: number[] = [];
        for (let i = 0; i < count; i++) {
            const asBigInt = view.getBigInt64(i * 8, true);
            const asNumber = Number(asBigInt);
            if (!Number.isSafeInteger(asNumber)) {
                return floatResult;
            }
            result.push(asNumber);
        }
        return result;
    }

    // --- FOR BITPACK ---
    // Format: [min:varint][bitwidth:u8][residuals:bitpacked]
    // residual_i = values[i] - min
    static encodeFOR(values: number[]): Uint8Array {
        if (values.length === 0) return new Uint8Array(0);

        let min = values[0];
        for (const v of values) {
            if (v < min) min = v;
        }

        const residuals = new Array<number>(values.length);
        let maxResidual = 0;
        for (let i = 0; i < values.length; i++) {
            const residual = values[i] - min;
            residuals[i] = residual;
            if (residual > maxResidual) maxResidual = residual;
        }

        let bitWidth = 0;
        let tmp = maxResidual;
        while (tmp > 0) {
            bitWidth++;
            tmp = Math.floor(tmp / 2);
        }

        const minBytes = encodeVarint([min]);
        const header = new Uint8Array(minBytes.length + 1);
        header.set(minBytes, 0);
        header[minBytes.length] = bitWidth;

        if (bitWidth === 0) {
            return header;
        }

        const writer = new BitWriter();
        for (const residual of residuals) {
            writer.writeBits(BigInt(residual), bitWidth);
        }

        const payload = writer.finish();
        const result = new Uint8Array(header.length + payload.length);
        result.set(header, 0);
        result.set(payload, header.length);
        return result;
    }

    static decodeFOR(data: Uint8Array, count: number): number[] {
        if (count === 0) return [];
        if (data.length === 0) throw new IntegrityError('GICS v1.3: FOR payload is empty');

        let min = 0;
        let offset = 0;
        try {
            const decoded = decodeVarintAt(data, 0);
            if (decoded.values.length !== 1 || decoded.values[0] === undefined) {
                throw new IntegrityError('GICS v1.3: FOR header is missing base value');
            }
            min = decoded.values[0];
            offset = decoded.nextPos;
        } catch {
            throw new IntegrityError('GICS v1.3: FOR base value is malformed');
        }

        if (offset >= data.length) throw new IntegrityError('GICS v1.3: FOR bit width is missing');
        const bitWidth = data[offset];
        const payload = data.subarray(offset + 1);

        if (bitWidth > 53) throw new IntegrityError(`GICS v1.3: FOR bit width ${bitWidth} exceeds safe integer width`);

        if (bitWidth === 0) {
            return new Array(count).fill(min);
        }

        const expectedBits = count * bitWidth;
        if ((payload.length * 8) < expectedBits) {
            throw new IntegrityError('GICS v1.3: FOR payload is truncated');
        }

        const reader = new BitReader(payload);
        const values: number[] = new Array(count);
        for (let i = 0; i < count; i++) {
            const residual = Number(reader.readBits(bitWidth));
            values[i] = min + residual;
        }
        return values;
    }

    // --- XOR FLOAT (Gorilla-style, deterministic) ---
    // Format:
    // [first_value: float64_le][bitstream]
    // bitstream per next value:
    //   0 -> same as previous bits
    //   1 -> changed: [leadingZeros:6][trailingZeros:6][meaningfulBitsMinus1:6][meaningfulBits]
    static encodeXorFloat(values: number[]): Uint8Array {
        if (values.length === 0) return new Uint8Array(0);

        const firstBytes = new Uint8Array(8);
        const firstView = new DataView(firstBytes.buffer);
        firstView.setFloat64(0, values[0], true);

        const writer = new BitWriter();
        let prevBits = Codecs.floatToBits(values[0]);

        for (let i = 1; i < values.length; i++) {
            const currentBits = Codecs.floatToBits(values[i]);
            const xor = prevBits ^ currentBits;

            if (xor === 0n) {
                writer.writeBit(0);
                continue;
            }

            writer.writeBit(1);
            const leadingZeros = Codecs.leadingZeros64(xor);
            const trailingZeros = Codecs.trailingZeros64(xor);
            const meaningfulBits = 64 - leadingZeros - trailingZeros;
            const packed = xor >> BigInt(trailingZeros);

            writer.writeBits(BigInt(leadingZeros), 6);
            writer.writeBits(BigInt(trailingZeros), 6);
            writer.writeBits(BigInt(meaningfulBits - 1), 6);
            writer.writeBits(packed, meaningfulBits);

            prevBits = currentBits;
        }

        const tail = writer.finish();
        const result = new Uint8Array(8 + tail.length);
        result.set(firstBytes, 0);
        result.set(tail, 8);
        return result;
    }

    static decodeXorFloat(data: Uint8Array, count: number): number[] {
        if (count === 0) return [];
        if (data.length < 8) return [];

        const firstView = new DataView(data.buffer, data.byteOffset, 8);
        const firstValue = firstView.getFloat64(0, true);
        const result: number[] = [firstValue];

        let prevBits = Codecs.floatToBits(firstValue);
        const reader = new BitReader(data.subarray(8));

        for (let i = 1; i < count; i++) {
            const marker = reader.readBit();
            if (marker === null) break;

            let currentBits = prevBits;
            if (marker === 1) {
                const leadingZeros = Number(reader.readBits(6));
                const trailingZeros = Number(reader.readBits(6));
                const meaningfulBits = Number(reader.readBits(6)) + 1;

                const safeLeading = Math.max(0, Math.min(63, leadingZeros));
                const safeTrailing = Math.max(0, Math.min(63, trailingZeros));
                const maxMeaningful = Math.max(1, 64 - safeLeading - safeTrailing);
                const safeMeaningful = Math.max(1, Math.min(maxMeaningful, meaningfulBits));

                const packed = reader.readBits(safeMeaningful);
                const xor = packed << BigInt(safeTrailing);
                currentBits = prevBits ^ xor;
            }

            result.push(Codecs.bitsToFloat(currentBits));
            prevBits = currentBits;
        }

        return result;
    }
}

class BitWriter {
    private readonly bytes: number[] = [];
    private currentByte = 0;
    private bitPos = 0;

    writeBit(bit: number): void {
        if (bit !== 0) {
            this.currentByte |= (1 << this.bitPos);
        }
        this.bitPos++;

        if (this.bitPos === 8) {
            this.bytes.push(this.currentByte);
            this.currentByte = 0;
            this.bitPos = 0;
        }
    }

    writeBits(value: bigint, width: number): void {
        for (let i = 0; i < width; i++) {
            const bit = Number((value >> BigInt(i)) & 1n);
            this.writeBit(bit);
        }
    }

    finish(): Uint8Array {
        if (this.bitPos > 0) {
            this.bytes.push(this.currentByte);
            this.currentByte = 0;
            this.bitPos = 0;
        }
        return new Uint8Array(this.bytes);
    }
}

class BitReader {
    private bytePos = 0;
    private bitPos = 0;

    constructor(private readonly data: Uint8Array) { }

    readBit(): number | null {
        if (this.bytePos >= this.data.length) return null;
        const bit = (this.data[this.bytePos] >> this.bitPos) & 1;
        this.bitPos++;
        if (this.bitPos === 8) {
            this.bitPos = 0;
            this.bytePos++;
        }
        return bit;
    }

    readBits(width: number): bigint {
        let result = 0n;
        for (let i = 0; i < width; i++) {
            const bit = this.readBit();
            if (bit === null) break;
            if (bit === 1) {
                result |= (1n << BigInt(i));
            }
        }
        return result;
    }
}
