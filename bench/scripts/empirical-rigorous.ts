import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { GICS } from '../../src/index.js';

type BenchmarkReport = {
    runId: string;
    timestampUtc: string;
    thresholdRatioX: number;
    targetRawBytes: number;
    environment: {
        node: string;
        os: string;
        cpu: string;
        gitCommit: string;
    };
    generation: {
        snapshotsGenerated: number;
        rawBytesGenerated: number;
        itemCountPerSnapshot: number;
    };
    gics: {
        compressedBytes: number;
        ratioX: number;
        encodeMs: number;
        decodeMs?: number;
        throughputMBps: number;
        verifyIntegrityOnly: boolean;
        fullDecodeEnabled: boolean;
        fullDecodeSnapshotCount?: number;
        telemetry?: {
            totalBlocks: number;
            quarantineBlocks: number;
            quarantineRate: number;
            coreRatio: number;
            ratioPercentiles: {
                p50: number;
                p90: number;
                p95: number;
                p99: number;
            };
            codecStats: Array<{
                streamId: number;
                codec: number;
                blocks: number;
                avgRatio: number;
                rawBytes: number;
                payloadBytes: number;
            }>;
        };
        memoryByPhase: {
            setupMb: number;
            encodingPeakMb: number;
            decodingPeakMb: number;
            finalRssMb: number;
        };
    };
    summary: {
        pass: boolean;
        failReasons: string[];
    };
};

function getGitCommit(): string {
    try {
        return execSync('git rev-parse HEAD').toString().trim();
    } catch {
        return 'unknown';
    }
}

function buildSnapshot(index: number, itemCount: number): { timestamp: number; items: Map<number, { price: number; quantity: number }> } {
    const baseTs = 1_700_000_000_000;
    const items = new Map<number, { price: number; quantity: number }>();
    const regime = index % 64;
    for (let i = 0; i < itemCount; i++) {
        const id = 1000 + i;
        const bucket = i % 8;
        const price = 100_000 + bucket * 100 + regime;
        const quantity = (bucket % 3) + 1;
        items.set(id, { price, quantity });
    }
    return { timestamp: baseTs + index, items };
}

function estimateRawSnapshotBytes(snapshot: { timestamp: number; items: Map<number, { price: number; quantity: number }> }): number {
    const plain = {
        timestamp: snapshot.timestamp,
        items: Array.from(snapshot.items.entries()).map(([id, v]) => ({ id, price: v.price, quantity: v.quantity })),
    };
    return Buffer.byteLength(JSON.stringify(plain) + '\n');
}

function renderMarkdown(report: BenchmarkReport): string {
    const lines: string[] = [];
    lines.push('# GICS Rigorous 1GB Benchmark Report');
    lines.push(`- Run: ${report.runId}`);
    lines.push(`- Timestamp: ${report.timestampUtc}`);
    lines.push(`- Target raw bytes: ${report.targetRawBytes}`);
    lines.push(`- Threshold ratio: ${report.thresholdRatioX}x`);
    lines.push(`- Pass: ${report.summary.pass ? 'YES' : 'NO'}`);
    lines.push('');
    lines.push('## Generation');
    lines.push(`- Snapshots generated: ${report.generation.snapshotsGenerated}`);
    lines.push(`- Raw bytes generated: ${report.generation.rawBytesGenerated}`);
    lines.push(`- Items per snapshot: ${report.generation.itemCountPerSnapshot}`);
    lines.push('');
    lines.push('## GICS');
    lines.push(`- Compressed bytes: ${report.gics.compressedBytes}`);
    lines.push(`- Ratio: ${report.gics.ratioX.toFixed(2)}x`);
    lines.push(`- Encode ms: ${report.gics.encodeMs.toFixed(2)}`);
    if (report.gics.decodeMs !== undefined) lines.push(`- Decode ms: ${report.gics.decodeMs.toFixed(2)}`);
    lines.push(`- Throughput: ${report.gics.throughputMBps.toFixed(2)} MB/s`);
    lines.push(`- Integrity verify: ${report.gics.verifyIntegrityOnly}`);
    lines.push(`- Full decode enabled: ${report.gics.fullDecodeEnabled}`);
    if (report.gics.fullDecodeSnapshotCount !== undefined) {
        lines.push(`- Full decode snapshot count: ${report.gics.fullDecodeSnapshotCount}`);
    }
    lines.push('');
    lines.push('## Memory (RSS)');
    lines.push(`- Setup: ${report.gics.memoryByPhase.setupMb.toFixed(2)} MB`);
    lines.push(`- Encoding peak: ${report.gics.memoryByPhase.encodingPeakMb.toFixed(2)} MB`);
    lines.push(`- Decoding peak: ${report.gics.memoryByPhase.decodingPeakMb.toFixed(2)} MB`);
    lines.push(`- Final RSS: ${report.gics.memoryByPhase.finalRssMb.toFixed(2)} MB`);

    if (report.gics.telemetry) {
        lines.push('');
        lines.push('## Telemetry');
        lines.push(`- Total blocks: ${report.gics.telemetry.totalBlocks}`);
        lines.push(`- Quarantine blocks: ${report.gics.telemetry.quarantineBlocks}`);
        lines.push(`- Quarantine rate: ${(report.gics.telemetry.quarantineRate * 100).toFixed(2)}%`);
        lines.push(`- Core ratio: ${report.gics.telemetry.coreRatio.toFixed(2)}x`);
        lines.push(`- Ratio p50/p90/p95/p99: ${report.gics.telemetry.ratioPercentiles.p50.toFixed(2)}x / ${report.gics.telemetry.ratioPercentiles.p90.toFixed(2)}x / ${report.gics.telemetry.ratioPercentiles.p95.toFixed(2)}x / ${report.gics.telemetry.ratioPercentiles.p99.toFixed(2)}x`);
        lines.push('');
        lines.push('| Stream | Codec | Blocks | Avg Ratio | Raw Bytes | Payload Bytes |');
        lines.push('|---:|---:|---:|---:|---:|---:|');
        for (const c of report.gics.telemetry.codecStats) {
            lines.push(`| ${c.streamId} | ${c.codec} | ${c.blocks} | ${c.avgRatio.toFixed(2)}x | ${c.rawBytes} | ${c.payloadBytes} |`);
        }
    }
    if (report.summary.failReasons.length > 0) {
        lines.push('');
        lines.push('## Fail reasons');
        for (const reason of report.summary.failReasons) lines.push(`- ${reason}`);
    }
    return lines.join('\n');
}

function percentile(values: number[], p: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
    return sorted[idx];
}

async function main(): Promise<void> {
    const thresholdRatioX = Number(process.env.GICS_MIN_RATIO_X ?? '50');
    const targetRawBytes = Number(process.env.GICS_TARGET_RAW_BYTES ?? '1000000000'); // 1 GB
    const itemCountPerSnapshot = Number(process.env.GICS_BENCH_ITEMS_PER_SNAPSHOT ?? '24');
    const flushEverySnapshots = Number(process.env.GICS_BENCH_FLUSH_EVERY ?? '20000');
    const doFullDecode = process.env.GICS_FULL_DECODE === '1';

    const runId = `empirical-rigorous-${new Date().toISOString().replace(/[:.]/g, '-')}`;

    const encoder = new GICS.Encoder();
    const setupRssMb = process.memoryUsage().rss / 1024 / 1024;
    let rawBytesGenerated = 0;
    let snapshotsGenerated = 0;
    const rawHasher = createHash('sha256');

    const t0 = performance.now();
    let encodingPeakRss = process.memoryUsage().rss;
    while (rawBytesGenerated < targetRawBytes) {
        const snap = buildSnapshot(snapshotsGenerated, itemCountPerSnapshot);
        await encoder.push(snap);

        const rss = process.memoryUsage().rss;
        if (rss > encodingPeakRss) encodingPeakRss = rss;

        const rawBytes = estimateRawSnapshotBytes(snap);
        rawBytesGenerated += rawBytes;
        rawHasher.update(String(rawBytes));
        rawHasher.update('|');

        snapshotsGenerated++;
        if (snapshotsGenerated % flushEverySnapshots === 0) {
            await encoder.flush();
        }
    }

    const packed = await encoder.seal();
    const t1 = performance.now();
    const verifyOk = await GICS.verify(packed);
    const telemetry = encoder.getTelemetry();

    let fullDecodeSnapshotCount: number | undefined;
    let decodeMs: number | undefined;
    let decodingPeakRss = process.memoryUsage().rss;
    if (doFullDecode) {
        const td0 = performance.now();
        const decoded = await GICS.unpack(packed);
        const td1 = performance.now();
        decodeMs = td1 - td0;
        const rss = process.memoryUsage().rss;
        if (rss > decodingPeakRss) decodingPeakRss = rss;
        fullDecodeSnapshotCount = decoded.length;
    }

    const blockRatios = (telemetry?.blocks ?? []).map((b) => b.ratio);
    const codecMap = new Map<string, { streamId: number; codec: number; blocks: number; rawBytes: number; payloadBytes: number; ratioAcc: number }>();
    for (const b of telemetry?.blocks ?? []) {
        const key = `${b.stream_id}:${b.codec}`;
        const prev = codecMap.get(key) ?? {
            streamId: b.stream_id,
            codec: b.codec,
            blocks: 0,
            rawBytes: 0,
            payloadBytes: 0,
            ratioAcc: 0,
        };
        prev.blocks += 1;
        prev.rawBytes += b.raw_bytes;
        prev.payloadBytes += b.payload_bytes;
        prev.ratioAcc += b.ratio;
        codecMap.set(key, prev);
    }

    const codecStats = Array.from(codecMap.values())
        .map((c) => ({
            streamId: c.streamId,
            codec: c.codec,
            blocks: c.blocks,
            avgRatio: c.ratioAcc / Math.max(1, c.blocks),
            rawBytes: c.rawBytes,
            payloadBytes: c.payloadBytes,
        }))
        .sort((a, b) => b.blocks - a.blocks);

    const ratioX = rawBytesGenerated / Math.max(1, packed.length);
    const throughputMBps = (rawBytesGenerated / 1024 / 1024) / Math.max(1e-9, (t1 - t0) / 1000);
    const failReasons: string[] = [];
    if (rawBytesGenerated < targetRawBytes) {
        failReasons.push(`Raw bytes generated (${rawBytesGenerated}) < target (${targetRawBytes})`);
    }
    if (!verifyOk) {
        failReasons.push('GICS verifyIntegrityOnly returned false');
    }
    if (ratioX < thresholdRatioX) {
        failReasons.push(`Compression ratio ${ratioX.toFixed(2)}x < required ${thresholdRatioX.toFixed(2)}x`);
    }
    if (doFullDecode && fullDecodeSnapshotCount !== snapshotsGenerated) {
        failReasons.push(`Full decode count mismatch: expected ${snapshotsGenerated}, got ${fullDecodeSnapshotCount}`);
    }

    const report: BenchmarkReport = {
        runId,
        timestampUtc: new Date().toISOString(),
        thresholdRatioX,
        targetRawBytes,
        environment: {
            node: process.version,
            os: `${os.type()} ${os.release()}`,
            cpu: os.cpus()[0]?.model ?? 'unknown',
            gitCommit: getGitCommit(),
        },
        generation: {
            snapshotsGenerated,
            rawBytesGenerated,
            itemCountPerSnapshot,
        },
        gics: {
            compressedBytes: packed.length,
            ratioX,
            encodeMs: t1 - t0,
            decodeMs,
            throughputMBps,
            verifyIntegrityOnly: verifyOk,
            fullDecodeEnabled: doFullDecode,
            fullDecodeSnapshotCount,
            telemetry: telemetry
                ? {
                    totalBlocks: telemetry.total_blocks,
                    quarantineBlocks: telemetry.quarantine_blocks,
                    quarantineRate: telemetry.quarantine_rate,
                    coreRatio: telemetry.core_ratio,
                    ratioPercentiles: {
                        p50: percentile(blockRatios, 0.5),
                        p90: percentile(blockRatios, 0.9),
                        p95: percentile(blockRatios, 0.95),
                        p99: percentile(blockRatios, 0.99),
                    },
                    codecStats,
                }
                : undefined,
            memoryByPhase: {
                setupMb: setupRssMb,
                encodingPeakMb: encodingPeakRss / 1024 / 1024,
                decodingPeakMb: decodingPeakRss / 1024 / 1024,
                finalRssMb: process.memoryUsage().rss / 1024 / 1024,
            },
        },
        summary: {
            pass: failReasons.length === 0,
            failReasons,
        },
    };

    const latestDir = path.join(process.cwd(), 'bench', 'results', 'latest');
    fs.mkdirSync(latestDir, { recursive: true });
    fs.writeFileSync(path.join(latestDir, 'empirical-rigorous-report.json'), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(latestDir, 'empirical-rigorous-report.md'), renderMarkdown(report));

    const archivePath = path.join(process.cwd(), 'bench', 'results', `${runId}.json`);
    fs.writeFileSync(archivePath, JSON.stringify(report, null, 2));

    console.log(`Rigorous report written to ${path.join(latestDir, 'empirical-rigorous-report.json')}`);
    console.log(`Raw generated: ${rawBytesGenerated} bytes (${(rawBytesGenerated / 1024 / 1024).toFixed(2)} MB)`);
    console.log(`Compressed: ${packed.length} bytes (${(packed.length / 1024 / 1024).toFixed(2)} MB)`);
    console.log(`Ratio: ${ratioX.toFixed(2)}x (threshold ${thresholdRatioX.toFixed(2)}x)`);

    if (!report.summary.pass) {
        console.error(`FAIL STATE: ${report.summary.failReasons.join(' | ')}`);
        process.exitCode = 1;
    }
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
