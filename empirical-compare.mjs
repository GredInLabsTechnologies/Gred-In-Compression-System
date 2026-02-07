// Empirical comparison: GICS v1.1 (HybridWriter/HybridReader) vs GICS v1.2 (GICSv2Encoder/GICSv2Decoder)
//
// This script is intentionally plain JS (ESM) so it can run with `node` without extra tooling.
// It uses the compiled artifacts under ./dist.

import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';

import { HybridWriter, HybridReader } from './dist/src/gics-hybrid.js';
import { GICSv2Encoder } from './dist/src/gics/v1_2/encode.js';
import { GICSv2Decoder } from './dist/src/gics/v1_2/decode.js';

// -----------------------------
// Deterministic RNG (xorshift32)
// -----------------------------
class RNG {
    /** @param {number} seed */
    constructor(seed) {
        this.x = (seed >>> 0) || 0x12345678;
    }

    /** @returns {number} uint32 */
    nextU32() {
        // xorshift32
        let x = this.x;
        x ^= (x << 13) >>> 0;
        x ^= (x >>> 17) >>> 0;
        x ^= (x << 5) >>> 0;
        this.x = x >>> 0;
        return this.x;
    }

    /** @returns {number} float [0,1) */
    next() {
        return this.nextU32() / 0x100000000;
    }

    /** @param {number} min @param {number} max */
    int(min, max) {
        return min + (this.nextU32() % (max - min + 1));
    }
}

// -----------------------------
// Dataset generators
// -----------------------------
/**
 * @param {number} rows
 * @param {number} seed
 */
function genTrend(rows, seed) {
    const rng = new RNG(seed);
    const baseTime = 1700000000;
    let v = 1000;
    /** @type {{timestamp:number, items: Map<number,{price:number,quantity:number}>}[]} */
    const snaps = [];
    for (let i = 0; i < rows; i++) {
        v += rng.int(-2, 2);
        const m = new Map();
        m.set(1, { price: v, quantity: 1 });
        snaps.push({ timestamp: baseTime + i * 60, items: m });
    }
    return snaps;
}

/**
 * @param {number} rows
 * @param {number} seed
 */
function genVolatile(rows, seed) {
    const rng = new RNG(seed);
    const baseTime = 1700000000;
    let v = 1000;
    /** @type {{timestamp:number, items: Map<number,{price:number,quantity:number}>}[]} */
    const snaps = [];
    for (let i = 0; i < rows; i++) {
        // Higher volatility, but still with some autocorrelation
        v += rng.int(-50, 50);
        if ((rng.nextU32() & 31) === 0) v += rng.int(-500, 500); // occasional burst
        const m = new Map();
        m.set(1, { price: v, quantity: 1 });
        snaps.push({ timestamp: baseTime + i * 60, items: m });
    }
    return snaps;
}

/**
 * Max entropy-ish (adversarial) integer stream.
 * @param {number} rows
 * @param {number} seed
 */
function genAdversarial(rows, seed) {
    const rng = new RNG(seed);
    const baseTime = 1700000000;
    /** @type {{timestamp:number, items: Map<number,{price:number,quantity:number}>}[]} */
    const snaps = [];
    for (let i = 0; i < rows; i++) {
        // IMPORTANT: Keep values within a range that the current varint implementation
        // can represent safely (it uses bitwise shifts => effectively 32-bit ops).
        // If we use full 32-bit randoms, delta-of-delta can exceed 2^31 and break.
        const v = rng.int(-500_000_000, 500_000_000);
        const m = new Map();
        m.set(1, { price: v, quantity: 1 });
        snaps.push({ timestamp: baseTime + i * 60, items: m });
    }
    return snaps;
}

/**
 * Multi-item dataset to ensure item IDs and snapshot-length behavior is correct.
 * @param {number} snapshots
 * @param {number} items
 * @param {number} seed
 */
function genMultiItem(snapshots, items, seed) {
    const rng = new RNG(seed);
    const baseTime = 1700000000;
    /** @type {{timestamp:number, items: Map<number,{price:number,quantity:number}>}[]} */
    const snaps = [];

    // IMPORTANT:
    // The current v1.1 HybridReader implementation in this repo is incomplete for the WARM tier.
    // To keep a fair, correctness-verified comparison, we generate data that forces all items to be HOT
    // (change every snapshot) and uses a fixed quantity=1.
    // That keeps warmCount=0 and avoids the placeholder code path.

    // initial prices
    const prices = new Array(items).fill(0).map((_, i) => 10000 + i * 3);

    for (let s = 0; s < snapshots; s++) {
        const m = new Map();
        for (let i = 0; i < items; i++) {
            // Always change => HOT tier
            prices[i] += 1 + (rng.nextU32() % 3);
            m.set(100 + i, { price: prices[i], quantity: 1 });
        }
        snaps.push({ timestamp: baseTime + s * 60, items: m });
    }
    return snaps;
}

// -----------------------------
// Utilities
// -----------------------------
function sha256(buf) {
    return createHash('sha256').update(buf).digest('hex');
}

/**
 * Create a stable JSON baseline (Maps are not JSON-serializable by default).
 * We transform snapshots to plain objects with sorted entries.
 */
function snapshotsToJsonBytes(snapshots) {
    const plain = snapshots.map(s => {
        const items = [...s.items.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([id, v]) => ({ id, price: v.price, quantity: v.quantity }));
        return { timestamp: s.timestamp, items };
    });
    const json = JSON.stringify(plain);
    return Buffer.byteLength(json);
}

function median(values) {
    const xs = [...values].sort((a, b) => a - b);
    return xs[Math.floor(xs.length / 2)];
}

function assertRoundtripEqual(original, decoded, label) {
    if (decoded.length !== original.length) {
        throw new Error(`${label}: snapshot length mismatch: expected=${original.length} got=${decoded.length}`);
    }

    for (let i = 0; i < original.length; i++) {
        const a = original[i];
        const b = decoded[i];
        if (a.timestamp !== b.timestamp) {
            throw new Error(`${label}: timestamp mismatch @${i}: expected=${a.timestamp} got=${b.timestamp}`);
        }
        if (a.items.size !== b.items.size) {
            throw new Error(`${label}: item-count mismatch @${i}: expected=${a.items.size} got=${b.items.size}`);
        }
        // compare sorted keys
        const aKeys = [...a.items.keys()].sort((x, y) => x - y);
        const bKeys = [...b.items.keys()].sort((x, y) => x - y);
        if (aKeys.length !== bKeys.length) throw new Error(`${label}: keys mismatch @${i}`);
        for (let k = 0; k < aKeys.length; k++) {
            if (aKeys[k] !== bKeys[k]) throw new Error(`${label}: key mismatch @${i}`);
            const id = aKeys[k];
            const av = a.items.get(id);
            const bv = b.items.get(id);
            if (!av || !bv) throw new Error(`${label}: missing item @${i} id=${id}`);
            if (av.price !== bv.price || av.quantity !== bv.quantity) {
                throw new Error(`${label}: value mismatch @${i} id=${id}`);
            }
        }
    }
}

// -----------------------------
// v1.1 / v1.2 adapters
// -----------------------------
async function encodeV11(snapshots) {
    const w = new HybridWriter();
    for (const s of snapshots) await w.addSnapshot(s);
    return await w.finish();
}

async function decodeV11(bytes) {
    const r = new HybridReader(bytes);
    return await r.getAllSnapshots();
}

async function encodeV12(snapshots) {
    process.env.GICS_VERSION = '1.2';
    process.env.GICS_CONTEXT_MODE = 'off';
    GICSv2Encoder.resetSharedContext();
    GICSv2Decoder.resetSharedContext();

    const enc = new GICSv2Encoder();
    for (const s of snapshots) await enc.addSnapshot(s);
    const out = await enc.flush();
    await enc.finalize();
    return out;
}

async function decodeV12(bytes) {
    process.env.GICS_CONTEXT_MODE = 'off';
    GICSv2Decoder.resetSharedContext();
    const dec = new GICSv2Decoder(bytes);
    return await dec.getAllSnapshots();
}

async function measureEncodeDecode(name, snapshots, encodeFn, decodeFn, runs = 7) {
    // cold run (not measured)
    const coldBytes = await encodeFn(snapshots);
    await decodeFn(coldBytes);

    const encodeTimes = [];
    const decodeTimes = [];
    let lastBytes = coldBytes;
    let lastDecoded = null;

    for (let i = 0; i < runs; i++) {
        const t0 = performance.now();
        const bytes = await encodeFn(snapshots);
        const t1 = performance.now();
        const decoded = await decodeFn(bytes);
        const t2 = performance.now();

        encodeTimes.push(t1 - t0);
        decodeTimes.push(t2 - t1);
        lastBytes = bytes;
        lastDecoded = decoded;
    }

    // correctness check (on last run)
    assertRoundtripEqual(snapshots, lastDecoded, `${name} roundtrip`);

    return {
        bytes: lastBytes,
        encode_ms_p50: median(encodeTimes),
        decode_ms_p50: median(decodeTimes)
    };
}

async function determinismCheck(label, snapshots, encodeFn) {
    // baseline
    const a = await encodeFn(snapshots);

    // reorder Map insertion order for first snapshot (reverse)
    const s0 = snapshots[0];
    const reversed = new Map([...s0.items.entries()].reverse());
    const snapshots2 = [{ timestamp: s0.timestamp, items: reversed }, ...snapshots.slice(1)];

    const b = await encodeFn(snapshots2);
    const same = (a.length === b.length) && a.every((v, i) => v === b[i]);
    return { same, hashA: sha256(Buffer.from(a)).slice(0, 16), hashB: sha256(Buffer.from(b)).slice(0, 16) };
}

// -----------------------------
// Main
// -----------------------------
async function main() {
    const datasets = [
        { id: 'TREND_10K', snapshots: genTrend(10_000, 42) },
        { id: 'VOLATILE_10K', snapshots: genVolatile(10_000, 42) },
        { id: 'ADVERSARIAL_10K', snapshots: genAdversarial(10_000, 42) },
        { id: 'MULTI_200x40', snapshots: genMultiItem(200, 40, 7) }
    ];

    console.log('=== Empirical Comparison: GICS v1.1 vs v1.2 ===');
    console.log(`Node: ${process.version}`);
    console.log('');

    /** @type {any[]} */
    const rows = [];

    for (const ds of datasets) {
        const jsonBytes = snapshotsToJsonBytes(ds.snapshots);

        // v1.1
        const r11 = await measureEncodeDecode(`v1.1/${ds.id}`, ds.snapshots, encodeV11, decodeV11);
        // v1.2
        const r12 = await measureEncodeDecode(`v1.2/${ds.id}`, ds.snapshots, encodeV12, decodeV12);

        const det11 = await determinismCheck(`v1.1/${ds.id}`, ds.snapshots, encodeV11);
        const det12 = await determinismCheck(`v1.2/${ds.id}`, ds.snapshots, encodeV12);

        rows.push({
            dataset: ds.id,
            baseline_json_bytes: jsonBytes,
            v11_bytes: r11.bytes.length,
            v11_ratio_x: +(jsonBytes / r11.bytes.length).toFixed(2),
            v11_enc_ms_p50: +r11.encode_ms_p50.toFixed(2),
            v11_dec_ms_p50: +r11.decode_ms_p50.toFixed(2),
            v11_det: det11.same,
            v12_bytes: r12.bytes.length,
            v12_ratio_x: +(jsonBytes / r12.bytes.length).toFixed(2),
            v12_enc_ms_p50: +r12.encode_ms_p50.toFixed(2),
            v12_dec_ms_p50: +r12.decode_ms_p50.toFixed(2),
            v12_det: det12.same,
            v11_sha16: sha256(Buffer.from(r11.bytes)).slice(0, 16),
            v12_sha16: sha256(Buffer.from(r12.bytes)).slice(0, 16)
        });
    }

    console.table(rows);

    console.log('\nNotes:');
    console.log('- Ratios are computed against a stable JSON baseline (Maps converted to sorted arrays).');
    console.log('- Times are median (p50) over warm runs (encode+decode measured separately).');
    console.log('- Determinism check only perturbs Map insertion order of the first snapshot.');
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
