
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { generateTrendInt, generateVolatileInt, Dataset } from './datasets.js';
import { measure, measureSplit, Metrics } from './metrics.js';
import { ZstdComparator } from './comparators.js';
// Import GICS - Adjust path if needed based on repo structure. 
// Assuming src/index.ts exports HybridWriter or similar.
// I will try to import from the compiled dist or src via tsx.
// For now, I'll assume the user has a GICS entry point.
// If I can't find it, I'll need to inspect.
// I saw 'benchmarks.ts' used: import { HybridWriter } from './src/index.js';
import { GICS } from '../../src/index.js';

interface Result {
    timestamp_utc: string;
    git_commit: string;
    cpu_model: string;
    os_info: string;
    node_version: string;
    dataset: { name: string; size: number; checksum: string };
    workload: string;
    system: string;
    metrics: Metrics & {
        output_bytes: number;
        ratio_x: number;
        encode_time_median?: number;
    };
    validity_flags: string[];
}

const timestamp = new Date().toISOString();
const results: Result[] = [];

// Environment
const env = {
    cpu: os.cpus()[0].model,
    os: `${os.type()} ${os.release()}`,
    node: process.version,
    git: 'HEAD'
};

try {
    env.git = execSync('git rev-parse HEAD').toString().trim();
} catch {
    // Git not available or not a repo
}

console.log(`Starting Benchmark Harness [${timestamp}]`);
console.log(`Env: ${JSON.stringify(env)}`);

// 1. Prepare Datasets
const datasets: Dataset[] = [
    generateTrendInt(100_000, 12345),
    generateVolatileInt(100_000, 12345),
];

// 2. Prepare Comparators
const zstd = new ZstdComparator();
await zstd.init();

// 3. Run Loop
for (const ds of datasets) {
    console.log(`\nDataset: ${ds.name} (${ds.size_bytes} bytes)`);

    // --- GICS ---
    const gicsResult = await runGicsEncode(ds);
    results.push({
        timestamp_utc: timestamp,
        git_commit: env.git,
        cpu_model: env.cpu,
        os_info: env.os,
        node_version: env.node,
        dataset: { name: ds.name, size: ds.size_bytes, checksum: ds.checksum },
        workload: 'BENCH-ENC-001',
        system: 'GICS',
        metrics: gicsResult,
        validity_flags: []
    });

    // --- GICS: Append Workload ---
    // Only run for smaller datasets or handle separate logic if needed, but running for all per requirements
    const gicsAppendResult = await runGicsAppend(ds, 5); // 5 chunks
    results.push({
        timestamp_utc: timestamp,
        git_commit: env.git,
        cpu_model: env.cpu,
        os_info: env.os,
        node_version: env.node,
        dataset: { name: ds.name, size: ds.size_bytes * 5, checksum: 'N/A' },
        workload: 'BENCH-ENC-APPEND-001',
        system: 'GICS',
        metrics: gicsAppendResult,
        validity_flags: []
    });

    // --- ZSTD ---
    try {
        const zstdResult = await runComparatorEncode(ds, zstd);
        results.push({
            timestamp_utc: timestamp,
            git_commit: env.git,
            cpu_model: env.cpu,
            os_info: env.os,
            node_version: env.node,
            dataset: { name: ds.name, size: ds.size_bytes, checksum: ds.checksum },
            workload: 'BENCH-ENC-001',
            system: 'BASELINE_ZSTD',
            metrics: zstdResult,
            validity_flags: []
        });
    } catch (err: any) {
        console.error(`Skipping ZSTD for ${ds.name}: ${err.message}`);
    }
}

// 4. Save
const outFile = path.join(process.cwd(), 'bench/results', `run-${timestamp.replaceAll(':', '-')}.json`);
fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
console.log(`\nSaved ${results.length} results to ${outFile}`);



async function runGicsEncode(ds: Dataset): Promise<any> {
    // Measure construction vs run
    const measured = await measureSplit(
        async () => {
            return new GICS.Encoder();
        },
        async (writer: any) => {
            for (const row of ds.data) {
                const itemMap = new Map();
                itemMap.set(1, { price: row.v, quantity: 1 });
                writer.push({ timestamp: row.t, items: itemMap });
            }
            return await writer.seal();
        }
    );

    const output = measured.result;
    return {
        ...measured.metrics,
        output_bytes: output.length,
        ratio_x: ds.size_bytes / output.length
    };
}

async function runGicsAppend(ds: Dataset, chunks: number): Promise<any> {
    const measured = await measureSplit(
        async () => {
            return new GICS.Encoder();
        },
        async (writer: any) => {
            for (let c = 0; c < chunks; c++) {
                // Ingest full dataset as a "chunk"
                for (const row of ds.data) {
                    const itemMap = new Map();
                    itemMap.set(1, { price: row.v, quantity: 1 });
                    // Shift timestamp to avoid overlap
                    writer.push({ timestamp: row.t + (c * 1_000_000), items: itemMap });
                }
            }
            return await writer.seal();
        }
    );

    const output = measured.result;
    return {
        ...measured.metrics,
        output_bytes: output.length,
        // Approximate ratio based on input size * chunks
        ratio_x: (ds.size_bytes * chunks) / output.length
    };
}

async function runComparatorEncode(ds: Dataset, comp: ZstdComparator): Promise<any> {
    const inputBuf = Buffer.from(JSON.stringify(ds.data)); // Raw JSON input
    const measured = await measure(async () => {
        return await comp.compress(inputBuf);
    });

    const output = measured.result;
    return {
        ...measured.metrics,
        output_bytes: output.length,
        ratio_x: ds.size_bytes / output.length
    };
}

