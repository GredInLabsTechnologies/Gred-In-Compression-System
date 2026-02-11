import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import protobuf from 'protobufjs/light';
import { encode as msgpackEncode, decode as msgpackDecode } from '@msgpack/msgpack';
import { tableFromArrays, tableFromIPC, tableToIPC } from 'apache-arrow';
import { GICS } from '../../src/index.js';

type Snapshot = {
    timestamp: number;
    items: Map<number, { price: number; quantity: number }>;
};

type FlatRow = {
    snapshotIndex: number;
    timestamp: number;
    id: number;
    price: number;
    quantity: number;
};

type DatasetScenario = {
    id: 'A' | 'B' | 'C';
    label: string;
    type: 'worst_case' | 'realistic_production' | 'best_case';
    seed: number;
    snapshots: Snapshot[];
};

type CodecResult = {
    dataset_id: string;
    dataset_type: string;
    system: 'GICS' | 'PROTOBUF' | 'MSGPACK' | 'ARROW' | 'STRUCTURED_BINARY';
    entropy_score: number;
    size_bytes: number;
    raw_bytes_real: number;
    compressed_bytes_real: number;
    compression_ratio_real: number;
    encode_time_ms: number;
    decode_time_ms: number;
    memory_peak_mb: number;
    integrity_hash_before: string;
    integrity_hash_after: string;
    binary_diff: number;
    status: 'valid' | 'invalid' | 'lab_only';
    audit?: {
        ratio_over_200x: boolean;
        discretization_detected: boolean;
        repetition_detected: boolean;
        deterministic_patterns_detected: boolean;
    };
    error?: string;
};

type CodecAdapter = {
    name: CodecResult['system'];
    encode: (snapshots: Snapshot[]) => Promise<Uint8Array>;
    decode: (encoded: Uint8Array) => Promise<Snapshot[]>;
};

class SeededRng {
    private state: number;

    constructor(seed: number) {
        this.state = seed % 2147483647;
        if (this.state <= 0) this.state += 2147483646;
    }

    next(): number {
        this.state = (this.state * 16807) % 2147483647;
        return (this.state - 1) / 2147483646;
    }

    nextInt(minInclusive: number, maxExclusive: number): number {
        return Math.floor(this.next() * (maxExclusive - minInclusive)) + minInclusive;
    }
}

function getGitCommit(): string {
    try {
        return execSync('git rev-parse HEAD').toString().trim();
    } catch {
        return 'unknown';
    }
}

function sha256(data: Uint8Array): string {
    return createHash('sha256').update(data).digest('hex');
}

function flattenSnapshots(snapshots: Snapshot[]): FlatRow[] {
    const rows: FlatRow[] = [];
    for (let s = 0; s < snapshots.length; s++) {
        const snap = snapshots[s];
        const ordered = Array.from(snap.items.entries()).sort((a, b) => a[0] - b[0]);
        for (const [id, values] of ordered) {
            rows.push({
                snapshotIndex: s,
                timestamp: snap.timestamp,
                id,
                price: values.price,
                quantity: values.quantity,
            });
        }
    }
    return rows;
}

function buildSnapshotsFromRows(rows: FlatRow[]): Snapshot[] {
    const snapshots = new Map<number, Snapshot>();
    for (const row of rows) {
        let snapshot = snapshots.get(row.snapshotIndex);
        if (!snapshot) {
            snapshot = { timestamp: row.timestamp, items: new Map<number, { price: number; quantity: number }>() };
            snapshots.set(row.snapshotIndex, snapshot);
        }
        snapshot.items.set(row.id, { price: row.price, quantity: row.quantity });
    }

    return Array.from(snapshots.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([, value]) => value);
}

function encodeStructuredRawBinary(snapshots: Snapshot[]): Uint8Array {
    const rows = flattenSnapshots(snapshots);
    const rowByteSize = 4 + 8 + 8 + 8 + 8;
    const headerByteSize = 8;
    const buf = Buffer.allocUnsafe(headerByteSize + rows.length * rowByteSize);
    let offset = 0;
    buf.writeUInt32LE(snapshots.length, offset);
    offset += 4;
    buf.writeUInt32LE(rows.length, offset);
    offset += 4;

    for (const row of rows) {
        buf.writeUInt32LE(row.snapshotIndex, offset);
        offset += 4;
        buf.writeDoubleLE(row.timestamp, offset);
        offset += 8;
        buf.writeDoubleLE(row.id, offset);
        offset += 8;
        buf.writeDoubleLE(row.price, offset);
        offset += 8;
        buf.writeDoubleLE(row.quantity, offset);
        offset += 8;
    }

    return new Uint8Array(buf);
}

function decodeStructuredRawBinary(encoded: Uint8Array): Snapshot[] {
    const buf = Buffer.from(encoded);
    let offset = 0;
    const _snapshotCount = buf.readUInt32LE(offset);
    offset += 4;
    const rowCount = buf.readUInt32LE(offset);
    offset += 4;

    const rows: FlatRow[] = [];
    for (let i = 0; i < rowCount; i++) {
        const snapshotIndex = buf.readUInt32LE(offset);
        offset += 4;
        const timestamp = buf.readDoubleLE(offset);
        offset += 8;
        const id = buf.readDoubleLE(offset);
        offset += 8;
        const price = buf.readDoubleLE(offset);
        offset += 8;
        const quantity = buf.readDoubleLE(offset);
        offset += 8;
        rows.push({ snapshotIndex, timestamp, id, price, quantity });
    }

    return buildSnapshotsFromRows(rows);
}

function binaryDiffCount(before: Uint8Array, after: Uint8Array): number {
    const min = Math.min(before.length, after.length);
    let diff = Math.abs(before.length - after.length);
    for (let i = 0; i < min; i++) {
        if (before[i] !== after[i]) diff++;
    }
    return diff;
}

function shannonEntropy(bytes: Uint8Array): number {
    if (bytes.length === 0) return 0;
    const freq = new Uint32Array(256);
    for (const b of bytes) freq[b]++;
    let entropy = 0;
    for (let i = 0; i < 256; i++) {
        const count = freq[i];
        if (count === 0) continue;
        const p = count / bytes.length;
        entropy -= p * Math.log2(p);
    }
    return entropy;
}

function percentile(values: number[], p: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
    return sorted[idx];
}

function auditDatasetForBias(snapshots: Snapshot[]) {
    const rows = flattenSnapshots(snapshots);
    const totalRows = Math.max(1, rows.length);

    let integerLike = 0;
    const signatures = new Set<string>();
    const tsDiffs = new Set<number>();
    const roundedPriceDiffs = new Set<number>();

    let lastTs = snapshots[0]?.timestamp ?? 0;
    let lastPrice = rows[0]?.price ?? 0;

    for (const row of rows) {
        const priceIntLike = Math.abs(row.price - Math.round(row.price)) < 1e-9;
        const qtyIntLike = Math.abs(row.quantity - Math.round(row.quantity)) < 1e-9;
        if (priceIntLike && qtyIntLike) integerLike++;
        signatures.add(`${row.id}:${row.price}:${row.quantity}`);

        const priceDiffRounded = Math.round((row.price - lastPrice) * 1000);
        roundedPriceDiffs.add(priceDiffRounded);
        lastPrice = row.price;
    }

    for (const snap of snapshots) {
        const diff = Math.round(snap.timestamp - lastTs);
        tsDiffs.add(diff);
        lastTs = snap.timestamp;
    }

    const discretizationDetected = integerLike / totalRows > 0.98;
    const repetitionDetected = signatures.size / totalRows < 0.25;
    const deterministicPatternsDetected = tsDiffs.size <= 3 || roundedPriceDiffs.size <= 3;

    return {
        discretizationDetected,
        repetitionDetected,
        deterministicPatternsDetected,
    };
}

function samplePeakRssWhile<T>(fn: () => Promise<T>, intervalMs = 5): Promise<{ result: T; peakMb: number; ms: number }> {
    return new Promise(async (resolve, reject) => {
        const started = performance.now();
        let peak = process.memoryUsage().rss;
        const timer = setInterval(() => {
            const rss = process.memoryUsage().rss;
            if (rss > peak) peak = rss;
        }, intervalMs);

        try {
            const result = await fn();
            clearInterval(timer);
            const ended = performance.now();
            resolve({ result, peakMb: peak / 1024 / 1024, ms: ended - started });
        } catch (error) {
            clearInterval(timer);
            reject(error);
        }
    });
}

function createScenarios(snapshotCount: number): DatasetScenario[] {
    const scenarioA = (() => {
        const rng = new SeededRng(1001);
        const snapshots: Snapshot[] = [];
        let timestamp = 1_700_000_000_000;
        let nextId = 1_000_000;

        for (let i = 0; i < snapshotCount; i++) {
            const items = new Map<number, { price: number; quantity: number }>();
            for (let j = 0; j < 12; j++) {
                const id = nextId++;
                const price = rng.next() * 1_000_000 + rng.next() * 0.000001;
                const quantity = rng.next() * 500 + rng.next() * 0.000001;
                items.set(id, { price, quantity });
            }
            timestamp += rng.nextInt(1, 4);
            snapshots.push({ timestamp, items });
        }

        return {
            id: 'A' as const,
            label: 'worst_case_random_noise_float_non_repetitive_ids',
            type: 'worst_case' as const,
            seed: 1001,
            snapshots,
        };
    })();

    const scenarioB = (() => {
        const rng = new SeededRng(2002);
        const snapshots: Snapshot[] = [];
        let timestamp = 1_700_100_000_000;
        const active = new Map<number, { price: number; quantity: number }>();
        for (let id = 1; id <= 320; id++) {
            active.set(id, { price: 10_000 + id * 3, quantity: 1 + (id % 7) });
        }

        for (let i = 0; i < snapshotCount; i++) {
            const step = rng.nextInt(1, 10);
            timestamp += i % 97 === 0 ? step * 100 : step;

            const updateCount = rng.nextInt(20, 80);
            for (let u = 0; u < updateCount; u++) {
                const id = rng.nextInt(1, 450);
                if (!active.has(id)) active.set(id, { price: 10_000 + id, quantity: 1 });
                const base = active.get(id)!;
                const drift = (rng.next() - 0.48) * 25;
                const outlier = i % 211 === 0 && u === 0 ? rng.nextInt(500, 1500) : 0;
                const nextPrice = Math.max(1, base.price + drift + outlier);
                const nextQty = Math.max(0.0001, base.quantity + (rng.next() - 0.5) * 2);
                active.set(id, { price: nextPrice, quantity: nextQty });
            }

            if (i % 41 === 0) {
                const removeId = rng.nextInt(1, 450);
                active.delete(removeId);
            }

            snapshots.push({ timestamp, items: new Map(active) });
        }

        return {
            id: 'B' as const,
            label: 'realistic_production_drift_gaps_outliers_partial_updates_irregular_timestamps',
            type: 'realistic_production' as const,
            seed: 2002,
            snapshots,
        };
    })();

    const scenarioC = (() => {
        const rng = new SeededRng(3003);
        const snapshots: Snapshot[] = [];
        let timestamp = 1_700_200_000_000;
        const base = new Map<number, { price: number; quantity: number }>();
        for (let id = 1; id <= 64; id++) {
            base.set(id, { price: 1000 + id * 2, quantity: 1 + (id % 3) });
        }

        for (let i = 0; i < snapshotCount; i++) {
            timestamp += 1;
            const items = new Map(base);
            if (i % 20 === 0) {
                for (let k = 0; k < 2; k++) {
                    const id = rng.nextInt(1, 65);
                    const current = items.get(id)!;
                    items.set(id, { price: current.price + 1, quantity: current.quantity });
                }
            }
            snapshots.push({ timestamp, items });
        }

        return {
            id: 'C' as const,
            label: 'best_case_structural_repetition_minimal_deltas_temporal_stability',
            type: 'best_case' as const,
            seed: 3003,
            snapshots,
        };
    })();

    return [scenarioA, scenarioB, scenarioC];
}

const protobufRoot = protobuf.Root.fromJSON({
    nested: {
        Row: {
            fields: {
                snapshotIndex: { type: 'uint32', id: 1 },
                timestamp: { type: 'double', id: 2 },
                id: { type: 'double', id: 3 },
                price: { type: 'double', id: 4 },
                quantity: { type: 'double', id: 5 },
            },
        },
        Dataset: {
            fields: {
                rows: { rule: 'repeated', type: 'Row', id: 1 },
            },
        },
    },
});
const ProtobufDataset = protobufRoot.lookupType('Dataset');

const adapters: CodecAdapter[] = [
    {
        name: 'GICS',
        encode: async (snapshots) => GICS.pack(snapshots),
        decode: async (encoded) => GICS.unpack(encoded),
    },
    {
        name: 'PROTOBUF',
        encode: async (snapshots) => {
            const rows = flattenSnapshots(snapshots);
            const payload = ProtobufDataset.create({ rows });
            return ProtobufDataset.encode(payload).finish();
        },
        decode: async (encoded) => {
            const decoded = ProtobufDataset.decode(encoded) as unknown as { rows?: FlatRow[] };
            return buildSnapshotsFromRows(decoded.rows ?? []);
        },
    },
    {
        name: 'MSGPACK',
        encode: async (snapshots) => {
            const rows = flattenSnapshots(snapshots);
            return msgpackEncode({ rows });
        },
        decode: async (encoded) => {
            const decoded = msgpackDecode(encoded) as { rows?: FlatRow[] };
            return buildSnapshotsFromRows(decoded.rows ?? []);
        },
    },
    {
        name: 'ARROW',
        encode: async (snapshots) => {
            const rows = flattenSnapshots(snapshots);
            const table = tableFromArrays({
                snapshotIndex: Int32Array.from(rows.map((r) => r.snapshotIndex)),
                timestamp: Float64Array.from(rows.map((r) => r.timestamp)),
                id: Float64Array.from(rows.map((r) => r.id)),
                price: Float64Array.from(rows.map((r) => r.price)),
                quantity: Float64Array.from(rows.map((r) => r.quantity)),
            });
            return tableToIPC(table);
        },
        decode: async (encoded) => {
            const table = tableFromIPC(encoded);
            const rows = (table.toArray() as Array<Record<string, number>>).map((r) => ({
                snapshotIndex: Number(r.snapshotIndex),
                timestamp: Number(r.timestamp),
                id: Number(r.id),
                price: Number(r.price),
                quantity: Number(r.quantity),
            }));
            return buildSnapshotsFromRows(rows);
        },
    },
    {
        name: 'STRUCTURED_BINARY',
        encode: async (snapshots) => encodeStructuredRawBinary(snapshots),
        decode: async (encoded) => decodeStructuredRawBinary(encoded),
    },
];

function writeFileAndMeasure(filePath: string, data: Uint8Array): number {
    fs.writeFileSync(filePath, data);
    return fs.statSync(filePath).size;
}

async function runCodec(
    scenario: DatasetScenario,
    adapter: CodecAdapter,
    runArtifactsDir: string,
): Promise<CodecResult> {
    const rawCanonical = encodeStructuredRawBinary(scenario.snapshots);
    const entropyScore = shannonEntropy(rawCanonical);
    const hashBefore = sha256(rawCanonical);

    const rawFilePath = path.join(runArtifactsDir, `${scenario.id}_${adapter.name}_raw.bin`);
    const rawBytesReal = writeFileAndMeasure(rawFilePath, rawCanonical);

    try {
        const encodedRun = await samplePeakRssWhile(async () => adapter.encode(scenario.snapshots));
        const encoded = encodedRun.result;
        const encodedFilePath = path.join(runArtifactsDir, `${scenario.id}_${adapter.name}_compressed.bin`);
        const compressedBytesReal = writeFileAndMeasure(encodedFilePath, encoded);

        const decodedRun = await samplePeakRssWhile(async () => adapter.decode(encoded));
        const decodedSnapshots = decodedRun.result;

        const rebuilt = encodeStructuredRawBinary(decodedSnapshots);
        const hashAfter = sha256(rebuilt);
        const diff = binaryDiffCount(rawCanonical, rebuilt);

        const ratio = rawBytesReal / Math.max(1, compressedBytesReal);
        const integrityOk = hashBefore === hashAfter && diff === 0;
        const auditSignals = auditDatasetForBias(scenario.snapshots);
        const ratioOver200 = ratio > 200;
        const mustLabOnly = ratioOver200;

        const status: CodecResult['status'] = !integrityOk
            ? 'invalid'
            : mustLabOnly
                ? 'lab_only'
                : 'valid';

        return {
            dataset_id: scenario.id,
            dataset_type: scenario.type,
            system: adapter.name,
            entropy_score: entropyScore,
            size_bytes: rawBytesReal,
            raw_bytes_real: rawBytesReal,
            compressed_bytes_real: compressedBytesReal,
            compression_ratio_real: ratio,
            encode_time_ms: encodedRun.ms,
            decode_time_ms: decodedRun.ms,
            memory_peak_mb: Math.max(encodedRun.peakMb, decodedRun.peakMb),
            integrity_hash_before: hashBefore,
            integrity_hash_after: hashAfter,
            binary_diff: diff,
            status,
            audit: {
                ratio_over_200x: ratioOver200,
                discretization_detected: auditSignals.discretizationDetected,
                repetition_detected: auditSignals.repetitionDetected,
                deterministic_patterns_detected: auditSignals.deterministicPatternsDetected,
            },
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            dataset_id: scenario.id,
            dataset_type: scenario.type,
            system: adapter.name,
            entropy_score: entropyScore,
            size_bytes: rawBytesReal,
            raw_bytes_real: rawBytesReal,
            compressed_bytes_real: 0,
            compression_ratio_real: 0,
            encode_time_ms: 0,
            decode_time_ms: 0,
            memory_peak_mb: process.memoryUsage().rss / 1024 / 1024,
            integrity_hash_before: hashBefore,
            integrity_hash_after: 'ERROR',
            binary_diff: Number.MAX_SAFE_INTEGER,
            status: 'invalid',
            error: message,
        };
    }
}

function renderStrictTextReport(
    env: { node: string; cpu: string; os: string; commit: string },
    results: CodecResult[],
    ratioSummary: { gics_ratio_p50: number; gics_ratio_p95: number },
): string {
    const blocks: string[] = [];
    for (const r of results) {
        blocks.push('[ENV]');
        blocks.push(`node=${env.node}`);
        blocks.push(`cpu=${env.cpu}`);
        blocks.push(`os=${env.os}`);
        blocks.push(`commit=${env.commit}`);
        blocks.push('');
        blocks.push('[DATASET]');
        blocks.push(`type=${r.dataset_id}_${r.dataset_type}`);
        blocks.push(`entropy_score=${r.entropy_score.toFixed(6)}`);
        blocks.push(`size_bytes=${r.size_bytes}`);
        blocks.push('');
        blocks.push('[RESULT]');
        blocks.push(`system=${r.system}`);
        blocks.push(`raw_bytes=${r.raw_bytes_real}`);
        blocks.push(`compressed_bytes=${r.compressed_bytes_real}`);
        blocks.push(`ratio_real=${r.compression_ratio_real.toFixed(6)}`);
        blocks.push('');
        blocks.push('[PERF]');
        blocks.push(`encode_ms=${r.encode_time_ms.toFixed(3)}`);
        blocks.push(`decode_ms=${r.decode_time_ms.toFixed(3)}`);
        blocks.push(`memory_peak=${r.memory_peak_mb.toFixed(3)}`);
        blocks.push('');
        blocks.push('[INTEGRITY]');
        blocks.push(`hash_before=${r.integrity_hash_before}`);
        blocks.push(`hash_after=${r.integrity_hash_after}`);
        blocks.push(`diff=${r.binary_diff}`);
        blocks.push('');
        blocks.push('[STATUS]');
        blocks.push(r.status);
        if (r.audit) {
            blocks.push('');
            blocks.push('[AUDIT]');
            blocks.push(`ratio_over_200x=${r.audit.ratio_over_200x}`);
            blocks.push(`discretization_detected=${r.audit.discretization_detected}`);
            blocks.push(`repetition_detected=${r.audit.repetition_detected}`);
            blocks.push(`deterministic_patterns_detected=${r.audit.deterministic_patterns_detected}`);
        }
        if (r.error) {
            blocks.push('');
            blocks.push('[ERROR]');
            blocks.push(r.error);
        }
        blocks.push('');
        blocks.push('---');
        blocks.push('');
    }

    blocks.push('[SUMMARY]');
    blocks.push(`gics_ratio_p50=${ratioSummary.gics_ratio_p50.toFixed(6)}`);
    blocks.push(`gics_ratio_p95=${ratioSummary.gics_ratio_p95.toFixed(6)}`);
    blocks.push(`gics_ratio_consistent=${(ratioSummary.gics_ratio_p95 / Math.max(1e-9, ratioSummary.gics_ratio_p50)).toFixed(6)}`);
    return blocks.join('\n');
}

async function main(): Promise<void> {
    const runId = `empirical-strict-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const snapshotCount = Number(process.env.GICS_STRICT_SNAPSHOTS ?? '900');

    const env = {
        node: process.version,
        cpu: os.cpus()[0]?.model ?? 'unknown',
        os: `${os.type()} ${os.release()}`,
        commit: getGitCommit(),
    };

    const scenarios = createScenarios(snapshotCount);
    const latestDir = path.join(process.cwd(), 'bench', 'results', 'latest');
    fs.mkdirSync(latestDir, { recursive: true });
    const runArtifactsDir = path.join(process.cwd(), 'bench', 'results', runId);
    fs.mkdirSync(runArtifactsDir, { recursive: true });

    const results: CodecResult[] = [];
    for (const scenario of scenarios) {
        for (const adapter of adapters) {
            const result = await runCodec(scenario, adapter, runArtifactsDir);
            results.push(result);
        }
    }

    const gicsRatios = results.filter((r) => r.system === 'GICS').map((r) => r.compression_ratio_real);
    const ratioSummary = {
        gics_ratio_p50: percentile(gicsRatios, 0.5),
        gics_ratio_p95: percentile(gicsRatios, 0.95),
    };

    const gicsRealistic = results.filter((r) => r.system === 'GICS' && r.dataset_id === 'B');
    const gicsIntegrityPerfect = gicsRealistic.every((r) => r.integrity_hash_before === r.integrity_hash_after && r.binary_diff === 0);
    const gicsAbove50xRealistic = gicsRealistic.every((r) => r.compression_ratio_real > 50);
    const gicsNoLabOnlyRealistic = gicsRealistic.every((r) => r.status !== 'lab_only');
    const gicsConsistency = ratioSummary.gics_ratio_p95 / Math.max(1e-9, ratioSummary.gics_ratio_p50);

    const jsonReport = {
        run_id: runId,
        timestamp_utc: new Date().toISOString(),
        env,
        snapshots_per_scenario: snapshotCount,
        scenarios: scenarios.map((s) => ({ id: s.id, label: s.label, type: s.type, seed: s.seed })),
        results,
        summary: {
            ...ratioSummary,
            gics_ratio_consistency_p95_over_p50: gicsConsistency,
            gics_validated_real_criteria:
                gicsAbove50xRealistic &&
                gicsIntegrityPerfect &&
                gicsNoLabOnlyRealistic &&
                gicsConsistency <= 2,
            criteria_breakdown: {
                maintains_gt_50x_on_realistic_critical: gicsAbove50xRealistic,
                perfect_integrity_on_realistic_critical: gicsIntegrityPerfect,
                no_lab_only_dependency_on_realistic_critical: gicsNoLabOnlyRealistic,
                ratio_consistent_p50_p95: gicsConsistency <= 2,
            },
        },
    };

    const jsonPathLatest = path.join(latestDir, 'empirical-strict-report.json');
    const txtPathLatest = path.join(latestDir, 'empirical-strict-report.txt');
    fs.writeFileSync(jsonPathLatest, JSON.stringify(jsonReport, null, 2));
    fs.writeFileSync(txtPathLatest, renderStrictTextReport(env, results, ratioSummary));

    fs.writeFileSync(path.join(process.cwd(), 'bench', 'results', `${runId}.json`), JSON.stringify(jsonReport, null, 2));

    console.log(`Strict benchmark complete: ${jsonPathLatest}`);
    console.log(`Strict text report: ${txtPathLatest}`);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
