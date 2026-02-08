import { GICS } from '../src/index.js';
import { Snapshot } from '../src/gics-types.js';
import crypto from 'node:crypto';

// Linear Congruential Generator for deterministic data
class LGC {
    private state: number;
    constructor(seed: number) { this.state = seed; }
    next(): number {
        this.state = (this.state * 1664525 + 1013904223) % 4294967296;
        return this.state;
    }
    nextFloat(): number {
        return this.next() / 4294967296;
    }
    nextRange(min: number, max: number): number {
        return min + Math.floor(this.nextFloat() * (max - min));
    }
}

describe('GICS v1.3 Canonical Reference', () => {
    // THIS HASH MUST NEVER CHANGE ONCE LOCKED
    // BASELINE HASH for v1.3 (Sections + Zstd + Hash Chain)
    const BASELINE_HASH = '60c70058a6e78cfc5fda763989ff497e92d90138ce1a1eaefef2125a50a06490';

    it('should match the BASELINE SHA-256 hash for deterministic dataset', async () => {
        const rng = new LGC(123456789); // Fixed seed
        const snapshots: Snapshot[] = [];
        const baseTime = 1700000000;

        // Generate 1000 deterministic snapshots
        for (let i = 0; i < 1000; i++) {
            const map = new Map<number, { price: number; quantity: number }>();

            // Random number of items (1 to 20)
            const numItems = rng.nextRange(1, 21);

            for (let j = 0; j < numItems; j++) {
                // Item IDs chosen from a set of 100 possible items
                const id = rng.nextRange(1, 101);
                const price = rng.nextRange(1000, 50000);
                const quantity = rng.nextRange(1, 1000);
                map.set(id, { price, quantity });
            }
            snapshots.push({ timestamp: baseTime + (i * 60), items: map });
        }

        const encoded = await GICS.pack(snapshots);

        // Compute SHA-256
        const hash = crypto.createHash('sha256').update(encoded).digest('hex');

        console.log(`Computed Hash: ${hash}`);
        console.log(`Encoded Bytes: ${encoded.length}`);

        expect(hash).toBe(BASELINE_HASH);
    });
});
