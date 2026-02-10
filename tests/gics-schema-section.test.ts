/**
 * Schema Section Tests (Fase 2)
 *
 * Tests:
 * 1. Encoder with schema → decoder reads same schema via parseHeader()
 * 2. Decoder without schema (v1.3 file) → implicit legacy schema
 * 3. Schema with categorical fields stores and recovers enum maps
 * 4. HAS_SCHEMA flag is set correctly
 * 5. verify() works on files with schema
 */
// NOTE: Vitest globals are enabled (see vitest.config.ts). Avoid importing from
// 'vitest' in test files to prevent "No test suite found" issues.
import { GICS } from '../src/index.js';
import type { Snapshot, SchemaProfile } from '../src/index.js';
import { GICSv2Encoder } from '../src/gics/encode.js';
import { GICSv2Decoder } from '../src/gics/decode.js';
import { GICS_FLAGS_V3 } from '../src/gics/format.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeSnapshots(count: number): Snapshot[] {
    const base = 1700000000;
    const snapshots: Snapshot[] = [];
    for (let i = 0; i < count; i++) {
        const items = new Map<number, { price: number; quantity: number }>();
        items.set(1, { price: 100 + i, quantity: 50 });
        items.set(2, { price: 200 - i, quantity: 30 });
        snapshots.push({ timestamp: base + i * 60, items });
    }
    return snapshots;
}

const TRUST_SCHEMA: SchemaProfile = {
    id: 'test_trust_v1',
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

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Schema Section in Header', () => {

    describe('Schema encoding/decoding round-trip', () => {
        it('encoder with schema → decoder reads same schema via parseHeader()', async () => {
            const snapshots = makeSnapshots(10);
            const encoder = new GICSv2Encoder({ schema: TRUST_SCHEMA });
            for (const s of snapshots) await encoder.addSnapshot(s);
            const packed = await encoder.finish();

            const decoder = new GICSv2Decoder(packed);
            await decoder.parseHeader();
            const schema = decoder.getSchema();

            expect(schema.id).toBe('test_trust_v1');
            expect(schema.version).toBe(1);
            expect(schema.itemIdType).toBe('string');
            expect(schema.fields).toHaveLength(6);
        });

        it('schema with categorical field preserves enum map', async () => {
            const snapshots = makeSnapshots(5);
            const encoder = new GICSv2Encoder({ schema: TRUST_SCHEMA });
            for (const s of snapshots) await encoder.addSnapshot(s);
            const packed = await encoder.finish();

            const decoder = new GICSv2Decoder(packed);
            await decoder.parseHeader();
            const schema = decoder.getSchema();

            const outcomeField = schema.fields.find(f => f.name === 'outcome');
            expect(outcomeField).toBeDefined();
            expect(outcomeField!.type).toBe('categorical');
            expect(outcomeField!.enumMap).toBeDefined();
            expect(outcomeField!.enumMap!.approved).toBe(0);
            expect(outcomeField!.enumMap!.rejected).toBe(1);
            expect(outcomeField!.enumMap!.auto_approved).toBe(4);
        });

        it('all field properties survive round-trip', async () => {
            const schema: SchemaProfile = {
                id: 'detailed_test',
                version: 3,
                itemIdType: 'number',
                fields: [
                    { name: 'alpha', type: 'numeric', codecStrategy: 'time' },
                    { name: 'beta', type: 'numeric', codecStrategy: 'value' },
                    { name: 'gamma', type: 'numeric', codecStrategy: 'structural' },
                    { name: 'delta', type: 'numeric' }, // no codecStrategy = auto-detect
                    { name: 'status', type: 'categorical', enumMap: { active: 0, inactive: 1 } },
                ],
            };

            const snapshots = makeSnapshots(5);
            const encoder = new GICSv2Encoder({ schema });
            for (const s of snapshots) await encoder.addSnapshot(s);
            const packed = await encoder.finish();

            const decoder = new GICSv2Decoder(packed);
            await decoder.parseHeader();
            const decoded = decoder.getSchema();

            expect(decoded.id).toBe('detailed_test');
            expect(decoded.version).toBe(3);
            expect(decoded.fields).toHaveLength(5);
            expect(decoded.fields[0].codecStrategy).toBe('time');
            expect(decoded.fields[3].codecStrategy).toBeUndefined();
            expect(decoded.fields[4].enumMap).toEqual({ active: 0, inactive: 1 });
        });
    });

    describe('Legacy files (no schema)', () => {
        it('decoder returns legacy schema for v1.3 files without HAS_SCHEMA', async () => {
            const snapshots = makeSnapshots(5);
            const packed = await GICS.pack(snapshots); // no schema

            const decoder = new GICSv2Decoder(packed);
            await decoder.parseHeader();
            const schema = decoder.getSchema();

            expect(schema.id).toBe('legacy_market_data');
            expect(schema.itemIdType).toBe('number');
            expect(schema.fields).toHaveLength(2);
            expect(schema.fields[0].name).toBe('price');
            expect(schema.fields[1].name).toBe('quantity');
        });
    });

    describe('Header flags', () => {
        it('HAS_SCHEMA flag is set when schema provided', async () => {
            const snapshots = makeSnapshots(5);
            const encoder = new GICSv2Encoder({ schema: TRUST_SCHEMA });
            for (const s of snapshots) await encoder.addSnapshot(s);
            const packed = await encoder.finish();

            const view = new DataView(packed.buffer, packed.byteOffset);
            const flags = view.getUint32(5, true);
            expect(flags & GICS_FLAGS_V3.HAS_SCHEMA).toBe(GICS_FLAGS_V3.HAS_SCHEMA);
        });

        it('HAS_SCHEMA flag is NOT set without schema', async () => {
            const snapshots = makeSnapshots(5);
            const packed = await GICS.pack(snapshots);

            const view = new DataView(packed.buffer, packed.byteOffset);
            const flags = view.getUint32(5, true);
            expect(flags & GICS_FLAGS_V3.HAS_SCHEMA).toBe(0);
        });
    });

    describe('Integrity', () => {
        it('verify() passes on files with schema', async () => {
            const snapshots = makeSnapshots(10);
            const encoder = new GICSv2Encoder({ schema: TRUST_SCHEMA });
            for (const s of snapshots) await encoder.addSnapshot(s);
            const packed = await encoder.finish();

            const valid = await GICS.verify(packed);
            expect(valid).toBe(true);
        });
    });
});
