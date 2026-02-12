import { createHash } from 'crypto';
import { SeededRNG } from './rng.js';

export interface Dataset {
    name: string;
    seed: number;
    rows: number;
    data: any[]; // The actual payload (array of objects)
    checksum: string;
    size_bytes: number;
    /** Number of distinct items per snapshot (for multi-item datasets) */
    itemCount?: number;
}

export function generateTrendInt(rows: number, seed: number, nameOverride: string = 'TS_TREND_INT'): Dataset {
    const rng = new SeededRNG(seed);
    const data: any[] = [];
    let current = 1000;

    for (let i = 0; i < rows; i++) {
        // Monotonic-ish trend
        const delta = rng.nextInt(-1, 5); // Bias positive
        current += delta;
        data.push({ t: i, v: current });
    }

    const json = JSON.stringify(data);
    return {
        name: nameOverride,
        seed,
        rows,
        data,
        checksum: sha256(json),
        size_bytes: Buffer.byteLength(json)
    };
}

export function generateTrendIntLarge(seed: number): Dataset {
    // 2 Million rows should be approx 50MB+ of JSON
    return generateTrendInt(2_000_000, seed, 'TS_TREND_INT_LARGE');
}

/**
 * Realistic volatile integer time-series using AR(1) + seasonality + adversarial features.
 *
 * Structure:
 * - AR(1) autocorrelation (phi=0.7): consecutive deltas are related
 * - Seasonal component: sin wave with period 200
 * - Random spikes (~2% of values): sudden jumps simulating anomalies
 * - Occasional resets (~0.5%): value resets to baseline
 * - Noise: bounded random perturbation
 */
export function generateVolatileInt(rows: number, seed: number): Dataset {
    const rng = new SeededRNG(seed);
    const data: any[] = [];
    let current = 1000;
    let prevDelta = 0;
    const baseline = 1000;

    for (let i = 0; i < rows; i++) {
        const roll = rng.next();

        if (roll < 0.005) {
            // Reset to baseline (~0.5%)
            current = baseline + rng.nextInt(-50, 50);
            prevDelta = 0;
        } else if (roll < 0.025) {
            // Spike (~2%): large sudden jump
            const spike = rng.nextInt(-500, 500);
            current += spike;
            prevDelta = spike;
        } else {
            // Normal AR(1) + seasonality + noise
            const ar = Math.round(0.7 * prevDelta);
            const seasonal = Math.round(15 * Math.sin(2 * Math.PI * i / 200));
            const noise = rng.nextInt(-30, 31);
            const delta = ar + seasonal + noise;
            current += delta;
            prevDelta = delta;
        }

        data.push({ t: i, v: current });
    }

    const json = JSON.stringify(data);
    return {
        name: 'TS_VOLATILE_INT',
        seed,
        rows,
        data,
        checksum: sha256(json),
        size_bytes: Buffer.byteLength(json)
    };
}

/**
 * Multi-item trend dataset simulating N correlated assets.
 *
 * Structure:
 * - Shared market baseline: slow trend all items follow
 * - Cross-item correlation: items in groups move together
 * - Per-item drift: each item has its own drift rate
 * - Repeating item IDs across snapshots (high structural redundancy)
 *
 * This is where GICS's structural compression shines: repeated item IDs,
 * correlated values, and temporal patterns across snapshots.
 */
export function generateMultiItemTrend(
    snapshotCount: number,
    itemCount: number,
    seed: number,
    nameOverride: string = 'TS_MULTI_ITEM'
): Dataset {
    const rng = new SeededRNG(seed);
    const data: any[] = [];

    // Per-item state
    const prices = new Array(itemCount);
    const drifts = new Array(itemCount);
    const quantities = new Array(itemCount);

    // Initialize: items start near shared baseline with per-item offsets
    for (let j = 0; j < itemCount; j++) {
        prices[j] = 1000 + rng.nextInt(-200, 200);
        drifts[j] = (rng.next() - 0.4) * 0.3; // slight upward bias
        quantities[j] = rng.nextInt(1, 100);
    }

    let marketTrend = 0;

    for (let i = 0; i < snapshotCount; i++) {
        // Shared market movement (slow drift + noise)
        marketTrend += (rng.next() - 0.45) * 2;
        const marketDelta = Math.round(marketTrend * 0.1);

        const items: Array<{ id: number; price: number; quantity: number }> = [];

        for (let j = 0; j < itemCount; j++) {
            // Correlated move (market) + individual drift + noise
            const individualNoise = rng.nextInt(-5, 6);
            const drift = Math.round(drifts[j] * (i + 1) * 0.01);
            prices[j] += marketDelta + drift + individualNoise;

            // Quantity changes are rare and structural
            if (rng.next() < 0.05) {
                quantities[j] = Math.max(1, quantities[j] + rng.nextInt(-10, 10));
            }

            items.push({
                id: j + 1,
                price: prices[j],
                quantity: quantities[j],
            });
        }

        data.push({ t: i, items });
    }

    const json = JSON.stringify(data);
    return {
        name: nameOverride,
        seed,
        rows: snapshotCount,
        data,
        checksum: sha256(json),
        size_bytes: Buffer.byteLength(json),
        itemCount,
    };
}

function sha256(content: string): string {
    return createHash('sha256').update(content).digest('hex');
}
