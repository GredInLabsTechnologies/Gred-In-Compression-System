import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

import { GICS } from '../../../src/index.js';
import { InnerCodecId, StreamId } from '../../../src/gics/format.js';
import { getPostfreezeDatasets, type PostfreezeDataset } from './datasets.postfreeze.js';

type Telemetry = NonNullable<ReturnType<InstanceType<(typeof GICS)['Encoder']>['getTelemetry']>>;

const ARTIFACTS_ROOT = path.join(process.cwd(), 'bench', 'forensics', 'artifacts', 'postfreeze');

function ensureDir(dir: string) {
    fs.mkdirSync(dir, { recursive: true });
}

function sha256Hex(content: Uint8Array | string): string {
    return createHash('sha256').update(content).digest('hex');
}

function streamName(streamId: number): string {
    switch (streamId) {
        case StreamId.TIME: return 'TIME';
        case StreamId.SNAPSHOT_LEN: return 'SNAPSHOT_LEN';
        case StreamId.ITEM_ID: return 'ITEM_ID';
        case StreamId.VALUE: return 'VALUE';
        case StreamId.QUANTITY: return 'QUANTITY';
        default: return `STREAM_${streamId}`;
    }
}

function codecName(codecId: number): string {
    switch (codecId) {
        case InnerCodecId.NONE: return 'NONE';
        case InnerCodecId.VARINT_DELTA: return 'VARINT_DELTA';
        case InnerCodecId.BITPACK_DELTA: return 'BITPACK_DELTA';
        case InnerCodecId.RLE_ZIGZAG: return 'RLE_ZIGZAG';
        case InnerCodecId.RLE_DOD: return 'RLE_DOD';
        case InnerCodecId.DOD_VARINT: return 'DOD_VARINT';
        case InnerCodecId.DICT_VARINT: return 'DICT_VARINT';
        default: return `CODEC_${codecId}`;
    }
}

function canonicalJsonRows(ds: PostfreezeDataset): string {
    return JSON.stringify(ds.data);
}

async function encodeDataset(ds: PostfreezeDataset, runDir: string): Promise<boolean> {
    console.log(`\n=== POSTFREEZE: ${ds.name} (seed=${ds.seed}) ===`);

    const rawJson = canonicalJsonRows(ds);
    fs.writeFileSync(path.join(runDir, `${ds.name}_raw.json`), rawJson);
    const rawSha = sha256Hex(rawJson);

    const encoder = new GICS.Encoder({
        runId: `forensics_postfreeze_${ds.name}`,
        contextMode: 'on',
        probeInterval: 4,
        sidecarWriter: null,
        logger: null,
        segmentSizeLimit: 1024 * 1024,
        password: ''
    });

    for (const row of ds.data) {
        const items = new Map<number, { price: number; quantity: number }>();
        items.set(1, { price: row.v, quantity: 1 });
        await encoder.addSnapshot({ timestamp: row.t, items });
    }

    const encoded = await encoder.finish();
    const telemetry = encoder.getTelemetry() as Telemetry;
    if (!telemetry) throw new Error('Missing telemetry from encoder');

    const encodedSha = sha256Hex(encoded);
    fs.writeFileSync(path.join(runDir, `${ds.name}_encoded.bin`), encoded);
    fs.writeFileSync(path.join(runDir, `${ds.name}_encoded.sha256`), `${encodedSha}\n`);

    const trace = telemetry.blocks.map((b: any, idx: number) => ({
        block_id: idx,
        stream_id: b.stream_id,
        stream_name: streamName(b.stream_id),
        raw_bytes: b.raw_bytes,
        total_bytes: b.bytes,
        payload_bytes: b.payload_bytes,
        header_bytes: b.header_bytes,
        routing_decision: b.params?.decision ?? 'CORE',
        routing_reason: b.params?.reason ?? null,
        codec_id: b.codec,
        codec_name: codecName(b.codec),
        health: b.health,
        flags: b.flags,
        entropy_unique_ratio: b.metrics?.unique_ratio ?? null,
    }));
    fs.writeFileSync(path.join(runDir, `${ds.name}_trace.json`), JSON.stringify(trace, null, 2));

    const traceTotalIn = trace.reduce((acc: number, b: any) => acc + (b.raw_bytes || 0), 0);
    const traceTotalOut = trace.reduce((acc: number, b: any) => acc + (b.total_bytes || 0), 0);

    const quarantineRatio = telemetry.quarantine_output_bytes > 0
        ? (telemetry.quarantine_input_bytes / telemetry.quarantine_output_bytes)
        : 0;

    const storageInputBytes = Buffer.byteLength(rawJson, 'utf8');
    const storageOutputBytes = encoded.length;

    const kpi = {
        core_input_bytes: telemetry.core_input_bytes,
        core_output_bytes: telemetry.core_output_bytes,
        core_ratio: telemetry.core_ratio,

        quarantine_input_bytes: telemetry.quarantine_input_bytes,
        quarantine_output_bytes: telemetry.quarantine_output_bytes,
        quarantine_ratio: quarantineRatio,

        total_input_bytes: traceTotalIn,
        total_output_bytes: traceTotalOut,
        global_ratio: traceTotalOut > 0 ? (traceTotalIn / traceTotalOut) : 0,

        storage_input_bytes: storageInputBytes,
        storage_output_bytes: storageOutputBytes,
        storage_ratio: storageOutputBytes > 0 ? (storageInputBytes / storageOutputBytes) : 0,
    };
    fs.writeFileSync(path.join(runDir, `${ds.name}_kpi.json`), JSON.stringify(kpi, null, 2));

    const chmOutTotal = telemetry.core_output_bytes + telemetry.quarantine_output_bytes;
    const impact = {
        quarantine_block_rate: telemetry.total_blocks > 0 ? (telemetry.quarantine_blocks / telemetry.total_blocks) : 0,
        quarantine_byte_rate: chmOutTotal > 0 ? (telemetry.quarantine_output_bytes / chmOutTotal) : 0,
        core_ratio: telemetry.core_ratio,
        storage_ratio: kpi.storage_ratio,
    };
    fs.writeFileSync(path.join(runDir, `${ds.name}_impact.json`), JSON.stringify(impact, null, 2));

    const decoder = new GICS.Decoder(encoded, { integrityMode: 'strict', logger: null, password: '' });
    const decodedSnapshots = await decoder.getAllSnapshots();
    const decodedRows = decodedSnapshots.map((s: any) => ({
        t: s.timestamp,
        v: s.items.get(1)?.price ?? 0,
    }));
    const decodedJson = JSON.stringify(decodedRows);
    const decodedSha = sha256Hex(decodedJson);
    fs.writeFileSync(path.join(runDir, `${ds.name}_decoded.json`), decodedJson);
    fs.writeFileSync(path.join(runDir, `${ds.name}_decoded.sha256`), `${decodedSha}\n`);

    const roundtripOk = decodedSha === rawSha;
    if (!roundtripOk) {
        console.error(`[ROUNDTRIP FAIL] ${ds.name}: raw SHA ${rawSha} != decoded SHA ${decodedSha}`);
    } else {
        console.log(`[OK] encoded_sha256=${encodedSha} raw_sha256=${rawSha} bytes_out=${encoded.length}`);
    }
    return roundtripOk;
}

interface RunResult { dataset: string; run: string; roundtripOk: boolean }

async function runAll(runLabel: 'runA' | 'runB'): Promise<RunResult[]> {
    const runDir = path.join(ARTIFACTS_ROOT, runLabel);
    ensureDir(runDir);

    const results: RunResult[] = [];
    for (const ds of getPostfreezeDatasets()) {
        const ok = await encodeDataset(ds, runDir);
        results.push({ dataset: ds.name, run: runLabel, roundtripOk: ok });
    }
    return results;
}

async function main() {
    ensureDir(ARTIFACTS_ROOT);
    console.log('Forensics/Postfreeze harness initialized');
    console.log(`node=${process.version}`);
    console.log(`os=${os.type()} ${os.release()}`);
    console.log(`cpu=${os.cpus()[0]?.model ?? 'unknown'}`);

    const resultsA = await runAll('runA');
    const resultsB = await runAll('runB');
    const all = [...resultsA, ...resultsB];

    console.log(`\nArtifacts written under: ${ARTIFACTS_ROOT}`);

    // Determinism check: runA vs runB SHA match
    const datasets = getPostfreezeDatasets();
    let deterministicOk = true;
    for (const ds of datasets) {
        const shaA = fs.readFileSync(path.join(ARTIFACTS_ROOT, 'runA', `${ds.name}_encoded.sha256`), 'utf8').trim();
        const shaB = fs.readFileSync(path.join(ARTIFACTS_ROOT, 'runB', `${ds.name}_encoded.sha256`), 'utf8').trim();
        if (shaA === shaB) {
            console.log(`[DETERMINISM OK] ${ds.name}: ${shaA}`);
        } else {
            console.error(`[DETERMINISM FAIL] ${ds.name}: runA=${shaA} runB=${shaB}`);
            deterministicOk = false;
        }
    }

    const failures = all.filter(r => !r.roundtripOk);
    console.log(`\n=== SUMMARY: ${all.length - failures.length}/${all.length} roundtrip OK, determinism=${deterministicOk ? 'OK' : 'FAIL'} ===`);
    if (failures.length > 0) {
        console.error('Failing datasets:', failures.map(f => `${f.dataset}(${f.run})`).join(', '));
        process.exit(1);
    }
    if (!deterministicOk) process.exit(1);
}

main().catch((e) => {
    console.error('FATAL ERROR IN POSTFREEZE HARNESS', e);
    process.exit(1);
});
