import { Snapshot } from '../gics-types.js';
import { encodeVarint } from '../gics-utils.js';
import { GICS_MAGIC_V2, V12_FLAGS, StreamId, CodecId, GICS_VERSION_BYTE, BLOCK_HEADER_SIZE, HealthTag } from './format.js';
import { ContextV0, ContextSnapshot } from './context.js';
import { calculateBlockMetrics, classifyRegime } from './metrics.js';
import { Codecs } from './codecs.js';
import { HealthMonitor, RoutingDecision } from './chm.js';
import type { GICSv2EncoderOptions } from './types.js';

const BLOCK_SIZE = 1000;

export class GICSv2Encoder {
    private snapshots: Snapshot[] = [];
    private context: ContextV0;
    private readonly chmTime: HealthMonitor;
    private readonly chmValue: HealthMonitor;
    private readonly mode: 'on' | 'off';
    private lastTelemetry: any = null;
    private isFinalized = false;
    private hasEmittedHeader = false;
    private readonly runId: string;
    private readonly options: Required<GICSv2EncoderOptions>;

    static reset() {
        // Backward-compat for existing tests. No global mutable state is used anymore.
    }

    static resetSharedContext() {
        // Backward-compat for existing tests. No global mutable state is used anymore.
    }

    constructor(options: GICSv2EncoderOptions = {}) {
        const defaults: Required<GICSv2EncoderOptions> = {
            runId: `run_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            contextMode: 'on',
            probeInterval: 4,
            sidecarWriter: null,
            logger: null,
        };
        this.options = { ...defaults, ...options };

        this.runId = this.options.runId;
        this.mode = this.options.contextMode;

        this.context = this.mode === 'off'
            ? new ContextV0('hash_placeholder', null)
            : new ContextV0('hash_placeholder');

        this.chmTime = new HealthMonitor(`${this.runId}:TIME`, this.options.probeInterval, this.options.logger);
        this.chmValue = new HealthMonitor(`${this.runId}:VALUE`, this.options.probeInterval, this.options.logger);
    }

    async addSnapshot(snapshot: Snapshot): Promise<void> {
        if (this.isFinalized) throw new Error("GICSv2Encoder: Cannot append after finalize()");
        this.snapshots.push(snapshot);
    }

    getTelemetry() {
        return this.lastTelemetry;
    }

    /**
     * FLUSH: Process buffered snapshots, emit bytes, maintain state.
     */
    async flush(): Promise<Uint8Array> {
        if (this.isFinalized) throw new Error("GICSv2Encoder: Cannot flush after finalize()");
        if (this.snapshots.length === 0) return new Uint8Array(0);

        const features = this.collectDataFeatures();
        this.snapshots = [];

        const blocks: Uint8Array[] = [];
        const blockStats: any[] = [];

        const processBlockWrapper = (streamId: StreamId, chunk: number[], inputData: number[], stateSnapshot: ContextSnapshot, chm: HealthMonitor) => {
            this.processStreamBlock(streamId, chunk, inputData, stateSnapshot, chm, blocks, blockStats);
        };

        this.processTimeBlocks(features.timestamps, processBlockWrapper);
        this.processSnapshotLenBlocks(features.snapshotLengths, blocks, blockStats);
        this.processItemIdBlocks(features.itemIds, blocks, blockStats);
        this.processValueBlocks(features.prices, processBlockWrapper);
        this.processQuantityBlocks(features.quantities, blocks, blockStats);

        return this.assembleOutput(blocks, blockStats);
    }

    private collectDataFeatures() {
        const timestamps: number[] = [];
        const snapshotLengths: number[] = [];
        const itemIds: number[] = [];
        const prices: number[] = [];
        const quantities: number[] = [];

        for (const s of this.snapshots) {
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

    private processTimeBlocks(timestamps: number[], processBlock: Function) {
        for (let i = 0; i < timestamps.length; i += BLOCK_SIZE) {
            const chunk = timestamps.slice(i, i + BLOCK_SIZE);
            const snapshot = this.context.snapshot();
            const deltas = this.computeTimeDeltas(chunk, true);
            processBlock(StreamId.TIME, chunk, deltas, snapshot, this.chmTime);
        }
    }

    private processSnapshotLenBlocks(lengths: number[], blocks: Uint8Array[], stats: any[]) {
        for (let i = 0; i < lengths.length; i += BLOCK_SIZE) {
            const chunk = lengths.slice(i, i + BLOCK_SIZE);
            const encoded = encodeVarint(chunk);
            const block = this.createBlock(StreamId.SNAPSHOT_LEN, CodecId.VARINT_DELTA, chunk.length, encoded, 0);
            blocks.push(block);
            this.recordSimpleBlockStats(StreamId.SNAPSHOT_LEN, chunk, block, encoded, stats);
        }
    }

    private processItemIdBlocks(itemIds: number[], blocks: Uint8Array[], stats: any[]) {
        for (let i = 0; i < itemIds.length; i += BLOCK_SIZE) {
            const chunk = itemIds.slice(i, i + BLOCK_SIZE);
            const encoded = encodeVarint(chunk);
            const block = this.createBlock(StreamId.ITEM_ID, CodecId.VARINT_DELTA, chunk.length, encoded, 0);
            blocks.push(block);
            this.recordSimpleBlockStats(StreamId.ITEM_ID, chunk, block, encoded, stats);
        }
    }

    private processValueBlocks(prices: number[], processBlock: Function) {
        for (let i = 0; i < prices.length; i += BLOCK_SIZE) {
            const chunk = prices.slice(i, i + BLOCK_SIZE);
            const snapshot = this.context.snapshot();
            const deltas = this.computeValueDeltas(chunk, true);
            processBlock(StreamId.VALUE, chunk, deltas, snapshot, this.chmValue);
        }
    }

    private processQuantityBlocks(quantities: number[], blocks: Uint8Array[], stats: any[]) {
        for (let i = 0; i < quantities.length; i += BLOCK_SIZE) {
            const chunk = quantities.slice(i, i + BLOCK_SIZE);
            const encoded = encodeVarint(chunk);
            const block = this.createBlock(StreamId.QUANTITY, CodecId.VARINT_DELTA, chunk.length, encoded, 0);
            blocks.push(block);
            this.recordSimpleBlockStats(StreamId.QUANTITY, chunk, block, encoded, stats);
        }
    }

    private recordSimpleBlockStats(streamId: StreamId, chunk: number[], block: Uint8Array, encoded: Uint8Array, stats: any[]) {
        const metrics = calculateBlockMetrics(chunk);
        stats.push({
            stream_id: streamId,
            codec: CodecId.VARINT_DELTA,
            bytes: block.length,
            raw_bytes: chunk.length * 8,
            header_bytes: BLOCK_HEADER_SIZE,
            payload_bytes: encoded.length,
            params: { decision: 'CORE', reason: null },
            flags: 0,
            health: HealthTag.OK,
            ratio: (chunk.length * 8) / block.length,
            trainBaseline: true,
            metrics: metrics,
            regime: classifyRegime(metrics)
        });
    }

    private processStreamBlock(
        streamId: StreamId,
        chunk: number[],
        inputData: number[],
        stateSnapshot: ContextSnapshot,
        chm: HealthMonitor,
        blocks: Uint8Array[],
        blockStats: any[]
    ) {
        const metrics = calculateBlockMetrics(chunk);
        const rawInBytes = chunk.length * 8;
        const currentBlockIndex = chm.getTotalBlocks() + 1;

        const { candidateEncoded, candidateCodec } = this.selectBestCodec(streamId, inputData, metrics, stateSnapshot);
        const coreLen = candidateEncoded.length + BLOCK_HEADER_SIZE;
        const candidateRatio = rawInBytes / (coreLen || 1);

        const route = chm.decideRoute(metrics, candidateRatio, currentBlockIndex);

        let finalEncoded: Uint8Array;
        let finalCodec: CodecId;

        if (route.decision === RoutingDecision.QUARANTINE) {
            this.context.restore(stateSnapshot);
            finalEncoded = encodeVarint(inputData);
            finalCodec = (streamId === StreamId.TIME) ? CodecId.DOD_VARINT : CodecId.VARINT_DELTA;
        } else {
            finalEncoded = candidateEncoded;
            finalCodec = candidateCodec;
        }

        const chmResult = chm.update(route.decision, metrics, rawInBytes, finalEncoded.length, BLOCK_HEADER_SIZE, currentBlockIndex, finalCodec);
        const block = this.createBlock(streamId, finalCodec, chunk.length, finalEncoded, chmResult.flags);
        blocks.push(block);

        blockStats.push({
            stream_id: streamId,
            codec: finalCodec,
            bytes: block.length,
            raw_bytes: rawInBytes,
            header_bytes: BLOCK_HEADER_SIZE,
            payload_bytes: finalEncoded.length,
            params: { decision: route.decision, reason: route.reason },
            flags: chmResult.flags,
            health: chmResult.healthTag,
            ratio: rawInBytes / block.length,
            trainBaseline: (route.decision === RoutingDecision.CORE),
            metrics: metrics,
            regime: classifyRegime(metrics)
        });
    }

    private assembleOutput(blocks: Uint8Array[], blockStats: any[]): Uint8Array {
        const totalPayloadSize = blocks.reduce((acc, b) => acc + b.length, 0);
        let headerSize = 0;
        let headerBytes: Uint8Array | null = null;

        if (!this.hasEmittedHeader) {
            headerSize = GICS_MAGIC_V2.length + 1 + 4;
            headerBytes = new Uint8Array(headerSize);
            headerBytes.set(GICS_MAGIC_V2, 0);
            headerBytes[4] = GICS_VERSION_BYTE;
            new DataView(headerBytes.buffer).setUint32(5, V12_FLAGS.FIELDWISE_TS, true);
            this.hasEmittedHeader = true;
        }

        const result = new Uint8Array((headerBytes ? headerSize : 0) + totalPayloadSize + 1);
        let pos = 0;
        if (headerBytes) {
            result.set(headerBytes, pos);
            pos += headerSize;
        }
        for (const b of blocks) {
            result.set(b, pos);
            pos += b.length;
        }
        result[pos] = 0xFF;

        this.computeTelemetry(blockStats);
        return result;
    }

    private computeTelemetry(blockStats: any[]) {
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

    /**
     * FINALIZE: Seal the stream, optionally write Manifest/Sidecar.
     */
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

        this.context = null as any;
        this.isFinalized = true;

        if (this.lastTelemetry) {
            this.lastTelemetry.sidecar = this.options.sidecarWriter ? filename : null;
        }
    }

    // Compatibility for Benchmark Harness
    async finish(): Promise<Uint8Array> {
        const result = await this.flush();
        return result;
    }

    private createBlock(streamId: StreamId, codecId: CodecId, nItems: number, payload: Uint8Array, flags: number): Uint8Array {
        const block = new Uint8Array(BLOCK_HEADER_SIZE + payload.length);
        const view = new DataView(block.buffer);

        view.setUint8(0, streamId);
        view.setUint8(1, codecId);
        view.setUint32(2, nItems, true);
        view.setUint32(6, payload.length, true);
        view.setUint8(10, flags);

        block.set(payload, BLOCK_HEADER_SIZE);
        return block;
    }

    private computeTimeDeltas(timestamps: number[], commitState: boolean): number[] {
        const deltas: number[] = [];
        let prev = this.context.lastTimestamp ?? 0;
        let prevDelta = this.context.lastTimestampDelta ?? 0;

        for (const current of timestamps) {
            const currentDelta = current - prev;
            const deltaOfDelta = currentDelta - prevDelta;
            deltas.push(deltaOfDelta);
            prev = current;
            prevDelta = currentDelta;
        }

        if (commitState) {
            this.context.lastTimestamp = prev;
            this.context.lastTimestampDelta = prevDelta;
        }
        return deltas;
    }

    private computeValueDeltas(values: number[], commitState: boolean): number[] {
        const deltas: number[] = [];
        let prev = this.context.lastValue ?? 0;
        let prevDelta = this.context.lastValueDelta ?? 0;

        for (const current of values) {
            const diff = current - prev;
            deltas.push(diff);
            prevDelta = diff;
            prev = current;
        }

        if (commitState) {
            this.context.lastValue = prev;
            this.context.lastValueDelta = prevDelta;
        }
        return deltas.map(Math.round);
    }

    private selectBestCodec(streamId: StreamId, inputData: number[], metrics: any, stateSnapshot: ContextSnapshot): { candidateEncoded: Uint8Array, candidateCodec: CodecId } {
        let candidateEncoded: Uint8Array;
        let candidateCodec: CodecId;

        if (this.context.id && streamId === StreamId.VALUE && metrics.unique_ratio < 0.5) {
            candidateCodec = CodecId.DICT_VARINT;
            candidateEncoded = Codecs.encodeDict(inputData, this.context);
        } else if (metrics.dod_zero_ratio > 0.9) {
            candidateCodec = CodecId.RLE_DOD;
            candidateEncoded = Codecs.encodeRLE(this.prepareDODStream(streamId, inputData, stateSnapshot));
        } else if (metrics.p90_abs_delta < 127) {
            candidateCodec = CodecId.BITPACK_DELTA;
            candidateEncoded = Codecs.encodeBitPack(inputData);
        } else if (streamId === StreamId.TIME) {
            candidateCodec = CodecId.DOD_VARINT;
            candidateEncoded = encodeVarint(inputData);
        } else {
            candidateCodec = CodecId.VARINT_DELTA;
            candidateEncoded = encodeVarint(inputData);
        }

        return { candidateEncoded, candidateCodec };
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
}
