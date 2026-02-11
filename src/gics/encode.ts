import { Snapshot, GenericSnapshot } from '../gics-types.js';
import { encodeVarint } from '../gics-utils.js';
import {
    GICS_MAGIC_V2, V12_FLAGS, StreamId, InnerCodecId, OuterCodecId,
    GICS_VERSION_BYTE, HealthTag, GICS_HEADER_SIZE_V3, FILE_EOS_SIZE,
    GICS_EOS_MARKER, SEGMENT_FOOTER_SIZE, GICS_FLAGS_V3, GICS_ENC_HEADER_SIZE_V3,
    SCHEMA_STREAM_BASE
} from './format.js';
import { ContextV0, ContextSnapshot } from './context.js';
import { calculateBlockMetrics, classifyRegime, BlockMetrics } from './metrics.js';
import { Codecs } from './codecs.js';
import { HealthMonitor, RoutingDecision } from './chm.js';
import type { GICSv2EncoderOptions } from './types.js';
import { StreamSection, BlockManifestEntry } from './stream-section.js';
import { getOuterCodec } from './outer-codecs.js';
import { IntegrityChain, calculateCRC32 } from './integrity.js';
import { SegmentBuilder, Segment, SegmentHeader, SegmentFooter, SegmentIndex, BloomFilter } from './segment.js';
import { StringDictionary, StringDictionaryData } from './string-dict.js';
import { FileAccess } from './file-access.js';
import type { FileHandle } from 'node:fs/promises';
import { BlockStats } from './telemetry-types.js';
import { FieldMath } from './field-math.js';
import {
    deriveKey,
    generateAuthVerify,
    encryptSection,
    generateEncryptionSecrets
} from './encryption.js';

const BLOCK_SIZE = 1000;

interface DataFeatures {
    timestamps: number[];
    snapshotLengths: number[];
    itemIds: number[];
    prices: number[];
    quantities: number[];
}

/** Extended features for schema-based encoding */
interface SchemaDataFeatures {
    timestamps: number[];
    snapshotLengths: number[];
    itemIds: number[]; // numeric IDs (mapped from strings if needed)
    fieldArrays: Map<string, number[]>; // fieldName → values
    stringDict?: StringDictionaryData; // only for string itemIds
}

type BlockProcessor = (streamId: StreamId, chunk: number[], inputData: number[], stateSnapshot: ContextSnapshot, chm: HealthMonitor) => void;

export class GICSv2Encoder {
    private snapshots: Array<Snapshot | GenericSnapshot<Record<string, number | string>>> = [];
    private context: ContextV0 | null;
    private readonly chmTime: HealthMonitor;
    private readonly chmValue: HealthMonitor;
    private readonly mode: 'on' | 'off';
    private lastTelemetry: {
        blocks: BlockStats[];
        total_blocks: number;
        core_input_bytes: number;
        core_output_bytes: number;
        core_ratio: number;
        quarantine_input_bytes: number;
        quarantine_output_bytes: number;
        quarantine_rate: number;
        quarantine_blocks: number;
        sidecar?: string | null;
    } | null = null;
    private isFinalized = false;
    private hasEmittedHeader = false;
    private readonly runId: string;
    private readonly options: Required<GICSv2EncoderOptions>;
    private integrity: IntegrityChain;
    private fileHandle: FileHandle | null = null;
    private readonly accumulatedBytes: Uint8Array[] = [];
    private readonly encryptionKey: Buffer | null = null;
    private readonly encryptionSalt: Uint8Array | null = null;
    private readonly encryptionFileNonce: Uint8Array | null = null;
    private readonly authVerify: Uint8Array | null = null;

    static reset() {
        // Backward-compat for existing tests. No global mutable state is used anymore.
    }

    static resetSharedContext() {
        // Backward-compat for existing tests. No global mutable state is used anymore.
    }

    static async openFile(handle: FileHandle, options: GICSv2EncoderOptions = {}): Promise<GICSv2Encoder> {
        const encoder = new GICSv2Encoder(options);
        encoder.fileHandle = handle;
        const prevHash = await FileAccess.prepareForAppend(handle);
        if (prevHash) {
            encoder.integrity = new IntegrityChain(prevHash);
            encoder.hasEmittedHeader = true;
        }
        return encoder;
    }

    constructor(options: GICSv2EncoderOptions = {}) {
        const defaults: Required<GICSv2EncoderOptions> = {
            runId: `run_${Date.now()}_${crypto.randomUUID().slice(0, 5)}`,
            contextMode: 'on',
            probeInterval: 4,
            sidecarWriter: null,
            logger: null,
            segmentSizeLimit: 1024 * 1024, // 1MB
            password: '',
            schema: undefined as unknown as import('../gics-types.js').SchemaProfile,
        };
        this.options = { ...defaults, ...options };

        if (this.options.password) {
            const secrets = generateEncryptionSecrets();
            this.encryptionSalt = secrets.salt;
            this.encryptionFileNonce = secrets.fileNonce;
            this.encryptionKey = deriveKey(this.options.password, this.encryptionSalt, 100000);
            this.authVerify = generateAuthVerify(this.encryptionKey);
        }

        this.runId = this.options.runId;
        this.mode = this.options.contextMode;

        this.context = this.mode === 'off'
            ? new ContextV0('hash_placeholder', null)
            : new ContextV0('hash_placeholder');

        this.chmTime = new HealthMonitor(`${this.runId}:TIME`, this.options.probeInterval, this.options.logger);
        this.chmValue = new HealthMonitor(`${this.runId}:VALUE`, this.options.probeInterval, this.options.logger);

        this.integrity = new IntegrityChain();
    }

    async addSnapshot(snapshot: Snapshot | GenericSnapshot<Record<string, number | string>>): Promise<void> {
        if (this.isFinalized) throw new Error("GICSv2Encoder: Cannot append after finalize()");
        this.snapshots.push(snapshot);
    }

    async push(snapshot: Snapshot | GenericSnapshot<Record<string, number | string>>): Promise<void> {
        await this.addSnapshot(snapshot);
    }

    getTelemetry() {
        return this.lastTelemetry;
    }

    private emitFileHeader(): Uint8Array {
        const isEncrypted = this.encryptionKey !== null;
        const hasSchema = !!this.options.schema;
        const totalSize = GICS_HEADER_SIZE_V3 + (isEncrypted ? GICS_ENC_HEADER_SIZE_V3 : 0);
        const headerBytes = new Uint8Array(totalSize);
        const view = new DataView(headerBytes.buffer);
        headerBytes.set(GICS_MAGIC_V2, 0);
        headerBytes[4] = GICS_VERSION_BYTE;

        let flags = V12_FLAGS.FIELDWISE_TS;
        if (hasSchema) flags |= GICS_FLAGS_V3.HAS_SCHEMA;
        if (isEncrypted) flags |= GICS_FLAGS_V3.ENCRYPTED;
        view.setUint32(5, flags, true);

        // streamCount: 3 fixed streams + N schema fields (or legacy 5)
        const streamCount = hasSchema
            ? 3 + this.options.schema!.fields.length  // TIME + SNAP_LEN + ITEM_ID + N fields
            : 5; // TIME + SNAP_LEN + ITEM_ID + VALUE + QUANTITY
        headerBytes[9] = streamCount;

        if (isEncrypted) {
            let pos = GICS_HEADER_SIZE_V3;
            view.setUint8(pos++, 1); // encMode: AES-256-GCM
            headerBytes.set(this.encryptionSalt!, pos); pos += 16;
            headerBytes.set(this.authVerify!, pos); pos += 32;
            view.setUint8(pos++, 1); // kdfId: PBKDF2
            view.setUint32(pos, 100000, true); pos += 4;
            view.setUint8(pos++, 1); // digestId: SHA-256
            headerBytes.set(this.encryptionFileNonce!, pos);
        }

        return headerBytes;
    }

    /**
     * Emit schema section: [schemaLength: uint32][schemaPayload: zstd-compressed JSON]
     * Only called when HAS_SCHEMA flag is set.
     */
    private async emitSchemaSection(): Promise<Uint8Array> {
        const schema = this.options.schema;
        if (!schema) return new Uint8Array(0);

        const jsonStr = JSON.stringify(schema);
        const jsonBytes = new TextEncoder().encode(jsonStr);
        const outerCodec = getOuterCodec(OuterCodecId.ZSTD);
        const compressed = await outerCodec.compress(jsonBytes);

        const result = new Uint8Array(4 + compressed.length);
        const view = new DataView(result.buffer);
        view.setUint32(0, compressed.length, true);
        result.set(compressed, 4);
        return result;
    }

    /**
     * FLUSH: Process buffered snapshots, emit segments, maintain state.
     */
    async flush(): Promise<Uint8Array> {
        if (this.isFinalized) throw new Error("GICSv2Encoder: Cannot flush after finalize()");
        if (this.snapshots.length === 0) return new Uint8Array(0);

        const builder = new SegmentBuilder(this.options.segmentSizeLimit);
        type AnySnapshot = Snapshot | GenericSnapshot<Record<string, number | string>>;
        const groups: AnySnapshot[][] = [];

        for (const s of this.snapshots) {
            if (builder.push(s as Snapshot)) {
                groups.push(builder.seal());
            }
        }
        if (builder.pendingCount > 0) {
            groups.push(builder.seal());
        }
        this.snapshots = [];

        const allBytes: Uint8Array[] = [];
        if (!this.hasEmittedHeader) {
            const header = this.emitFileHeader();
            allBytes.push(header);
            if (this.fileHandle) await FileAccess.appendData(this.fileHandle, header);

            // Emit schema section after header if HAS_SCHEMA
            if (this.options.schema) {
                const schemaSection = await this.emitSchemaSection();
                allBytes.push(schemaSection);
                if (this.fileHandle) await FileAccess.appendData(this.fileHandle, schemaSection);
            }

            this.hasEmittedHeader = true;
        }

        const blockStats: BlockStats[] = [];
        for (const group of groups) {
            const { segment, stats } = await this.encodeSegment(group);
            const bytes = segment.serialize();
            allBytes.push(bytes);
            if (this.fileHandle) await FileAccess.appendData(this.fileHandle, bytes);
            blockStats.push(...stats);
        }

        this.computeTelemetry(blockStats);
        const finalBytes = this.concatArrays(allBytes);
        if (!this.fileHandle) this.accumulatedBytes.push(finalBytes);
        return finalBytes;
    }

    private async encodeSegment(snapshots: Array<Snapshot | GenericSnapshot<Record<string, number | string>>>): Promise<{ segment: Segment, stats: BlockStats[] }> {
        const streamBlocks: Map<number, { manifest: BlockManifestEntry[], payloads: Uint8Array[] }> = new Map();
        const blockStats: BlockStats[] = [];

        const addToStream = (streamId: number, manifest: BlockManifestEntry, payload: Uint8Array) => {
            if (!streamBlocks.has(streamId)) {
                streamBlocks.set(streamId, { manifest: [], payloads: [] });
            }
            const entry = streamBlocks.get(streamId)!;
            entry.manifest.push(manifest);
            entry.payloads.push(payload);
        };

        const globalCtx = this.context;
        if (!globalCtx) throw new Error("Encoder context missing");
        const segmentCtx = new ContextV0(this.options.runId, this.mode === 'on' ? 'segment_ctx' : null);
        this.context = segmentCtx;

        let segmentIndex: SegmentIndex;
        let useSchemaPath = false;

        try {
            if (this.options.schema) {
                // ── Schema-based generic path ──
                useSchemaPath = true;
                const features = this.collectSchemaFeatures(snapshots);
                this.processSchemaComponents(segmentCtx, features, addToStream, blockStats);
                segmentIndex = this.createSegmentIndexFromSchema(features);
            } else {
                // ── Legacy path (byte-identical to v1.3) ──
                const features = this.collectDataFeatures(snapshots as Snapshot[]);
                this.processCoreComponents(segmentCtx, features, addToStream, blockStats);
                segmentIndex = this.createSegmentIndex(features.itemIds);
            }
        } finally {
            this.context = globalCtx;
        }

        // Legacy path uses fixed stream order for byte-identical output;
        // schema path sorts by stream ID for deterministic dynamic ordering.
        const sections = useSchemaPath
            ? await this.wrapSectionsGeneric(streamBlocks)
            : await this.wrapSections(streamBlocks as Map<StreamId, { manifest: BlockManifestEntry[], payloads: Uint8Array[] }>);
        return this.assembleSegment(sections, segmentIndex, blockStats);
    }

    private processCoreComponents(
        ctx: ContextV0,
        features: DataFeatures,
        addToStream: (streamId: StreamId, manifest: BlockManifestEntry, payload: Uint8Array) => void,
        blockStats: BlockStats[]
    ) {
        const processBlockWrapper = (streamId: StreamId, chunk: number[], inputData: number[], stateSnapshot: ContextSnapshot, chm: HealthMonitor) => {
            const result = this.processStreamBlock(ctx, streamId, chunk, inputData, stateSnapshot, chm);
            addToStream(streamId, result.manifest, result.payload);
            blockStats.push(result.stats as BlockStats);
        };

        this.processTimeBlocks(ctx, features.timestamps, processBlockWrapper);
        this.processSnapshotLenBlocks(features.snapshotLengths, addToStream, blockStats);
        this.processItemIdBlocks(features.itemIds, addToStream, blockStats);
        this.processValueBlocks(ctx, features.prices, processBlockWrapper, addToStream, blockStats);
        this.processQuantityBlocks(features.quantities, addToStream, blockStats);
    }

    private async wrapSections(
        streamBlocks: Map<StreamId, { manifest: BlockManifestEntry[], payloads: Uint8Array[] }>
    ): Promise<StreamSection[]> {
        const sections: StreamSection[] = [];
        const order = [StreamId.TIME, StreamId.SNAPSHOT_LEN, StreamId.ITEM_ID, StreamId.VALUE, StreamId.QUANTITY];
        const outerCodec = getOuterCodec(OuterCodecId.ZSTD);

        for (const streamId of order) {
            const data = streamBlocks.get(streamId);
            if (!data) continue;

            const section = await this.wrapSingleSection(streamId, data, outerCodec);
            sections.push(section);
        }
        return sections;
    }

    /**
     * Generic version of wrapSections that handles dynamic stream IDs.
     * Iterates all stream blocks in deterministic order (sorted by stream ID).
     */
    private async wrapSectionsGeneric(
        streamBlocks: Map<number, { manifest: BlockManifestEntry[], payloads: Uint8Array[] }>
    ): Promise<StreamSection[]> {
        const sections: StreamSection[] = [];
        const outerCodec = getOuterCodec(OuterCodecId.ZSTD);

        // Sort by stream ID for deterministic output
        const sortedIds = Array.from(streamBlocks.keys()).sort((a, b) => a - b);

        for (const streamId of sortedIds) {
            const data = streamBlocks.get(streamId)!;
            const section = await this.wrapSingleSection(streamId, data, outerCodec);
            sections.push(section);
        }
        return sections;
    }

    private async wrapSingleSection(
        streamId: StreamId,
        data: { manifest: BlockManifestEntry[], payloads: Uint8Array[] },
        outerCodec: { compress(data: Uint8Array, level?: number): Promise<Uint8Array> }
    ): Promise<StreamSection> {
        const concatenated = this.concatArrays(data.payloads);
        const compressed = await outerCodec.compress(concatenated);
        const manifestBytes = StreamSection.serializeManifest(data.manifest);

        const { finalPayload, authTag } = this.encryptPayloadIfNeeded(streamId, compressed);
        const sectionHash = this.calculateSectionHash(streamId, data.manifest.length, manifestBytes, finalPayload);

        return new StreamSection(
            streamId,
            OuterCodecId.ZSTD,
            data.manifest.length,
            concatenated.length,
            finalPayload.length,
            sectionHash,
            data.manifest,
            finalPayload,
            authTag
        );
    }

    private encryptPayloadIfNeeded(streamId: StreamId, compressed: Uint8Array): { finalPayload: Uint8Array, authTag: Uint8Array | null } {
        if (!this.encryptionKey) {
            return { finalPayload: compressed, authTag: null };
        }
        const aad = this.emitFileHeader().subarray(0, GICS_HEADER_SIZE_V3);
        const encrypted = encryptSection(compressed, this.encryptionKey, this.encryptionFileNonce!, streamId, aad);
        return { finalPayload: encrypted.ciphertext, authTag: encrypted.tag };
    }

    private calculateSectionHash(streamId: StreamId, blockCount: number, manifestBytes: Uint8Array, finalPayload: Uint8Array): Uint8Array {
        const blockCountBytes = new Uint8Array(2);
        new DataView(blockCountBytes.buffer).setUint16(0, blockCount, true);

        const dataToHash = this.concatArrays([
            new Uint8Array([streamId]),
            blockCountBytes,
            manifestBytes,
            finalPayload
        ]);
        return this.integrity.update(dataToHash);
    }

    private createSegmentIndex(itemIds: number[]): SegmentIndex {
        const bf = new BloomFilter();
        const uniqueIds = Array.from(new Set(itemIds)).sort((a, b) => a - b);
        for (const id of uniqueIds) bf.add(id);
        return new SegmentIndex(bf, uniqueIds);
    }

    private assembleSegment(sections: StreamSection[], index: SegmentIndex, blockStats: BlockStats[]): { segment: Segment, stats: BlockStats[] } {
        const tempSerializedSections = sections.map(s => s.serialize());
        const sectionsTotalLen = tempSerializedSections.reduce((acc, b) => acc + b.length, 0);

        const indexBytes = index.serialize();
        const totalLength = 14 + sectionsTotalLen + indexBytes.length + SEGMENT_FOOTER_SIZE;

        const header = new SegmentHeader(14 + sectionsTotalLen, totalLength);
        const preFooter = this.concatArrays([
            header.serialize(),
            ...tempSerializedSections,
            indexBytes
        ]);
        const footer = new SegmentFooter(this.integrity.getRootHash(), calculateCRC32(preFooter));

        return {
            segment: new Segment(header, sections, index, footer),
            stats: blockStats
        };
    }

    private collectDataFeatures(snapshots: Snapshot[]) {
        const timestamps: number[] = [];
        const snapshotLengths: number[] = [];
        const itemIds: number[] = [];
        const prices: number[] = [];
        const quantities: number[] = [];

        for (const s of snapshots) {
            timestamps.push(s.timestamp);
            const sortedItems = [...s.items.entries()].sort((a, b) => a[0] - b[0]);
            snapshotLengths.push(sortedItems.length);
            for (const [id, data] of sortedItems) {
                itemIds.push(id);
                prices.push(data.price);
                quantities.push(data.quantity);
            }
        }
        return { timestamps, snapshotLengths, itemIds, prices, quantities };
    }

    // ── Schema-aware feature extraction ─────────────────────────────────────

    private collectSchemaFeatures(snapshots: Array<Snapshot | GenericSnapshot<Record<string, number | string>>>): SchemaDataFeatures {
        const schema = this.options.schema!;
        const timestamps: number[] = [];
        const snapshotLengths: number[] = [];
        const rawItemKeys: (number | string)[] = [];
        const fieldArrays = new Map<string, number[]>();

        for (const field of schema.fields) {
            fieldArrays.set(field.name, []);
        }

        for (const s of snapshots) {
            timestamps.push(s.timestamp);
            // Sort items by key for determinism
            const entries = [...s.items.entries()].sort((a, b) =>
                String(a[0]).localeCompare(String(b[0]))
            );
            snapshotLengths.push(entries.length);

            for (const [key, data] of entries) {
                rawItemKeys.push(key);
                for (const field of schema.fields) {
                    const arr = fieldArrays.get(field.name)!;
                    const rawVal = (data as Record<string, number | string>)[field.name];

                    if (field.type === 'categorical' && field.enumMap) {
                        // Convert string to numeric via enum map
                        const numVal = typeof rawVal === 'string' ? (field.enumMap[rawVal] ?? 0) : (rawVal ?? 0);
                        arr.push(numVal);
                    } else {
                        arr.push(typeof rawVal === 'number' ? rawVal : 0);
                    }
                }
            }
        }

        // Build string dictionary if needed
        let stringDict: StringDictionaryData | undefined;
        let numericItemIds: number[];

        if (schema.itemIdType === 'string') {
            const stringKeys = rawItemKeys.map(k => String(k));
            stringDict = StringDictionary.build(stringKeys);
            numericItemIds = stringKeys.map(k => stringDict!.map.get(k)!);
        } else {
            numericItemIds = rawItemKeys.map(k => typeof k === 'number' ? k : parseInt(k, 10));
        }

        return { timestamps, snapshotLengths, itemIds: numericItemIds, fieldArrays, stringDict };
    }

    private processSchemaComponents(
        ctx: ContextV0,
        features: SchemaDataFeatures,
        addToStream: (streamId: number, manifest: BlockManifestEntry, payload: Uint8Array) => void,
        blockStats: BlockStats[]
    ) {
        const schema = this.options.schema!;

        const processBlockWrapper = (streamId: number, chunk: number[], inputData: number[], stateSnapshot: ContextSnapshot, chm: HealthMonitor) => {
            const result = this.processStreamBlock(ctx, streamId as StreamId, chunk, inputData, stateSnapshot, chm);
            addToStream(streamId, result.manifest, result.payload);
            blockStats.push(result.stats as BlockStats);
        };

        // Fixed streams (same as legacy)
        this.processTimeBlocks(ctx, features.timestamps, processBlockWrapper);
        this.processSnapshotLenBlocks(features.snapshotLengths, addToStream, blockStats);
        this.processItemIdBlocks(features.itemIds, addToStream, blockStats);

        // Schema fields: each gets its own stream with ID = SCHEMA_STREAM_BASE + index
        for (let i = 0; i < schema.fields.length; i++) {
            const field = schema.fields[i];
            const streamId = SCHEMA_STREAM_BASE + i;
            const data = features.fieldArrays.get(field.name)!;
            this.processFieldBlocks(streamId, data, field.codecStrategy, addToStream, blockStats, ctx);
        }
    }

    /**
     * Generic field block processor that selects candidates based on codecStrategy hint.
     */
    private processFieldBlocks(
        streamId: number,
        data: number[],
        codecStrategy: string | undefined,
        addToStream: (streamId: number, manifest: BlockManifestEntry, payload: Uint8Array) => void,
        blockStats: BlockStats[],
        ctx: ContextV0
    ) {
        const candidates = this.getCandidatesForStrategy(codecStrategy, ctx);

        for (let i = 0; i < data.length; i += BLOCK_SIZE) {
            const chunk = data.slice(i, i + BLOCK_SIZE);
            this.processStructuralBlock(streamId as StreamId, chunk, candidates, addToStream, blockStats);
        }
    }

    /**
     * Returns codec candidates based on codecStrategy hint.
     */
    private getCandidatesForStrategy(
        codecStrategy: string | undefined,
        ctx: ContextV0
    ): { id: InnerCodecId, encode: (data: number[]) => Uint8Array }[] {
        switch (codecStrategy) {
            case 'time':
                return [
                    { id: InnerCodecId.DOD_VARINT, encode: (data) => encodeVarint(data) },
                    { id: InnerCodecId.RLE_DOD, encode: (data) => Codecs.encodeRLE(data) },
                    { id: InnerCodecId.BITPACK_DELTA, encode: (data) => Codecs.encodeBitPack(data) },
                ];
            case 'value':
                return [
                    { id: InnerCodecId.VARINT_DELTA, encode: (data) => encodeVarint(data) },
                    { id: InnerCodecId.BITPACK_DELTA, encode: (data) => Codecs.encodeBitPack(data) },
                    { id: InnerCodecId.RLE_ZIGZAG, encode: (data) => Codecs.encodeRLE(data) },
                    { id: InnerCodecId.DICT_VARINT, encode: (data) => Codecs.encodeDict(data, ctx) },
                ];
            case 'structural':
                return [
                    { id: InnerCodecId.VARINT_DELTA, encode: (data) => encodeVarint(data) },
                    { id: InnerCodecId.RLE_ZIGZAG, encode: (data) => Codecs.encodeRLE(data) },
                    { id: InnerCodecId.BITPACK_DELTA, encode: (data) => Codecs.encodeBitPack(data) },
                ];
            default:
                // Auto-detect: try all candidates (superset of time + value + structural)
                return [
                    { id: InnerCodecId.DOD_VARINT, encode: (data) => encodeVarint(data) },
                    { id: InnerCodecId.RLE_DOD, encode: (data) => Codecs.encodeRLE(data) },
                    { id: InnerCodecId.VARINT_DELTA, encode: (data) => encodeVarint(data) },
                    { id: InnerCodecId.BITPACK_DELTA, encode: (data) => Codecs.encodeBitPack(data) },
                    { id: InnerCodecId.RLE_ZIGZAG, encode: (data) => Codecs.encodeRLE(data) },
                    { id: InnerCodecId.DICT_VARINT, encode: (data) => Codecs.encodeDict(data, ctx) },
                ];
        }
    }

    private createSegmentIndexFromSchema(features: SchemaDataFeatures): SegmentIndex {
        const bf = new BloomFilter();
        const uniqueIds = Array.from(new Set(features.itemIds)).sort((a, b) => a - b);
        for (const id of uniqueIds) bf.add(id);
        return new SegmentIndex(bf, uniqueIds, features.stringDict);
    }

    private processTimeBlocks(ctx: ContextV0, timestamps: number[], processBlock: BlockProcessor) {
        for (let i = 0; i < timestamps.length; i += BLOCK_SIZE) {
            const chunk = timestamps.slice(i, i + BLOCK_SIZE);
            const snapshot = ctx.snapshot();
            const deltas = this.computeTimeDeltas(ctx, chunk, false);
            processBlock(StreamId.TIME, chunk, deltas, snapshot, this.chmTime);
        }
    }

    private processSnapshotLenBlocks(lengths: number[], addToStream: (streamId: StreamId, manifest: BlockManifestEntry, payload: Uint8Array) => void, stats: BlockStats[]) {
        for (let i = 0; i < lengths.length; i += BLOCK_SIZE) {
            const chunk = lengths.slice(i, i + BLOCK_SIZE);
            this.processStructuralBlock(StreamId.SNAPSHOT_LEN, chunk, [
                { id: InnerCodecId.VARINT_DELTA, encode: (data) => encodeVarint(data) },
                { id: InnerCodecId.RLE_ZIGZAG, encode: (data) => Codecs.encodeRLE(data) },
                { id: InnerCodecId.BITPACK_DELTA, encode: (data) => Codecs.encodeBitPack(data) }
            ], addToStream, stats);
        }
    }

    private processItemIdBlocks(itemIds: number[], addToStream: (streamId: StreamId, manifest: BlockManifestEntry, payload: Uint8Array) => void, stats: BlockStats[]) {
        for (let i = 0; i < itemIds.length; i += BLOCK_SIZE) {
            const chunk = itemIds.slice(i, i + BLOCK_SIZE);
            this.processStructuralBlock(StreamId.ITEM_ID, chunk, [
                { id: InnerCodecId.VARINT_DELTA, encode: (data) => encodeVarint(data) },
                { id: InnerCodecId.BITPACK_DELTA, encode: (data) => Codecs.encodeBitPack(data) },
                { id: InnerCodecId.DICT_VARINT, encode: (data) => Codecs.encodeDict(data, this.context!) }
            ], addToStream, stats);
        }
    }

    private processValueBlocks(
        ctx: ContextV0,
        prices: number[],
        processBlock: BlockProcessor,
        addToStream: (streamId: StreamId, manifest: BlockManifestEntry, payload: Uint8Array) => void,
        stats: BlockStats[]
    ) {
        for (let i = 0; i < prices.length; i += BLOCK_SIZE) {
            const chunk = prices.slice(i, i + BLOCK_SIZE);
            if (this.hasNonIntegerValues(chunk)) {
                const result = FieldMath.computeValueDeltas(chunk, ctx.lastValue ?? 0);
                ctx.lastValue = result.nextValue;
                const encoded = Codecs.encodeFixed64(result.deltas);
                addToStream(StreamId.VALUE, { innerCodecId: InnerCodecId.FIXED64_LE, nItems: chunk.length, payloadLen: encoded.length, flags: 0 }, encoded);
                this.recordSimpleBlockStats(StreamId.VALUE, chunk, encoded, stats, InnerCodecId.FIXED64_LE);
                continue;
            }
            const snapshot = ctx.snapshot();
            const deltas = this.computeValueDeltas(ctx, chunk, false);
            processBlock(StreamId.VALUE, chunk, deltas, snapshot, this.chmValue);
        }
    }

    private processQuantityBlocks(quantities: number[], addToStream: (streamId: StreamId, manifest: BlockManifestEntry, payload: Uint8Array) => void, stats: BlockStats[]) {
        for (let i = 0; i < quantities.length; i += BLOCK_SIZE) {
            const chunk = quantities.slice(i, i + BLOCK_SIZE);
            if (this.hasNonIntegerValues(chunk)) {
                const encoded = Codecs.encodeFixed64(chunk);
                addToStream(StreamId.QUANTITY, { innerCodecId: InnerCodecId.FIXED64_LE, nItems: chunk.length, payloadLen: encoded.length, flags: 0 }, encoded);
                this.recordSimpleBlockStats(StreamId.QUANTITY, chunk, encoded, stats, InnerCodecId.FIXED64_LE);
                continue;
            }
            this.processStructuralBlock(StreamId.QUANTITY, chunk, [
                { id: InnerCodecId.VARINT_DELTA, encode: (data) => encodeVarint(data) },
                { id: InnerCodecId.RLE_ZIGZAG, encode: (data) => Codecs.encodeRLE(data) },
                { id: InnerCodecId.DICT_VARINT, encode: (data) => Codecs.encodeDict(data, this.context!) }
            ], addToStream, stats);
        }
    }

    private hasNonIntegerValues(values: number[]): boolean {
        for (const value of values) {
            if (!Number.isFinite(value) || !Number.isInteger(value)) {
                return true;
            }
        }
        return false;
    }

    private processStructuralBlock(
        streamId: StreamId,
        chunk: number[],
        candidates: { id: InnerCodecId, encode: (data: number[]) => Uint8Array }[],
        addToStream: (streamId: StreamId, manifest: BlockManifestEntry, payload: Uint8Array) => void,
        stats: BlockStats[]
    ) {
        const ctx = this.context!;
        const snapshot = ctx.snapshot();
        let bestEncoded: Uint8Array | null = null;
        let bestCodec: InnerCodecId = InnerCodecId.VARINT_DELTA;

        for (const cand of candidates) {
            ctx.restore(snapshot);
            const encoded = cand.encode(chunk);
            if (bestEncoded === null || encoded.length < bestEncoded.length) {
                bestEncoded = encoded;
                bestCodec = cand.id;
            }
        }

        // Final commit
        ctx.restore(snapshot);
        const bestCand = candidates.find(c => c.id === bestCodec)!;
        const finalEncoded = bestCand.encode(chunk);

        addToStream(streamId, { innerCodecId: bestCodec, nItems: chunk.length, payloadLen: finalEncoded.length, flags: 0 }, finalEncoded);
        this.recordSimpleBlockStats(streamId, chunk, finalEncoded, stats, bestCodec);
    }

    private recordSimpleBlockStats(streamId: StreamId, chunk: number[], encoded: Uint8Array, stats: BlockStats[], codecId: InnerCodecId) {
        const metrics = calculateBlockMetrics(chunk);
        stats.push({
            stream_id: streamId,
            codec: codecId,
            bytes: encoded.length,
            raw_bytes: chunk.length * 8,
            header_bytes: 0,
            payload_bytes: encoded.length,
            params: { decision: 'CORE', reason: null },
            flags: 0,
            health: HealthTag.OK,
            ratio: (chunk.length * 8) / (encoded.length || 1),
            trainBaseline: true,
            metrics: metrics,
            regime: classifyRegime(metrics)
        });
    }

    private processStreamBlock(
        ctx: ContextV0,
        streamId: StreamId,
        chunk: number[],
        inputData: number[],
        stateSnapshot: ContextSnapshot,
        chm: HealthMonitor
    ) {
        const metrics = calculateBlockMetrics(chunk);
        const rawInBytes = chunk.length * 8;
        const currentBlockIndex = chm.getTotalBlocks() + 1;

        const { candidateEncoded, candidateCodec } = this.selectBestCodec(streamId, inputData, metrics, stateSnapshot);
        const candidateRatio = rawInBytes / (candidateEncoded.length || 1);

        const route = chm.decideRoute(metrics, candidateRatio, currentBlockIndex);

        let finalEncoded: Uint8Array;
        let finalCodec: InnerCodecId;

        if (route.decision === RoutingDecision.QUARANTINE) {
            ctx.restore(stateSnapshot);
            finalEncoded = Codecs.encodeFixed64(inputData);
            finalCodec = InnerCodecId.FIXED64_LE;
        } else {
            // Re-encode to commit state correctly (trial only restored)
            ctx.restore(stateSnapshot);
            finalCodec = candidateCodec;
            const finalData = (finalCodec === InnerCodecId.DOD_VARINT || finalCodec === InnerCodecId.RLE_DOD)
                ? this.prepareDODStream(streamId, inputData, stateSnapshot)
                : inputData;

            if (finalCodec === InnerCodecId.DICT_VARINT) {
                finalEncoded = Codecs.encodeDict(finalData, ctx);
            } else if (finalCodec === InnerCodecId.BITPACK_DELTA) {
                finalEncoded = Codecs.encodeBitPack(finalData);
            } else if (finalCodec === InnerCodecId.RLE_ZIGZAG || finalCodec === InnerCodecId.RLE_DOD) {
                finalEncoded = Codecs.encodeRLE(finalData);
            } else {
                finalEncoded = encodeVarint(finalData);
            }
        }

        // Final state commit for persistent fields (TIME/VALUE)
        if (streamId === StreamId.TIME) {
            const result = FieldMath.computeTimeDeltas(chunk, ctx.lastTimestamp ?? 0, ctx.lastTimestampDelta ?? 0);
            ctx.lastTimestamp = result.nextTimestamp;
            ctx.lastTimestampDelta = result.nextTimestampDelta;
        } else if (streamId === StreamId.VALUE) {
            const result = FieldMath.computeValueDeltas(chunk, ctx.lastValue ?? 0);
            ctx.lastValue = result.nextValue;
        }

        const chmResult = chm.update(route.decision, metrics, rawInBytes, finalEncoded.length, 0, currentBlockIndex, finalCodec);

        return {
            manifest: { innerCodecId: finalCodec, nItems: chunk.length, payloadLen: finalEncoded.length, flags: chmResult.flags },
            payload: finalEncoded,
            stats: {
                stream_id: streamId,
                codec: finalCodec,
                bytes: finalEncoded.length,
                raw_bytes: rawInBytes,
                header_bytes: 0,
                payload_bytes: finalEncoded.length,
                params: { decision: route.decision, reason: route.reason },
                flags: chmResult.flags,
                health: chmResult.healthTag,
                ratio: rawInBytes / (finalEncoded.length || 1),
                trainBaseline: (route.decision === RoutingDecision.CORE),
                metrics: metrics,
                regime: classifyRegime(metrics)
            }
        };
    }

    async seal(): Promise<Uint8Array> {
        await this.flush();
        const eosBytes = this.emitFileEOS();
        if (this.fileHandle) {
            await FileAccess.appendData(this.fileHandle, eosBytes);
        } else {
            this.accumulatedBytes.push(eosBytes);
        }
        await this.finalize();
        return this.fileHandle ? eosBytes : this.concatArrays(this.accumulatedBytes);
    }

    async sealToFile(): Promise<void> {
        await this.seal();
    }

    private emitFileEOS(): Uint8Array {
        const buffer = new Uint8Array(FILE_EOS_SIZE);
        const view = new DataView(buffer.buffer);
        buffer[0] = GICS_EOS_MARKER;
        buffer.set(this.integrity.getRootHash(), 1);
        view.setUint32(33, calculateCRC32(buffer.subarray(1, 33)), true);
        return buffer;
    }

    private computeTelemetry(blockStats: BlockStats[]) {
        const timeStats = this.chmTime.getStats();
        const valueStats = this.chmValue.getStats();
        const chmStats = {
            core_blocks: timeStats.core_blocks + valueStats.core_blocks,
            core_input_bytes: timeStats.core_input_bytes + valueStats.core_input_bytes,
            core_output_bytes: timeStats.core_output_bytes + valueStats.core_output_bytes,
            quar_blocks: timeStats.quar_blocks + valueStats.quar_blocks,
            quar_input_bytes: timeStats.quar_input_bytes + valueStats.quar_input_bytes,
            quar_output_bytes: timeStats.quar_output_bytes + valueStats.quar_output_bytes,
        };

        const totalChmBlocks = this.chmTime.getTotalBlocks() + this.chmValue.getTotalBlocks();
        const coreRatio = chmStats.core_output_bytes > 0 ? (chmStats.core_input_bytes / chmStats.core_output_bytes) : 0;
        const quarRate = totalChmBlocks > 0 ? (chmStats.quar_blocks / totalChmBlocks) : 0;

        this.lastTelemetry = {
            blocks: blockStats,
            total_blocks: totalChmBlocks,
            core_input_bytes: chmStats.core_input_bytes,
            core_output_bytes: chmStats.core_output_bytes,
            core_ratio: coreRatio,
            quarantine_input_bytes: chmStats.quar_input_bytes,
            quarantine_output_bytes: chmStats.quar_output_bytes,
            quarantine_rate: quarRate,
            quarantine_blocks: chmStats.quar_blocks
        };
    }

    async finalize(): Promise<void> {
        if (this.isFinalized) throw new Error("GICSv2Encoder: Finalize called twice!");

        const report = {
            time: this.chmTime.getReport(),
            value: this.chmValue.getReport(),
        };
        const filename = `gics-anomalies.${this.runId}.json`;

        if (this.options.sidecarWriter) {
            await this.options.sidecarWriter({ filename, report, encoderRunId: this.runId });
        }

        this.context = null;
        this.isFinalized = true;

        if (this.lastTelemetry) {
            this.lastTelemetry.sidecar = this.options.sidecarWriter ? filename : null;
        }
    }

    async finish(): Promise<Uint8Array> {
        return this.seal();
    }

    private computeTimeDeltas(ctx: ContextV0, timestamps: number[], commitState: boolean): number[] {
        const result = FieldMath.computeTimeDeltas(timestamps, ctx.lastTimestamp ?? 0, ctx.lastTimestampDelta ?? 0);
        if (commitState) {
            ctx.lastTimestamp = result.nextTimestamp;
            ctx.lastTimestampDelta = result.nextTimestampDelta;
        }
        return result.deltas;
    }

    private computeValueDeltas(ctx: ContextV0, values: number[], commitState: boolean): number[] {
        const result = FieldMath.computeValueDeltas(values, ctx.lastValue ?? 0);
        if (commitState) {
            ctx.lastValue = result.nextValue;
        }
        return result.deltas;
    }

    private selectBestCodec(streamId: StreamId, inputData: number[], metrics: BlockMetrics, stateSnapshot: ContextSnapshot): { candidateEncoded: Uint8Array, candidateCodec: InnerCodecId } {
        const ctx = this.context!;
        let bestEncoded: Uint8Array | null = null;
        let bestCodec: InnerCodecId = InnerCodecId.VARINT_DELTA;

        const candidates: { id: InnerCodecId, encode: () => Uint8Array }[] = [];

        if (streamId === StreamId.TIME) {
            candidates.push(
                { id: InnerCodecId.DOD_VARINT, encode: () => encodeVarint(inputData) },
                { id: InnerCodecId.RLE_DOD, encode: () => Codecs.encodeRLE(inputData) },
                { id: InnerCodecId.BITPACK_DELTA, encode: () => Codecs.encodeBitPack(inputData) }
            );
        } else if (streamId === StreamId.VALUE) {
            candidates.push(
                { id: InnerCodecId.VARINT_DELTA, encode: () => encodeVarint(inputData) },
                { id: InnerCodecId.BITPACK_DELTA, encode: () => Codecs.encodeBitPack(inputData) },
                { id: InnerCodecId.RLE_ZIGZAG, encode: () => Codecs.encodeRLE(inputData) }
            );
            if (ctx.id && metrics.unique_ratio < 0.6) {
                candidates.push({ id: InnerCodecId.DICT_VARINT, encode: () => Codecs.encodeDict(inputData, ctx) });
            }
            if (metrics.dod_zero_ratio > 0.4 || metrics.mean_abs_delta > 10) {
                const dod = this.prepareDODStream(streamId, inputData, stateSnapshot);
                candidates.push(
                    { id: InnerCodecId.DOD_VARINT, encode: () => encodeVarint(dod) },
                    { id: InnerCodecId.RLE_DOD, encode: () => Codecs.encodeRLE(dod) }
                );
            }
        }

        for (const cand of candidates) {
            ctx.restore(stateSnapshot);
            const encoded = cand.encode();
            if (bestEncoded === null || encoded.length < bestEncoded.length) {
                bestEncoded = encoded;
                bestCodec = cand.id;
            }
        }

        // Trial leaves context restored
        ctx.restore(stateSnapshot);

        if (!bestEncoded) {
            return {
                candidateEncoded: encodeVarint(inputData),
                candidateCodec: streamId === StreamId.TIME ? InnerCodecId.DOD_VARINT : InnerCodecId.VARINT_DELTA
            };
        }

        return { candidateEncoded: bestEncoded, candidateCodec: bestCodec };
    }

    private prepareDODStream(streamId: StreamId, inputData: number[], stateSnapshot: ContextSnapshot): number[] {
        if (streamId === StreamId.TIME) return inputData;

        const dodStream: number[] = [];
        let pd = stateSnapshot.lastValueDelta ?? 0;
        for (const d of inputData) {
            dodStream.push(d - pd);
            pd = d;
        }
        return dodStream;
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
}
