import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import { GICS, type Snapshot, type GenericSnapshot, type SchemaProfile } from '../../src/index.js';

type NormalizedLegacySnapshot = {
    timestamp: number;
    items: Array<[number, { price: number; quantity: number }]>;
};

type NormalizedGenericSnapshot = {
    timestamp: number;
    items: Array<[string | number, Record<string, number | string>]>;
};

function sha256Hex(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex');
}

function normalizeLegacy(snapshots: Snapshot[]): NormalizedLegacySnapshot[] {
    return snapshots.map(s => {
        const items = Array.from(s.items.entries())
            .sort((a, b) => a[0] - b[0]);
        return { timestamp: s.timestamp, items };
    });
}

function normalizeGeneric(snapshots: Array<GenericSnapshot<Record<string, number | string>>>): NormalizedGenericSnapshot[] {
    return snapshots.map(s => {
        const items = Array.from(s.items.entries())
            .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
        return { timestamp: s.timestamp, items };
    });
}

function buildLegacySnapshots(): Snapshot[] {
    const snapshots: Snapshot[] = [];
    let baseTs = 1_700_000_000; // deterministic

    for (let i = 0; i < 48; i++) {
        const ts = baseTs + i * 3600; // hourly
        const items = new Map<number, { price: number; quantity: number }>();

        // Trending
        items.set(1, { price: 10_000 + i * 3, quantity: 1 });
        // Volatile-ish (deterministic)
        items.set(2, { price: 20_000 + ((i * 17) % 101) - 50, quantity: 2 });
        // Sparse
        if (i % 6 === 0) items.set(3, { price: 99_000, quantity: 1 });

        // Extra item to force multi-item / index variety
        if (i % 4 === 0) items.set(10, { price: 1234, quantity: 5 });

        snapshots.push({ timestamp: ts, items });
    }
    return snapshots;
}

function buildTrustEventsSnapshots(schema: SchemaProfile): Array<GenericSnapshot<Record<string, number | string>>> {
    if (schema.itemIdType !== 'string') {
        throw new Error('Expected TRUST_EVENTS schema to use string item IDs');
    }
    const baseTs = 1_700_100_000;
    const keys = ['alice', 'bob', 'charlie'];
    const outcomes = ['approved', 'rejected', 'timeout', 'auto_approved'] as const;

    const out: Array<GenericSnapshot<Record<string, number | string>>> = [];
    for (let i = 0; i < 12; i++) {
        const ts = baseTs + i * 60;
        const items = new Map<string, Record<string, number | string>>();

        // Deterministic item set shape
        const activeKeys = i % 3 === 0 ? keys : keys.slice(0, 2);
        for (let k = 0; k < activeKeys.length; k++) {
            const key = activeKeys[k];
            items.set(key, {
                score: 100 + i + k,
                approvals: (i + k) % 7,
                rejections: (i * 2 + k) % 5,
                failures: (i * 3 + k) % 3,
                streak: (i + 10) % 11,
                outcome: outcomes[(i + k) % outcomes.length],
            });
        }
        out.push({ timestamp: ts, items });
    }
    return out;
}

async function writeFixturePair(args: {
    baseName: string;
    bytes: Uint8Array;
    expected: unknown;
    outDir: string;
}) {
    const binPath = path.join(args.outDir, `${args.baseName}.gics`);
    const jsonPath = path.join(args.outDir, `${args.baseName}.expected.json`);
    await writeFile(binPath, args.bytes);
    await writeFile(jsonPath, JSON.stringify({
        name: args.baseName,
        sha256: sha256Hex(args.bytes),
        expected: args.expected,
    }, null, 2));
}

async function main() {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const outDir = path.resolve(__dirname, '../../tests/fixtures/golden');
    await mkdir(outDir, { recursive: true });

    // 1) Legacy plain
    const legacy = buildLegacySnapshots();
    const legacyPlainBytes = await GICS.pack(legacy, { runId: 'golden_legacy_plain' });
    await writeFixturePair({
        baseName: 'legacy_plain',
        bytes: legacyPlainBytes,
        expected: normalizeLegacy(legacy),
        outDir,
    });

    // 2) Legacy encrypted
    const password = 'correct-horse-battery-staple';
    const legacyEncBytes = await GICS.pack(legacy, { runId: 'golden_legacy_enc', password });
    await writeFixturePair({
        baseName: 'legacy_encrypted',
        bytes: legacyEncBytes,
        expected: normalizeLegacy(legacy),
        outDir,
    });

    // 3) Legacy multi-segment (small segment size)
    const legacyMultiSegBytes = await GICS.pack(legacy, { runId: 'golden_legacy_multiseg', segmentSizeLimit: 800 });
    await writeFixturePair({
        baseName: 'legacy_multisegment',
        bytes: legacyMultiSegBytes,
        expected: normalizeLegacy(legacy),
        outDir,
    });

    // 4) Schema (TRUST_EVENTS) plain
    const trustSchema = GICS.schemas.TRUST_EVENTS;
    const trustSnaps = buildTrustEventsSnapshots(trustSchema);
    const enc = new GICS.Encoder({ runId: 'golden_schema_trust', schema: trustSchema });
    for (const s of trustSnaps) await enc.addSnapshot(s);
    const trustBytes = await enc.finish();
    await writeFixturePair({
        baseName: 'schema_trust_events_plain',
        bytes: trustBytes,
        expected: normalizeGeneric(trustSnaps),
        outDir,
    });

    console.log(`[golden] wrote fixtures to ${outDir}`);
}

try {
    await main();
} catch (err) {
    console.error(err);
    process.exit(1);
}

