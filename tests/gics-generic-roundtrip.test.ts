/**
 * Generic Encoder/Decoder Round-Trip Tests (Fase 4)
 *
 * Tests:
 * 1. Trust schema: encode → getAllGenericSnapshots → identical data
 * 2. Categorical fields: string→numeric→string round-trip
 * 3. String item keys: encode with string IDs → decode with string IDs
 * 4. queryGeneric() with string keys
 * 5. queryGeneric() with numeric keys (legacy)
 * 6. Multi-segment round-trip
 * 7. Legacy files via getAllGenericSnapshots()
 * 8. Schema with no categorical fields
 * 9. Large dataset round-trip (1000 snapshots)
 */
// NOTE: Vitest globals are enabled (see vitest.config.ts). Avoid importing from
// 'vitest' in test files to prevent "No test suite found" issues.
import { GICS } from '../src/index.js';
import type { SchemaProfile, GenericSnapshot } from '../src/index.js';
import { GICSv2Encoder } from '../src/gics/encode.js';
import { GICSv2Decoder } from '../src/gics/decode.js';
import type { Snapshot } from '../src/gics-types.js';

// ── Schemas ─────────────────────────────────────────────────────────────────

const TRUST_SCHEMA: SchemaProfile = {
    id: 'gimo_trust_v1',
    version: 1,
    itemIdType: 'string',
    fields: [
        { name: 'score', type: 'numeric', codecStrategy: 'value' },
        { name: 'approvals', type: 'numeric', codecStrategy: 'structural' },
        { name: 'rejections', type: 'numeric', codecStrategy: 'structural' },
        { name: 'failures', type: 'numeric', codecStrategy: 'structural' },
        { name: 'streak', type: 'numeric', codecStrategy: 'structural' },
        { name: 'outcome', type: 'categorical', enumMap: { approved: 0, rejected: 1, error: 2, timeout: 3, auto_approved: 4 } },
    ],
};

const NUMERIC_SCHEMA: SchemaProfile = {
    id: 'sensor_v1',
    version: 1,
    itemIdType: 'number',
    fields: [
        { name: 'temperature', type: 'numeric', codecStrategy: 'value' },
        { name: 'humidity', type: 'numeric', codecStrategy: 'structural' },
        { name: 'pressure', type: 'numeric', codecStrategy: 'value' },
    ],
};

const MINIMAL_SCHEMA: SchemaProfile = {
    id: 'minimal_v1',
    version: 1,
    itemIdType: 'number',
    fields: [
        { name: 'value', type: 'numeric' },
    ],
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTrustSnapshots(count: number): GenericSnapshot<Record<string, number | string>>[] {
    const base = 1700000000;
    const outcomes = ['approved', 'rejected', 'error', 'timeout', 'auto_approved'];
    const snapshots: GenericSnapshot<Record<string, number | string>>[] = [];

    for (let i = 0; i < count; i++) {
        const items = new Map<string, Record<string, number | string>>();
        items.set('file_write|src/auth.py', {
            score: 850 + (i % 50),
            approvals: 100 + i,
            rejections: 5,
            failures: 2,
            streak: 10 + (i % 20),
            outcome: outcomes[i % outcomes.length],
        });
        items.set('shell_exec|rm -rf /', {
            score: 100,
            approvals: 0,
            rejections: 50 + i,
            failures: 20 + i,
            streak: 0,
            outcome: 'rejected',
        });
        items.set('llm_call|claude-sonnet', {
            score: 950,
            approvals: 200 + i * 2,
            rejections: 1,
            failures: 0,
            streak: 30 + i,
            outcome: 'approved',
        });
        snapshots.push({ timestamp: base + i * 60, items });
    }
    return snapshots;
}

function makeSensorSnapshots(count: number): GenericSnapshot<Record<string, number>>[] {
    const base = 1700000000;
    const snapshots: GenericSnapshot<Record<string, number>>[] = [];

    for (let i = 0; i < count; i++) {
        const items = new Map<number, Record<string, number>>();
        items.set(1, { temperature: 2200 + (i % 100), humidity: 55 + (i % 30), pressure: 101300 + (i % 200) });
        items.set(2, { temperature: 1800 - (i % 50), humidity: 70, pressure: 101100 });
        items.set(3, { temperature: 2500, humidity: 40 + (i % 10), pressure: 101500 - (i % 100) });
        snapshots.push({ timestamp: base + i * 60, items });
    }
    return snapshots;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Generic Encoder/Decoder Round-Trip', () => {

    describe('Trust schema (string keys + categorical)', () => {
        it('round-trips trust snapshots with identical data', async () => {
            const original = makeTrustSnapshots(10);
            const encoder = new GICSv2Encoder({ schema: TRUST_SCHEMA });
            for (const s of original) await encoder.addSnapshot(s);
            const packed = await encoder.finish();

            const decoder = new GICSv2Decoder(packed);
            const decoded = await decoder.getAllGenericSnapshots();

            expect(decoded).toHaveLength(10);

            for (let i = 0; i < original.length; i++) {
                expect(decoded[i].timestamp).toBe(original[i].timestamp);
                expect(decoded[i].items.size).toBe(original[i].items.size);

                for (const [key, origData] of original[i].items) {
                    expect(decoded[i].items.has(key)).toBe(true);
                    const decData = decoded[i].items.get(key)!;
                    for (const field of TRUST_SCHEMA.fields) {
                        expect(decData[field.name]).toBe(origData[field.name]);
                    }
                }
            }
        });

        it('categorical fields round-trip as strings, not numbers', async () => {
            const original = makeTrustSnapshots(5);
            const encoder = new GICSv2Encoder({ schema: TRUST_SCHEMA });
            for (const s of original) await encoder.addSnapshot(s);
            const packed = await encoder.finish();

            const decoder = new GICSv2Decoder(packed);
            const decoded = await decoder.getAllGenericSnapshots();

            // Check specific categorical values
            const firstSnap = decoded[0];
            const authData = firstSnap.items.get('file_write|src/auth.py')!;
            expect(authData.outcome).toBe('approved');
            expect(typeof authData.outcome).toBe('string');

            const shellData = firstSnap.items.get('shell_exec|rm -rf /')!;
            expect(shellData.outcome).toBe('rejected');
        });

        it('string keys are preserved exactly', async () => {
            const original = makeTrustSnapshots(3);
            const encoder = new GICSv2Encoder({ schema: TRUST_SCHEMA });
            for (const s of original) await encoder.addSnapshot(s);
            const packed = await encoder.finish();

            const decoder = new GICSv2Decoder(packed);
            const decoded = await decoder.getAllGenericSnapshots();

            for (const snap of decoded) {
                expect(snap.items.has('file_write|src/auth.py')).toBe(true);
                expect(snap.items.has('shell_exec|rm -rf /')).toBe(true);
                expect(snap.items.has('llm_call|claude-sonnet')).toBe(true);
            }
        });
    });

    describe('Numeric schema (no categorical)', () => {
        it('round-trips sensor data', async () => {
            const original = makeSensorSnapshots(10);
            const encoder = new GICSv2Encoder({ schema: NUMERIC_SCHEMA });
            for (const s of original) await encoder.addSnapshot(s as any);
            const packed = await encoder.finish();

            const decoder = new GICSv2Decoder(packed);
            const decoded = await decoder.getAllGenericSnapshots();

            expect(decoded).toHaveLength(10);
            for (let i = 0; i < original.length; i++) {
                expect(decoded[i].timestamp).toBe(original[i].timestamp);
                expect(decoded[i].items.size).toBe(original[i].items.size);

                for (const [key, origData] of original[i].items) {
                    const decData = decoded[i].items.get(key)!;
                    expect(decData.temperature).toBe(origData.temperature);
                    expect(decData.humidity).toBe(origData.humidity);
                    expect(decData.pressure).toBe(origData.pressure);
                }
            }
        });
    });

    describe('Minimal schema', () => {
        it('single-field schema round-trips', async () => {
            const snaps: GenericSnapshot<Record<string, number>>[] = [];
            for (let i = 0; i < 5; i++) {
                const items = new Map<number, Record<string, number>>();
                items.set(1, { value: 100 + i });
                items.set(2, { value: 200 - i });
                snaps.push({ timestamp: 1700000000 + i * 60, items });
            }

            const encoder = new GICSv2Encoder({ schema: MINIMAL_SCHEMA });
            for (const s of snaps) await encoder.addSnapshot(s as any);
            const packed = await encoder.finish();

            const decoder = new GICSv2Decoder(packed);
            const decoded = await decoder.getAllGenericSnapshots();

            expect(decoded).toHaveLength(5);
            expect(decoded[0].items.get(1)!.value).toBe(100);
            expect(decoded[4].items.get(2)!.value).toBe(196);
        });
    });

    describe('queryGeneric()', () => {
        it('query by string key returns matching snapshots', async () => {
            const original = makeTrustSnapshots(20);
            const encoder = new GICSv2Encoder({ schema: TRUST_SCHEMA });
            for (const s of original) await encoder.addSnapshot(s);
            const packed = await encoder.finish();

            const decoder = new GICSv2Decoder(packed);
            const results = await decoder.queryGeneric('shell_exec|rm -rf /');

            expect(results.length).toBeGreaterThan(0);
            for (const snap of results) {
                expect(snap.items.has('shell_exec|rm -rf /')).toBe(true);
            }
        });

        it('query by numeric key on numeric schema', async () => {
            const original = makeSensorSnapshots(10);
            const encoder = new GICSv2Encoder({ schema: NUMERIC_SCHEMA });
            for (const s of original) await encoder.addSnapshot(s as any);
            const packed = await encoder.finish();

            const decoder = new GICSv2Decoder(packed);
            const results = await decoder.queryGeneric(2);

            expect(results.length).toBeGreaterThan(0);
            for (const snap of results) {
                expect(snap.items.has(2)).toBe(true);
            }
        });

        it('query by non-existent key returns empty', async () => {
            const original = makeTrustSnapshots(5);
            const encoder = new GICSv2Encoder({ schema: TRUST_SCHEMA });
            for (const s of original) await encoder.addSnapshot(s);
            const packed = await encoder.finish();

            const decoder = new GICSv2Decoder(packed);
            const results = await decoder.queryGeneric('nonexistent_key');
            expect(results).toHaveLength(0);
        });
    });

    describe('Legacy compatibility via getAllGenericSnapshots()', () => {
        it('legacy files return { price, quantity } records', async () => {
            const legacySnaps: Snapshot[] = [];
            for (let i = 0; i < 5; i++) {
                const items = new Map<number, { price: number; quantity: number }>();
                items.set(1, { price: 100 + i, quantity: 50 });
                items.set(2, { price: 200, quantity: 30 + i });
                legacySnaps.push({ timestamp: 1700000000 + i * 60, items });
            }

            const packed = await GICS.pack(legacySnaps);
            const decoder = new GICSv2Decoder(packed);
            const decoded = await decoder.getAllGenericSnapshots();

            expect(decoded).toHaveLength(5);
            expect(decoded[0].items.get(1)!.price).toBe(100);
            expect(decoded[0].items.get(1)!.quantity).toBe(50);
        });
    });

    describe('Integrity', () => {
        it('verify() passes on schema-encoded files', async () => {
            const original = makeTrustSnapshots(10);
            const encoder = new GICSv2Encoder({ schema: TRUST_SCHEMA });
            for (const s of original) await encoder.addSnapshot(s);
            const packed = await encoder.finish();

            const valid = await GICS.verify(packed);
            expect(valid).toBe(true);
        });

        it('getAllSnapshots() on legacy files still works', async () => {
            const legacySnaps: Snapshot[] = [];
            for (let i = 0; i < 5; i++) {
                const items = new Map<number, { price: number; quantity: number }>();
                items.set(1, { price: 100 + i, quantity: 50 });
                legacySnaps.push({ timestamp: 1700000000 + i * 60, items });
            }
            const packed = await GICS.pack(legacySnaps);
            const decoder = new GICSv2Decoder(packed);
            const decoded = await decoder.getAllSnapshots();
            expect(decoded).toHaveLength(5);
            expect(decoded[0].items.get(1)!.price).toBe(100);
        });
    });

    describe('Large dataset', () => {
        it('1000 trust snapshots round-trip correctly', async () => {
            const original = makeTrustSnapshots(1000);
            const encoder = new GICSv2Encoder({ schema: TRUST_SCHEMA });
            for (const s of original) await encoder.addSnapshot(s);
            const packed = await encoder.finish();

            const decoder = new GICSv2Decoder(packed);
            const decoded = await decoder.getAllGenericSnapshots();

            expect(decoded).toHaveLength(1000);

            // Spot-check first, middle, last
            for (const idx of [0, 499, 999]) {
                expect(decoded[idx].timestamp).toBe(original[idx].timestamp);
                expect(decoded[idx].items.size).toBe(3);

                const authKey = 'file_write|src/auth.py';
                expect(decoded[idx].items.get(authKey)!.score).toBe(original[idx].items.get(authKey)!.score);
            }
        });
    });
});
