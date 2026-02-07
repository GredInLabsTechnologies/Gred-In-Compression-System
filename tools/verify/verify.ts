import { gics_decode, gics_encode, type Snapshot } from '../../src/index.js';

function buildDeterministicSnapshots(): Snapshot[] {
    const snapshots: Snapshot[] = [];
    const baseTs = 1_700_000_000; // deterministic

    for (let i = 0; i < 48; i++) {
        const ts = baseTs + i * 3600; // hourly
        const items = new Map<number, { price: number; quantity: number }>();

        // Trending
        items.set(1, { price: 10_000 + i * 3, quantity: 1 });
        // Volatile-ish (deterministic)
        items.set(2, { price: 20_000 + ((i * 17) % 101) - 50, quantity: 2 });
        // Sparse
        if (i % 6 === 0) items.set(3, { price: 99_000, quantity: 1 });

        snapshots.push({ timestamp: ts, items });
    }
    return snapshots;
}

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(`VERIFY_FAILED: ${message}`);
}

async function main() {
    const snapshots = buildDeterministicSnapshots();
    const encoded = await gics_encode(snapshots);
    const decoded = await gics_decode(encoded);

    assert(decoded.length === snapshots.length, `snapshotCount mismatch (${decoded.length} != ${snapshots.length})`);

    for (let i = 0; i < snapshots.length; i++) {
        const a = snapshots[i];
        const b = decoded[i];

        assert(b.timestamp === a.timestamp, `timestamp mismatch at index ${i} (${b.timestamp} != ${a.timestamp})`);

        const a1 = a.items.get(1);
        const b1 = b.items.get(1);
        assert(!!a1 && !!b1, `missing item 1 at index ${i}`);
        assert(b1.price === a1.price, `item 1 price mismatch at index ${i}`);

        const a2 = a.items.get(2);
        const b2 = b.items.get(2);
        assert(!!a2 && !!b2, `missing item 2 at index ${i}`);
        assert(b2.price === a2.price, `item 2 price mismatch at index ${i}`);
    }

    const sparseCount = decoded.reduce((acc, s) => acc + (s.items.has(3) ? 1 : 0), 0);
    assert(sparseCount > 0, 'sparse item (3) never appeared after decode');

    console.log(`[verify] OK. snapshots=${snapshots.length}, encodedBytes=${encoded.length}`);
}

main().catch((err) => {
    console.error(String(err?.stack ?? err));
    process.exit(1);
});
