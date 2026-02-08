import { HybridReader, HybridWriter, VersionMismatchError } from '../src/gics-hybrid.js';

describe('GICS Versioning & Security', () => {
    it('should write the correct magic bytes (GICS)', async () => {
        const writer = new HybridWriter();
        await writer.addSnapshot({ timestamp: 100, items: new Map([[1, { price: 10, quantity: 1 }]]) });
        const data = await writer.finish();

        // Check Magic: G I C S (0x47 0x49 0x43 0x53)
        expect(data[0]).toBe(0x47);
        expect(data[1]).toBe(0x49);
        expect(data[2]).toBe(0x43);
        expect(data[3]).toBe(0x53);
    });

    it('should write the correct version (v1)', async () => {
        const writer = new HybridWriter();
        await writer.addSnapshot({ timestamp: 100, items: new Map() });
        const data = await writer.finish();

        // Version byte at offset 4
        expect(data[4]).toBe(1);
    });

    it('should reject future versions', async () => {
        const writer = new HybridWriter();
        await writer.addSnapshot({ timestamp: 100, items: new Map() });
        const validData = await writer.finish();

        // Tamper with version: Set to v255 (future)
        const corruptedData = new Uint8Array(validData);
        corruptedData[4] = 255;

        // Reader should explode
        expect(() => new HybridReader(corruptedData)).toThrow(VersionMismatchError);
    });

    it('should reject invalid magic bytes', async () => {
        const data = new Uint8Array(100);
        data.set([0x00, 0x01, 0x02, 0x03], 0); // BAD MAGIC

        expect(() => new HybridReader(data)).toThrow(/Invalid GICS Magic Bytes/);
    });
});



