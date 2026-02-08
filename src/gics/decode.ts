import { Snapshot } from '../gics-types.js';
import { decodeVarint } from '../gics-utils.js';
import {
    GICS_MAGIC_V2, StreamId, InnerCodecId, GICS_HEADER_SIZE_V3,
    FILE_EOS_SIZE, GICS_EOS_MARKER, SEGMENT_FOOTER_SIZE, GICS_FLAGS_V3,
    GICS_ENC_HEADER_SIZE_V3
} from './format.js';
import { ContextV0 } from './context.js';
import { Codecs } from './codecs.js';
import { IncompleteDataError, IntegrityError } from './errors.js';
import { StreamSection } from './stream-section.js';
import { getOuterCodec } from './outer-codecs.js';
import { IntegrityChain, calculateCRC32 } from './integrity.js';
import type { GICSv2DecoderOptions } from './types.js';
import { SegmentHeader, SegmentFooter, SegmentIndex } from './segment.js';
import {
    deriveKey,
    verifyAuth,
    decryptSection
} from './encryption.js';

interface DecompressionResult {
    time: number[];
    lengths: number[];
    itemIds: number[];
    prices: number[];
    quantities: number[];
}

export class GICSv2Decoder {
    private readonly data: Uint8Array;
    private pos: number = 0;
    private readonly context: ContextV0;
    private readonly options: Required<GICSv2DecoderOptions>;
    private encryptionKey: Buffer | null = null;
    private encryptionFileNonce: Uint8Array | null = null;
    private isEncrypted: boolean = false;
    private fileHeaderBytes: Uint8Array | null = null;

    static resetSharedContext() {
        // kept for backward-compat in tests; no-op now
    }

    constructor(data: Uint8Array, options: GICSv2DecoderOptions = {}) {
        this.data = data;
        this.context = new ContextV0('hash_placeholder');
        const defaults: Required<GICSv2DecoderOptions> = {
            integrityMode: 'strict',
            logger: null,
            password: '',
        };
        this.options = { ...defaults, ...options };
    }

    async getAllSnapshots(): Promise<Snapshot[]> {
        if (this.data.length < GICS_MAGIC_V2.length) {
            throw new Error('Data too short');
        }

        let isV2 = true;
        for (let i = 0; i < GICS_MAGIC_V2.length; i++) {
            if (this.data[i] !== GICS_MAGIC_V2[i]) {
                isV2 = false;
                break;
            }
        }

        if (!isV2) {
            throw new IntegrityError("GICS Decoder: Legacy v1.1 format not supported.");
        }

        this.pos = GICS_MAGIC_V2.length;
        const version = this.getUint8();

        if (version === 0x03) {
            // v1.3 has 37-byte footer starting with 0xFF.
            if (this.data[this.data.length - FILE_EOS_SIZE] !== GICS_EOS_MARKER) {
                throw new IncompleteDataError('GICS v1.3: Missing File EOS marker (0xFF)');
            }

            // Re-read header with flags
            this.pos = 5;
            const flags = this.getUint32();
            this.isEncrypted = (flags & GICS_FLAGS_V3.ENCRYPTED) !== 0;
            this.fileHeaderBytes = this.data.subarray(0, GICS_HEADER_SIZE_V3);

            this.pos = GICS_HEADER_SIZE_V3;
            if (this.isEncrypted) {
                if (!this.options.password) throw new Error("GICS v1.3: Password required for encrypted file");

                const encMode = this.getUint8();
                if (encMode !== 1) throw new Error(`GICS v1.3: Unsupported encryption mode ${encMode}`);

                const salt = this.data.slice(this.pos, this.pos + 16); this.pos += 16;
                const authVerify = this.data.slice(this.pos, this.pos + 32); this.pos += 32;
                this.getUint8(); // kdfId
                const iterations = this.getUint32();
                this.getUint8(); // digestId
                this.encryptionFileNonce = this.data.slice(this.pos, this.pos + 8); this.pos += 8;

                this.encryptionKey = deriveKey(this.options.password, salt, iterations);
                if (!verifyAuth(this.encryptionKey, authVerify)) {
                    throw new IntegrityError("GICS v1.3: Invalid password");
                }
            }

            return this.getAllSnapshotsV3();
        } else if (version === 0x02) {
            if (this.data.at(-1) !== 0xFF) {
                throw new IncompleteDataError('GICS v1.2: Missing EOS marker (0xFF)');
            }
            this.pos = 9;
            return this.getAllSnapshotsV2();
        } else {
            throw new IntegrityError(`Unsupported version: ${version}`);
        }
    }

    /**
     * Optimized query: Only decompresses segments that MIGHT contain the itemId.
     */
    async query(itemId: number): Promise<Snapshot[]> {
        if (this.data.length < GICS_HEADER_SIZE_V3) throw new Error('Data too short');
        this.pos = 0;
        const magicMatch = GICS_MAGIC_V2.every((b, i) => this.data[i] === b);
        if (!magicMatch) throw new IntegrityError("Invalid Magic");
        this.pos = 4;
        const version = this.getUint8();
        if (version !== 0x03) throw new Error("Query only supported on v1.3 segments");

        this.pos = GICS_HEADER_SIZE_V3;
        const dataEnd = this.data.length - FILE_EOS_SIZE;
        const result: Snapshot[] = [];

        while (this.pos < dataEnd) {
            const { snapshots, nextPos } = await this.decodeSegment(true, itemId);
            result.push(...snapshots);
            this.pos = nextPos;
        }
        return result;
    }

    /**
     * Verifies the entire file integrity (Hash Chain, CRCs) WITHOUT decompressing payloads.
     */
    async verifyIntegrityOnly(): Promise<boolean> {
        try {
            this.pos = 0;
            // Basic header check
            if (this.data.length < GICS_HEADER_SIZE_V3) return false;
            const magicMatch = GICS_MAGIC_V2.every((b, i) => this.data[i] === b);
            if (!magicMatch) return false;
            this.pos = 4;
            const version = this.getUint8();
            if (version !== 0x03) return false; // verify() primarily for v1.3

            this.pos = 5;
            const flags = this.getUint32();
            this.isEncrypted = (flags & GICS_FLAGS_V3.ENCRYPTED) !== 0;
            this.pos = GICS_HEADER_SIZE_V3;
            if (this.isEncrypted) this.pos += GICS_ENC_HEADER_SIZE_V3;

            const dataEnd = this.data.length - FILE_EOS_SIZE;
            const integrity = new IntegrityChain();

            while (this.pos < dataEnd) {
                const segmentStart = this.pos;
                const header = SegmentHeader.deserialize(this.data.subarray(this.pos, this.pos + 14));
                this.pos += 14;
                const absoluteIndexOffset = segmentStart + header.indexOffset;

                const sections = this.extractSections(segmentStart + 14, absoluteIndexOffset);
                const nextSegmentPos = this.locateNextSegment(this.pos + 14);

                const footerBytes = this.data.subarray(nextSegmentPos - SEGMENT_FOOTER_SIZE, nextSegmentPos);
                if (footerBytes.length < SEGMENT_FOOTER_SIZE) return false;
                const footer = SegmentFooter.deserialize(footerBytes);

                // 1. Verify CRC
                const preFooter = this.data.subarray(segmentStart, nextSegmentPos - SEGMENT_FOOTER_SIZE);
                if (calculateCRC32(preFooter) !== footer.crc32) return false;

                // 2. Update Chain and verify root
                this.updateIntegrityChain(integrity, sections);
                if (!this.compareHashes(integrity.getRootHash(), footer.rootHash)) return false;

                this.pos = nextSegmentPos;
            }

            // 3. Verify File EOS
            const eosBytes = this.data.subarray(dataEnd, this.data.length);
            if (eosBytes[0] !== GICS_EOS_MARKER) return false;
            const fileRootHash = eosBytes.slice(1, 33);
            if (!this.compareHashes(fileRootHash, integrity.getRootHash())) return false;

            return true;
        } catch {
            return false;
        }
    }

    private findSegmentEnd(start: number): number {
        // v1.3 has totalLength in header
        if (this.data.length >= start + 14) {
            try {
                const header = SegmentHeader.deserialize(this.data.subarray(start, start + 14));
                if (header.totalLength > 0) return header.totalLength;
            } catch {
                // fallback to magic scanning
            }
        }
        // Fallback: Find next SG magic or FileEOS
        let p = start + 2;
        while (p < this.data.length - FILE_EOS_SIZE) {
            if (this.data[p] === 0x53 && this.data[p + 1] === 0x47) return p - start;
            p++;
        }
        return (this.data.length - FILE_EOS_SIZE) - start;
    }

    private async getAllSnapshotsV3(): Promise<Snapshot[]> {
        const snapshots: Snapshot[] = [];
        const dataEnd = this.data.length - FILE_EOS_SIZE;
        const integrity = new IntegrityChain();

        while (this.pos < dataEnd) {
            try {
                const { snapshots: segmentSnaps, nextPos } = await this.decodeSegment(false, undefined, integrity);
                snapshots.push(...segmentSnaps);
                this.pos = nextPos;
            } catch (err) {
                if (err instanceof IntegrityError) throw err;
                throw new IntegrityError(err instanceof Error ? err.message : "Segment decoding failed");
            }
        }

        // Verify File EOS
        const eosBytes = this.data.subarray(dataEnd, this.data.length);
        if (eosBytes[0] !== GICS_EOS_MARKER) throw new IncompleteDataError("Missing File EOS");
        const fileRootHash = eosBytes.slice(1, 33);
        if (!this.compareHashes(fileRootHash, integrity.getRootHash())) {
            if (this.options.integrityMode === 'strict') {
                throw new IntegrityError("File-level integrity chain mismatch");
            }
        }

        return snapshots;
    }

    private async decodeSegment(skipIfMissing: boolean, itemId?: number, chain?: IntegrityChain): Promise<{ snapshots: Snapshot[], nextPos: number, index: SegmentIndex }> {
        const segmentStart = this.pos;
        const header = SegmentHeader.deserialize(this.data.subarray(this.pos, this.pos + 14));
        this.pos += 14;
        const absoluteIndexOffset = segmentStart + header.indexOffset;

        const sections = this.extractSections(segmentStart + 14, absoluteIndexOffset);
        const nextSegmentPos = this.locateNextSegment(this.pos + 14);

        const indexBytes = this.data.subarray(absoluteIndexOffset, nextSegmentPos - SEGMENT_FOOTER_SIZE);
        if (indexBytes.length === 0 && absoluteIndexOffset < nextSegmentPos - SEGMENT_FOOTER_SIZE) {
            throw new IncompleteDataError("Segment Index truncated");
        }
        const index = SegmentIndex.deserialize(indexBytes);
        const footerBytes = this.data.subarray(nextSegmentPos - SEGMENT_FOOTER_SIZE, nextSegmentPos);
        if (footerBytes.length < SEGMENT_FOOTER_SIZE) throw new IncompleteDataError("Segment Footer truncated");
        const footer = SegmentFooter.deserialize(footerBytes);

        this.verifySegmentIntegrity(segmentStart, nextSegmentPos, footer);

        if (skipIfMissing && itemId !== undefined && !index.contains(itemId)) {
            if (chain) this.updateIntegrityChain(chain, sections);
            return { snapshots: [], nextPos: nextSegmentPos, index };
        }

        const data = await this.decompressAndDecode(sections, chain);
        let snapshots = this.reconstructSnapshots(data.time, data.lengths, data.itemIds, data.prices, data.quantities);

        if (itemId !== undefined) {
            snapshots = snapshots.filter(s => s.items.has(itemId));
        }

        return { snapshots, nextPos: nextSegmentPos, index };
    }

    private extractSections(start: number, end: number): StreamSection[] {
        let currentPos = start;
        const sections: StreamSection[] = [];
        while (currentPos < end) {
            const section = StreamSection.deserialize(this.data, currentPos, this.isEncrypted);
            sections.push(section);
            currentPos += section.totalSize;
        }
        return sections;
    }

    private locateNextSegment(start: number): number {
        let p = start;
        const dataEnd = this.data.length - FILE_EOS_SIZE;
        while (p < dataEnd) {
            if (this.data[p] === 0x53 && this.data[p + 1] === 0x47) break;
            p++;
        }
        return Math.min(p, dataEnd);
    }

    private verifySegmentIntegrity(start: number, end: number, footer: SegmentFooter) {
        const preFooter = this.data.subarray(start, end - SEGMENT_FOOTER_SIZE);
        if (calculateCRC32(preFooter) !== footer.crc32) {
            throw new IntegrityError("Segment CRC mismatch");
        }
    }

    private updateIntegrityChain(chain: IntegrityChain, sections: StreamSection[]) {
        for (const s of sections) {
            const blockCountBytes = new Uint8Array(2);
            new DataView(blockCountBytes.buffer).setUint16(0, s.blockCount, true);
            const manifestBytes = StreamSection.serializeManifest(s.manifest);
            chain.update(this.concatArrays([new Uint8Array([s.streamId]), blockCountBytes, manifestBytes, s.payload]));
        }
    }

    private async decompressAndDecode(sections: StreamSection[], chain?: IntegrityChain) {
        const res: DecompressionResult = { time: [], lengths: [], itemIds: [], prices: [], quantities: [] };
        const segmentContext = new ContextV0('segment_chain_marker');
        for (const section of sections) {
            await this.processSection(section, res, segmentContext, chain);
        }
        return res;
    }

    private async processSection(section: StreamSection, res: DecompressionResult, context: ContextV0, chain?: IntegrityChain) {
        if (chain) {
            const blockCountBytes = new Uint8Array(2);
            new DataView(blockCountBytes.buffer).setUint16(0, section.blockCount, true);
            const manifestBytes = StreamSection.serializeManifest(section.manifest);
            const dataToHash = this.concatArrays([new Uint8Array([section.streamId]), blockCountBytes, manifestBytes, section.payload]);
            const calculatedHash = chain.update(dataToHash);
            if (!this.compareHashes(calculatedHash, section.sectionHash)) {
                if (this.options.integrityMode === 'strict') throw new IntegrityError(`Hash mismatch for stream ${section.streamId}`);
            }
        }
        const outerCodec = getOuterCodec(section.outerCodecId);

        let payload = section.payload;
        if (this.isEncrypted) {
            if (!this.encryptionKey || !this.encryptionFileNonce) throw new Error("Encryption key or nonce missing");
            payload = decryptSection(
                section.payload,
                section.authTag!,
                this.encryptionKey,
                this.encryptionFileNonce,
                section.streamId,
                this.fileHeaderBytes!
            );
        }

        const decompressed = await outerCodec.decompress(payload);
        let offset = 0;
        for (const entry of section.manifest) {
            const blockPayload = decompressed.subarray(offset, offset + entry.payloadLen);
            offset += entry.payloadLen;
            const values = this.decodeBlock(section.streamId, entry.innerCodecId, entry.nItems, blockPayload, entry.flags, context);
            this.distributeValues(section.streamId, values, res);
        }
    }

    private distributeValues(streamId: StreamId, values: number[], res: DecompressionResult) {
        if (streamId === StreamId.TIME) res.time.push(...values);
        else if (streamId === StreamId.SNAPSHOT_LEN) res.lengths.push(...values);
        else if (streamId === StreamId.ITEM_ID) res.itemIds.push(...values);
        else if (streamId === StreamId.VALUE) res.prices.push(...values);
        else if (streamId === StreamId.QUANTITY) res.quantities.push(...values);
    }

    private getAllSnapshotsV2(): Snapshot[] {
        let timeData: number[] = [];
        let snapshotLengths: number[] = [];
        let itemIds: number[] = [];
        let priceData: number[] = [];
        let quantityData: number[] = [];

        const dataEnd = this.data.length - 1;

        while (this.pos < dataEnd) {
            const block = this.parseBlockV2(dataEnd);
            if (block.streamId === StreamId.TIME) timeData.push(...block.values);
            else if (block.streamId === StreamId.SNAPSHOT_LEN) snapshotLengths.push(...block.values);
            else if (block.streamId === StreamId.ITEM_ID) itemIds.push(...block.values);
            else if (block.streamId === StreamId.VALUE) priceData.push(...block.values);
            else if (block.streamId === StreamId.QUANTITY) quantityData.push(...block.values);
        }

        return this.reconstructSnapshots(timeData, snapshotLengths, itemIds, priceData, quantityData);
    }

    private parseBlockV2(dataEnd: number) {
        const BLOCK_HEADER_SIZE_V2 = 11;
        if (this.pos + BLOCK_HEADER_SIZE_V2 > dataEnd) {
            throw new IncompleteDataError('GICS: Truncated block header');
        }

        const streamId = this.getUint8();
        const codecId = this.getUint8();
        const nItems = this.getUint32();
        const payloadLen = this.getUint32();
        const blockFlags = this.getUint8();

        const payloadStart = this.pos;
        const payloadEnd = this.pos + payloadLen;
        if (payloadEnd > dataEnd) throw new IncompleteDataError('GICS: Block payload exceeds limit');

        const payload = this.data.subarray(payloadStart, payloadEnd);
        this.pos = payloadEnd;

        const values = this.decodeBlock(streamId, codecId, nItems, payload, blockFlags, this.context);
        return { streamId, values };
    }

    private decodeBlock(streamId: StreamId, codecId: InnerCodecId, nItems: number, payload: Uint8Array, blockFlags: number, context: ContextV0): number[] {
        let values: number[] = [];

        if (codecId === InnerCodecId.VARINT_DELTA || codecId === InnerCodecId.DOD_VARINT) {
            values = decodeVarint(payload);
        } else if (codecId === InnerCodecId.BITPACK_DELTA) {
            values = Codecs.decodeBitPack(payload, nItems);
        } else if (codecId === InnerCodecId.RLE_ZIGZAG || codecId === InnerCodecId.RLE_DOD) {
            values = Codecs.decodeRLE(payload);
        } else if (codecId === InnerCodecId.DICT_VARINT) {
            values = Codecs.decodeDict(payload, context);
        } else {
            return [];
        }

        const commitable = (blockFlags & 0x10) === 0;

        if (streamId === StreamId.TIME) {
            return this.decodeTimeStream(values, commitable, context);
        } else if (streamId === StreamId.VALUE) {
            const isDOD = (codecId === InnerCodecId.DOD_VARINT || codecId === InnerCodecId.RLE_DOD);
            return this.decodeValueStream(values, commitable, context, isDOD);
        } else {
            return values;
        }
    }

    private reconstructSnapshots(timeData: number[], snapshotLengths: number[], itemIds: number[], priceData: number[], quantityData: number[]): Snapshot[] {
        const result: Snapshot[] = [];

        // Phase 3: No legacy single-item fallback. SNAPSHOT_LEN stream is mandatory in v1.3.
        if (snapshotLengths.length === 0) {
            throw new IntegrityError('GICS v1.3: SNAPSHOT_LEN stream is mandatory');
        }

        // Phase 6: Cross-stream validation
        if (timeData.length !== snapshotLengths.length) {
            throw new IntegrityError(`Cross-stream mismatch: TIME length (${timeData.length}) != SNAPSHOT_LEN length (${snapshotLengths.length})`);
        }

        const totalItemsExpected = snapshotLengths.reduce((a, b) => a + b, 0);
        if (totalItemsExpected !== itemIds.length) {
            throw new IntegrityError(`Cross-stream mismatch: Sum of SNAPSHOT_LEN (${totalItemsExpected}) != ITEM_ID length (${itemIds.length})`);
        }

        if (itemIds.length !== priceData.length) {
            throw new IntegrityError(`Cross-stream mismatch: ITEM_ID length (${itemIds.length}) != VALUE length (${priceData.length})`);
        }

        if (itemIds.length !== quantityData.length) {
            throw new IntegrityError(`Cross-stream mismatch: ITEM_ID length (${itemIds.length}) != QUANTITY length (${quantityData.length})`);
        }

        let itemOffset = 0;
        for (let s = 0; s < snapshotLengths.length; s++) {
            const count = snapshotLengths[s];
            const map = new Map<number, { price: number; quantity: number }>();
            for (let j = 0; j < count; j++) {
                const id = itemIds[itemOffset] ?? 0;
                const price = priceData[itemOffset] ?? 0;
                const quantity = quantityData[itemOffset] ?? 0;
                map.set(id, { price, quantity });
                itemOffset++;
            }
            result.push({ timestamp: timeData[s] ?? 0, items: map });
        }
        return result;
    }

    private decodeTimeStream(deltas: number[], shouldCommit: boolean, context: ContextV0): number[] {
        const timestamps: number[] = [];
        let prev = context.lastTimestamp ?? 0;
        let prevDelta = context.lastTimestampDelta ?? 0;

        for (const deltaOfDelta of deltas) {
            const currentDelta = prevDelta + deltaOfDelta;
            const current = prev + currentDelta;
            timestamps.push(current);
            prev = current;
            prevDelta = currentDelta;
        }

        if (shouldCommit) {
            context.lastTimestamp = prev;
            context.lastTimestampDelta = prevDelta;
        }
        return timestamps;
    }

    private decodeValueStream(deltas: number[], shouldCommit: boolean, context: ContextV0, isDOD: boolean = false): number[] {
        const values: number[] = [];
        let prev = context.lastValue ?? 0;
        let prevDelta = context.lastValueDelta ?? 0;

        for (const rawChange of deltas) {
            let change = rawChange;
            if (isDOD) {
                const currentDelta = prevDelta + change;
                change = currentDelta;
                prevDelta = currentDelta;
            } else {
                prevDelta = change;
            }
            const current = prev + change;
            values.push(current);
            prev = current;
        }

        if (shouldCommit) {
            context.lastValue = prev;
            context.lastValueDelta = prevDelta;
        }
        return values;
    }

    private getUint8(): number {
        if (this.pos >= this.data.length) throw new IncompleteDataError("Unexpected end of data (uint8)");
        return this.data[this.pos++];
    }

    private getUint32(): number {
        const sub = this.data.subarray(this.pos, this.pos + 4);
        if (sub.length < 4) throw new IncompleteDataError("Unexpected end of data (uint32)");
        const val = new DataView(sub.buffer, sub.byteOffset, 4).getUint32(0, true);
        this.pos += 4;
        return val;
    }

    private concatArrays(arrays: Uint8Array[]): Uint8Array {
        const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
        const result = new Uint8Array(totalLength);
        let offset = 0;
        for (const arr of arrays) {
            result.set(arr, offset);
            offset += arr.length;
        }
        return result;
    }

    private compareHashes(h1: Uint8Array, h2: Uint8Array): boolean {
        if (h1.length !== h2.length) return false;
        for (let i = 0; i < h1.length; i++) {
            if (h1[i] !== h2[i]) return false;
        }
        return true;
    }
}
