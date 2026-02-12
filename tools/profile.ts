/**
 * CLI: Compression Profiler
 *
 * Usage:  tsx tools/profile.ts [--mode quick|deep] [--snapshots N] [--items N]
 *
 * Runs the CompressionProfiler against synthetic datasets and prints
 * the recommended configuration with full trial matrix.
 */

import { CompressionProfiler, type ProfileResult } from '../src/index.js';
import type { Snapshot } from '../src/gics-types.js';

// --- CLI args ---
const args = process.argv.slice(2);

function getArg(name: string, fallback: string): string {
    const idx = args.indexOf(`--${name}`);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}

const mode = getArg('mode', 'quick') as 'quick' | 'deep';
const snapshotCount = parseInt(getArg('snapshots', '500'), 10);
const itemCount = parseInt(getArg('items', '10'), 10);

// --- Dataset generators ---
function makeTrend(count: number): Snapshot[] {
    const out: Snapshot[] = [];
    const base = 1700000000;
    for (let i = 0; i < count; i++) {
        const items = new Map<number, { price: number; quantity: number }>();
        items.set(1, { price: 10_000 + i * 3, quantity: 1 });
        out.push({ timestamp: base + i * 60, items });
    }
    return out;
}

function makeVolatile(count: number): Snapshot[] {
    const out: Snapshot[] = [];
    const base = 1700000000;
    for (let i = 0; i < count; i++) {
        const items = new Map<number, { price: number; quantity: number }>();
        items.set(1, { price: 20_000 + ((i * 17) % 101) - 50, quantity: 2 + (i % 3) });
        out.push({ timestamp: base + i * 60, items });
    }
    return out;
}

function makeMultiItem(count: number, items: number): Snapshot[] {
    const out: Snapshot[] = [];
    const base = 1700000000;
    for (let i = 0; i < count; i++) {
        const m = new Map<number, { price: number; quantity: number }>();
        for (let j = 1; j <= items; j++) {
            m.set(j, { price: 1000 * j + i * 10 + j, quantity: 50 + (i % 5 === 0 ? j : 0) });
        }
        out.push({ timestamp: base + i * 60, items: m });
    }
    return out;
}

// --- Formatting ---
function printResult(label: string, result: ProfileResult) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`  ${label}`);
    console.log(`${'='.repeat(60)}`);
    console.log(`  Recommended: level=${result.compressionLevel}, blockSize=${result.blockSize}`);
    console.log(`  Preset:      ${result.preset ?? '(custom)'}`);
    console.log(`  Best ratio:  ${result.bestRatio.toFixed(2)}x`);
    console.log(`  Encode time: ${result.bestEncodeMs.toFixed(1)}ms`);
    console.log(`  Sample hash: ${result.meta.sampleHash}`);
    console.log();

    // Trial matrix
    const levels = [...new Set(result.trials.map(t => t.compressionLevel))].sort((a, b) => a - b);
    const blocks = [...new Set(result.trials.map(t => t.blockSize))].sort((a, b) => a - b);

    const header = ['Level', ...blocks.map(b => `B${b}`)];
    console.log(`  ${header.map(h => h.toString().padStart(10)).join('')}`);

    for (const lv of levels) {
        const row = [lv.toString()];
        for (const bs of blocks) {
            const t = result.trials.find(tr => tr.compressionLevel === lv && tr.blockSize === bs);
            row.push(t ? `${t.ratio.toFixed(1)}x` : '-');
        }
        console.log(`  ${row.map(c => c.padStart(10)).join('')}`);
    }
}

// --- Main ---
async function main() {
    console.log(`GICS Compression Profiler`);
    console.log(`Mode: ${mode} | Snapshots: ${snapshotCount} | Items (multi): ${itemCount}`);

    const datasets: [string, Snapshot[]][] = [
        ['TREND (single-item, linear)', makeTrend(snapshotCount)],
        ['VOLATILE (single-item, noisy)', makeVolatile(snapshotCount)],
        [`MULTI-ITEM (${itemCount} items, stable)`, makeMultiItem(snapshotCount, itemCount)],
    ];

    for (const [label, sample] of datasets) {
        const result = await CompressionProfiler.profile(sample, mode);
        printResult(label, result);
    }

    console.log(`\nDone.`);
}

try {
    await main();
} catch (err: unknown) {
    console.error(String((err as Error)?.stack ?? err));
    process.exit(1);
}
