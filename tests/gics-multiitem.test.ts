import { GICS, Snapshot } from '../src/index.js';

describe('GICS Multi-Item Roundtrip', () => {
    it('should roundtrip multi-item snapshots exactly', async () => {
        const snapshots: Snapshot[] = [];
        const baseTime = 1700000000;

        // 10 snapshots × 5 items each
        for (let i = 0; i < 10; i++) {
            const map = new Map<number, { price: number; quantity: number }>();
            map.set(101, { price: 1000 + i * 10, quantity: 50 });
            map.set(202, { price: 2000 + i * 5, quantity: 100 });
            map.set(303, { price: 3000 + i * 2, quantity: 25 });
            map.set(404, { price: 500 + i, quantity: 200 });
            map.set(505, { price: 8000 - i * 3, quantity: 10 });
            snapshots.push({ timestamp: baseTime + (i * 60), items: map });
        }

        const encoded = await GICS.pack(snapshots);

        // Validate EOS marker (v1.3: 0xFF at -37)
        expect(encoded.at(-37)).toBe(0xFF);

        const decoded = await GICS.unpack(encoded);

        // Same number of snapshots
        expect(decoded.length).toBe(snapshots.length);

        // Deep compare each snapshot
        for (let i = 0; i < snapshots.length; i++) {
            expect(decoded[i].timestamp).toBe(snapshots[i].timestamp);
            expect(decoded[i].items.size).toBe(snapshots[i].items.size);

            for (const [id, original] of snapshots[i].items) {
                const reconstructed = decoded[i].items.get(id);
                expect(reconstructed).toBeDefined();
                expect(reconstructed!.price).toBe(original.price);
                expect(reconstructed!.quantity).toBe(original.quantity);
            }
        }
    });

    it('should preserve item IDs correctly', async () => {
        const map = new Map<number, { price: number; quantity: number }>();
        map.set(12345, { price: 999, quantity: 1 });
        map.set(67890, { price: 888, quantity: 2 });
        map.set(11111, { price: 777, quantity: 3 });

        const snapshots: Snapshot[] = [
            { timestamp: 1000, items: map }
        ];

        const encoded = await GICS.pack(snapshots);
        const decoded = await GICS.unpack(encoded);

        expect(decoded[0].items.has(12345)).toBe(true);
        expect(decoded[0].items.has(67890)).toBe(true);
        expect(decoded[0].items.has(11111)).toBe(true);
        expect(decoded[0].items.get(12345)!.price).toBe(999);
        expect(decoded[0].items.get(67890)!.price).toBe(888);
        expect(decoded[0].items.get(11111)!.price).toBe(777);
    });

    it('should preserve quantities correctly', async () => {
        const map = new Map<number, { price: number; quantity: number }>();
        map.set(1, { price: 100, quantity: 500 });
        map.set(2, { price: 200, quantity: 1 });
        map.set(3, { price: 300, quantity: 9999 });

        const snapshots: Snapshot[] = [
            { timestamp: 2000, items: map }
        ];

        const encoded = await GICS.pack(snapshots);
        const decoded = await GICS.unpack(encoded);

        expect(decoded[0].items.get(1)!.quantity).toBe(500);
        expect(decoded[0].items.get(2)!.quantity).toBe(1);
        expect(decoded[0].items.get(3)!.quantity).toBe(9999);
    });

    it('should handle variable item counts per snapshot', async () => {
        const snapshots: Snapshot[] = [];

        // Snapshot 1: 1 item
        const map1 = new Map<number, { price: number; quantity: number }>();
        map1.set(1, { price: 100, quantity: 1 });
        snapshots.push({ timestamp: 1000, items: map1 });

        // Snapshot 2: 5 items
        const map2 = new Map<number, { price: number; quantity: number }>();
        for (let i = 1; i <= 5; i++) {
            map2.set(i, { price: i * 100, quantity: i });
        }
        snapshots.push({ timestamp: 2000, items: map2 });

        // Snapshot 3: 20 items
        const map3 = new Map<number, { price: number; quantity: number }>();
        for (let i = 1; i <= 20; i++) {
            map3.set(i * 10, { price: i * 50, quantity: i * 2 });
        }
        snapshots.push({ timestamp: 3000, items: map3 });

        // Snapshot 4: 3 items
        const map4 = new Map<number, { price: number; quantity: number }>();
        map4.set(99, { price: 999, quantity: 99 });
        map4.set(88, { price: 888, quantity: 88 });
        map4.set(77, { price: 777, quantity: 77 });
        snapshots.push({ timestamp: 4000, items: map4 });

        const encoded = await GICS.pack(snapshots);
        const decoded = await GICS.unpack(encoded);

        expect(decoded.length).toBe(4);
        expect(decoded[0].items.size).toBe(1);
        expect(decoded[1].items.size).toBe(5);
        expect(decoded[2].items.size).toBe(20);
        expect(decoded[3].items.size).toBe(3);
    });

    it('should handle empty items (snapshot with 0 items)', async () => {
        const snapshots: Snapshot[] = [
            { timestamp: 1000, items: new Map() },
            { timestamp: 2000, items: new Map() }
        ];

        const encoded = await GICS.pack(snapshots);
        const decoded = await GICS.unpack(encoded);

        expect(decoded.length).toBe(2);
        expect(decoded[0].items.size).toBe(0);
        expect(decoded[1].items.size).toBe(0);
    });

    it('should produce deterministic output (sorted by itemId)', async () => {
        // Create map with items added in random order
        const map1 = new Map<number, { price: number; quantity: number }>();
        map1.set(303, { price: 300, quantity: 3 });
        map1.set(101, { price: 100, quantity: 1 });
        map1.set(202, { price: 200, quantity: 2 });

        const map2 = new Map<number, { price: number; quantity: number }>();
        map2.set(101, { price: 100, quantity: 1 });
        map2.set(202, { price: 200, quantity: 2 });
        map2.set(303, { price: 300, quantity: 3 });

        const snapshots1: Snapshot[] = [{ timestamp: 1000, items: map1 }];
        const snapshots2: Snapshot[] = [{ timestamp: 1000, items: map2 }];

        const encoded1 = await GICS.pack(snapshots1);
        const encoded2 = await GICS.pack(snapshots2);

        // Same bytes regardless of insertion order
        expect(encoded1.length).toBe(encoded2.length);
        for (let i = 0; i < encoded1.length; i++) {
            expect(encoded1[i]).toBe(encoded2[i]);
        }
    });

    it('should reject data without EOS marker', async () => {
        const map = new Map<number, { price: number; quantity: number }>();
        map.set(1, { price: 100, quantity: 1 });

        const snapshots: Snapshot[] = [{ timestamp: 1000, items: map }];
        const encoded = await GICS.pack(snapshots);

        // Corrupt: remove whole 37-byte footer
        const corrupted = encoded.slice(0, -37);

        await expect(GICS.unpack(corrupted)).rejects.toThrow('EOS marker');
    });
});
