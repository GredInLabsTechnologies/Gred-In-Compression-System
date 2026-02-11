import { Snapshot, GenericSnapshot } from '../gics-types.js';
import { decodeVarint } from '../gics-utils.js';
import {
    GICS_MAGIC_V2, StreamId, InnerCodecId, GICS_HEADER_SIZE_V3,
    FILE_EOS_SIZE, GICS_EOS_MARKER, SEGMENT_FOOTER_SIZE, GICS_FLAGS_V3,
    GICS_ENC_HEADER_SIZE_V3, SCHEMA_STREAM_BASE
} from './format.js';
import type { SchemaProfile } from '../gics-types.js';
import { ContextV0 } from './context.js';
import { Codecs } from './codecs.js';
import { IncompleteDataError, IntegrityError, LimitExceededError } from './errors.js';
import { StreamSection, BlockManifestEntry } from './stream-section.js';
import { getOuterCodec } from './outer-codecs.js';
import { IntegrityChain, calculateCRC32 } from './integrity.js';
import type { GICSv2DecoderOptions } from './types.js';
import { SegmentHeader, SegmentFooter, SegmentIndex } from './segment.js';
import { FieldMath } from './field-math.js';
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

/** Generic decompression result for schema-based files */
interface GenericDecompressionResult {
    time: number[];
    lengths: number[];
    itemIds: number[];
    fieldArrays: Map<number, number[]>; // streamId → decoded values
}

/** Default legacy schema (implicit for v1.3 files without HAS_SCHEMA) */
const LEGACY_SCHEMA: SchemaProfile = {
    id: 'legacy_market_data',
    version: 1,
    itemIdType: 'number',
    fields: [
        { name: 'price', type: 'numeric', codecStrategy: 'value' },
        { name: 'quantity', type: 'numeric', codecStrategy: 'structural' },
    ],
};

const ERR_DATA_TOO_SHORT = 'Data too short';

export class GICSv2Decoder {
    private readonly data: Uint8Array;
    private pos: number = 0;
    private readonly context: ContextV0;
    private readonly options: Required<GICSv2DecoderOptions>;
    private encryptionKey: Buffer | null = null;
    private encryptionFileNonce: Uint8Array | null = null;
    private isEncrypted: boolean = false;
    private hasSchema: boolean = false;
    private schema: SchemaProfile = LEGACY_SCHEMA;
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
            throw new Error(ERR_DATA_TOO_SHORT);
        }

        if (!this.verifyMagic()) {
            throw new IntegrityError("GICS Decoder: Legacy v1.1 format not supported.");
        }

        this.pos = GICS_MAGIC_V2.length;
        const version = this.getUint8();

        if (version === 0x03) {
            return this.handleV3();
        } else if (version === 0x02) {
            return this.handleV2();
        } else {
            throw new IntegrityError(`Unsupported version: ${version}`);
        }
    }

    /**
     * Decode all snapshots as generic records (for schema-based files).
     * For legacy files without schema, returns snapshots with { price, quantity } fields.
     */
    async getAllGenericSnapshots(): Promise<GenericSnapshot<Record<string, number | string>>[]> {
        if (this.data.length < GICS_MAGIC_V2.length) {
            throw new Error(ERR_DATA_TOO_SHORT);
        }
        if (!this.verifyMagic()) {
            throw new IntegrityError("GICS Decoder: Invalid magic bytes.");
        }

        this.pos = GICS_MAGIC_V2.length;
        const version = this.getUint8();
        if (version !== 0x03) throw new IntegrityError(`getAllGenericSnapshots requires v1.3, got version ${version}`);

        return this.handleV3Generic();
    }

    private async handleV3Generic(): Promise<GenericSnapshot<Record<string, number | string>>[]> {
        if (this.data[this.data.length - FILE_EOS_SIZE] !== GICS_EOS_MARKER) {
            throw new IncompleteDataError('GICS v1.3: Missing File EOS marker (0xFF)');
        }

        this.pos = 5;
        const flags = this.getUint32();
        this.isEncrypted = (flags & GICS_FLAGS_V3.ENCRYPTED) !== 0;
        this.hasSchema = (flags & GICS_FLAGS_V3.HAS_SCHEMA) !== 0;
        this.fileHeaderBytes = this.data.subarray(0, GICS_HEADER_SIZE_V3);

        this.pos = GICS_HEADER_SIZE_V3;
        if (this.isEncrypted) {
            await this.setupEncryption();
        }
        if (this.hasSchema) {
            await this.readSchemaSection();
        }

        return this.getAllGenericSnapshotsV3();
    }

    private async getAllGenericSnapshotsV3(): Promise<GenericSnapshot<Record<string, number | string>>[]> {
        const snapshots: GenericSnapshot<Record<string, number | string>>[] = [];
        const dataEnd = this.data.length - FILE_EOS_SIZE;
        const integrity = new IntegrityChain();

        while (this.pos < dataEnd) {
            const { snapshots: segmentSnaps, nextPos } = await this.decodeSegmentGeneric(integrity);
            snapshots.push(...segmentSnaps);
            this.pos = nextPos;
        }

        this.verifyFileEOS(integrity);
        return snapshots;
    }

    private verifyMagic(): boolean {
        for (let i = 0; i < GICS_MAGIC_V2.length; i++) {
            if (this.data[i] !== GICS_MAGIC_V2[i]) return false;
        }
        return true;
    }

    private async handleV3(): Promise<Snapshot[]> {
        // v1.3 has 37-byte footer starting with 0xFF.
        if (this.data[this.data.length - FILE_EOS_SIZE] !== GICS_EOS_MARKER) {
            throw new IncompleteDataError('GICS v1.3: Missing File EOS marker (0xFF)');
        }

        // Re-read header with flags
        this.pos = 5;
        const flags = this.getUint32();
        this.isEncrypted = (flags & GICS_FLAGS_V3.ENCRYPTED) !== 0;
        this.hasSchema = (flags & GICS_FLAGS_V3.HAS_SCHEMA) !== 0;
        this.fileHeaderBytes = this.data.subarray(0, GICS_HEADER_SIZE_V3);

        this.pos = GICS_HEADER_SIZE_V3;
        if (this.isEncrypted) {
            await this.setupEncryption();
        }

        // Read schema section if present
        if (this.hasSchema) {
            await this.readSchemaSection();
        }

        return this.getAllSnapshotsV3();
    }

    /**
     * Read the schema section: [schemaLength: uint32][schemaPayload: zstd-compressed JSON]
     */
    private async readSchemaSection(): Promise<void> {
        if (this.pos + 4 > this.data.length) {
            throw new IncompleteDataError('GICS v1.3: Truncated schema section length');
        }
        const schemaLen = this.getUint32();
        if (this.pos + schemaLen > this.data.length) {
            throw new IncompleteDataError('GICS v1.3: Truncated schema section payload');
        }
        const compressed = this.data.subarray(this.pos, this.pos + schemaLen);
        this.pos += schemaLen;

        const decompressed = await getOuterCodec(1 /* ZSTD */).decompress(compressed);
        const jsonStr = new TextDecoder().decode(decompressed);
        this.schema = JSON.parse(jsonStr) as SchemaProfile;
    }

    /**
     * Returns the schema profile for this file.
     * If no schema was embedded, returns the legacy implicit schema.
     * Can be called after parseHeader() or getAllSnapshots().
     */
    getSchema(): SchemaProfile {
        return this.schema;
    }

    /**
     * Parse the file header (magic, version, flags, encryption, schema) without decoding data.
     * After calling this, getSchema() returns the embedded schema.
     */
    async parseHeader(): Promise<void> {
        if (!this.verifyMagic()) {
            throw new IntegrityError("GICS Decoder: Invalid magic bytes.");
        }
        this.pos = GICS_MAGIC_V2.length;
        const version = this.getUint8();
        if (version !== 0x03) throw new IntegrityError(`Unsupported version: ${version}`);

        this.pos = 5;
        const flags = this.getUint32();
        this.isEncrypted = (flags & GICS_FLAGS_V3.ENCRYPTED) !== 0;
        this.hasSchema = (flags & GICS_FLAGS_V3.HAS_SCHEMA) !== 0;
        this.fileHeaderBytes = this.data.subarray(0, GICS_HEADER_SIZE_V3);

        this.pos = GICS_HEADER_SIZE_V3;
        if (this.isEncrypted) {
            await this.setupEncryption();
        }
        if (this.hasSchema) {
            await this.readSchemaSection();
        }
    }

    private async setupEncryption() {
        if (!this.options.password) throw new Error("GICS v1.3: Password required for encrypted file");

        const encMode = this.getUint8();
        if (encMode !== 1) throw new Error(`GICS v1.3: Unsupported encryption mode ${encMode}`);

        const salt = this.data.slice(this.pos, this.pos + 16); this.pos += 16;
        const authVerify = this.data.slice(this.pos, this.pos + 32); this.pos += 32;
        this.getUint8(); // kdfId
        const iterations = this.getUint32();
        this.getUint8(); // digestId
        this.encryptionFileNonce = this.data.slice(this.pos, this.pos + 12); this.pos += 12;

        this.encryptionKey = deriveKey(this.options.password, salt, iterations);
        if (!verifyAuth(this.encryptionKey, authVerify)) {
            throw new IntegrityError("GICS v1.3: Invalid password");
        }
    }

    private handleV2(): Snapshot[] {
        if (this.data.at(-1) !== 0xFF) {
            throw new IncompleteDataError('GICS v1.2: Missing EOS marker (0xFF)');
        }
        this.pos = 9;
        return this.getAllSnapshotsV2();
    }

    /**
     * Optimized query: Only decompresses segments that MIGHT contain the itemId.
     */
    async query(itemId: number): Promise<Snapshot[]> {
        if (this.data.length < GICS_HEADER_SIZE_V3) throw new Error(ERR_DATA_TOO_SHORT);
        this.pos = 0;
        const magicMatch = GICS_MAGIC_V2.every((b, i) => this.data[i] === b);
        if (!magicMatch) throw new IntegrityError("Invalid Magic");
        this.pos = 4;
        const version = this.getUint8();
        if (version !== 0x03) throw new Error("Query only supported on v1.3 segments");

        // Read flags to detect schema
        this.pos = 5;
        const flags = this.getUint32();
        const hasSchemaFlag = (flags & GICS_FLAGS_V3.HAS_SCHEMA) !== 0;

        this.pos = GICS_HEADER_SIZE_V3;

        // Skip schema section if present (bounds-checked, fail-closed)
        if (hasSchemaFlag) {
            if (this.pos + 4 > this.data.length) {
                throw new IncompleteDataError('GICS v1.3: Truncated schema section length');
            }
            const schemaLen = this.getUint32();
            const dataEnd = this.data.length - FILE_EOS_SIZE;
            if (this.pos + schemaLen > dataEnd) {
                throw new IncompleteDataError('GICS v1.3: Truncated schema section payload');
            }
            this.pos += schemaLen;
        }

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
     * Query by string or numeric key on schema-based files.
     * Returns matching generic snapshots, skipping segments via bloom filter.
     */
    async queryGeneric(itemKey: number | string): Promise<GenericSnapshot<Record<string, number | string>>[]> {
        await this.parseHeader();

        const dataEnd = this.data.length - FILE_EOS_SIZE;
        const result: GenericSnapshot<Record<string, number | string>>[] = [];

        while (this.pos < dataEnd) {
            const snapshots = await this.querySegmentForGeneric(itemKey);
            if (snapshots) result.push(...snapshots);
        }
        return result;
    }

    private async querySegmentForGeneric(itemKey: number | string): Promise<GenericSnapshot<Record<string, number | string>>[] | null> {
        const { sections, index, footer, nextPos, segmentStart } = this.parseSegmentParts(this.pos);
        this.verifySegmentIntegrity(segmentStart, nextPos, footer);

        const shouldSkip = typeof itemKey === 'string'
            ? !index.containsString(itemKey)
            : !index.contains(itemKey);

        if (shouldSkip) {
            this.pos = nextPos;
            return null;
        }

        let snapshots: GenericSnapshot<Record<string, number | string>>[];

        if (this.hasSchema) {
            const data = await this.decompressAndDecodeGeneric(sections);
            snapshots = this.reconstructGenericSnapshots(data, index);
            snapshots = snapshots.filter(s => s.items.has(itemKey));
        } else {
            const data = await this.decompressAndDecode(sections);
            const legacySnaps = this.reconstructSnapshots(data.time, data.lengths, data.itemIds, data.prices, data.quantities);
            const numKey = typeof itemKey === 'number' ? itemKey : Number.parseInt(itemKey, 10);
            snapshots = legacySnaps
                .filter(s => s.items.has(numKey))
                .map(s => ({
                    timestamp: s.timestamp,
                    items: new Map(
                        Array.from(s.items.entries()).map(([id, v]) => [id, { price: v.price, quantity: v.quantity } as Record<string, number | string>])
                    ),
                }));
        }

        this.pos = nextPos;
        return snapshots;
    }

    /**
     * Verifies the entire file integrity (Hash Chain, CRCs) WITHOUT decompressing payloads.
     */
    async verifyIntegrityOnly(): Promise<boolean> {
        try {
            if (!this.verifyMagic()) return false;
            this.pos = 4;
            const version = this.getUint8();
            if (version !== 0x03) return false;

            this.pos = 5;
            const flags = this.getUint32();
            this.isEncrypted = (flags & GICS_FLAGS_V3.ENCRYPTED) !== 0;
            const hasSchemaFlag = (flags & GICS_FLAGS_V3.HAS_SCHEMA) !== 0;

            const dataEnd = this.data.length - FILE_EOS_SIZE;

            this.pos = GICS_HEADER_SIZE_V3;
            if (this.isEncrypted) this.pos += GICS_ENC_HEADER_SIZE_V3;

            // Skip schema section if present (bounds-checked)
            if (hasSchemaFlag) {
                if (this.pos + 4 > this.data.length) return false;
                const schemaLen = this.getUint32();
                if (this.pos + schemaLen > dataEnd) return false;
                this.pos += schemaLen;
            }

            const integrity = new IntegrityChain();

            while (this.pos < dataEnd) {
                const result = this.verifySegmentAt(this.pos, integrity);
                if (!result.success) return false;
                this.pos = result.nextPos;
            }

            this.verifyFileEOS(integrity);
            return true;
        } catch {
            return false;
        }
    }

    private verifySegmentAt(pos: number, integrity: IntegrityChain): { success: boolean, nextPos: number } {
        try {
            const { sections, footer, nextPos, segmentStart, footerPos } = this.parseSegmentParts(pos);

            // 1. Verify CRC
            const preFooter = this.data.subarray(segmentStart, footerPos);
            if (calculateCRC32(preFooter) !== footer.crc32) return { success: false, nextPos: pos };

            // 2. Update Chain and verify root
            this.updateIntegrityChain(integrity, sections);
            if (!this.compareHashes(integrity.getRootHash(), footer.rootHash)) return { success: false, nextPos: pos };

            return { success: true, nextPos };
        } catch {
            return { success: false, nextPos: pos };
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
            snapshots.push(...await this.decodeNextSegment(integrity));
        }

        this.verifyFileEOS(integrity);
        return snapshots;
    }

    private async decodeNextSegment(integrity: IntegrityChain): Promise<Snapshot[]> {
        try {
            const { snapshots: segmentSnaps, nextPos } = await this.decodeSegment(false, undefined, integrity);
            this.pos = nextPos;
            return segmentSnaps;
        } catch (err) {
            if (err instanceof IntegrityError || err instanceof LimitExceededError) throw err;
            throw new IntegrityError(err instanceof Error ? err.message : "Segment decoding failed");
        }
    }

    private verifyFileEOS(integrity: IntegrityChain) {
        const dataEnd = this.data.length - FILE_EOS_SIZE;
        const eosBytes = this.data.subarray(dataEnd, this.data.length);
        if (eosBytes[0] !== GICS_EOS_MARKER) throw new IncompleteDataError("Missing File EOS");
        const fileRootHash = eosBytes.slice(1, 33);
        if (!this.compareHashes(fileRootHash, integrity.getRootHash())) {
            if (this.options.integrityMode === 'strict') {
                throw new IntegrityError("File-level integrity chain mismatch");
            }
        }
    }

    private async decodeSegment(skipIfMissing: boolean, itemId?: number, chain?: IntegrityChain): Promise<{ snapshots: Snapshot[], nextPos: number, index: SegmentIndex }> {
        const { sections, index, footer, nextPos, segmentStart } = this.parseSegmentParts(this.pos);

        this.verifySegmentIntegrity(segmentStart, nextPos, footer);

        if (skipIfMissing && itemId !== undefined && !index.contains(itemId)) {
            if (chain) this.updateIntegrityChain(chain, sections);
            return { snapshots: [], nextPos, index };
        }

        const data = await this.decompressAndDecode(sections, chain);
        let snapshots = this.reconstructSnapshots(data.time, data.lengths, data.itemIds, data.prices, data.quantities);

        if (itemId !== undefined) {
            snapshots = snapshots.filter(s => s.items.has(itemId));
        }

        return { snapshots, nextPos, index };
    }

    private async decodeSegmentGeneric(chain?: IntegrityChain): Promise<{
        snapshots: GenericSnapshot<Record<string, number | string>>[], nextPos: number, index: SegmentIndex
    }> {
        const { sections, index, footer, nextPos, segmentStart } = this.parseSegmentParts(this.pos);
        this.verifySegmentIntegrity(segmentStart, nextPos, footer);

        if (this.hasSchema) {
            const data = await this.decompressAndDecodeGeneric(sections, chain);
            const snapshots = this.reconstructGenericSnapshots(data, index);
            return { snapshots, nextPos, index };
        } else {
            // Legacy: convert Snapshot[] to GenericSnapshot[]
            const data = await this.decompressAndDecode(sections, chain);
            const legacySnaps = this.reconstructSnapshots(data.time, data.lengths, data.itemIds, data.prices, data.quantities);
            const genericSnaps: GenericSnapshot<Record<string, number | string>>[] = legacySnaps.map(s => ({
                timestamp: s.timestamp,
                items: new Map(
                    Array.from(s.items.entries()).map(([id, v]) => [id, { price: v.price, quantity: v.quantity } as Record<string, number | string>])
                ),
            }));
            return { snapshots: genericSnaps, nextPos, index };
        }
    }

    private async decompressAndDecodeGeneric(sections: StreamSection[], chain?: IntegrityChain): Promise<GenericDecompressionResult> {
        const res: GenericDecompressionResult = { time: [], lengths: [], itemIds: [], fieldArrays: new Map() };
        const segmentContext = new ContextV0('segment_chain_marker');

        for (const section of sections) {
            if (chain) this.verifySectionHash(section, chain);
            this.checkDecompressionLimit(section.uncompressedLen);

            let payload = section.payload;
            if (this.isEncrypted) {
                payload = this.decryptSectionPayload(section);
            }

            const decompressed = await getOuterCodec(section.outerCodecId).decompress(payload);

            if (decompressed.length !== section.uncompressedLen) {
                throw new IntegrityError(`Decompression size mismatch: expected ${section.uncompressedLen}, got ${decompressed.length}`);
            }

            this.decodeGenericSectionBlocks(section, decompressed, segmentContext, res);
        }
        return res;
    }

    private decodeGenericSectionBlocks(section: StreamSection, decompressed: Uint8Array, context: ContextV0, res: GenericDecompressionResult) {
        let offset = 0;
        for (const entry of section.manifest) {
            const blockPayload = decompressed.subarray(offset, offset + entry.payloadLen);
            offset += entry.payloadLen;

            const streamId = section.streamId;
            const values = this.decodeGenericBlock(streamId, entry.innerCodecId, entry.nItems, blockPayload, entry.flags, context);

            if (streamId === StreamId.TIME) {
                res.time.push(...values);
            } else if (streamId === StreamId.SNAPSHOT_LEN) {
                res.lengths.push(...values);
            } else if (streamId === StreamId.ITEM_ID) {
                res.itemIds.push(...values);
            } else if (streamId >= SCHEMA_STREAM_BASE) {
                if (!res.fieldArrays.has(streamId)) res.fieldArrays.set(streamId, []);
                res.fieldArrays.get(streamId)!.push(...values);
            }
        }
    }

    /**
     * Decode a single block. For TIME stream, applies DOD decoding.
     * For schema field streams (100+), just raw codec dispatch (no state tracking).
     */
    private decodeGenericBlock(streamId: number, codecId: InnerCodecId, nItems: number, payload: Uint8Array, blockFlags: number, context: ContextV0): number[] {
        const values = this.dispatchCodec(codecId, payload, nItems, context);
        if (values.length === 0) return [];

        if (streamId === StreamId.TIME) {
            return this.decodeTimeStream(values, true, context);
        }
        // Schema field streams and structural streams: raw values, no state tracking
        return values;
    }

    private reconstructGenericSnapshots(
        data: GenericDecompressionResult,
        index: SegmentIndex
    ): GenericSnapshot<Record<string, number | string>>[] {
        const schema = this.schema;
        const totalItems = data.lengths.reduce((a, b) => a + b, 0);

        this.validateGenericDataLengths(data, totalItems);
        const reverseEnumMaps = this.buildReverseEnumMaps();
        const stringDict = index.stringDict;

        const result: GenericSnapshot<Record<string, number | string>>[] = [];
        let itemOffset = 0;

        for (let s = 0; s < data.lengths.length; s++) {
            const count = data.lengths[s];
            const items = new Map<number | string, Record<string, number | string>>();

            for (let j = 0; j < count; j++) {
                const numericId = data.itemIds[itemOffset];
                const key = (schema.itemIdType === 'string' && stringDict)
                    ? (stringDict.entries[numericId] ?? numericId)
                    : numericId;

                items.set(key, this.buildItemRecord(data, itemOffset, reverseEnumMaps));
                itemOffset++;
            }

            result.push({ timestamp: data.time[s] ?? 0, items });
        }

        return result;
    }

    private validateGenericDataLengths(data: GenericDecompressionResult, totalItems: number) {
        if (data.time.length !== data.lengths.length) {
            throw new IntegrityError(`Cross-stream mismatch: TIME (${data.time.length}) != SNAPSHOT_LEN (${data.lengths.length})`);
        }
        if (totalItems !== data.itemIds.length) {
            throw new IntegrityError(`Cross-stream mismatch: Sum of SNAPSHOT_LEN (${totalItems}) != ITEM_ID (${data.itemIds.length})`);
        }
        for (let i = 0; i < this.schema.fields.length; i++) {
            const streamId = SCHEMA_STREAM_BASE + i;
            const fieldVals = data.fieldArrays.get(streamId) ?? [];
            if (fieldVals.length !== totalItems) {
                throw new IntegrityError(`Cross-stream mismatch: field '${this.schema.fields[i].name}' length (${fieldVals.length}) != ITEM_ID (${totalItems})`);
            }
        }
    }

    private buildReverseEnumMaps(): Map<string, Map<number, string>> {
        const reverseEnumMaps = new Map<string, Map<number, string>>();
        for (const field of this.schema.fields) {
            if (field.type === 'categorical' && field.enumMap) {
                const reverse = new Map<number, string>();
                for (const [str, num] of Object.entries(field.enumMap)) {
                    reverse.set(num, str);
                }
                reverseEnumMaps.set(field.name, reverse);
            }
        }
        return reverseEnumMaps;
    }

    private buildItemRecord(
        data: GenericDecompressionResult,
        itemOffset: number,
        reverseEnumMaps: Map<string, Map<number, string>>
    ): Record<string, number | string> {
        const record: Record<string, number | string> = {};
        for (let f = 0; f < this.schema.fields.length; f++) {
            const field = this.schema.fields[f];
            const streamId = SCHEMA_STREAM_BASE + f;
            const rawVal = data.fieldArrays.get(streamId)![itemOffset];

            if (field.type === 'categorical' && reverseEnumMaps.has(field.name)) {
                const reverseMap = reverseEnumMaps.get(field.name)!;
                record[field.name] = reverseMap.get(rawVal) ?? rawVal;
            } else {
                record[field.name] = rawVal;
            }
        }
        return record;
    }

    private parseSegmentParts(pos: number): {
        header: SegmentHeader,
        sections: StreamSection[],
        index: SegmentIndex,
        footer: SegmentFooter,
        nextPos: number,
        segmentStart: number,
        footerPos: number
    } {
        const segmentStart = pos;
        const header = SegmentHeader.deserialize(this.data.subarray(pos, pos + 14));
        const absoluteIndexOffset = segmentStart + header.indexOffset;
        const sections = this.extractSections(segmentStart + 14, absoluteIndexOffset);

        // Use totalLength from header when available; fall back to magic scanning
        const nextPos = header.totalLength > 0
            ? segmentStart + header.totalLength
            : this.locateNextSegment(pos + 14);
        const footerPos = nextPos - SEGMENT_FOOTER_SIZE;
        const footerBytes = this.data.subarray(footerPos, nextPos);
        if (footerBytes.length < SEGMENT_FOOTER_SIZE) throw new IncompleteDataError("Segment Footer truncated");
        const footer = SegmentFooter.deserialize(footerBytes);

        const indexBytes = this.data.subarray(absoluteIndexOffset, footerPos);
        if (indexBytes.length === 0 && absoluteIndexOffset < footerPos) {
            throw new IncompleteDataError("Segment Index truncated");
        }
        const index = SegmentIndex.deserialize(indexBytes);

        return { header, sections, index, footer, nextPos, segmentStart, footerPos };
    }

    private extractSections(start: number, end: number): StreamSection[] {
        let currentPos = start;
        const sections: StreamSection[] = [];
        // Safety: Ensure we don't loop infinitely or OOM if 'end' is huge but sections are 0-size (impossible as header=12 min)
        while (currentPos < end) {
            // Extra safety against start offset being out of bounds for the view creation
            if (currentPos >= this.data.length) throw new IncompleteDataError("Section offset out of bounds");

            const section = StreamSection.deserialize(this.data, currentPos, this.isEncrypted);

            // Safety: section end must not exceed 'end' (which is the index start)
            if (currentPos + section.totalSize > end) {
                throw new IntegrityError("Section extends beyond section area");
            }

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
            this.verifySectionHash(section, chain);
        }

        this.checkDecompressionLimit(section.uncompressedLen);

        let payload = section.payload;
        if (this.isEncrypted) {
            payload = this.decryptSectionPayload(section);
        }

        const decompressed = await getOuterCodec(section.outerCodecId).decompress(payload);

        if (decompressed.length !== section.uncompressedLen) {
            throw new IntegrityError(`Decompression size mismatch: expected ${section.uncompressedLen}, got ${decompressed.length}`);
        }

        this.decodeAndDistributeSection(section.streamId, section.manifest, decompressed, context, res);
    }

    private verifySectionHash(section: StreamSection, chain: IntegrityChain) {
        const blockCountBytes = new Uint8Array(2);
        new DataView(blockCountBytes.buffer).setUint16(0, section.blockCount, true);
        const manifestBytes = StreamSection.serializeManifest(section.manifest);
        const dataToHash = this.concatArrays([new Uint8Array([section.streamId]), blockCountBytes, manifestBytes, section.payload]);
        const calculatedHash = chain.update(dataToHash);

        if (!this.compareHashes(calculatedHash, section.sectionHash)) {
            if (this.options.integrityMode === 'strict') throw new IntegrityError(`Hash mismatch for stream ${section.streamId}`);
        }
    }

    private decryptSectionPayload(section: StreamSection): Uint8Array {
        if (!this.encryptionKey || !this.encryptionFileNonce) throw new Error("Encryption key or nonce missing");
        return decryptSection(
            section.payload,
            section.authTag!,
            this.encryptionKey,
            this.encryptionFileNonce,
            section.streamId,
            this.fileHeaderBytes!
        );
    }

    private decodeAndDistributeSection(streamId: StreamId, manifest: BlockManifestEntry[], decompressed: Uint8Array, context: ContextV0, res: DecompressionResult) {
        let offset = 0;
        for (const entry of manifest) {
            const blockPayload = decompressed.subarray(offset, offset + entry.payloadLen);
            offset += entry.payloadLen;
            const values = this.decodeBlock(streamId, entry.innerCodecId, entry.nItems, blockPayload, entry.flags, context);
            this.distributeValues(streamId, values, res);
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
        const timeData: number[] = [];
        const snapshotLengths: number[] = [];
        const itemIds: number[] = [];
        const priceData: number[] = [];
        const quantityData: number[] = [];

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
        const values = this.dispatchCodec(codecId, payload, nItems, context);
        if (values.length === 0) return [];

        // Always commit state: encoder commits unconditionally (encode.ts:512-519),
        // so decoder must match. HEALTH_QUAR (0x10) is a health annotation, not a skip signal.
        if (streamId === StreamId.TIME) {
            return this.decodeTimeStream(values, true, context);
        } else if (streamId === StreamId.VALUE) {
            const isDOD = (codecId === InnerCodecId.DOD_VARINT || codecId === InnerCodecId.RLE_DOD);
            return this.decodeValueStream(values, true, context, isDOD);
        } else {
            return values;
        }
    }

    private dispatchCodec(codecId: InnerCodecId, payload: Uint8Array, nItems: number, context: ContextV0): number[] {
        switch (codecId) {
            case InnerCodecId.VARINT_DELTA:
            case InnerCodecId.DOD_VARINT:
                return decodeVarint(payload);
            case InnerCodecId.BITPACK_DELTA:
                return Codecs.decodeBitPack(payload, nItems);
            case InnerCodecId.RLE_ZIGZAG:
            case InnerCodecId.RLE_DOD:
                return Codecs.decodeRLE(payload);
            case InnerCodecId.DICT_VARINT:
                return Codecs.decodeDict(payload, context);
            case InnerCodecId.FIXED64_LE:
                return Codecs.decodeFixed64(payload, nItems);
            default:
                return [];
        }
    }

    private reconstructSnapshots(timeData: number[], snapshotLengths: number[], itemIds: number[], priceData: number[], quantityData: number[]): Snapshot[] {
        this.validateCrossStreams(timeData, snapshotLengths, itemIds, priceData, quantityData);

        const result: Snapshot[] = [];
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

    private validateCrossStreams(timeData: number[], snapshotLengths: number[], itemIds: number[], priceData: number[], quantityData: number[]) {
        if (snapshotLengths.length === 0) {
            throw new IntegrityError('GICS v1.3: SNAPSHOT_LEN stream is mandatory');
        }

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
    }

    private decodeTimeStream(deltas: number[], shouldCommit: boolean, context: ContextV0): number[] {
        const result = FieldMath.decodeTimeStream(deltas, context.lastTimestamp ?? 0, context.lastTimestampDelta ?? 0);
        if (shouldCommit) {
            context.lastTimestamp = result.nextTimestamp;
            context.lastTimestampDelta = result.nextTimestampDelta;
        }
        return result.timestamps;
    }

    private decodeValueStream(deltas: number[], shouldCommit: boolean, context: ContextV0, isDOD: boolean = false): number[] {
        const result = FieldMath.decodeValueStream(deltas, context.lastValue ?? 0, context.lastValueDelta ?? 0, isDOD);
        if (shouldCommit) {
            context.lastValue = result.nextValue;
            context.lastValueDelta = result.nextValueDelta;
        }
        return result.values;
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

    private checkDecompressionLimit(len: number) {
        // Limit: 64MB per section.
        // Segments are usually 1MB. 64MB is a very generous safety upper bound.
        const MAX_ALLOCATION = 64 * 1024 * 1024;
        if (len > MAX_ALLOCATION) {
            throw new LimitExceededError(`Decompression size ${len} exceeds limit of ${MAX_ALLOCATION}`);
        }
    }

    private compareHashes(h1: Uint8Array, h2: Uint8Array): boolean {
        if (h1.length !== h2.length) return false;
        for (let i = 0; i < h1.length; i++) {
            if (h1[i] !== h2[i]) return false;
        }
        return true;
    }
}
