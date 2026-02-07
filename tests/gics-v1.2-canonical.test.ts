import { describe, it, expect, beforeEach } from 'vitest';
import { gics_encode } from '../src/index.js';
import { GICSv2Encoder } from '../src/gics/v1_2/encode.js';
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

describe('GICS v1.2 Canonical Reference', () => {
    // THIS HASH MUST NEVER CHANGE ONCE LOCKED
    // It represents the bit-exact output of the canonical v1.2 encoder
    const BASELINE_HASH = 'a3701a820fa843fc0c269aa76303f16fdbe916aecd640c88dff0d965a9c53812';

    beforeEach(() => {
        process.env.GICS_VERSION = '1.2';
        process.env.GICS_CONTEXT_MODE = 'off';
        GICSv2Encoder.resetSharedContext();
    });

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

        const encoded = await gics_encode(snapshots);

        // Compute SHA-256
        const hash = crypto.createHash('sha256').update(encoded).digest('hex');

        console.log(`Computed Hash: ${hash}`);
        console.log(`Encoded Bytes: ${encoded.length}`);

        expect(hash).toBe(BASELINE_HASH);
    });
});
