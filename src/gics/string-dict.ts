/**
 * String Dictionary for GICS Schema Profiles.
 *
 * Maps string item IDs to compact numeric indices for efficient binary encoding.
 * Serialization: sorted entries with delta-encoded lengths + concatenated UTF-8 strings.
 *
 * Position in binary format: after SegmentHeader, before StreamSections.
 */
import { encodeVarint, decodeVarint } from '../gics-utils.js';

export interface StringDictionaryData {
    /** String → numeric index mapping */
    map: Map<string, number>;
    /** Ordered string entries (index = position) */
    entries: string[];
}

export class StringDictionary {
    /**
     * Build a string dictionary from an array of keys.
     * Keys are sorted for deterministic encoding.
     */
    static build(keys: string[]): StringDictionaryData {
        const unique = Array.from(new Set(keys)).sort();
        const map = new Map<string, number>();
        for (let i = 0; i < unique.length; i++) {
            map.set(unique[i], i);
        }
        return { map, entries: unique };
    }

    /**
     * Encode a string dictionary to bytes.
     *
     * Format:
     *   [entryCount: varint]
     *   [lengths: varint[] (delta-encoded)]
     *   [concatenated UTF-8 strings]
     */
    static encode(dict: StringDictionaryData): Uint8Array {
        if (dict.entries.length === 0) {
            return encodeVarint([0]);
        }

        const encoder = new TextEncoder();
        const encodedStrings: Uint8Array[] = [];
        const lengths: number[] = [];

        for (const entry of dict.entries) {
            const bytes = encoder.encode(entry);
            encodedStrings.push(bytes);
            lengths.push(bytes.length);
        }

        // Delta-encode lengths for better compression
        const deltaLengths: number[] = [lengths[0]];
        for (let i = 1; i < lengths.length; i++) {
            deltaLengths.push(lengths[i] - lengths[i - 1]);
        }

        const countBytes = encodeVarint([dict.entries.length]);
        const lengthBytes = encodeVarint(deltaLengths);

        // Concatenate all string bytes
        const totalStringBytes = encodedStrings.reduce((sum, b) => sum + b.length, 0);
        const stringPayload = new Uint8Array(totalStringBytes);
        let offset = 0;
        for (const b of encodedStrings) {
            stringPayload.set(b, offset);
            offset += b.length;
        }

        // Final: [countBytes][lengthBytes][stringPayload]
        const total = countBytes.length + lengthBytes.length + stringPayload.length;
        const result = new Uint8Array(total);
        let pos = 0;
        result.set(countBytes, pos); pos += countBytes.length;
        result.set(lengthBytes, pos); pos += lengthBytes.length;
        result.set(stringPayload, pos);
        return result;
    }

    /**
     * Decode bytes into a reverse map (numeric index → string).
     */
    static decode(data: Uint8Array): Map<number, string> {
        const result = new Map<number, string>();
        if (data.length === 0) return result;

        // Decode count
        let pos = 0;
        const countDecoded = decodeVarintAt(data, pos);
        const count = countDecoded.values[0];
        pos = countDecoded.nextPos;

        if (count === 0) return result;

        // Decode delta-encoded lengths
        const lengthsDecoded = decodeVarintN(data, pos, count);
        pos = lengthsDecoded.nextPos;

        // Un-delta the lengths
        const lengths: number[] = [lengthsDecoded.values[0]];
        for (let i = 1; i < count; i++) {
            lengths.push(lengths[i - 1] + lengthsDecoded.values[i]);
        }

        // Decode strings
        const decoder = new TextDecoder();
        for (let i = 0; i < count; i++) {
            const strBytes = data.subarray(pos, pos + lengths[i]);
            result.set(i, decoder.decode(strBytes));
            pos += lengths[i];
        }

        return result;
    }

    /**
     * Decode bytes into a forward map (string → numeric index).
     */
    static decodeForward(data: Uint8Array): Map<string, number> {
        const reverse = StringDictionary.decode(data);
        const forward = new Map<string, number>();
        for (const [idx, str] of reverse) {
            forward.set(str, idx);
        }
        return forward;
    }

    /**
     * Get the byte size of encoded dictionary data without the outer framing.
     */
    static encodedSize(data: Uint8Array): number {
        if (data.length === 0) return 0;

        let pos = 0;
        const countDecoded = decodeVarintAt(data, pos);
        const count = countDecoded.values[0];
        pos = countDecoded.nextPos;

        if (count === 0) return pos;

        const lengthsDecoded = decodeVarintN(data, pos, count);
        pos = lengthsDecoded.nextPos;

        const lengths: number[] = [lengthsDecoded.values[0]];
        for (let i = 1; i < count; i++) {
            lengths.push(lengths[i - 1] + lengthsDecoded.values[i]);
        }

        const totalStringBytes = lengths.reduce((a, b) => a + b, 0);
        return pos + totalStringBytes;
    }
}

// ── Internal varint helpers with position tracking ───────────────────────────

function decodeVarintAt(data: Uint8Array, start: number): { values: number[], nextPos: number } {
    let i = start;
    let zigzag = 0;
    let p2d = 1;

    while (i < data.length) {
        const byte = data[i++];
        zigzag += (byte & 0x7F) * p2d;
        if ((byte & 0x80) === 0) break;
        p2d *= 128;
    }

    const val = (zigzag % 2 === 0) ? (zigzag / 2) : -((zigzag + 1) / 2);
    return { values: [val], nextPos: i };
}

function decodeVarintN(data: Uint8Array, start: number, n: number): { values: number[], nextPos: number } {
    const values: number[] = [];
    let i = start;

    for (let count = 0; count < n && i < data.length; count++) {
        let zigzag = 0;
        let p2d = 1;
        while (i < data.length) {
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
