import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { tmpdir } from 'node:os';
import { GICS } from '../../src/index.js';
import { SegmentHeader } from '../../src/gics/segment.js';
import { FILE_EOS_SIZE, GICS_ENC_HEADER_SIZE_V3, GICS_FLAGS_V3, GICS_HEADER_SIZE_V3 } from '../../src/gics/format.js';

type Snapshot = {
    timestamp: number;
    items: Map<number, { price: number; quantity: number }>;
};

type Scenario = 'single_file_streaming' | 'rotator_adaptive';
type RawBytesMode = 'exact' | 'sampled' | 'off';
type VerifyMode = 'full' | 'skipped';

type RuntimeOptions = {
    rawBytesMode: RawBytesMode;
    verify: boolean;
    scenarios: Scenario[];
    maxSnapshots: number;
};

type ScenarioResult = {
    scenario: Scenario;
    years: number;
    snapshots: number;
    snapshotsPerDay: number;
    itemCount: number;
    rawJsonBytes: number;
    encodedBytes: number;
    ratioX: number;
    encodeMs: number;
    peakHeapUsedBytes: number;
    segmentCount: number;
    fileCount: number;
    verifyOk: boolean;
    verifyMode: VerifyMode;
    breachReasons: Record<string, number>;
};

type ForensicsReport = {
    timestampUtc: string;
    config: {
        years: number;
        snapshotsPerDay: number;
        itemCounts: number[];
        flushEvery: number;
        peakHeapLimitMB: number;
        rawBytesMode: RawBytesMode;
        verify: boolean;
        scenarios: Scenario[];
        maxSnapshots: number;
    };
    results: ScenarioResult[];
};

function parseItemCounts(): number[] {
    const listRaw = process.env.GICS_FORENSICS_ITEMS_LIST
        ?? process.env.GICS_FORENSICS_ITEMS
        ?? '1024,4096,10000';
    return listRaw
        .split(',')
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isFinite(value) && value > 0);
}

function parseRuntimeOptions(): RuntimeOptions {
    const fastMode = (process.env.GICS_FORENSICS_FAST ?? '0') !== '0';
    const rawModeRaw = (process.env.GICS_FORENSICS_RAW_MODE ?? (fastMode ? 'sampled' : 'exact')).toLowerCase();
    const rawBytesMode: RawBytesMode = rawModeRaw === 'off' || rawModeRaw === 'exact' || rawModeRaw === 'sampled'
        ? rawModeRaw
        : 'exact';

    const verify = process.env.GICS_FORENSICS_VERIFY
        ? process.env.GICS_FORENSICS_VERIFY !== '0'
        : !fastMode;

    const scenarioRaw = process.env.GICS_FORENSICS_SCENARIOS ?? (fastMode ? 'rotator_adaptive' : 'single_file_streaming,rotator_adaptive');
    const scenarios = scenarioRaw
        .split(',')
        .map((value) => value.trim())
        .filter((value): value is Scenario => value === 'single_file_streaming' || value === 'rotator_adaptive');

    const uniqueScenarios = Array.from(new Set(scenarios));
    if (uniqueScenarios.length === 0) {
        throw new Error('No valid scenarios requested. Use single_file_streaming and/or rotator_adaptive.');
    }

    const maxSnapshots = Number(process.env.GICS_FORENSICS_MAX_SNAPSHOTS ?? '0');
    return {
        rawBytesMode,
        verify,
        scenarios: uniqueScenarios,
        maxSnapshots: Number.isFinite(maxSnapshots) && maxSnapshots > 0 ? Math.floor(maxSnapshots) : 0,
    };
}

function createGenerator(itemCount: number) {
    const prices = new Array<number>(itemCount);
    const quantities = new Array<number>(itemCount);
    const drifts = new Array<number>(itemCount);

    for (let i = 0; i < itemCount; i++) {
        prices[i] = 500_000 + i * 13;
        quantities[i] = 1 + (i % 80);
        drifts[i] = ((i % 15) - 7) * 0.02;
    }

    let marketBias = 0;
    let timestamp = Date.UTC(2020, 0, 1, 0, 0, 0);

    return (index: number, snapshotsPerDay: number): Snapshot => {
        marketBias += (index % 11 === 0 ? 1 : 0) - (index % 17 === 0 ? 1 : 0);
        timestamp += Math.floor((24 * 60 * 60 * 1000) / snapshotsPerDay);

        const items = new Map<number, { price: number; quantity: number }>();
        for (let i = 0; i < itemCount; i++) {
            const seasonal = Math.round(Math.sin((index / snapshotsPerDay) + (i % 29)) * 3);
            const micro = ((index + i) % 7) - 3;
            const drift = Math.round(drifts[i] * index * 0.01);
            prices[i] += marketBias + seasonal + micro + drift;

            if (index % 29 === 0 && i % 13 === 0) {
                quantities[i] += 1;
            } else if (index % 47 === 0 && i % 31 === 0) {
                quantities[i] = Math.max(1, quantities[i] - 1);
            }
            items.set(i + 1, { price: prices[i], quantity: quantities[i] });
        }
        return { timestamp, items };
    };
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

function updateRawBytesEstimate(
    mode: RawBytesMode,
    state: { rawJsonBytes: number; sampledSnapshotBytes: number | null; },
    snapshot: Snapshot,
    index: number
): void {
    if (mode === 'off') {
        return;
    }

    if (mode === 'exact') {
        state.rawJsonBytes += estimatePlainSnapshotBytes(snapshot);
        if (index > 0) state.rawJsonBytes += 1;
        return;
    }

    if (state.sampledSnapshotBytes === null) {
        state.sampledSnapshotBytes = estimatePlainSnapshotBytes(snapshot);
        state.rawJsonBytes = 2;
    }
    state.rawJsonBytes += state.sampledSnapshotBytes;
    if (index > 0) state.rawJsonBytes += 1;
}

function countSegmentsFromData(encoded: Uint8Array): number {
    if (encoded.length < GICS_HEADER_SIZE_V3 + FILE_EOS_SIZE) {
        return 0;
    }
    const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);
    const flags = view.getUint32(5, true);
    let pos = GICS_HEADER_SIZE_V3;
    if ((flags & GICS_FLAGS_V3.ENCRYPTED) !== 0) {
        pos += GICS_ENC_HEADER_SIZE_V3;
    }
    if ((flags & GICS_FLAGS_V3.HAS_SCHEMA) !== 0) {
        if (pos + 4 > encoded.length - FILE_EOS_SIZE) {
            return 0;
        }
        const schemaLen = view.getUint32(pos, true);
        pos += 4 + schemaLen;
    }

    const dataEnd = encoded.length - FILE_EOS_SIZE;
    let count = 0;
    while (pos + 14 <= dataEnd) {
        const header = SegmentHeader.deserialize(encoded.subarray(pos, pos + 14));
        if (header.totalLength <= 0 || pos + header.totalLength > dataEnd) {
            break;
        }
        count++;
        pos += header.totalLength;
    }
    return count;
}

async function runSingleFileScenario(params: {
    years: number;
    snapshotsPerDay: number;
    itemCount: number;
    flushEvery: number;
    rawBytesMode: RawBytesMode;
    verify: boolean;
    maxSnapshots: number;
}): Promise<ScenarioResult> {
    const requestedSnapshots = params.years * 365 * params.snapshotsPerDay;
    const snapshots = params.maxSnapshots > 0 ? Math.min(requestedSnapshots, params.maxSnapshots) : requestedSnapshots;
    const nextSnapshot = createGenerator(params.itemCount);
    const tempFilePath = path.join(tmpdir(), `gics-forensics-single-${Date.now()}-${params.itemCount}.gics`);
    const handle = await fs.promises.open(tempFilePath, 'w+');
    const encoder = await GICS.Encoder.openFile(handle, {
        preset: 'balanced',
        autoFlushThreshold: params.flushEvery,
        minSnapshotsPerSegment: Math.max(params.flushEvery, 256),
        maxSnapshotsPerSegment: Math.max(params.flushEvery, 1024),
        maxItemsPerSegment: Math.max(1_000_000, params.flushEvery * params.itemCount),
    });

    const rawState = { rawJsonBytes: params.rawBytesMode === 'off' ? 0 : 2, sampledSnapshotBytes: null as number | null };
    let peakHeap = 0;
    const started = performance.now();
    try {
        for (let index = 0; index < snapshots; index++) {
            const snapshot = nextSnapshot(index, params.snapshotsPerDay);
            updateRawBytesEstimate(params.rawBytesMode, rawState, snapshot, index);
            await encoder.addSnapshot(snapshot);
            peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
        }
        await encoder.sealToFile();
    } finally {
        await handle.close().catch(() => {});
    }
    const encodeMs = performance.now() - started;
    const encoded = await fs.promises.readFile(tempFilePath);
    await fs.promises.unlink(tempFilePath).catch(() => {});

    const verifyOk = params.verify ? await GICS.verify(encoded) : true;
    const rawJsonBytes = rawState.rawJsonBytes;

    return {
        scenario: 'single_file_streaming',
        years: params.years,
        snapshots,
        snapshotsPerDay: params.snapshotsPerDay,
        itemCount: params.itemCount,
        rawJsonBytes,
        encodedBytes: encoded.length,
        ratioX: rawJsonBytes / Math.max(1, encoded.length),
        encodeMs,
        peakHeapUsedBytes: peakHeap,
        segmentCount: countSegmentsFromData(encoded),
        fileCount: 1,
        verifyOk,
        verifyMode: params.verify ? 'full' : 'skipped',
        breachReasons: {},
    };
}

async function runRotatorScenario(params: {
    years: number;
    snapshotsPerDay: number;
    itemCount: number;
    flushEvery: number;
    rawBytesMode: RawBytesMode;
    verify: boolean;
    maxSnapshots: number;
}): Promise<ScenarioResult> {
    const requestedSnapshots = params.years * 365 * params.snapshotsPerDay;
    const snapshots = params.maxSnapshots > 0 ? Math.min(requestedSnapshots, params.maxSnapshots) : requestedSnapshots;
    const nextSnapshot = createGenerator(params.itemCount);
    const sessionDir = await fs.promises.mkdtemp(path.join(tmpdir(), 'gics-forensics-rotator-'));
    const manifestPath = path.join(sessionDir, 'forensics.manifest.json');
    const rotator = await GICS.RotatingEncoder.create({
        sessionDir,
        sessionId: 'forensics',
        manifestPath,
        flushEverySnapshots: params.flushEvery,
        maxFileBytes: Number(process.env.GICS_FORENSICS_ROTATOR_MAX_FILE_MB ?? '256') * 1024 * 1024,
        maxSnapshotsPerFile: Number(process.env.GICS_FORENSICS_ROTATOR_MAX_SNAPSHOTS ?? '1000000'),
        maxSegmentsPerFile: Number(process.env.GICS_FORENSICS_ROTATOR_MAX_SEGMENTS ?? '4096'),
        maxFileDurationMs: Number(process.env.GICS_FORENSICS_ROTATOR_MAX_DURATION_MS ?? String(24 * 60 * 60 * 1000)),
        adaptive: {
            enabled: (process.env.GICS_FORENSICS_ROTATOR_ADAPTIVE ?? '1') !== '0',
            ewmaAlpha: Number(process.env.GICS_FORENSICS_ROTATOR_EWMA_ALPHA ?? '0.25'),
            latencyPerSnapshotUsBudget: Number(process.env.GICS_FORENSICS_ROTATOR_LAT_US ?? '4000'),
            ratioDropPct: Number(process.env.GICS_FORENSICS_ROTATOR_RATIO_DROP_PCT ?? '25'),
            heapHighWaterMB: Number(process.env.GICS_FORENSICS_ROTATOR_HEAP_MB ?? '768'),
            consecutiveBreachesToRotate: Number(process.env.GICS_FORENSICS_ROTATOR_BREACHES ?? '3'),
            cooldownFlushes: Number(process.env.GICS_FORENSICS_ROTATOR_COOLDOWN ?? '2'),
        },
        encoderOptions: {
            preset: 'balanced',
            minSnapshotsPerSegment: Math.max(params.flushEvery, 256),
            maxSnapshotsPerSegment: Math.max(params.flushEvery, 1024),
            maxItemsPerSegment: Math.max(1_000_000, params.flushEvery * params.itemCount),
        },
    });

    const rawState = { rawJsonBytes: params.rawBytesMode === 'off' ? 0 : 2, sampledSnapshotBytes: null as number | null };
    let peakHeap = 0;
    const started = performance.now();
    for (let index = 0; index < snapshots; index++) {
        const snapshot = nextSnapshot(index, params.snapshotsPerDay);
        updateRawBytesEstimate(params.rawBytesMode, rawState, snapshot, index);
        await rotator.addSnapshot(snapshot);
        peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
    }
    const manifest = await rotator.seal();
    const encodeMs = performance.now() - started;

    const committed = manifest.files.filter((entry) => !entry.orphaned);
    const encodedBytes = committed.reduce((sum, entry) => sum + entry.bytes, 0);
    const segmentCount = committed.reduce((sum, entry) => sum + entry.segmentCount, 0);
    const verifyOk = params.verify ? await GICS.verifySession(manifestPath) : true;
    const reasons = rotator.getRotationReasonCounts();
    const rawJsonBytes = rawState.rawJsonBytes;

    await fs.promises.rm(sessionDir, { recursive: true, force: true }).catch(() => {});

    return {
        scenario: 'rotator_adaptive',
        years: params.years,
        snapshots,
        snapshotsPerDay: params.snapshotsPerDay,
        itemCount: params.itemCount,
        rawJsonBytes,
        encodedBytes,
        ratioX: rawJsonBytes / Math.max(1, encodedBytes),
        encodeMs,
        peakHeapUsedBytes: peakHeap,
        segmentCount,
        fileCount: committed.length,
        verifyOk,
        verifyMode: params.verify ? 'full' : 'skipped',
        breachReasons: reasons,
    };
}

async function main(): Promise<void> {
    const years = Number(process.env.GICS_FORENSICS_YEARS ?? '20');
    const snapshotsPerDay = Number(process.env.GICS_FORENSICS_SNAPSHOTS_PER_DAY ?? '24');
    const flushEvery = Number(process.env.GICS_FORENSICS_FLUSH_EVERY ?? '1024');
    const maxPeakHeapMB = Number(process.env.GICS_FORENSICS_MAX_PEAK_HEAP_MB ?? '200');
    const itemCounts = parseItemCounts();
    const runtime = parseRuntimeOptions();
    const results: ScenarioResult[] = [];

    for (const itemCount of itemCounts) {
        if (runtime.scenarios.includes('single_file_streaming')) {
            console.log(`Running forensics single-file for ${years}y / ${itemCount} items...`);
            results.push(await runSingleFileScenario({
                years,
                snapshotsPerDay,
                itemCount,
                flushEvery,
                rawBytesMode: runtime.rawBytesMode,
                verify: runtime.verify,
                maxSnapshots: runtime.maxSnapshots,
            }));
        }
        if (runtime.scenarios.includes('rotator_adaptive')) {
            console.log(`Running forensics rotator for ${years}y / ${itemCount} items...`);
            results.push(await runRotatorScenario({
                years,
                snapshotsPerDay,
                itemCount,
                flushEvery,
                rawBytesMode: runtime.rawBytesMode,
                verify: runtime.verify,
                maxSnapshots: runtime.maxSnapshots,
            }));
        }
    }

    const report: ForensicsReport = {
        timestampUtc: new Date().toISOString(),
        config: {
            years,
            snapshotsPerDay,
            itemCounts,
            flushEvery,
            peakHeapLimitMB: maxPeakHeapMB,
            rawBytesMode: runtime.rawBytesMode,
            verify: runtime.verify,
            scenarios: runtime.scenarios,
            maxSnapshots: runtime.maxSnapshots,
        },
        results,
    };

    const latestDir = path.join(process.cwd(), 'bench', 'results', 'latest');
    fs.mkdirSync(latestDir, { recursive: true });
    const outPath = path.join(latestDir, 'long-horizon-forensics.json');
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

    const summary = results.map((result) => ({
        scenario: result.scenario,
        itemCount: result.itemCount,
        ratioX: Number(result.ratioX.toFixed(2)),
        fileCount: result.fileCount,
        segmentCount: result.segmentCount,
        verifyOk: result.verifyOk,
        verifyMode: result.verifyMode,
        peakHeapMB: Number((result.peakHeapUsedBytes / 1024 / 1024).toFixed(1)),
        encodeSec: Number((result.encodeMs / 1000).toFixed(1)),
    }));
    console.log(`Long-horizon forensics written to ${outPath}`);
    console.log(JSON.stringify(summary, null, 2));

    for (const result of results) {
        const heapMb = result.peakHeapUsedBytes / 1024 / 1024;
        if (heapMb > maxPeakHeapMB) {
            throw new Error(
                `${result.scenario}/${result.itemCount}: peak heap ${heapMb.toFixed(1)} MB exceeded threshold ${maxPeakHeapMB.toFixed(1)} MB.`,
            );
        }
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
