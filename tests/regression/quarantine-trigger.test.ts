import { GICSv2Encoder } from '../../src/gics/encode.js';
import { GICSv2Decoder } from '../../src/gics/decode.js';
import { InnerCodecId } from '../../src/gics/format.js';

function makeDeterministicRng(seed = 0xC0FFEE) {
    let state = seed >>> 0;
    return () => {
        state = (Math.imul(1664525, state) + 1013904223) >>> 0;
        return state;
    };
}

describe('Regression: quarantine trigger stability', () => {
    it('keeps triggering quarantine on noisy bursts and remains decodable', async () => {
        const encoder = new GICSv2Encoder({ contextMode: 'on', probeInterval: 2 });
        const rnd = makeDeterministicRng(0xBADC0DE);

        // Baseline section (compressible)
        for (let i = 0; i < 10; i++) {
            await encoder.addSnapshot({
                timestamp: 1_705_000_000_000 + i,
                items: new Map([[1, { price: 10_000 + (i % 4), quantity: 1 }]]),
            });
        }
        await encoder.flush();

        // Noisy burst section (expected quarantine)
        for (let i = 0; i < 10; i++) {
            const items = new Map<number, { price: number; quantity: number }>();
            for (let id = 1; id <= 100; id++) {
                items.set(id, {
                    price: 10_000_000 + (rnd() % 90_000_000),
                    quantity: rnd() % 100,
                });
            }
            await encoder.addSnapshot({ timestamp: 1_705_000_001_000 + i, items });
        }

        const bytes = await encoder.finish();
        const telemetry = encoder.getTelemetry();

        expect(telemetry).toBeTruthy();
        expect(telemetry!.quarantine_blocks).toBeGreaterThan(0);

        const quarantineFixed64 = telemetry!.blocks.filter(
            (b) => b.codec === InnerCodecId.FIXED64_LE && b.health !== 0,
        );
        expect(quarantineFixed64.length).toBeGreaterThan(0);

        const decoder = new GICSv2Decoder(bytes);
        const decoded = await decoder.getAllSnapshots();
        expect(decoded.length).toBe(20);
    });
});
