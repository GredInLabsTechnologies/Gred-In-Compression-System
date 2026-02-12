import { GICSv2Encoder } from '../../src/gics/encode.js';

describe('Regression: codec selection stability', () => {
    it('produces deterministic telemetry codec sequence for same input', async () => {
        const makeInput = () =>
            Array.from({ length: 2000 }, (_, i) => ({
                timestamp: 1_700_500_000_000 + i,
                items: new Map([
                    [1, { price: 1000 + (i % 5), quantity: 1 }],
                    [2, { price: 2000 + ((i * 3) % 7), quantity: 2 }],
                ]),
            }));

        const run = async () => {
            const encoder = new GICSv2Encoder({ contextMode: 'on', probeInterval: 2 });
            for (const s of makeInput()) await encoder.addSnapshot(s);
            await encoder.finish();
            const telemetry = encoder.getTelemetry();
            return (telemetry?.blocks ?? []).map((b) => `${b.stream_id}:${b.codec}:${b.health}`).join('|');
        };

        const a = await run();
        const b = await run();

        expect(a.length).toBeGreaterThan(0);
        expect(a).toBe(b);
    });
});
