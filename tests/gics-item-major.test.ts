import { GICS, Snapshot } from '../src/index.js';
import { SEGMENT_FLAGS } from '../src/gics/format.js';
import { SegmentHeader } from '../src/gics/segment.js';

function makeStableMultiItemSnapshots(snapshotCount: number, itemCount: number): Snapshot[] {
    const snapshots: Snapshot[] = [];
    const baseTime = 1700000000;
    for (let s = 0; s < snapshotCount; s++) {
        const items = new Map<number, { price: number; quantity: number }>();
        for (let i = 1; i <= itemCount; i++) {
            items.set(i, {
                price: 1000 * i + s * 10 + i,
                quantity: 50 + (s % 5 === 0 ? i : 0),
            });
        }
        snapshots.push({ timestamp: baseTime + s * 60, items });
    }
    return snapshots;
}

describe('Item-Major Layout', () => {
    it('roundtrip: stable multi-item (20 items x 100 snapshots)', async () => {
        const snapshots = makeStableMultiItemSnapshots(100, 20);

        const encoded = await GICS.pack(snapshots);
        const decoded = await GICS.unpack(encoded);

        expect(decoded.length).toBe(snapshots.length);
        for (let s = 0; s < snapshots.length; s++) {
            expect(decoded[s].timestamp).toBe(snapshots[s].timestamp);
            expect(decoded[s].items.size).toBe(snapshots[s].items.size);
            for (const [id, original] of snapshots[s].items) {
                const reconstructed = decoded[s].items.get(id);
                expect(reconstructed).toBeDefined();
                expect(reconstructed!.price).toBe(original.price);
                expect(reconstructed!.quantity).toBe(original.quantity);
            }
        }
    });

    it('segment flag is set for stable multi-item data', async () => {
        const snapshots = makeStableMultiItemSnapshots(50, 10);
        const encoded = await GICS.pack(snapshots);

        // Find the segment header (starts after 14-byte file header with "SG" magic)
        let pos = 14; // skip GICS file header
        while (pos < encoded.length - 14) {
            if (encoded[pos] === 0x53 && encoded[pos + 1] === 0x47) break;
            pos++;
        }
        const header = SegmentHeader.deserialize(encoded.subarray(pos, pos + 14));
        expect(header.flags & SEGMENT_FLAGS.ITEM_MAJOR_LAYOUT).toBe(SEGMENT_FLAGS.ITEM_MAJOR_LAYOUT);
        expect(header.itemsPerSnapshot).toBe(10);
    });

    it('fallback: varying item counts stay snapshot-major', async () => {
        const snapshots: Snapshot[] = [];
        const baseTime = 1700000000;
        for (let s = 0; s < 50; s++) {
            const items = new Map<number, { price: number; quantity: number }>();
            // Varying item count: some snapshots have 5, some have 4
            const count = s % 7 === 0 ? 4 : 5;
            for (let i = 1; i <= count; i++) {
                items.set(i, { price: 1000 + s * 10 + i, quantity: 50 });
            }
            snapshots.push({ timestamp: baseTime + s * 60, items });
        }

        const encoded = await GICS.pack(snapshots);

        // Verify flag is NOT set
        let pos = 14;
        while (pos < encoded.length - 14) {
            if (encoded[pos] === 0x53 && encoded[pos + 1] === 0x47) break;
            pos++;
        }
        const header = SegmentHeader.deserialize(encoded.subarray(pos, pos + 14));
        expect(header.flags & SEGMENT_FLAGS.ITEM_MAJOR_LAYOUT).toBe(0);

        // Roundtrip still works
        const decoded = await GICS.unpack(encoded);
        expect(decoded.length).toBe(snapshots.length);
        for (let s = 0; s < snapshots.length; s++) {
            expect(decoded[s].timestamp).toBe(snapshots[s].timestamp);
            for (const [id, original] of snapshots[s].items) {
                const reconstructed = decoded[s].items.get(id);
                expect(reconstructed).toBeDefined();
                expect(reconstructed!.price).toBe(original.price);
                expect(reconstructed!.quantity).toBe(original.quantity);
            }
        }
    });

    it('single-item data does not activate item-major', async () => {
        const snapshots: Snapshot[] = [];
        const baseTime = 1700000000;
        for (let s = 0; s < 100; s++) {
            const items = new Map<number, { price: number; quantity: number }>();
            items.set(1, { price: 1000 + s, quantity: 50 });
            snapshots.push({ timestamp: baseTime + s * 60, items });
        }

        const encoded = await GICS.pack(snapshots);

        // Verify flag is NOT set
        let pos = 14;
        while (pos < encoded.length - 14) {
            if (encoded[pos] === 0x53 && encoded[pos + 1] === 0x47) break;
            pos++;
        }
        const header = SegmentHeader.deserialize(encoded.subarray(pos, pos + 14));
        expect(header.flags & SEGMENT_FLAGS.ITEM_MAJOR_LAYOUT).toBe(0);

        // Roundtrip still works
        const decoded = await GICS.unpack(encoded);
        expect(decoded.length).toBe(100);
        for (let s = 0; s < 100; s++) {
            expect(decoded[s].items.get(1)!.price).toBe(1000 + s);
        }
    });

    it('roundtrip: large multi-item (20 items x 500 snapshots)', async () => {
        const snapshots = makeStableMultiItemSnapshots(500, 20);

        const encoded = await GICS.pack(snapshots);
        const decoded = await GICS.unpack(encoded);

        expect(decoded.length).toBe(500);
        for (let s = 0; s < snapshots.length; s++) {
            expect(decoded[s].timestamp).toBe(snapshots[s].timestamp);
            for (const [id, original] of snapshots[s].items) {
                expect(decoded[s].items.get(id)).toEqual(original);
            }
        }
    });
});
