import { gics_encode, gics_decode, Snapshot } from '../src/index.js';
import { GICSv2Encoder } from '../src/gics/v1_2/encode.js';
import { Regime } from '../src/gics/v1_2/metrics.js';

describe('GICS v1.2 Roundtrip', () => {

    it('should roundtrip basic data correctly', async () => {
        // Set v1.2
        process.env.GICS_VERSION = '1.2';

        const snapshots: Snapshot[] = [];
        const baseTime = 1700000000;

        // Generate 10 snapshots
        for (let i = 0; i < 10; i++) {
            const map = new Map();
            map.set(101, { price: 100 + i, quantity: 50 });
            snapshots.push({
                timestamp: baseTime + (i * 10),
                items: map
            });
        }

        const encoded = await gics_encode(snapshots);

        // Basic format check
        const magic = new TextDecoder().decode(encoded.slice(0, 4));
        expect(magic).toBe('GICS');
        expect(encoded[4]).toBe(0x02);

        const decoded = await gics_decode(encoded);

        expect(decoded.length).toBe(snapshots.length);

        for (let i = 0; i < snapshots.length; i++) {
            expect(decoded[i].timestamp).toBe(snapshots[i].timestamp);
            // Check value (first item price)
            const originalPrice = snapshots[i].items.get(101)?.price;
            const decodedPrice = decoded[i].items.values().next().value?.price || 0;
            expect(decodedPrice).toBe(originalPrice);
        }
    });

    it('should expose block metrics and regime in telemetry', async () => {
        const enc = new GICSv2Encoder();
        const map = new Map();
        map.set(1, { price: 100, quantity: 1 });

        // Add enough data (1001 items) to trigger >1 block potentially or just 1 block
        const snapshots: Snapshot[] = [];
        for (let i = 0; i < 50; i++) {
            snapshots.push({ timestamp: 1000 + i, items: map });
        }

        for (const s of snapshots) await enc.addSnapshot(s);

        const encoded = await enc.flush();
        await enc.finalize();
        const telemetry = enc.getTelemetry();

        expect(telemetry).toBeDefined();
        expect(telemetry.blocks).toBeDefined();
        expect(telemetry.blocks.length).toBeGreaterThan(0);

        const block0 = telemetry.blocks[0];
        expect(block0.metrics).toBeDefined();
        expect(block0.regime).toBeDefined();

        // Regime should be valid string enum
        expect([Regime.ORDERED, Regime.MIXED, Regime.CHAOTIC]).toContain(block0.regime);
        // ORDERED expected for this simple linear data
        expect(block0.regime).toBe(Regime.ORDERED);
    });

});
