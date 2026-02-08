import { Snapshot } from '../gics-types.js';
import { decodeVarint } from '../gics-utils.js';
import { GICS_MAGIC_V2, StreamId, CodecId, BLOCK_HEADER_SIZE } from './format.js';
import { ContextV0 } from './context.js';
import { Codecs } from './codecs.js';
import { IncompleteDataError, IntegrityError } from './errors.js';

export class GICSv2Decoder {
    private readonly data: Uint8Array;
    private pos: number = 0;
    private readonly context: ContextV0;

    // NOTE(v1.3 hygiene): no shared mutable static state between instances.
    static resetSharedContext() {
        // kept for backward-compat in tests; no-op now
    }

    constructor(data: Uint8Array) {
        this.data = data;

        // v1.2 decoder must be deterministic and instance-isolated.
        // (Previous sharedContext caused cross-test contamination.)
        this.context = new ContextV0('hash_placeholder');
    }

    async getAllSnapshots(): Promise<Snapshot[]> {
        // 1. Check Magic
        if (this.data.length < GICS_MAGIC_V2.length) {
            throw new Error('Data too short');
        }

        // Check if v2
        let isV2 = true;
        for (let i = 0; i < GICS_MAGIC_V2.length; i++) {
            if (this.data[i] !== GICS_MAGIC_V2[i]) {
                isV2 = false;
                break;
            }
        }

        if (!isV2) {
            throw new IntegrityError("GICS v1.2 Decoder: Legacy v1.1 format not supported in this build.");
        }

        // 2. Validate EOS marker (fail-closed)
        if (this.data.at(-1) !== 0xFF) {
            throw new IncompleteDataError('GICS: Missing EOS marker (0xFF) - incomplete or corrupt data');
        }

        // 3. Parse V2 Header
        this.pos = GICS_MAGIC_V2.length;
        const version = this.getUint8();
        if (version !== 2) throw new IntegrityError(`Unsupported version: ${version}`);

        this.getUint32(); // Read flags (unused for now)

        // 4. Parse Blocks - Multi-stream support
        let timeData: number[] = [];
        let snapshotLengths: number[] = [];
        let itemIds: number[] = [];
        let priceData: number[] = [];
        let quantityData: number[] = [];

        // -1 to skip EOS marker at end
        const dataEnd = this.data.length - 1;

        while (this.pos < dataEnd) {
            const { streamId, values } = this.parseBlock(dataEnd);

            // Route to appropriate stream array
            if (streamId === StreamId.TIME) {
                timeData.push(...values);
            } else if (streamId === StreamId.SNAPSHOT_LEN) {
                snapshotLengths.push(...values);
            } else if (streamId === StreamId.ITEM_ID) {
                itemIds.push(...values);
            } else if (streamId === StreamId.VALUE) {
                priceData.push(...values);
            } else if (streamId === StreamId.QUANTITY) {
                quantityData.push(...values);
            }
        }

        return this.reconstructSnapshots(timeData, snapshotLengths, itemIds, priceData, quantityData);
    }

    private reconstructSnapshots(timeData: number[], snapshotLengths: number[], itemIds: number[], priceData: number[], quantityData: number[]): Snapshot[] {
        const result: Snapshot[] = [];

        // If snapshotLengths is empty, fall back to legacy single-item mode
        if (snapshotLengths.length === 0) {
            // Legacy single-item mode (for backward compat with broken v1.2 files)
            const count = Math.min(timeData.length, priceData.length);
            for (let i = 0; i < count; i++) {
                const map = new Map<number, { price: number; quantity: number }>();
                map.set(1, { price: priceData[i], quantity: 1 });
                result.push({ timestamp: timeData[i], items: map });
            }
        } else {
            // Multi-item mode
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

                result.push({
                    timestamp: timeData[s] ?? 0,
                    items: map
                });
            }
        }

        return result;
    }

    private parseBlock(dataEnd: number) {
        if (this.pos + BLOCK_HEADER_SIZE > dataEnd) {
            throw new IncompleteDataError('GICS: Truncated block header');
        }

        const streamId = this.getUint8();
        const codecId = this.getUint8();
        const nItems = this.getUint32();
        const payloadLen = this.getUint32();
        const blockFlags = this.getUint8();

        const payloadStart = this.pos;
        const payloadEnd = this.pos + payloadLen;

        if (payloadEnd > dataEnd) {
            throw new IncompleteDataError('GICS: Block payload exceeds file size');
        }

        const payload = this.data.subarray(payloadStart, payloadEnd);
        this.pos = payloadEnd;

        // Decode payload
        let values: number[] = [];

        if (codecId === CodecId.VARINT_DELTA || codecId === CodecId.DOD_VARINT) {
            values = decodeVarint(payload);
        } else if (codecId === CodecId.BITPACK_DELTA) {
            values = Codecs.decodeBitPack(payload, nItems);
        } else if (codecId === CodecId.RLE_ZIGZAG || codecId === CodecId.RLE_DOD) {
            values = Codecs.decodeRLE(payload);
        } else if (codecId === CodecId.DICT_VARINT) {
            values = Codecs.decodeDict(payload, this.context);
        } else {
            // Unknown codec, return empty
            return { streamId, values: [] };
        }

        const commitable = (blockFlags & 0x10) === 0; // HEALTH_QUAR = 0x10

        if (streamId === StreamId.TIME) {
            return { streamId, values: this.decodeTimeStream(values, commitable) };
        } else if (streamId === StreamId.VALUE) {
            const isDOD = (codecId === CodecId.DOD_VARINT || codecId === CodecId.RLE_DOD);
            return { streamId, values: this.decodeValueStream(values, commitable, isDOD) };
        } else {
            return { streamId, values };
        }
    }

    private decodeTimeStream(deltas: number[], shouldCommit: boolean): number[] {
        if (deltas.length === 0) return [];
        const timestamps: number[] = [];

        let prev = this.context.lastTimestamp ?? 0;
        let prevDelta = this.context.lastTimestampDelta ?? 0;

        for (const deltaOfDelta of deltas) {
            const currentDelta = prevDelta + deltaOfDelta;
            const current = prev + currentDelta;
            timestamps.push(current);
            prev = current;
            prevDelta = currentDelta;
        }

        if (shouldCommit) {
            this.context.lastTimestamp = prev;
            this.context.lastTimestampDelta = prevDelta;
        }
        return timestamps;
    }

    private decodeValueStream(deltas: number[], shouldCommit: boolean, isDOD: boolean = false): number[] {
        if (deltas.length === 0) return [];
        const values: number[] = [];
        let prev = this.context.lastValue ?? 0;
        let prevDelta = this.context.lastValueDelta ?? 0;

        for (const rawChange of deltas) {
            let change = rawChange;
            if (isDOD) {
                // Input is DeltaOfDelta
                const currentDelta = prevDelta + change;
                change = currentDelta; // Change to Apply is the new Delta
                prevDelta = currentDelta;
            } else {
                // Input is Delta
                const currentDelta = change;
                prevDelta = currentDelta;
            }

            const current = prev + change;
            values.push(current);
            prev = current;
        }

        if (shouldCommit) {
            this.context.lastValue = prev;
            this.context.lastValueDelta = prevDelta;
        }
        return values;
    }

    private getUint8(): number {
        return this.data[this.pos++];
    }

    private getUint32(): number {
        const val = new DataView(this.data.buffer, this.data.byteOffset + this.pos, 4).getUint32(0, true);
        this.pos += 4;
        return val;
    }
}
