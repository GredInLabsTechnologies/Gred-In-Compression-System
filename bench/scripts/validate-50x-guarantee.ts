import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { execSync } from 'node:child_process';
import { GICS } from '../../src/index.js';

type Snapshot = {
    timestamp: number;
    items: Map<number, { price: number; quantity: number }>;
};

type DatasetSpec = {
    name: string;
    description: string;
    expectedMinRatio: number;
    snapshots: Snapshot[];
};

type DatasetResult = {
    name: string;
    description: string;
    expectedMinRatio: number;
    rawBytes: number;
    compressedBytes: number;
    ratio: number;
    encodeMs: number;
    decodeMs: number;
    verifyOk: boolean;
    roundtripCountOk: boolean;
    pass: boolean;
};

function getGitCommit(): string {
    try {
        return execSync('git rev-parse HEAD').toString().trim();
    } catch {
        return 'unknown';
    }
}

function estimateRawBytes(snapshots: Snapshot[]): number {
    const plain = snapshots.map((s) => ({
        timestamp: s.timestamp,
        items: Array.from(s.items.entries()).map(([id, v]) => ({ id, price: v.price, quantity: v.quantity })),
    }));
    return Buffer.byteLength(JSON.stringify(plain));
}

function makeTrendingDataset(rows = 12000): DatasetSpec {
    const snapshots: Snapshot[] = [];
    let ts = 1_702_000_000_000;
    const items = new Map<number, { price: number; quantity: number }>();
    for (let id = 1; id <= 80; id++) {
        items.set(id, { price: 10_000 + id * 3, quantity: 1 + (id % 3) });
    }
    for (let i = 0; i < rows; i++) {
        ts += 1;
        if (i % 7 === 0) {
            for (let id = 1; id <= 80; id += 4) {
                const cur = items.get(id)!;
                items.set(id, { price: cur.price + 1, quantity: cur.quantity });
            }
        }
        snapshots.push({ timestamp: ts, items: new Map(items) });
    }
    return {
        name: 'market_data_trending',
        description: 'Serie con tendencia suave y repetición estructural',
        expectedMinRatio: 80,
        snapshots,
    };
}

function makeStableDataset(rows = 12000): DatasetSpec {
    const snapshots: Snapshot[] = [];
    let ts = 1_702_100_000_000;
    const items = new Map<number, { price: number; quantity: number }>();
    for (let id = 1; id <= 64; id++) items.set(id, { price: 20_000 + id, quantity: 1 + (id % 2) });

    for (let i = 0; i < rows; i++) {
        ts += 1;
        if (i % 30 === 0) {
            const cur = items.get(1)!;
            items.set(1, { price: cur.price + 1, quantity: cur.quantity });
        }
        snapshots.push({ timestamp: ts, items: new Map(items) });
    }

    return {
        name: 'market_data_stable',
        description: 'Serie casi constante (alta compresibilidad)',
        expectedMinRatio: 200,
        snapshots,
    };
}

function makeIotDataset(rows = 12000): DatasetSpec {
    const snapshots: Snapshot[] = [];
    const period = 96;
    let ts = 1_702_200_000_000;
    for (let i = 0; i < rows; i++) {
        ts += 5;
        const phase = i % period;
        const items = new Map<number, { price: number; quantity: number }>();
        for (let id = 1; id <= 40; id++) {
            const wave = Math.round(Math.sin((phase / period) * Math.PI * 2) * 10);
            items.set(id, {
                price: 1000 + id * 2 + wave,
                quantity: 50 + (id % 4),
            });
        }
        snapshots.push({ timestamp: ts, items });
    }
    return {
        name: 'iot_sensor_periodic',
        description: 'Patrones periódicos de sensores IoT',
        expectedMinRatio: 120,
        snapshots,
    };
}

function makeEventDataset(rows = 12000): DatasetSpec {
    const snapshots: Snapshot[] = [];
    let ts = 1_702_300_000_000;
    for (let i = 0; i < rows; i++) {
        ts += i % 8 === 0 ? 10 : 5;
        const items = new Map<number, { price: number; quantity: number }>();
        const eventType = i % 20;
        items.set(1_000 + eventType, { price: 10_000 + eventType, quantity: 1 });
        items.set(2_000 + eventType, { price: 20_000 + eventType, quantity: 2 });
        if (i % 12 === 0) items.set(3_000, { price: 30_000, quantity: 1 });
        snapshots.push({ timestamp: ts, items });
    }
    return {
        name: 'event_log_structured',
        description: 'Logs estructurados con campos categóricos repetitivos',
        expectedMinRatio: 60,
        snapshots,
    };
}

async function runDataset(ds: DatasetSpec): Promise<DatasetResult> {
    const rawBytes = estimateRawBytes(ds.snapshots);
    const t0 = performance.now();
    const packed = await GICS.pack(ds.snapshots);
    const t1 = performance.now();
    const unpacked = await GICS.unpack(packed);
    const t2 = performance.now();
    const verifyOk = await GICS.verify(packed);
    const ratio = rawBytes / Math.max(1, packed.length);
    const roundtripCountOk = unpacked.length === ds.snapshots.length;
    const pass = verifyOk && roundtripCountOk && ratio >= ds.expectedMinRatio;

    return {
        name: ds.name,
        description: ds.description,
        expectedMinRatio: ds.expectedMinRatio,
        rawBytes,
        compressedBytes: packed.length,
        ratio,
        encodeMs: t1 - t0,
        decodeMs: t2 - t1,
        verifyOk,
        roundtripCountOk,
        pass,
    };
}

async function main(): Promise<void> {
    const runId = `validate-50x-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const datasets = [
        makeTrendingDataset(),
        makeStableDataset(),
        makeIotDataset(),
        makeEventDataset(),
    ];

    const results: DatasetResult[] = [];
    for (const ds of datasets) {
        results.push(await runDataset(ds));
    }

    const pass = results.every((r) => r.pass);
    const failReasons = results.filter((r) => !r.pass).map((r) => {
        if (r.ratio < r.expectedMinRatio) {
            return `${r.name}: ratio ${r.ratio.toFixed(2)}x < ${r.expectedMinRatio}x`;
        }
        if (!r.verifyOk) return `${r.name}: verify=false`;
        if (!r.roundtripCountOk) return `${r.name}: roundtrip_count_mismatch`;
        return `${r.name}: unknown_failure`;
    });

    const report = {
        run_id: runId,
        timestamp_utc: new Date().toISOString(),
        env: {
            node: process.version,
            os: `${os.type()} ${os.release()}`,
            cpu: os.cpus()[0]?.model ?? 'unknown',
            git_commit: getGitCommit(),
        },
        results,
        summary: {
            pass,
            fail_reasons: failReasons,
        },
    };

    const latestDir = path.join(process.cwd(), 'bench', 'results', 'latest');
    fs.mkdirSync(latestDir, { recursive: true });
    const jsonPath = path.join(latestDir, 'validate-50x-report.json');
    const mdPath = path.join(latestDir, 'validate-50x-report.md');

    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
    fs.writeFileSync(
        mdPath,
        [
            '# Validate 50x Guarantee Report',
            `- Run: ${runId}`,
            `- Pass: ${pass ? 'YES' : 'NO'}`,
            '',
            '| Dataset | Min Ratio | Actual Ratio | Verify | Roundtrip | Pass |',
            '|---|---:|---:|---|---|---|',
            ...results.map((r) => `| ${r.name} | ${r.expectedMinRatio}x | ${r.ratio.toFixed(2)}x | ${r.verifyOk} | ${r.roundtripCountOk} | ${r.pass ? 'YES' : 'NO'} |`),
            '',
            failReasons.length > 0 ? `- Fail reasons: ${failReasons.join(' | ')}` : '- Fail reasons: none',
            '',
        ].join('\n'),
    );

    fs.writeFileSync(path.join(process.cwd(), 'bench', 'results', `${runId}.json`), JSON.stringify(report, null, 2));

    console.log(`Validate-50x report: ${jsonPath}`);
    if (!pass) {
        console.error(`Validate-50x gate failed: ${failReasons.join(' | ')}`);
        process.exitCode = 1;
    }
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
