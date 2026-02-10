/**
 * Schema Profiles — Retrocompatibility Tests
 *
 * Invariants:
 * 1. Files encoded WITHOUT schema produce IDENTICAL bytes to v1.3
 * 2. v1.3 decoder can still read files without schema
 * 3. pack() without schema = exact same pipeline as before
 * 4. New types exist and are well-formed
 */
// NOTE: Vitest globals are enabled (see vitest.config.ts). Avoid importing from
// 'vitest' in test files to prevent "No test suite found" issues.
import { GICS } from '../src/index.js';
import type { Snapshot, SchemaProfile, FieldDef, GenericSnapshot } from '../src/index.js';
import { GICS_FLAGS_V3, SCHEMA_STREAM_BASE, GICS_VERSION_BYTE } from '../src/gics/format.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeSnapshots(count: number): Snapshot[] {
    const base = 1700000000;
    const snapshots: Snapshot[] = [];
    for (let i = 0; i < count; i++) {
        const items = new Map<number, { price: number; quantity: number }>();
        items.set(1, { price: 100 + i, quantity: 50 });
        items.set(2, { price: 200 - i, quantity: 30 });
        items.set(3, { price: 150 + (i % 5), quantity: 10 + i });
        snapshots.push({ timestamp: base + i * 60, items });
    }
    return snapshots;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Schema Profiles — Retrocompatibility', () => {

    describe('Type definitions', () => {
        it('FieldDef has correct shape', () => {
            const field: FieldDef = { name: 'score', type: 'numeric', codecStrategy: 'value' };
            expect(field.name).toBe('score');
            expect(field.type).toBe('numeric');
            expect(field.codecStrategy).toBe('value');
        });

        it('FieldDef supports categorical with enumMap', () => {
            const field: FieldDef = {
                name: 'outcome',
                type: 'categorical',
                enumMap: { approved: 0, rejected: 1, error: 2 },
            };
            expect(field.type).toBe('categorical');
            expect(field.enumMap!.approved).toBe(0);
            expect(field.enumMap!.rejected).toBe(1);
        });

        it('SchemaProfile has correct shape', () => {
            const schema: SchemaProfile = {
                id: 'test_v1',
                version: 1,
                itemIdType: 'string',
                fields: [
                    { name: 'score', type: 'numeric', codecStrategy: 'value' },
                    { name: 'outcome', type: 'categorical', enumMap: { ok: 0, fail: 1 } },
                ],
            };
            expect(schema.id).toBe('test_v1');
            expect(schema.version).toBe(1);
            expect(schema.itemIdType).toBe('string');
            expect(schema.fields).toHaveLength(2);
        });

        it('GenericSnapshot supports custom item types', () => {
            type TrustItem = { score: number; approvals: number };
            const snap: GenericSnapshot<TrustItem> = {
                timestamp: 1700000000,
                items: new Map([['dim_key_1', { score: 85, approvals: 42 }]]),
            };
            expect(snap.items.get('dim_key_1')!.score).toBe(85);
        });

        it('GenericSnapshot default type matches legacy Snapshot', () => {
            const snap: GenericSnapshot = {
                timestamp: 1700000000,
                items: new Map([[1, { price: 100, quantity: 50 }]]),
            };
            expect(snap.items.get(1)!.price).toBe(100);
        });
    });

    describe('Format constants', () => {
        it('HAS_SCHEMA flag is defined and does not conflict', () => {
            expect(GICS_FLAGS_V3.HAS_SCHEMA).toBe(0x04);
            // Must not conflict with ENCRYPTED
            expect(GICS_FLAGS_V3.HAS_SCHEMA & GICS_FLAGS_V3.ENCRYPTED).toBe(0);
        });

        it('SCHEMA_STREAM_BASE is 100', () => {
            expect(SCHEMA_STREAM_BASE).toBe(100);
        });

        it('VERSION_BYTE remains 0x03', () => {
            expect(GICS_VERSION_BYTE).toBe(0x03);
        });
    });

    describe('Predefined schemas', () => {
        it('MARKET_DATA schema exists and has price+quantity', () => {
            const schema = GICS.schemas.MARKET_DATA;
            expect(schema.id).toBe('market_data_v1');
            expect(schema.itemIdType).toBe('number');
            expect(schema.fields).toHaveLength(2);
            expect(schema.fields[0].name).toBe('price');
            expect(schema.fields[1].name).toBe('quantity');
        });

        it('TRUST_EVENTS schema exists with 6 fields', () => {
            const schema = GICS.schemas.TRUST_EVENTS;
            expect(schema.id).toBe('gimo_trust_v1');
            expect(schema.itemIdType).toBe('string');
            expect(schema.fields).toHaveLength(6);
            const outcomeField = schema.fields.find(f => f.name === 'outcome');
            expect(outcomeField!.type).toBe('categorical');
            expect(outcomeField!.enumMap).toBeDefined();
        });
    });

    describe('Byte-identical encoding without schema', () => {
        it('pack() without schema produces identical bytes across two calls', async () => {
            const snapshots = makeSnapshots(20);
            const bytes1 = await GICS.pack(snapshots);
            const bytes2 = await GICS.pack(snapshots);
            expect(bytes1.length).toBe(bytes2.length);
            expect(Buffer.from(bytes1).equals(Buffer.from(bytes2))).toBe(true);
        });

        it('header version byte is 0x03 when no schema', async () => {
            const snapshots = makeSnapshots(5);
            const bytes = await GICS.pack(snapshots);
            // Magic: GICS (4 bytes), then version byte
            expect(bytes[0]).toBe(0x47); // G
            expect(bytes[1]).toBe(0x49); // I
            expect(bytes[2]).toBe(0x43); // C
            expect(bytes[3]).toBe(0x53); // S
            expect(bytes[4]).toBe(0x03); // v1.3
        });

        it('header flags do NOT include HAS_SCHEMA when no schema given', async () => {
            const snapshots = makeSnapshots(5);
            const bytes = await GICS.pack(snapshots);
            const view = new DataView(bytes.buffer, bytes.byteOffset);
            const flags = view.getUint32(5, true);
            expect(flags & GICS_FLAGS_V3.HAS_SCHEMA).toBe(0);
        });
    });

    describe('Round-trip without schema (legacy path)', () => {
        it('encode → decode produces identical data', async () => {
            const snapshots = makeSnapshots(30);
            const packed = await GICS.pack(snapshots);
            const unpacked = await GICS.unpack(packed);
            expect(unpacked).toHaveLength(snapshots.length);
            for (let i = 0; i < snapshots.length; i++) {
                expect(unpacked[i].timestamp).toBe(snapshots[i].timestamp);
                expect(unpacked[i].items.size).toBe(snapshots[i].items.size);
                for (const [id, data] of snapshots[i].items) {
                    const decoded = unpacked[i].items.get(id);
                    expect(decoded).toBeDefined();
                    expect(decoded!.price).toBe(data.price);
                    expect(decoded!.quantity).toBe(data.quantity);
                }
            }
        });

        it('verify() passes on files without schema', async () => {
            const snapshots = makeSnapshots(10);
            const packed = await GICS.pack(snapshots);
            const valid = await GICS.verify(packed);
            expect(valid).toBe(true);
        });

        it('query() works on files without schema', async () => {
            const snapshots = makeSnapshots(10);
            const packed = await GICS.pack(snapshots);
            const decoder = new GICS.Decoder(packed);
            const results = await decoder.query(1);
            expect(results.length).toBeGreaterThan(0);
            for (const snap of results) {
                expect(snap.items.has(1)).toBe(true);
            }
        });
    });
});
