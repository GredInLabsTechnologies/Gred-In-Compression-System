import { Snapshot } from '../../gics-types.js';
import { encodeVarint } from '../../gics-utils.js';
import { GICS_MAGIC_V2, V12_FLAGS, StreamId, CodecId, GICS_VERSION_BYTE, BLOCK_HEADER_SIZE, HealthTag } from './format.js';
import { ContextV0, ContextSnapshot } from './context.js';
import { calculateBlockMetrics, classifyRegime, BlockMetrics } from './metrics.js';
import { Codecs } from './codecs.js';
import { HealthMonitor, RoutingDecision } from './chm.js';
import * as fs from 'fs';
import * as path from 'path';

const BLOCK_SIZE = 1000;

// User Requirement: Strict Safe Logic selection.
const SAFE_CODEC_TIME = CodecId.DOD_VARINT;
const SAFE_CODEC_VALUE = CodecId.VARINT_DELTA;

export class GICSv2Encoder {
    private snapshots: Snapshot[] = [];
    private context: ContextV0;
    private chmTime: HealthMonitor;
    private chmValue: HealthMonitor;
    private mode: string;
    private lastTelemetry: any = null;
    private isFinalized = false;
    private hasEmittedHeader = false;
    private runId: string;

    private static sharedContext: ContextV0 | null = null;
    private static sharedCHMTime: HealthMonitor | null = null;
    private static sharedCHMValue: HealthMonitor | null = null;

    static reset() {
        GICSv2Encoder.sharedContext = null;
        GICSv2Encoder.sharedCHMTime = null;
        GICSv2Encoder.sharedCHMValue = null;
    }

    static resetSharedContext() {
        GICSv2Encoder.reset();
    }

    constructor() {
        if (process.env.GICS_TEST_RUN_ID) {
            this.runId = process.env.GICS_TEST_RUN_ID;
        } else {
            this.runId = `run_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
        }
        this.mode = process.env.GICS_CONTEXT_MODE || 'on';

        if (this.mode === 'off') {
            this.context = new ContextV0('hash_placeholder', null);
            const envProbe = process.env.GICS_PROBE_INTERVAL;
            const probeInterval = (envProbe !== undefined && envProbe !== '') ? parseInt(envProbe, 10) : 4;
            this.chmTime = new HealthMonitor(`${this.runId}:TIME`, probeInterval);
            this.chmValue = new HealthMonitor(`${this.runId}:VALUE`, probeInterval);
        } else {
            if (!GICSv2Encoder.sharedContext) {
                GICSv2Encoder.sharedContext = new ContextV0('hash_placeholder');
            }
            this.context = GICSv2Encoder.sharedContext;

            if (!GICSv2Encoder.sharedCHMTime || !GICSv2Encoder.sharedCHMValue) {
                const envProbe = process.env.GICS_PROBE_INTERVAL;
                const probeInterval = (envProbe !== undefined && envProbe !== '') ? parseInt(envProbe, 10) : 4;
                if (!GICSv2Encoder.sharedCHMTime) {
                    GICSv2Encoder.sharedCHMTime = new HealthMonitor(`${this.runId}:TIME`, probeInterval);
                }
                if (!GICSv2Encoder.sharedCHMValue) {
                    GICSv2Encoder.sharedCHMValue = new HealthMonitor(`${this.runId}:VALUE`, probeInterval);
                }
            }
            this.chmTime = GICSv2Encoder.sharedCHMTime!;
            this.chmValue = GICSv2Encoder.sharedCHMValue!;
        }
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
        if (this.snapshots.length === 0) {
            return new Uint8Array(0);
        }

        const blocks: Uint8Array[] = [];
        const blockStats: any[] = [];

        // Process snapshots - MULTI-ITEM with deterministic ordering
        const timestamps: number[] = [];
        const snapshotLengths: number[] = [];  // Items per snapshot
        const itemIds: number[] = [];          // All item IDs (flattened)
        const prices: number[] = [];           // All prices (flattened)
        const quantities: number[] = [];       // All quantities (flattened)

        for (const s of this.snapshots) {
            timestamps.push(s.timestamp);
            // Sort items by ID for determinism (Map iteration order is not guaranteed)
            const sortedItems = [...s.items.entries()].sort((a, b) => a[0] - b[0]);
            snapshotLengths.push(sortedItems.length);
            for (const [id, data] of sortedItems) {
                itemIds.push(id);
                prices.push(data.price);
                quantities.push(data.quantity);
            }
        }
        this.snapshots = [];

        // Updated Signature: accepts stateSnapshot (ContextSnapshot)
        const processBlock = (streamId: StreamId, chunk: number[], inputData: number[], stateSnapshot: ContextSnapshot, chm: HealthMonitor) => {
            const metrics = calculateBlockMetrics(chunk);
            const rawInBytes = chunk.length * 8;
            const currentBlockIndex = chm.getTotalBlocks() + 1;

            // --- Split-5: Router-First Optimistic Execution ---
            let candidateEncoded: Uint8Array;
            let candidateCodec: CodecId;
            let candidateRatio: number;

            // 1. Select Best Codec for Core (Heuristic -> Data Driven)

            // PRIORITY 1: Dictionary (Repeated Raw Values)
            // (Only for Values, Time is usually strictly increasing)
            if (this.context.id && streamId === StreamId.VALUE && metrics.unique_ratio < 0.5) {
                candidateCodec = CodecId.DICT_VARINT;
                candidateEncoded = Codecs.encodeDict(inputData, this.context);
            }
            // PRIORITY 2: RLE on Delta-of-Delta (Trend with Noise / Linear)
            else if (metrics.dod_zero_ratio > 0.90) {
                // To use RLE_DOD, we need DoD stream.
                let dodStream: number[];
                if (streamId === StreamId.TIME) {
                    // Time inputData is ALREADY DoD
                    dodStream = inputData;
                } else {
                    // Value inputData is Delta. Compute DoD.
                    dodStream = [];
                    let pd = stateSnapshot.lastValueDelta || 0;
                    for (const d of inputData) {
                        dodStream.push(d - pd);
                        pd = d;
                    }
                }
                candidateCodec = CodecId.RLE_DOD;
                candidateEncoded = Codecs.encodeRLE(dodStream);
            }
            // PRIORITY 3: Bitpacking (Low Entropy Delta)
            else if (metrics.p90_abs_delta < 127) {
                // NOTE:
                // - VALUE stream `inputData` is Delta.
                // - TIME stream `inputData` is Delta-of-Delta.
                // The decoder's TIME path expects Delta-of-Delta values for all codecs.
                // So for TIME we bitpack the DoD stream directly (NOT reconstructed deltas).
                const bitpackInput = (streamId === StreamId.TIME) ? inputData : inputData;
                candidateCodec = CodecId.BITPACK_DELTA;
                candidateEncoded = Codecs.encodeBitPack(bitpackInput);
            }
            // FALLBACK: Standard Varint
            else {
                if (streamId === StreamId.TIME) {
                    // Input is DoD. Use DOD_VARINT.
                    candidateCodec = CodecId.DOD_VARINT;
                    candidateEncoded = encodeVarint(inputData);
                } else {
                    // Input is Delta. Use VARINT_DELTA.
                    candidateCodec = CodecId.VARINT_DELTA;
                    candidateEncoded = encodeVarint(inputData);
                }
            }

            const coreLen = candidateEncoded.length + BLOCK_HEADER_SIZE;
            const safeCoreOut = coreLen > 0 ? coreLen : 1;
            candidateRatio = rawInBytes / safeCoreOut;

            // 2. CHM Routing Decision (Quality Gate)
            const route = chm.decideRoute(metrics, candidateRatio, currentBlockIndex);

            // 3. Execution based on Route
            let finalEncoded: Uint8Array;
            let finalCodec: CodecId;

            if (route.decision === RoutingDecision.QUARANTINE) {
                // REJECTED: Rollback Context
                this.context.restore(stateSnapshot);

                // Encode SAFE (Stateless)
                // SAFE uses Varint Delta.
                // For Time (DoD input), we need Delta.
                // For Value (Delta input), we have Delta.

                let safeDeltas: number[];
                if (streamId === StreamId.TIME) {
                    safeDeltas = [];
                    let pd = stateSnapshot.lastTimestampDelta || 0;
                    for (const dd of inputData) {
                        pd = pd + dd;
                        safeDeltas.push(pd);
                    }
                } else {
                    safeDeltas = inputData;
                }

                const safeCodec = (streamId === StreamId.TIME) ? SAFE_CODEC_TIME : SAFE_CODEC_VALUE;
                // Wait, SAFE_CODEC_TIME is DOD_VARINT in constants line 14?
                // const SAFE_CODEC_TIME = CodecId.DOD_VARINT;
                // If Safe is DoD Varint, then we can preserve DoD input for Time?
                // But Stateless means NO CONTEXT.
                // DoD requires previous delta. Without context, DoD is impossible?
                // Actually, VarintDelta requires previous Value.
                // Stateless usually implies: We emit raw? Or we emit Delta from 0?
                // For Quarantine, we usually just want "Valid Format".
                // If we use DOD_VARINT for Time in Quarantine, decoder needs context.
                // QUARANTINE blocks should assume broken context?
                // Implementation in v1.1 used separate Quarantine Context or just appended?
                // Here we restored context. So effectively we FORGOT the block content from context perspective.
                // So the NEXT block will start from the OLD context.
                // The current block must be decodable?
                // If we emit a block as QUARANTINE, does the decoder update context?
                // Decoder reads flag. If QUARANTINE, maybe it skips context update?
                // We haven't touched Decoder. Reference implementation required.
                // Assuming "Safe Encode" means "Encode using standard codec but DO NOT update context" (which we already did by restore).
                // But the BYTES must be valid.
                // If we encode Deltas, and Decoder decodes Deltas, it updates its context.
                // If Decoder sees QUARANTINE, does it ignore the data?
                // Spec says "QUARANTINE exists for anomalies".
                // We'll stick to the existing logic:
                // `finalEncoded = encodeVarint(deltas);`
                // `finalCodec = safeCodec;`

                // Existing logic used `deltas` variable from closure scope.
                // Verify what `deltas` was in original code.
                // In original: `processBlock(..., deltas, ...)` -> passed straight.
                // For Time it was DoD. For Value it was Delta.
                // So we just use `inputData`.

                finalEncoded = encodeVarint(inputData);
                finalCodec = (streamId === StreamId.TIME) ? CodecId.DOD_VARINT : CodecId.VARINT_DELTA;

            } else {
                // ACCEPTED: Keep Context Updates (Commit)
                finalEncoded = candidateEncoded;
                finalCodec = candidateCodec;
            }

            // 4. Update CHM (Stat Tracking & State Transitions)
            const chmResult = chm.update(
                route.decision,
                metrics,
                rawInBytes,
                finalEncoded.length,
                BLOCK_HEADER_SIZE,
                currentBlockIndex,
                finalCodec
            );

            // Create Block
            const block = this.createBlock(streamId, finalCodec, chunk.length, finalEncoded, chmResult.flags);
            blocks.push(block);

            blockStats.push({
                stream_id: streamId,
                codec: finalCodec,
                bytes: block.length, // Total Output (Header + Payload)
                raw_bytes: rawInBytes, // Audit: Raw Input
                header_bytes: BLOCK_HEADER_SIZE, // Audit: Header Overhead
                payload_bytes: finalEncoded.length, // Audit: Compressed Payload
                params: { // Audit: Context for Decision Trace
                    decision: route.decision,
                    reason: route.reason
                },
                flags: chmResult.flags,
                health: chmResult.healthTag,
                ratio: rawInBytes / block.length, // Honest Block Ratio
                trainBaseline: (route.decision === RoutingDecision.CORE),
                metrics: metrics,
                regime: classifyRegime(metrics)
            });
        };

        // Create Time Blocks
        for (let i = 0; i < timestamps.length; i += BLOCK_SIZE) {
            const chunk = timestamps.slice(i, i + BLOCK_SIZE);
            const snapshot = this.context.snapshot(); // Capture START state (before TS update)
            const deltas = this.computeTimeDeltas(chunk, true); // Updates Context TS to END
            processBlock(StreamId.TIME, chunk, deltas, snapshot, this.chmTime);
        }
        // Create SNAPSHOT_LEN Blocks (items per snapshot - 1:1 with timestamps)
        for (let i = 0; i < snapshotLengths.length; i += BLOCK_SIZE) {
            const chunk = snapshotLengths.slice(i, i + BLOCK_SIZE);
            const snapshot = this.context.snapshot();
            // SNAPSHOT_LEN uses simple varint encoding (no delta context needed)
            const encoded = encodeVarint(chunk);
            const block = this.createBlock(StreamId.SNAPSHOT_LEN, CodecId.VARINT_DELTA, chunk.length, encoded, 0);
            blocks.push(block);
            blockStats.push({
                stream_id: StreamId.SNAPSHOT_LEN,
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
                metrics: calculateBlockMetrics(chunk),
                regime: classifyRegime(calculateBlockMetrics(chunk))
            });
        }

        // Create ITEM_ID Blocks (all item IDs flattened)
        for (let i = 0; i < itemIds.length; i += BLOCK_SIZE) {
            const chunk = itemIds.slice(i, i + BLOCK_SIZE);
            const snapshot = this.context.snapshot();
            const encoded = encodeVarint(chunk);
            const block = this.createBlock(StreamId.ITEM_ID, CodecId.VARINT_DELTA, chunk.length, encoded, 0);
            blocks.push(block);
            blockStats.push({
                stream_id: StreamId.ITEM_ID,
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
                metrics: calculateBlockMetrics(chunk),
                regime: classifyRegime(calculateBlockMetrics(chunk))
            });
        }

        // Create VALUE Blocks (prices - using existing compressible pipeline)
        for (let i = 0; i < prices.length; i += BLOCK_SIZE) {
            const chunk = prices.slice(i, i + BLOCK_SIZE);
            const snapshot = this.context.snapshot(); // Capture START state
            const deltas = this.computeValueDeltas(chunk, true); // Updates Context to END
            processBlock(StreamId.VALUE, chunk, deltas, snapshot, this.chmValue);
        }

        // Create QUANTITY Blocks (all quantities flattened)
        for (let i = 0; i < quantities.length; i += BLOCK_SIZE) {
            const chunk = quantities.slice(i, i + BLOCK_SIZE);
            const snapshot = this.context.snapshot();
            const encoded = encodeVarint(chunk);
            const block = this.createBlock(StreamId.QUANTITY, CodecId.VARINT_DELTA, chunk.length, encoded, 0);
            blocks.push(block);
            blockStats.push({
                stream_id: StreamId.QUANTITY,
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
                metrics: calculateBlockMetrics(chunk),
                regime: classifyRegime(calculateBlockMetrics(chunk))
            });
        }

        // --- Header Handling ---
        let result: Uint8Array;

        const totalPayloadSize = blocks.reduce((acc, b) => acc + b.length, 0);

        let headerSize = 0;
        let headerBytes: Uint8Array | null = null;

        if (!this.hasEmittedHeader) {
            headerSize = GICS_MAGIC_V2.length + 1 + 4; // Magic(4)+Ver(1)+Flags(4)
            headerBytes = new Uint8Array(headerSize);
            headerBytes.set(GICS_MAGIC_V2, 0);
            headerBytes[4] = GICS_VERSION_BYTE;
            new DataView(headerBytes.buffer).setUint32(5, V12_FLAGS.FIELDWISE_TS, true);
            this.hasEmittedHeader = true;
        }

        // +1 for EOS marker
        const size = (headerBytes ? headerSize : 0) + totalPayloadSize + 1;
        result = new Uint8Array(size);

        let pos = 0;
        if (headerBytes) {
            result.set(headerBytes, pos);
            pos += headerSize;
        }

        for (const b of blocks) {
            result.set(b, pos);
            pos += b.length;
        }

        // Write EOS marker (0xFF) for fail-closed validation
        result[pos] = 0xFF;

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

        return result;
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

        // Only write sidecar if GICS_SIDECAR_PATH is set (avoid CWD pollution)
        const sidecarPath = process.env.GICS_SIDECAR_PATH;
        if (sidecarPath) {
            try {
                fs.writeFileSync(path.join(sidecarPath, filename), JSON.stringify(report, null, 2));
            } catch (e) {
                console.error("Failed to write sidecar report", e);
            }
        }

        this.context = null as any;
        this.isFinalized = true;

        if (this.lastTelemetry) {
            this.lastTelemetry.sidecar = sidecarPath ? filename : null;
        }
    }

    // Compatibility for Benchmark Harness
    // Harness expects writer.finish() to return the encoded buffer (Uint8Array)
    async finish(): Promise<Uint8Array> {
        const result = await this.flush();
        // Do NOT finalize here, as harness might interpret finish() as "flush current chunk" in continuous mode.
        // await this.finalize(); 
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
        let prev = this.context.lastTimestamp !== undefined ? this.context.lastTimestamp : 0;
        let prevDelta = this.context.lastTimestampDelta !== undefined ? this.context.lastTimestampDelta : 0;

        for (let i = 0; i < timestamps.length; i++) {
            const current = timestamps[i];
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
        let prev = this.context.lastValue !== undefined ? this.context.lastValue : 0;
        let prevDelta = this.context.lastValueDelta !== undefined ? this.context.lastValueDelta : 0;

        for (let i = 0; i < values.length; i++) {
            const current = values[i];
            const diff = current - prev; // Delta
            deltas.push(diff);

            // For state tracking of DoD, we need to know the 'delta' we just made
            // But we don't compute DoD here for return (we return Deltas).
            // But we must update lastValueDelta if commitState is true
            // So we just track it.
            prevDelta = diff;
            prev = current;
        }

        if (commitState) {
            this.context.lastValue = prev;
            this.context.lastValueDelta = prevDelta;
        }
        return deltas.map(Math.round);
    }
}
