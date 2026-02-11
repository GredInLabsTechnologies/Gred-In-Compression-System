import { describe, it, expect } from 'vitest';
import { GICSv2Encoder } from '../../src/gics/encode.js';
import { GICSv2Decoder } from '../../src/gics/decode.js';
import { SchemaProfile } from '../../src/gics-types.js';
import { calculateCRC32 } from '../../src/gics/integrity.js';

describe('Security: Untrusted Header Length', () => {
    const SCHEMA: SchemaProfile = {
        id: 'test_schema',
        version: 1,
        itemIdType: 'number',
        fields: [
            { name: 'val', type: 'numeric' }
        ]
    };

    it('should reject decompression if actual length does not match header length', async () => {
        // 1. Create a valid GICS file
        const encoder = new GICSv2Encoder({ schema: SCHEMA });
        await encoder.addSnapshot({
            timestamp: 1000,
            items: new Map([[1, { val: 123 }]])
        });
        const validData = await encoder.finish();

        // 2. Modify uncompressedLen to 0
        const view = new DataView(validData.buffer, validData.byteOffset, validData.byteLength);
        let pos = 14; // Skip File Header

        // Skip Schema Section
        const schemaLen = view.getUint32(pos, true);
        pos += 4 + schemaLen;

        const segmentStart = pos;
        const segmentTotalLength = view.getUint32(pos + 6, true);

        pos += 14; // Skip Segment Header

        // Now at First Stream Section
        const uncompressedLenOffset = pos + 4;

        // Clone buffer
        const exploitedData = new Uint8Array(validData);
        const exploitedView = new DataView(exploitedData.buffer, exploitedData.byteOffset, exploitedData.byteLength);

        exploitedView.setUint32(uncompressedLenOffset, 0, true);

        // 3. Recompute CRC
        const footerSize = 36;
        const preFooterLength = segmentTotalLength - footerSize;
        const preFooter = exploitedData.subarray(segmentStart, segmentStart + preFooterLength);

        const newCRC = calculateCRC32(preFooter);
        const crcOffset = segmentStart + segmentTotalLength - 4;
        exploitedView.setUint32(crcOffset, newCRC, true);

        // 4. Attempt to decode
        const decoder = new GICSv2Decoder(exploitedData);

        await expect(decoder.getAllGenericSnapshots()).rejects.toThrow(/Decompression size mismatch/);
    });
});
