import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { execSync } from 'node:child_process';
import { GICS } from '../../src/index.js';
import { SegmentHeader } from '../../src/gics/segment.js';
import { FILE_EOS_SIZE, GICS_HEADER_SIZE_V3 } from '../../src/gics/format.js';

type Snapshot = {
    timestamp: number;
    items: Map<number, { price: number; quantity: number }>;
};

type HorizonSpec = {
    years: number;
    snapshots: number;
};

type HorizonResult = {
    years: number;
    snapshots: number;
    itemsPerSnapshot: number;
    temporalItems: number;
    flushEverySnapshots: number;
    rawJsonBytes: number;
    encodedBytes: number;
    ratioX: number;
    encodeMs: number;
    verifyMode: 'full_roundtrip' | 'integrity_only';
    verifyOk: boolean;
    roundtripOk: boolean | null;
    decodedSnapshots: number | null;
    segmentCount: number;
    peakHeapUsedBytes: number;
};

type LongHorizonReport = {
    runId: string;
    timestampUtc: string;
    environment: {
        node: string;
        os: string;
        cpu: string;
        gitCommit: string;
    };
    config: {
        snapshotsPerDay: number;
        itemCount: number;
        compressionPreset: string;
        flushEverySnapshots: number;
        fullDecodeMaxSnapshots: number;
        horizonsYears: number[];
    };
    results: HorizonResult[];
};

function getGitCommit(): string {
    try {
        return execSync('git rev-parse HEAD').toString().trim();
    } catch {
        return 'unknown';
    }
}

function parseYears(): number[] {
    const raw = process.env.GICS_LONG_HORIZON_YEARS ?? '1,3,5,10,20,100';
    return raw
        .split(',')
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isFinite(value) && value > 0)
        .sort((a, b) => a - b);
}

function countSegments(data: Uint8Array): number {
    let count = 0;
    let pos = GICS_HEADER_SIZE_V3;
    const dataEnd = data.length - FILE_EOS_SIZE;

    while (pos + 14 <= dataEnd) {
        const header = SegmentHeader.deserialize(data.subarray(pos, pos + 14));
        if (header.totalLength <= 0) {
            break;
        }
        count++;
        pos += header.totalLength;
    }

    return count;
}

function estimatePlainSnapshotBytes(snapshot: Snapshot): number {
    const plain = {
        timestamp: snapshot.timestamp,
        items: Array.from(snapshot.items.entries()).map(([id, value]) => ({
            id,
            price: value.price,
            quantity: value.quantity,
        })),
    };
    return Buffer.byteLength(JSON.stringify(plain));
}

function createGenerator(itemCount: number) {
    const prices = new Array<number>(itemCount);
    const quantities = new Array<number>(itemCount);
    const drifts = new Array<number>(itemCount);

    for (let i = 0; i < itemCount; i++) {
        prices[i] = 100_000 + i * 11;
        quantities[i] = 10 + (i % 17);
        drifts[i] = ((i % 9) - 4) * 0.03;
    }

    let marketBias = 0;
    let timestamp = Date.UTC(2020, 0, 1, 0, 0, 0);

    return (index: number, snapshotsPerDay: number): Snapshot => {
        marketBias += (index % 11 === 0 ? 1 : 0) - (index % 17 === 0 ? 1 : 0);
        timestamp += Math.floor((24 * 60 * 60 * 1000) / snapshotsPerDay);

        const items = new Map<number, { price: number; quantity: number }>();
        for (let i = 0; i < itemCount; i++) {
            const seasonal = Math.round(Math.sin((index / snapshotsPerDay) + (i % 13)) * 2);
            const micro = ((index + i) % 5) - 2;
            const drift = Math.round(drifts[i] * index * 0.02);
            prices[i] += marketBias + seasonal + micro + drift;
            if (index % 29 === 0 && i % 7 === 0) {
                quantities[i] += 1;
            } else if (index % 43 === 0 && i % 19 === 0) {
                quantities[i] = Math.max(1, quantities[i] - 1);
            }
            items.set(i + 1, { price: prices[i], quantity: quantities[i] });
        }

        return { timestamp, items };
    };
}

function writeReportArtifacts(report: LongHorizonReport): void {
    const latestDir = path.join(process.cwd(), 'bench', 'results', 'latest');
    fs.mkdirSync(latestDir, { recursive: true });
    const jsonPath = path.join(latestDir, 'long-horizon-report.json');
    const mdPath = path.join(latestDir, 'long-horizon-report.md');
    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
    fs.writeFileSync(mdPath, renderMarkdown(report));
    fs.writeFileSync(
        path.join(process.cwd(), 'bench', 'results', `${report.runId}.json`),
        JSON.stringify(report, null, 2),
    );
}

async function runHorizon(
    years: number,
    snapshotsPerDay: number,
    itemCount: number,
    flushEverySnapshots: number,
    fullDecodeMaxSnapshots: number,
    preset: 'balanced' | 'max_ratio' | 'low_latency',
): Promise<HorizonResult> {
    const snapshots = years * 365 * snapshotsPerDay;
    const nextSnapshot = createGenerator(itemCount);
    const encoder = new GICS.Encoder({
        preset,
        minSnapshotsPerSegment: Math.max(flushEverySnapshots, 256),
        maxSnapshotsPerSegment: Math.max(flushEverySnapshots, 1024),
    });

    let rawJsonBytes = 2;
    let encodeMs = 0;
    let peakHeapUsedBytes = 0;
    const progressEvery = Math.max(1_000, Math.floor(snapshots / 20));

    const started = performance.now();
    for (let index = 0; index < snapshots; index++) {
        const snapshot = nextSnapshot(index, snapshotsPerDay);
        rawJsonBytes += estimatePlainSnapshotBytes(snapshot);
        if (index > 0) {
            rawJsonBytes += 1;
        }

        await encoder.addSnapshot(snapshot);
        if ((index + 1) % flushEverySnapshots === 0) {
            await encoder.flush();
        }
        const heapUsed = process.memoryUsage().heapUsed;
        if (heapUsed > peakHeapUsedBytes) {
            peakHeapUsedBytes = heapUsed;
        }
        if ((index + 1) % progressEvery === 0 || index + 1 === snapshots) {
            const elapsedMs = performance.now() - started;
            console.log(
                `[${years}y] progress ${(index + 1).toLocaleString()}/${snapshots.toLocaleString()} snapshots, ` +
                `heap ${(heapUsed / 1024 / 1024).toFixed(1)} MB, elapsed ${(elapsedMs / 1000).toFixed(1)} s`,
            );
        }
    }
    const encoded = await encoder.seal();
    encodeMs = performance.now() - started;
    const verifyMode: 'full_roundtrip' | 'integrity_only' = snapshots <= fullDecodeMaxSnapshots
        ? 'full_roundtrip'
        : 'integrity_only';

    const verifyOk = await GICS.verify(encoded);
    let roundtripOk: boolean | null = null;
    let decodedSnapshots: number | null = null;

    if (verifyMode === 'full_roundtrip') {
        const decoded = await GICS.unpack(encoded);
        decodedSnapshots = decoded.length;
        roundtripOk = decoded.length === snapshots;
    }

    return {
        years,
        snapshots,
        itemsPerSnapshot: itemCount,
        temporalItems: snapshots * itemCount,
        flushEverySnapshots,
        rawJsonBytes,
        encodedBytes: encoded.length,
        ratioX: rawJsonBytes / Math.max(1, encoded.length),
        encodeMs,
        verifyMode,
        verifyOk,
        roundtripOk,
        decodedSnapshots,
        segmentCount: countSegments(encoded),
        peakHeapUsedBytes,
    };
}

function renderMarkdown(report: LongHorizonReport): string {
    const lines: string[] = [];
    lines.push('# GICS Long-Horizon Benchmark');
    lines.push(`- Run: ${report.runId}`);
    lines.push(`- Timestamp: ${report.timestampUtc}`);
    lines.push(`- Items per snapshot: ${report.config.itemCount}`);
    lines.push(`- Snapshots per day: ${report.config.snapshotsPerDay}`);
    lines.push(`- Flush window: ${report.config.flushEverySnapshots}`);
    lines.push(`- Full decode max snapshots: ${report.config.fullDecodeMaxSnapshots}`);
    lines.push('');
    lines.push('| Horizon | Snapshots | Temporal Items | Raw MB | GICS MB | Ratio | Segments | Verify Mode | Verify | Roundtrip | Encode ms |');
    lines.push('|---|---:|---:|---:|---:|---:|---:|---|---|---|---:|');
    for (const result of report.results) {
        lines.push(
            `| ${result.years}y | ${result.snapshots} | ${result.temporalItems} | ${(result.rawJsonBytes / 1024 / 1024).toFixed(2)} | ${(result.encodedBytes / 1024 / 1024).toFixed(2)} | ${result.ratioX.toFixed(2)}x | ${result.segmentCount} | ${result.verifyMode} | ${result.verifyOk} | ${result.roundtripOk === null ? 'n/a' : result.roundtripOk} | ${result.encodeMs.toFixed(0)} |`,
        );
    }
    lines.push('');
    lines.push('## Notes');
    lines.push('- `full_roundtrip` means `GICS.unpack()` was executed and snapshot count matched.');
    lines.push('- `integrity_only` means full-file hash-chain/CRC verification passed, but full decode was intentionally skipped to avoid benchmarking the decoder instead of long-horizon retention.');
    lines.push('- Peak heap is stored in the JSON artifact for each horizon.');
    return lines.join('\n');
}

async function main(): Promise<void> {
    const snapshotsPerDay = Number(process.env.GICS_LONG_HORIZON_SNAPSHOTS_PER_DAY ?? '24');
    const itemCount = Number(process.env.GICS_LONG_HORIZON_ITEMS ?? '1024');
    const flushEverySnapshots = Number(process.env.GICS_LONG_HORIZON_FLUSH_EVERY ?? '1024');
    const fullDecodeMaxSnapshots = Number(process.env.GICS_LONG_HORIZON_FULL_DECODE_MAX ?? '50000');
    const preset = (process.env.GICS_LONG_HORIZON_PRESET ?? 'balanced') as 'balanced' | 'max_ratio' | 'low_latency';
    const horizonsYears = parseYears();

    const results: HorizonResult[] = [];
    for (const years of horizonsYears) {
        console.log(`Running long-horizon benchmark for ${years} year(s)...`);
        results.push(await runHorizon(years, snapshotsPerDay, itemCount, flushEverySnapshots, fullDecodeMaxSnapshots, preset));
        const partialReport: LongHorizonReport = {
            runId: `long-horizon-${new Date().toISOString().replace(/[:.]/g, '-')}`,
            timestampUtc: new Date().toISOString(),
            environment: {
                node: process.version,
                os: `${os.type()} ${os.release()}`,
                cpu: os.cpus()[0]?.model ?? 'unknown',
                gitCommit: getGitCommit(),
            },
            config: {
                snapshotsPerDay,
                itemCount,
                compressionPreset: preset,
                flushEverySnapshots,
                fullDecodeMaxSnapshots,
                horizonsYears,
            },
            results: [...results],
        };
        writeReportArtifacts(partialReport);
    }

    const report: LongHorizonReport = {
        runId: `long-horizon-${new Date().toISOString().replace(/[:.]/g, '-')}`,
        timestampUtc: new Date().toISOString(),
        environment: {
            node: process.version,
            os: `${os.type()} ${os.release()}`,
            cpu: os.cpus()[0]?.model ?? 'unknown',
            gitCommit: getGitCommit(),
        },
        config: {
            snapshotsPerDay,
            itemCount,
            compressionPreset: preset,
            flushEverySnapshots,
            fullDecodeMaxSnapshots,
            horizonsYears,
        },
        results,
    };

    writeReportArtifacts(report);
    console.log('Long-horizon report written to bench/results/latest/long-horizon-report.json');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
