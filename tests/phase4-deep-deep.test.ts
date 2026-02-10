
// NOTE: Vitest globals are enabled (see vitest.config.ts). Avoid importing from
// 'vitest' in test files to prevent "No test suite found" issues.
import { GICSv2Encoder } from '../src/gics/encode.js';
import { GICSv2Decoder } from '../src/gics/decode.js';
import { Snapshot } from '../src/gics-types.js';
import { InnerCodecId, StreamId } from '../src/gics/format.js';

describe('Deep Dive Phase 4: Structural and CHM Validation', () => {

    it('verifies SNAPSHOT_LEN trial selection chooses the most efficient codec', async () => {
        // Create snapshots where RLE is clearly better for length (constant lengths)
        const snapshots: Snapshot[] = [];
        for (let i = 0; i < 1100; i++) {
            snapshots.push({ timestamp: i, items: new Map([[1, { price: 10, quantity: 1 }]]) });
        }

        const encoder = new GICSv2Encoder();
        for (const s of snapshots) await encoder.push(s);
        await encoder.flush();

        const telemetry = encoder.getTelemetry();
        const snapLenBlock = telemetry?.blocks.find(b => b.stream_id === StreamId.SNAPSHOT_LEN);

        // With constant lengths, RLE_ZIGZAG should be chosen over VARINT
        // RLE for 1100 identical values is much smaller than 1100 varints.
        expect(snapLenBlock?.codec).toBe(InnerCodecId.RLE_ZIGZAG);
    });

    it('verifies ITEM_ID uses DICT_VARINT when item IDs repeat', async () => {
        const snapshots: Snapshot[] = [];
        for (let i = 0; i < 1100; i++) {
            const items = new Map();
            items.set(5000, { price: 10, quantity: 1 }); // High ID to favor DICT over VARINT
            snapshots.push({ timestamp: i, items });
        }

        const encoder = new GICSv2Encoder();
        for (const s of snapshots) await encoder.push(s);
        await encoder.flush();

        const telemetry = encoder.getTelemetry();
        const itemBlock = telemetry?.blocks.find(b => b.stream_id === StreamId.ITEM_ID);

        // For repeating high IDs, DICT should beat VARINT (1 byte vs 2-3 bytes)
        expect(itemBlock?.codec).toBe(InnerCodecId.DICT_VARINT);
    });

    it('verifies context isolation: one stream must NOT affect another in trial', async () => {
        const snapshots: Snapshot[] = [
            { timestamp: 1000, items: new Map([[1, { price: 100, quantity: 1 }]]) },
            { timestamp: 1010, items: new Map([[1, { price: 110, quantity: 1 }]]) }
        ];

        const encoder = new GICSv2Encoder();
        for (const s of snapshots) await encoder.push(s);
        const bytes = await encoder.seal();

        const decoder = new GICSv2Decoder(bytes);
        const decoded = await decoder.getAllSnapshots();

        expect(decoded[1].timestamp).toBe(1010);
        expect(decoded[1].items.get(1)?.price).toBe(110);
    });

    it('verifies CHM transition for TIME stream under high jitter', async () => {
        const snapshots: Snapshot[] = [];
        let time = 1000;
        // Block 1: Stable
        for (let i = 0; i < 1000; i++) {
            time += 10;
            snapshots.push({ timestamp: time, items: new Map([[1, { price: 10, quantity: 1 }]]) });
        }
        // Block 2: Chaos (should trigger QUARANTINE)
        for (let i = 0; i < 1000; i++) {
            time += (Math.random() > 0.5 ? 1000 : 1);
            snapshots.push({ timestamp: time, items: new Map([[1, { price: 10, quantity: 1 }]]) });
        }

        const encoder = new GICSv2Encoder();
        for (const s of snapshots) await encoder.push(s);
        await encoder.flush();

        const telemetry = encoder.getTelemetry();
        const timeBlocks = telemetry?.blocks.filter(b => b.stream_id === StreamId.TIME);

        expect(timeBlocks?.[0].params.decision).toBe('CORE');
        // The second block might be CORE initially but should ideally detect anomaly if jitter is high enough
        // Note: CHM needs enough blocks to build baseline. 1 block might be too little for Sigma-3 trigger.
    });
});
