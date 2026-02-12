import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { GICSv2Encoder } from '../../src/gics/encode.js';
import { GICSv2Decoder } from '../../src/gics/decode.js';

type Snapshot = {
    timestamp: number;
    items: Map<number, { price: number; quantity: number }>;
};

function getGitCommit(): string {
    try {
        return execSync('git rev-parse HEAD').toString().trim();
    } catch {
        return 'unknown';
    }
}

function buildDataset(total = 16000): Snapshot[] {
    const out: Snapshot[] = [];
    const baseTs = 1_704_000_000_000;
    const book = new Map<number, { price: number; quantity: number }>();

    for (let id = 1; id <= 80; id++) {
        book.set(id, { price: 10_000 + id * 2, quantity: 1 + (id % 3) });
    }

    for (let i = 0; i < total; i++) {
        const items = new Map(book);

        if (i % 17 === 0) {
            for (let id = 1; id <= 80; id += 5) {
                const cur = items.get(id)!;
                items.set(id, { price: cur.price + 1, quantity: cur.quantity });
            }
        }

        if (i % 101 === 0) {
            const id = (i % 80) + 1;
            const cur = items.get(id)!;
            items.set(id, { price: cur.price + 177, quantity: cur.quantity + 1 });
        }

        out.push({ timestamp: baseTs + i, items });
        for (const [id, v] of items) book.set(id, v);
    }
    return out;
}

async function main(): Promise<void> {
    const runId = `empirical-codec-stats-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const snapshots = buildDataset(Number(process.env.GICS_CODEC_STATS_ROWS ?? '16000'));

    const encoder = new GICSv2Encoder({ contextMode: 'on', probeInterval: 2 });
    const t0 = performance.now();
    for (const s of snapshots) await encoder.addSnapshot(s);
    const packed = await encoder.finish();
    const t1 = performance.now();

    const telemetry = encoder.getTelemetry();
    const decoder = new GICSv2Decoder(packed);
    const decoded = await decoder.getAllSnapshots();
    const verifyOk = await decoder.verifyIntegrityOnly();

    const codecStats = new Map<string, { blocks: number; payloadBytes: number; rawBytes: number }>();
    for (const b of telemetry?.blocks ?? []) {
        const k = `${b.stream_id}:${b.codec}`;
        const prev = codecStats.get(k) ?? { blocks: 0, payloadBytes: 0, rawBytes: 0 };
        prev.blocks += 1;
        prev.payloadBytes += b.payload_bytes;
        prev.rawBytes += b.raw_bytes;
        codecStats.set(k, prev);
    }

    const codecRows = Array.from(codecStats.entries())
        .map(([key, v]) => ({
            key,
            blocks: v.blocks,
            payloadBytes: v.payloadBytes,
            rawBytes: v.rawBytes,
            ratio: v.rawBytes / Math.max(1, v.payloadBytes),
        }))
        .sort((a, b) => b.blocks - a.blocks);

    const report = {
        run_id: runId,
        timestamp_utc: new Date().toISOString(),
        env: {
            node: process.version,
            os: `${os.type()} ${os.release()}`,
            cpu: os.cpus()[0]?.model ?? 'unknown',
            git_commit: getGitCommit(),
        },
        summary: {
            snapshots_input: snapshots.length,
            snapshots_output: decoded.length,
            verify_ok: verifyOk,
            encode_ms: t1 - t0,
            compression_ratio: (Buffer.byteLength(JSON.stringify(snapshots.length)) + snapshots.length * 16) / Math.max(1, packed.length),
            quarantine_rate: telemetry?.quarantine_rate ?? 0,
            quarantine_blocks: telemetry?.quarantine_blocks ?? 0,
            total_blocks: telemetry?.total_blocks ?? 0,
            pass: verifyOk && decoded.length === snapshots.length,
        },
        codec_stats: codecRows,
    };

    const latestDir = path.join(process.cwd(), 'bench', 'results', 'latest');
    fs.mkdirSync(latestDir, { recursive: true });
    fs.writeFileSync(path.join(latestDir, 'empirical-codec-stats-report.json'), JSON.stringify(report, null, 2));
    fs.writeFileSync(
        path.join(latestDir, 'empirical-codec-stats-report.md'),
        [
            '# GICS Empirical Codec Stats Report',
            `- Run: ${runId}`,
            `- Pass: ${report.summary.pass ? 'YES' : 'NO'}`,
            `- Quarantine rate: ${(report.summary.quarantine_rate * 100).toFixed(2)}%`,
            '',
            '| Stream:Codec | Blocks | Raw Bytes | Payload Bytes | Ratio |',
            '|---|---:|---:|---:|---:|',
            ...codecRows.map((r) => `| ${r.key} | ${r.blocks} | ${r.rawBytes} | ${r.payloadBytes} | ${r.ratio.toFixed(2)}x |`),
            '',
        ].join('\n'),
    );

    fs.writeFileSync(path.join(process.cwd(), 'bench', 'results', `${runId}.json`), JSON.stringify(report, null, 2));

    console.log(`Codec stats report: ${path.join(latestDir, 'empirical-codec-stats-report.json')}`);
    if (!report.summary.pass) process.exitCode = 1;
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
