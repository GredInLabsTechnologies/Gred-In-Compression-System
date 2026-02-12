/**
 * GICS Utilities
 * 
 * @module gics
 * @version 1.1.0
 * @status FROZEN - Canonical implementation
 * @see docs/GICS_V1.1_SPEC.md
 * 
 * Shared functions for GICS encoding/decoding.
 */

/**
 * Encode integers with zigzag + variable-length encoding
 * Small numbers = 1 byte, larger = 2-5 bytes
 */
export function encodeVarint(values: number[]): Uint8Array {
    const buffer: number[] = [];

    for (const val of values) {
        // Zigzag encode: map signed to unsigned (negative numbers close to 0)
        const zigzag = val >= 0 ? val * 2 : (Math.abs(val) * 2) - 1;

        // Variable-length encoding
        let n = zigzag;
        while (n >= 0x80) {
            buffer.push((n % 128) | 0x80);
            n = Math.floor(n / 128);
        }
        buffer.push(n);
    }

    return new Uint8Array(buffer);
}

/**
 * Decode zigzag + variable-length integers
 */
export function decodeVarint(data: Uint8Array): number[] {
    const values: number[] = [];
    let i = 0;

    while (i < data.length) {
        let zigzag = 0;
        let p2d = 1; // Power of 2 (for shift replacement)

        while (i < data.length) {
            const byte = data[i++];
            zigzag += (byte & 0x7F) * p2d;
            if ((byte & 0x80) === 0) break;
            p2d *= 128;
        }

        // Decode zigzag
        const val = (zigzag % 2 === 0) ? (zigzag / 2) : -((zigzag + 1) / 2);
        values.push(val);
    }

    return values;
}

/**
 * RLE + Varint encoding: extremely efficient for sparse data with many zeros
 * Format: [run_length][value][run_length][value]...
 * - Run of zeros: encode as [count, 0]
 * - Run of same value: encode as [count, value]
 * - Single values: encode as [1, value]
 */
export function encodeRLE(values: number[]): Uint8Array {
    if (values.length === 0) return new Uint8Array(0);

    const runs: number[] = [];
    let i = 0;

    while (i < values.length) {
        const val = values[i];
        let count = 1;

        // Count consecutive identical values
        while (i + count < values.length && values[i + count] === val && count < 255) {
            count++;
        }

        runs.push(count, val);
        i += count;
    }

    return encodeVarint(runs);
}

/**
 * Decode RLE + Varint
 */
export function decodeRLE(data: Uint8Array): number[] {
    const runs = decodeVarint(data);
    const values: number[] = [];

    // Guard: RLE runs must be pairs (count, value)
    if (runs.length % 2 !== 0) {
        console.warn('[GICS] decodeRLE: odd run count, data may be corrupted');
        // Process available pairs only
    }

    const pairCount = Math.floor(runs.length / 2);
    for (let i = 0; i < pairCount; i++) {
        const count = runs[i * 2];
        const val = runs[i * 2 + 1];
        for (let j = 0; j < count; j++) {
            values.push(val);
        }
    }

    return values;
}

export function decodeVarintAt(data: Uint8Array, start: number): { values: number[], nextPos: number } {
    let i = start;
    let zigzag = 0;
    let p2d = 1;

    while (true) {
        if (i >= data.length) throw new RangeError("Truncated varint");
        const byte = data[i++];
        zigzag += (byte & 0x7F) * p2d;
        if ((byte & 0x80) === 0) break;
        p2d *= 128;
    }

    const val = (zigzag % 2 === 0) ? (zigzag / 2) : -((zigzag + 1) / 2);
    return { values: [val], nextPos: i };
}

export function decodeVarintN(data: Uint8Array, start: number, n: number): { values: number[], nextPos: number } {
    const values: number[] = [];
    let i = start;

    for (let count = 0; count < n; count++) { // Removed i < data.length check from loop condition to catch it inside
        let zigzag = 0;
        let p2d = 1;
        while (true) {
            if (i >= data.length) throw new RangeError("Truncated varint");
            const byte = data[i++];
            zigzag += (byte & 0x7F) * p2d;
            if ((byte & 0x80) === 0) break;
            p2d *= 128;
        }
        const val = (zigzag % 2 === 0) ? (zigzag / 2) : -((zigzag + 1) / 2);
        values.push(val);
    }

    return { values, nextPos: i };
}

/**
 * Wait for N ms
 */
export const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));