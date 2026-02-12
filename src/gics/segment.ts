import { SEGMENT_MAGIC, SEGMENT_FOOTER_SIZE } from './format.js';
import { StreamSection } from './stream-section.js';
import { encodeVarint, decodeVarint } from '../gics-utils.js';
import { Snapshot } from '../gics-types.js';
import { StringDictionary, StringDictionaryData } from './string-dict.js';

/**
 * Simple Bloom Filter for ItemID existence check.
 */
export class BloomFilter {
    public readonly bits: Uint8Array;
    constructor(sizeBytes: number = 256) {
        this.bits = new Uint8Array(sizeBytes).fill(0);
    }

    add(id: number) {
        const h1 = this.hash(id, 0x12345678);
        const h2 = this.hash(id, 0x87654321);
        const h3 = this.hash(id, 0xABCDEF01);
        this.setBit(h1);
        this.setBit(h2);
        this.setBit(h3);
    }

    private hash(val: number, seed: number): number {
        let h = seed ^ val;
        h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
        h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
        return (h ^ (h >>> 16)) >>> 0;
    }

    private setBit(hash: number) {
        const bitIdx = hash % (this.bits.length * 8);
        const byteIdx = bitIdx >>> 3;
        const bitOffset = bitIdx & 7;
        this.bits[byteIdx] |= (1 << bitOffset);
    }

    maybeContains(id: number): boolean {
        const h1 = this.hash(id, 0x12345678);
        const h2 = this.hash(id, 0x87654321);
        const h3 = this.hash(id, 0xABCDEF01);
        return this.getBit(h1) && this.getBit(h2) && this.getBit(h3);
    }

    private getBit(hash: number): boolean {
        const bitIdx = hash % (this.bits.length * 8);
        const byteIdx = bitIdx >>> 3;
        const bitOffset = bitIdx & 7;
        return (this.bits[byteIdx] & (1 << bitOffset)) !== 0;
    }
}

/**
 * Segment Index: Bloom Filter + Sorted ItemIDs.
 * Optionally includes a StringDictionary for string-keyed schemas.
 */
export class SegmentIndex {
    constructor(
        public readonly bloom: BloomFilter,
        public readonly sortedItemIds: number[],
        public readonly stringDict?: StringDictionaryData
    ) { }

    serialize(): Uint8Array {
        const sortedDeltas: number[] = [];
        let prev = 0;
        for (const id of this.sortedItemIds) {
            sortedDeltas.push(id - prev);
            prev = id;
        }
        const deltaBytes = encodeVarint(sortedDeltas);

        // String dict bytes: only present when schema uses string IDs
        // IMPORTANT: When no stringDict, emit ZERO extra bytes to preserve v1.3 byte-identical output
        const dictBytes = this.stringDict ? StringDictionary.encode(this.stringDict) : null;

        const dictSection = dictBytes
            ? 1 + 4 + dictBytes.length  // flag(1) + length(4) + payload
            : 0;                         // nothing — legacy format

        const totalSize = 2 + this.bloom.bits.length + 4 + deltaBytes.length + dictSection;
        const buffer = new Uint8Array(totalSize);
        const view = new DataView(buffer.buffer);

        let pos = 0;
        view.setUint16(pos, this.bloom.bits.length, true); pos += 2;
        buffer.set(this.bloom.bits, pos); pos += this.bloom.bits.length;

        view.setUint32(pos, this.sortedItemIds.length, true); pos += 4;
        buffer.set(deltaBytes, pos); pos += deltaBytes.length;

        // String dictionary section — only when present
        if (dictBytes) {
            buffer[pos++] = 1; // hasDict flag
            view.setUint32(pos, dictBytes.length, true); pos += 4;
            buffer.set(dictBytes, pos);
        }

        return buffer;
    }

    static deserialize(data: Uint8Array): SegmentIndex {
        if (data.length < 2) throw new Error("Truncated Segment Index (header)");
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        let pos = 0;

        const bloomSize = view.getUint16(pos, true); pos += 2;
        if (data.length < pos + bloomSize) throw new Error("Truncated Segment Index (bloom)");
        const bf = new BloomFilter(bloomSize);
        bf.bits.set(data.subarray(pos, pos + bloomSize)); pos += bloomSize;

        if (data.length < pos + 4) throw new Error("Truncated Segment Index (count)");
        const count = view.getUint32(pos, true); pos += 4;

        // Decode sorted item IDs — need to know how many varint bytes were consumed
        const deltaData = data.subarray(pos);
        const deltas = decodeVarint(deltaData);

        const itemIds: number[] = [];
        let current = 0;
        for (let i = 0; i < count && i < deltas.length; i++) {
            current += deltas[i];
            itemIds.push(current);
        }

        // Calculate consumed bytes for varint section by re-encoding (needed for precise pos tracking)
        const consumedVarintBytes = encodeVarint(deltas.slice(0, count)).length;
        pos += consumedVarintBytes;

        // String dictionary (optional, added by schema profiles)
        let stringDict: StringDictionaryData | undefined;
        if (pos < data.length) {
            const hasDict = data[pos++];
            if (hasDict === 1 && pos + 4 <= data.length) {
                const dictLen = view.getUint32(pos, true); pos += 4;
                if (pos + dictLen <= data.length) {
                    const dictData = data.subarray(pos, pos + dictLen);
                    const reverseMap = StringDictionary.decode(dictData);
                    const entries: string[] = [];
                    const forwardMap = new Map<string, number>();
                    for (const [idx, str] of reverseMap) {
                        entries[idx] = str;
                        forwardMap.set(str, idx);
                    }
                    stringDict = { map: forwardMap, entries };
                }
            }
        }

        return new SegmentIndex(bf, itemIds, stringDict);
    }

    contains(itemId: number): boolean {
        if (!this.bloom.maybeContains(itemId)) return false;
        let low = 0;
        let high = this.sortedItemIds.length - 1;
        while (low <= high) {
            const mid = (low + high) >>> 1;
            const val = this.sortedItemIds[mid];
            if (val === itemId) return true;
            if (val < itemId) low = mid + 1;
            else high = mid - 1;
        }
        return false;
    }

    /**
     * Query by string key. Looks up the string dict for the numeric mapping,
     * then delegates to the standard contains() path.
     */
    containsString(key: string): boolean {
        if (!this.stringDict) return false;
        const numericId = this.stringDict.map.get(key);
        if (numericId === undefined) return false;
        return this.contains(numericId);
    }
}

/**
 * Segment Header (14 bytes).
 * SG(2) + indexOffset(4) + totalLength(4) + flags(1) + reserved(1) + itemsPerSnapshot(2)
 */
export class SegmentHeader {
    constructor(
        public readonly indexOffset: number,
        public readonly totalLength: number,
        public readonly flags: number = 0,
        public readonly itemsPerSnapshot: number = 0
    ) { }

    serialize(): Uint8Array {
        const buffer = new Uint8Array(14);
        const view = new DataView(buffer.buffer);
        buffer.set(SEGMENT_MAGIC, 0);
        view.setUint32(2, this.indexOffset, true);
        view.setUint32(6, this.totalLength, true);
        buffer[10] = this.flags;
        // byte 11 reserved
        view.setUint16(12, this.itemsPerSnapshot, true);
        return buffer;
    }

    static deserialize(data: Uint8Array): SegmentHeader {
        if (data.length < 14) throw new Error("Truncated Segment Header");
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        if (data[0] !== SEGMENT_MAGIC[0] || data[1] !== SEGMENT_MAGIC[1]) {
            throw new Error("Invalid Segment Magic");
        }
        const indexOffset = view.getUint32(2, true);
        const totalLength = view.getUint32(6, true);
        const flags = data[10];
        const itemsPerSnapshot = view.getUint16(12, true);
        return new SegmentHeader(indexOffset, totalLength, flags, itemsPerSnapshot);
    }
}

/**
 * Segment Footers.
 */
export class SegmentFooter {
    constructor(
        public readonly rootHash: Uint8Array,
        public readonly crc32: number
    ) { }

    serialize(): Uint8Array {
        const buffer = new Uint8Array(SEGMENT_FOOTER_SIZE);
        const view = new DataView(buffer.buffer);
        buffer.set(this.rootHash, 0);
        view.setUint32(32, this.crc32, true);
        return buffer;
    }

    static deserialize(data: Uint8Array): SegmentFooter {
        if (data.length < SEGMENT_FOOTER_SIZE) throw new Error("Truncated Segment Footer");
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const hash = data.slice(0, 32);
        const crc = view.getUint32(32, true);
        return new SegmentFooter(hash, crc);
    }
}

/**
 * High-level Segment representation.
 */
export class Segment {
    constructor(
        public readonly header: SegmentHeader,
        public readonly sections: StreamSection[],
        public readonly index: SegmentIndex,
        public readonly footer: SegmentFooter
    ) { }

    serialize(): Uint8Array {
        const headerBytes = this.header.serialize();
        const sectionBytesList = this.sections.map(s => s.serialize());
        const indexBytes = this.index.serialize();
        const footerBytes = this.footer.serialize();

        const totalSize = headerBytes.length + sectionBytesList.reduce((acc, b) => acc + b.length, 0) + indexBytes.length + footerBytes.length;
        const buffer = new Uint8Array(totalSize);

        let pos = 0;
        buffer.set(headerBytes, pos); pos += headerBytes.length;
        for (const b of sectionBytesList) {
            buffer.set(b, pos); pos += b.length;
        }
        buffer.set(indexBytes, pos); pos += indexBytes.length;
        buffer.set(footerBytes, pos);

        return buffer;
    }
}

/**
 * Logic for splitting snapshots into segments.
 */
export class SegmentBuilder {
    private currentSnapshots: Snapshot[] = [];
    private currentSize: number = 0;
    private readonly limit: number;

    constructor(limit: number = 1024 * 1024) {
        this.limit = limit;
    }

    push(snapshot: Snapshot): boolean {
        this.currentSnapshots.push(snapshot);
        this.currentSize += this.estimateSize(snapshot);
        return this.currentSize >= this.limit;
    }

    private estimateSize(snapshot: Snapshot): number {
        // Rough estimate of uncompressed data volume
        return 12 + (snapshot.items?.size ?? 0) * 12;
    }

    seal(): Snapshot[] {
        const snaps = this.currentSnapshots;
        this.currentSnapshots = [];
        this.currentSize = 0;
        return snaps;
    }

    get pendingCount(): number {
        return this.currentSnapshots.length;
    }
}
