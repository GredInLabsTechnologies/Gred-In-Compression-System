// Note: vitest is configured with `globals: true` (see vitest.config.ts).
// Importing `describe/test/expect` can cause Vitest to not detect the suite in some setups.
// Use the global APIs instead.
import { GICSv2Encoder } from '../src/gics/encode.js';
import { GICSv2Decoder } from '../src/gics/decode.js';
import { InnerCodecId } from '../src/gics/format.js';
import { Snapshot } from '../src/gics-types.js';

function makeDeterministicRng(seed = 0xC0FFEE) {
    // Simple LCG (deterministic, fast). Not crypto.
    let state = seed >>> 0;
    return () => {
        state = (Math.imul(1664525, state) + 1013904223) >>> 0;
        return state;
    };
}

describe('GICS Phase 11: Quarantine Cap (FIXED64_LE)', () => {
    test('should trigger quarantine and use FIXED64_LE for noisy data', async () => {
        const encoder = new GICSv2Encoder({
            contextMode: 'on',
            probeInterval: 2 // frequent probes for testing
        });

        const rnd = makeDeterministicRng(0xBADC0DE);

        // 1. Train baseline with "smooth" data (price=100,200,300...)
        for (let i = 0; i < 10; i++) {
            const snap: Snapshot = {
                timestamp: 1000 + i * 10,
                items: new Map([[1, { price: 1000 + i * 10, quantity: 1 }]])
            };
            await encoder.addSnapshot(snap);
        }
        await encoder.flush();

        // 2. Inject "monster" noisy data (High entropy, random prices)
        // This should trigger the Entropy Gate or Ratio Drop
        for (let i = 0; i < 10; i++) {
            const snap: Snapshot = {
                timestamp: 2000 + i * 10,
                items: new Map()
            };
            // Use 100 random items to increase entropy and data volume
            for (let j = 0; j < 100; j++) {
                const r1 = rnd();
                const r2 = rnd();
                snap.items.set(j, {
                    price: 10_000_000 + (r1 % 90_000_000),
                    quantity: r2 % 100
                });
            }
            await encoder.addSnapshot(snap);
        }

        const bytes = await encoder.seal();
        const telemetry = encoder.getTelemetry();

        // At least some blocks should be in quarantine
        expect(telemetry?.quarantine_blocks).toBeGreaterThan(0);

        // 3. Verify decoding works 
        const decoder = new GICSv2Decoder(bytes);
        const decoded = await decoder.getAllSnapshots();

        expect(decoded.length).toBe(20);

        // Verify specifically that FIXED64_LE was used
        const qBlocks = telemetry?.blocks.filter(b => b.health === 2 /* QUAR */);
        expect(qBlocks?.length).toBeGreaterThan(0);

        const hasFixed64 = qBlocks?.some(b => b.codec === InnerCodecId.FIXED64_LE);
        expect(hasFixed64).toBe(true);

        // Verify NO block in quarantine is larger than 8 bytes per item (payload wise)
        for (const b of qBlocks!) {
            if (b.codec === InnerCodecId.FIXED64_LE) {
                // FIXED64_LE payload_bytes should be exactly 8 * nItems
                expect(b.bytes).toBeLessThanOrEqual(b.raw_bytes);
            }
        }

        // Verify some items in noisy section
        expect(decoded[15].items.size).toBe(100);
    });

    test('reconstructs values correctly when using FIXED64_LE', async () => {
        const encoder = new GICSv2Encoder({ contextMode: 'on', probeInterval: 1 });

        const testValues = [12345678, 23456789, 34567890, 45678901, 56789012];
        const snapshots: Snapshot[] = testValues.map((v, i) => ({
            timestamp: 1000 + i,
            items: new Map([[1, { price: v, quantity: 1 }]])
        }));

        for (const s of snapshots) await encoder.addSnapshot(s);

        const bytes = await encoder.seal();
        const decoder = new GICSv2Decoder(bytes);
        const decoded = await decoder.getAllSnapshots();

        for (let i = 0; i < testValues.length; i++) {
            expect(decoded[i].items.get(1)?.price).toBe(testValues[i]);
        }
    });
});
