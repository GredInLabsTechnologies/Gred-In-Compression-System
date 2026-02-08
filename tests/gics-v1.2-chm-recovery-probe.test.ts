import assert from 'node:assert';
import { GICSv2Encoder } from '../src/gics/encode.js';
import { BLOCK_FLAGS } from '../src/gics/format.js';

// Mocks
// We need to subclass or mock GICSv2Encoder to force behavior?
// Or we can construct input data carefully.
// To demonstrate Probe logic:
// We need Quarantine Active.
// We need Standard Encode (Probe) -> High Ratio (Success).
// We need Safe Encode (Actual) -> Low Ratio (Failure to recover if used directly).

// If Safe Encode uses Varint on Deltas, and Standard uses Varint on Deltas (default),
// they are the same unless Dictionary is used or Context is used.
// If Context is disabled during SAFE, but ENABLED during Probe (Normal dry-run uses context).
// So:
// 1. Establish a Context with good history.
// 2. Trigger Anomaly (e.g. huge jump).
// 3. In Quarantine:
//    - Feed data that matches Context history perfectly (Standard/Probe uses Context -> Tiny Deltas -> High Ratio).
//    - Safe (No Context) -> Large Deltas (if we clear context on safe? No, Safe just ignores it).
//    Actually Safe Codec is Fixed.
//    If we use Value Stream:
//    Standard = VARINT_DELTA (uses context lastValue).
//    Safe = VARINT_DELTA (uses context lastValue? No, Safe Codec usually stateless or uses its own? 
//    Wait. `codecs.ts` logic?
//    In `encode.ts`: 
//      Safe Loop: `const safeEncoded = encodeVarint(deltas);`
//      Standard Loop: `stdEncoded = encodeVarint(deltas);` (if not Dict)
//    Both usage `deltas`. `deltas` comes from `computeValueDeltas`.
//    `computeValueDeltas` uses `this.context.lastValue`.
//    The Context is shared?
//    Check `encode.ts` source again.
//    `computeValueDeltas` updates context if `commitState` is true.
//    But we calculate deltas ONCE per block at start of `processBlock`.
//    So `deltas` are fixed regardless of codec.
//    If `deltas` are small, `encodeVarint(deltas)` is small.
//    So Safe and Standard (Varint) are identical?
//    
//    Difference comes if Standard uses DICT.
//    If we force Dict capable data (repeating patterns) -> Standard uses Dict -> High Ratio.
//    Safe uses Varint -> Low Ratio.
//    
//    So we need data that compresses well with Dict but poorly with Varint.
//    Repeating sequence: 100, 200, 100, 200...
//    Deltas: +100, -100, +100, -100...
//    Varint of 100 is 1 byte (if < 128). 2 bytes if > 127.
//    Dict: 2 entries (-100, +100). References are 1 bit? 
//    Yes, Dict can be much better.

describe('GICS v1.2 CHM Recovery Probe', () => {

    it('Should recover from quarantine via Probe (Dict) even if Safe (Varint) is poor', async () => {
        GICSv2Encoder.reset();
        const enc = new GICSv2Encoder(); // Ensure context is ON by default

        // 1. Training Phase (High Entropy but Stable to build baseline)
        // We need baseline to be established. 
        // Default baselineRatio = 2.0.
        // Let's feed data that gives ratio ~2.0.
        // 1000 items. 4 bytes raw each (32bit) = 4000 bytes.
        // Compressed target 2000 bytes. 2 bytes per item.
        // Varint of 256 is 2 bytes. 
        // So values 256, 512, ... delta 256.

        const blockRaw: number[] = [];
        let v = 0;
        for (let i = 0; i < 1000; i++) {
            v += 300; // Delta 300 -> 2 bytes varint
            blockRaw.push(v);
        }

        // Feed 10 blocks to stabilize baseline around 2.0
        for (let b = 0; b < 10; b++) {
            // Each addSnapshot is one row. We need 1000 rows for 1 block.
            // Helper logic needed or just map?
            // Since `flush` batches, we can just dump all.
            // We need 10,000 items total.
            await Promise.all(blockRaw.map(val => enc.addSnapshot({ timestamp: Date.now(), items: new Map([[1, { price: val, quantity: 1 }]]) })));
            // Oh `addSnapshot` uses `items.values().next().value`. 
            // We need to emulate Value stream properly.
        }

        // Flush to process Training
        await enc.flush();

        // 2. Trigger Anomaly
        // Feed Random Noise -> Ratio drop.
        // Delta random large numbers -> 4-5 bytes per item.
        // Ratio < 1.0. Baseline 2.0. Drop > 3 sigma.

        const noiseData: number[] = [];
        for (let i = 0; i < 1000; i++) {
            noiseData.push(Math.floor(Math.random() * 1000000));
        }
        // Feed 1 block (1000 items)
        await Promise.all(noiseData.map(val => enc.addSnapshot({ timestamp: Date.now(), items: new Map([[1, { price: val, quantity: 1 }]]) })));
        await enc.flush();

        // Check finding ANOMALY_START
        // We can check bits in dataAnomaly or mock CHM?
        // Let's assume Anomaly Triggered.

        // 3. Recovery Phase
        // We want Standard (Dict) to be good, Safe (Varint) to be bad.
        // Repeating Pattern: +10000, -10000.
        // Varint(10000) is large (~2-3 bytes). Ratio ~1.5? Might be below baseline if baseline is 2.0.
        // Dict: 2 symbols. Ratio very high.

        const patternData: number[] = [];
        v = 0;
        for (let i = 0; i < 1000; i++) {
            v += (i % 2 === 0) ? 10000 : -10000;
            patternData.push(v);
        }

        // Feed enough blocks to trigger recovery.
        // M=3 probes. Interval=4.
        // We need to hit indexes: 12, 16, 20 (assuming block 11 was anomaly start).
        // Total blocks needed: 15-20.

        for (let b = 0; b < 20; b++) {
            await Promise.all(patternData.map(val => enc.addSnapshot({ timestamp: Date.now(), items: new Map([[1, { price: val, quantity: 1 }]]) })));
        }

        const finalData = await enc.flush();

        // We verify the Flags in finalData.
        // We expect to see ANOMALY_END eventually.
        // Parse blocks.


        let blockIndicesWithEnd: number[] = [];
        let valueBlockCount = 0;

        // Note: previous flushes output bytes too. "finalData" only contains new blocks from last flush?
        // Yes, `flush` returns current buffer.
        // So we scan `finalData` which corresponds to the 20 recovery blocks.
        // Block indices start from 12? (10 training + 1 anomaly = 11).

        // We need to handle `finalData` might be empty if loop failed? No.

        let pos = 0; // In finalData, it starts at 0 (no file header if header already emitted in previous flush? 
        // `hasEmittedHeader` in Encode.ts prevents re-emit.
        // So `finalData` has NO file header.

        while (pos < finalData.length) {
            const streamId = finalData[pos];
            if (streamId === undefined || streamId === 0xFF) break; // EOS marker

            const payloadLen = new DataView(finalData.buffer, finalData.byteOffset + pos + 6, 4).getUint32(0, true);
            const flags = finalData[pos + 10];
            const BLOCK_HEADER_SIZE = 11;



            // Only evaluate recovery timing on VALUE stream blocks.
            if (streamId === 20) {
                valueBlockCount++;
                if ((flags & BLOCK_FLAGS.ANOMALY_END) !== 0) {
                    blockIndicesWithEnd.push(valueBlockCount);
                }
            }
            pos += BLOCK_HEADER_SIZE + payloadLen;
        }

        // We expect exactly one ANOMALY_END.
        assert.strictEqual(blockIndicesWithEnd.length, 1, 'Should find one ANOMALY_END block');

        // It should be roughly after M*N blocks.
        // 3 * 4 = 12 blocks delay from START of QUARANTINE.
        // Quarantine started at Block 11. 11 + 12 = 23 (Absolute).
        // Wait, probes at 12, 16, 20. Recovery at 20.
        // Relative to flush (starting at 12): 20 - 11 = 9.
        assert.ok(blockIndicesWithEnd[0] >= 8 && blockIndicesWithEnd[0] <= 12, `Recovery should happen around probe 3 (Redux 9). Found at ${blockIndicesWithEnd[0]}`);

    });
});
