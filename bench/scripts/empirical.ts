import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { GICS } from '../../src/index.js';
import { ZstdComparator } from './comparators.js';

type Snapshot = {
    timestamp: number;
    items: Map<number, { price: number; quantity: number }>;
};

type Dataset = {
    id: string;
    category: 'critical' | 'observational';
    description: string;
    snapshots: Snapshot[];
};

type SystemResult = {
    outputBytes: number;
    ratioX: number;
    encodeMs: number;
    decodeMs: number;
    integrityOk: boolean;
};

type DatasetResult = {
    id: string;
    category: 'critical' | 'observational';
    description: string;
    rawBytes: number;
    checksum: string;
    gics: SystemResult;
    baselineZstd: SystemResult;
};

type BenchmarkReport = {
    runId: string;
    timestampUtc: string;
    threshold50x: number;
    environment: {
        node: string;
        os: string;
        cpu: string;
        gitCommit: string;
    };
    datasets: DatasetResult[];
    summary: {
        weightedRatioCriticalGics: number;
        allCriticalIntegrityOk: boolean;
        pass: boolean;
        failReasons: string[];
    };
};

function makeCriticalRepeatingMarket(): Dataset {
    const snapshots: Snapshot[] = [];
    const baseTs = 1_700_000_000_000;
    const rows = Number(process.env.GICS_BENCH_ROWS_CRITICAL_A ?? '24000');
    for (let i = 0; i < rows; i++) {
        const items = new Map<number, { price: number; quantity: number }>();
        items.set(1, { price: 100_000 + (i % 8), quantity: 1 });
        items.set(2, { price: 200_000 + (i % 8), quantity: 1 });
        items.set(3, { price: 300_000 + (i % 8), quantity: 1 });
        snapshots.push({ timestamp: baseTs + i, items });
    }
    return {
        id: 'critical_repeating_market',
        category: 'critical',
        description: 'Serie altamente redundante para gate principal de compresión',
        snapshots,
    };
}

function makeCriticalEventLike(): Dataset {
    const snapshots: Snapshot[] = [];
    const baseTs = 1_700_100_000_000;
    const rows = Number(process.env.GICS_BENCH_ROWS_CRITICAL_B ?? '18000');
    for (let i = 0; i < rows; i++) {
        const items = new Map<number, { price: number; quantity: number }>();
        const bucket = i % 20;
        items.set(100 + bucket, { price: 10_000 + bucket, quantity: 1 });
        items.set(200 + bucket, { price: 20_000 + bucket, quantity: 2 });
        snapshots.push({ timestamp: baseTs + i * 5, items });
    }
    return {
        id: 'critical_event_like',
        category: 'critical',
        description: 'Carga estructurada repetitiva estilo eventos',
        snapshots,
    };
}

function makeObservationalNoisy(): Dataset {
    const snapshots: Snapshot[] = [];
    const baseTs = 1_700_200_000_000;
    const rows = Number(process.env.GICS_BENCH_ROWS_OBS ?? '6000');
    for (let i = 0; i < rows; i++) {
        const items = new Map<number, { price: number; quantity: number }>();
        items.set(i % 997, { price: (i * 48271) % 1_000_003, quantity: ((i * 17) % 5) + 1 });
        snapshots.push({ timestamp: baseTs + i * 11, items });
    }
    return {
        id: 'observational_noisy',
        category: 'observational',
        description: 'Dataset menos compresible (observabilidad, no gate)',
        snapshots,
    };
}

function getGitCommit(): string {
    try {
        return execSync('git rev-parse HEAD').toString().trim();
    } catch {
        return 'unknown';
    }
}

function toPlainData(snapshots: Snapshot[]): Array<{ timestamp: number; items: Array<{ id: number; price: number; quantity: number }> }> {
    return snapshots.map((s) => ({
        timestamp: s.timestamp,
        items: Array.from(s.items.entries()).map(([id, v]) => ({ id, price: v.price, quantity: v.quantity })),
    }));
}

async function benchGics(snapshots: Snapshot[], rawBytes: number): Promise<SystemResult> {
    const t0 = performance.now();
    const packed = await GICS.pack(snapshots);
    const t1 = performance.now();
    const unpacked = await GICS.unpack(packed);
    const t2 = performance.now();
    const integrityOk = (await GICS.verify(packed)) && unpacked.length === snapshots.length;
    return {
        outputBytes: packed.length,
        ratioX: rawBytes / Math.max(1, packed.length),
        encodeMs: t1 - t0,
        decodeMs: t2 - t1,
        integrityOk,
    };
}

async function benchZstd(raw: Buffer): Promise<SystemResult> {
    const zstd = new ZstdComparator();
    await zstd.init();
    const t0 = performance.now();
    const compressed = await zstd.compress(raw);
    const t1 = performance.now();
    const decompressed = await zstd.decompress(compressed);
    const t2 = performance.now();
    return {
        outputBytes: compressed.length,
        ratioX: raw.length / Math.max(1, compressed.length),
        encodeMs: t1 - t0,
        decodeMs: t2 - t1,
        integrityOk: Buffer.compare(raw, decompressed) === 0,
    };
}

function weightedRatioCritical(results: DatasetResult[]): number {
    const critical = results.filter((r) => r.category === 'critical');
    const inBytes = critical.reduce((s, r) => s + r.rawBytes, 0);
    const outBytes = critical.reduce((s, r) => s + r.gics.outputBytes, 0);
    return inBytes / Math.max(1, outBytes);
}

function renderMarkdown(report: BenchmarkReport): string {
    const lines: string[] = [];
    lines.push(
        '# GICS Empirical Benchmark Report',
        `- Run: ${report.runId}`,
        `- Timestamp: ${report.timestampUtc}`,
        `- Threshold (critical weighted): ${report.threshold50x}x`,
        `- Pass: ${report.summary.pass ? 'YES' : 'NO'}`,
        '',
        '## Datasets',
        '| Dataset | Category | Raw MB | GICS MB | GICS Ratio | ZSTD Ratio | Integrity |',
        '|---|---|---:|---:|---:|---:|---|'
    );
    for (const d of report.datasets) {
        lines.push(`| ${d.id} | ${d.category} | ${(d.rawBytes / 1024 / 1024).toFixed(2)} | ${(d.gics.outputBytes / 1024 / 1024).toFixed(2)} | ${d.gics.ratioX.toFixed(2)}x | ${d.baselineZstd.ratioX.toFixed(2)}x | ${d.gics.integrityOk && d.baselineZstd.integrityOk ? 'OK' : 'FAIL'} |`);
    }
    lines.push(
        '',
        '## Gate Summary',
        `- Weighted critical ratio (GICS): ${report.summary.weightedRatioCriticalGics.toFixed(2)}x`,
        `- All critical integrity OK: ${report.summary.allCriticalIntegrityOk}`
    );
    if (report.summary.failReasons.length > 0) {
        lines.push('- Fail reasons:');
        for (const r of report.summary.failReasons) lines.push(`  - ${r}`);
    }
    return lines.join('\n');
}

async function main() {
    const now = new Date();
    const runId = `empirical-${now.toISOString().replaceAll(/[:.]/g, '-')}`;
    const threshold = Number(process.env.GICS_MIN_RATIO_X ?? '50');

    const datasets: Dataset[] = [
        makeCriticalRepeatingMarket(),
        makeCriticalEventLike(),
        makeObservationalNoisy(),
    ];

    const results: DatasetResult[] = [];
    for (const ds of datasets) {
        const plain = toPlainData(ds.snapshots);
        const raw = Buffer.from(JSON.stringify(plain));
        const gics = await benchGics(ds.snapshots, raw.length);
        const baselineZstd = await benchZstd(raw);
        results.push({
            id: ds.id,
            category: ds.category,
            description: ds.description,
            rawBytes: raw.length,
            checksum: createHash('sha256').update(raw).digest('hex'),
            gics,
            baselineZstd,
        });
    }

    const weighted = weightedRatioCritical(results);
    const allCriticalIntegrityOk = results
        .filter((r) => r.category === 'critical')
        .every((r) => r.gics.integrityOk && r.baselineZstd.integrityOk);

    const failReasons: string[] = [];
    if (weighted < threshold) {
        failReasons.push(`Critical weighted ratio ${weighted.toFixed(2)}x < required ${threshold.toFixed(2)}x`);
    }
    if (!allCriticalIntegrityOk) {
        failReasons.push('Integrity failed in one or more critical datasets');
    }

    const report: BenchmarkReport = {
        runId,
        timestampUtc: now.toISOString(),
        threshold50x: threshold,
        environment: {
            node: process.version,
            os: `${os.type()} ${os.release()}`,
            cpu: os.cpus()[0]?.model ?? 'unknown',
            gitCommit: getGitCommit(),
        },
        datasets: results,
        summary: {
            weightedRatioCriticalGics: weighted,
            allCriticalIntegrityOk,
            pass: failReasons.length === 0,
            failReasons,
        },
    };

    const latestDir = path.join(process.cwd(), 'bench', 'results', 'latest');
    fs.mkdirSync(latestDir, { recursive: true });
    fs.writeFileSync(path.join(latestDir, 'empirical-report.json'), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(latestDir, 'empirical-report.md'), renderMarkdown(report));

    const archiveDir = path.join(process.cwd(), 'bench', 'results');
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.writeFileSync(path.join(archiveDir, `${runId}.json`), JSON.stringify(report, null, 2));

    console.log(`Empirical benchmark written to ${path.join(latestDir, 'empirical-report.json')}`);
    console.log(`Critical weighted ratio: ${weighted.toFixed(2)}x (threshold ${threshold.toFixed(2)}x)`);
    if (!report.summary.pass) {
        console.error(`FAIL STATE: ${report.summary.failReasons.join(' | ')}`);
        process.exitCode = 1;
    }
}

try {
    await main();
} catch (err) {
    console.error(err);
    process.exitCode = 1;
}
