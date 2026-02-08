/**
 * GICS CRC Validation Test (Deterministic)
 * 
 * Uses finishWithLayout__debug() for precise payload targeting.
 * Not dependent on random offsets or guessing file structure.
 */

import { HybridWriter, HybridReader } from '../src/index.js';

// Header layout constants (must match gics-hybrid.ts)
const HEADER_VERSION_OFFSET = 4;

describe('GICS CRC Validation (Deterministic)', () => {

    it('should throw CRC_MISMATCH when payload byte is flipped', async () => {
        // 1. Generate file with layout info
        const writer = new HybridWriter();
        await writer.addSnapshot({
            timestamp: 1700000000,
            items: new Map([[1, { price: 1000, quantity: 10 }]])
        });
        const { bytes, layout } = await writer.finishWithLayout__debug();

        // 2. Verify we have at least one block
        expect(layout.blocks.length).toBeGreaterThan(0);

        // 3. Flip byte in the MIDDLE of the first block's payload
        const block = layout.blocks[0];
        const payloadMiddle = block.payloadStart + Math.floor(block.payloadLen / 2);

        const corrupted = new Uint8Array(bytes);
        corrupted[payloadMiddle] = (corrupted[payloadMiddle] + 1) % 256;

        // 4. Assert CRC_MISMATCH on read (error message is part of contract)
        const reader = new HybridReader(corrupted);
        await expect(reader.queryItems({})).rejects.toThrow(/CRC_MISMATCH/);
    });

    it('should NOT throw for valid uncorrupted file', async () => {
        const writer = new HybridWriter();
        await writer.addSnapshot({
            timestamp: 1700000000,
            items: new Map([[1, { price: 1000, quantity: 10 }]])
        });
        const { bytes } = await writer.finishWithLayout__debug();

        const reader = new HybridReader(bytes);

        // Should not throw
        const results = await reader.queryItems({});
        expect(results.length).toBeGreaterThan(0);
    });

    it('should throw on header corruption (magic bytes)', () => {
        const corrupted = new Uint8Array(100);
        corrupted.set([0x00, 0x01, 0x02, 0x03], 0); // Bad magic at offset 0

        expect(() => new HybridReader(corrupted)).toThrow(/Invalid GICS Magic Bytes/);
    });

    it('should throw on version corruption (future version)', async () => {
        const writer = new HybridWriter();
        await writer.addSnapshot({
            timestamp: 1700000000,
            items: new Map([[1, { price: 1000, quantity: 10 }]])
        });
        const { bytes } = await writer.finishWithLayout__debug();

        const corrupted = new Uint8Array(bytes);
        corrupted[HEADER_VERSION_OFFSET] = 255; // Future version

        expect(() => new HybridReader(corrupted)).toThrow(/Version/);
    });

    it('should report correct layout from finishWithLayout__debug', async () => {
        const writer = new HybridWriter();
        await writer.addSnapshot({
            timestamp: 1700000000,
            items: new Map([[1, { price: 1000, quantity: 10 }]])
        });
        const { bytes, layout } = await writer.finishWithLayout__debug();

        // Validate layout structure
        expect(layout.dataOffset).toBeGreaterThan(0);
        expect(layout.blocks.length).toBe(1);

        const block = layout.blocks[0];
        expect(block.start).toBeGreaterThanOrEqual(layout.dataOffset);
        expect(block.payloadStart).toBe(block.start + 9); // 9-byte wrapper
        expect(block.payloadLen).toBeGreaterThan(0);
        expect(block.payloadStart + block.payloadLen).toBeLessThanOrEqual(bytes.length);
    });
});



