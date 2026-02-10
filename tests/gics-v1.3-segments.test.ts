// NOTE: Vitest globals are enabled (see vitest.config.ts). Avoid importing from
// 'vitest' in test files to prevent "No test suite found" issues.
import { GICSv2Encoder } from '../src/gics/encode.js';
import { GICSv2Decoder } from '../src/gics/decode.js';
import { Snapshot } from '../src/gics-types.js';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('GICS v1.3 Segments & Append', () => {
    const createSnapshots = (count: number, startTs: number, itemId: number): Snapshot[] => {
        const snaps: Snapshot[] = [];
        for (let i = 0; i < count; i++) {
            const items = new Map();
            items.set(itemId, { price: 100 + i, quantity: 10 });
            snaps.push({ timestamp: startTs + i * 1000, items });
        }
        return snaps;
    };

    it('should encode and decode multiple segments using size limit', async () => {
        // limit to 200 bytes per segment to force split
        const encoder = new GICSv2Encoder({ segmentSizeLimit: 200 });
        const snapshots = createSnapshots(10, 1600000000000, 101);

        for (const s of snapshots) await encoder.push(s);
        const data = await encoder.seal();

        const decoder = new GICSv2Decoder(data);
        const decoded = await decoder.getAllSnapshots();

        expect(decoded.length).toBe(10);
        expect(decoded[0].timestamp).toBe(snapshots[0].timestamp);
        expect(decoded[9].timestamp).toBe(snapshots[9].timestamp);
    });

    it('should append to an existing GICS file', async () => {
        const tempPath = join(tmpdir(), `gics_test_append_${Date.now()}.gics`);

        // Initial write
        const handle1 = await fs.open(tempPath, 'w+');
        const encoder1 = await GICSv2Encoder.openFile(handle1);
        const snaps1 = createSnapshots(5, 1600000000000, 101);
        for (const s of snaps1) await encoder1.push(s);
        await encoder1.sealToFile();
        await handle1.close();

        // Append write
        const handle2 = await fs.open(tempPath, 'r+');
        const encoder2 = await GICSv2Encoder.openFile(handle2);
        const snaps2 = createSnapshots(5, 1600000005000, 102);
        for (const s of snaps2) await encoder2.push(s);
        await encoder2.sealToFile();
        await handle2.close();

        // Decode
        const data = await fs.readFile(tempPath);
        const decoder = new GICSv2Decoder(data);
        const decoded = await decoder.getAllSnapshots();

        expect(decoded.length).toBe(10);
        expect(decoded[0].timestamp).toBe(snaps1[0].timestamp);
        expect(decoded[5].timestamp).toBe(snaps2[0].timestamp);

        await fs.unlink(tempPath);
    });

    it('should perform optimized query using segment index', async () => {
        const encoder = new GICSv2Encoder({ segmentSizeLimit: 200 });

        // Segment 1: Item 101
        for (const s of createSnapshots(5, 1600000000000, 101)) await encoder.push(s);
        await encoder.flush();

        // Segment 2: Item 202
        for (const s of createSnapshots(5, 1600000005000, 202)) await encoder.push(s);
        await encoder.flush();

        const data = await encoder.seal();
        const decoder = new GICSv2Decoder(data);

        // Query for 101 - should stay in result
        const q101 = await decoder.query(101);
        expect(q101.length).toBe(5);
        expect([...q101[0].items.keys()]).toContain(101);

        // Query for 202
        const q202 = await decoder.query(202);
        expect(q202.length).toBe(5);
        expect([...q202[0].items.keys()]).toContain(202);

        // Query for non-existent
        const q999 = await decoder.query(999);
        expect(q999.length).toBe(0);
    });

    it('should verify file-level integrity chain', async () => {
        const encoder = new GICSv2Encoder();
        for (const s of createSnapshots(5, 1600000000000, 101)) await encoder.push(s);
        const data = await encoder.seal();

        // Tamper with 1 byte inside the *first stream section payload*.
        // Important: don't corrupt SegmentHeader fields (e.g. totalLength) because the decoder
        // may fail earlier with a parse/truncation error instead of an integrity failure.
        //
        // Layout (v1.3): [FileHeader(14)] [SegmentHeader(14)] [StreamSection...] [SegmentIndex] [SegmentFooter(36)] [FileEOS(37)]
        const tampered = new Uint8Array(data);

        const fileHeaderSize = 14;
        const segmentHeaderSize = 14;
        const sectionOffset = fileHeaderSize + segmentHeaderSize;
        // StreamSection header is 12 bytes up to compressedLen (see StreamSection.deserialize)
        const view = new DataView(tampered.buffer, tampered.byteOffset + sectionOffset);
        const blockCount = view.getUint16(2, true);
        const compressedLen = view.getUint32(8, true);
        const sectionHeaderTotal = 44 + blockCount * 10; // 12 + hash(32) + manifest
        const payloadStart = sectionOffset + sectionHeaderTotal;

        const corruptAt = payloadStart + Math.floor(compressedLen / 2);
        if (corruptAt >= tampered.length - 37) {
            throw new Error('Test invariant failed: corruptAt outside data region');
        }
        tampered[corruptAt] ^= 0x01;

        const decoder = new GICSv2Decoder(tampered);
        await expect(decoder.getAllSnapshots()).rejects.toThrow(/CRC|Hash mismatch/);
    });
});
