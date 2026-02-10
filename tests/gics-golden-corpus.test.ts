// NOTE: Vitest globals are enabled (see vitest.config.ts). Avoid importing from
// 'vitest' in test files to prevent "No test suite found" issues.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import { GICS } from '../src/index.js';
import { IntegrityError, IncompleteDataError } from '../src/gics/errors.js';

type GoldenFile = {
    name: string;
    sha256: string;
    expected: unknown;
};

function sha256Hex(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex');
}

function normalizeResult(snapshots: any[]): any[] {
    // Normalize Map iteration order for stable deep equality
    return snapshots.map((s: any) => {
        const items = Array.from(s.items.entries())
            .sort((a: any, b: any) => {
                const ka = a[0];
                const kb = b[0];
                if (typeof ka === 'number' && typeof kb === 'number') return ka - kb;
                return String(ka).localeCompare(String(kb));
            });
        return { timestamp: s.timestamp, items };
    });
}

async function loadFixture(name: string): Promise<{ bytes: Uint8Array; json: GoldenFile }> {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const dir = path.resolve(__dirname, 'fixtures/golden');

    const bytes = new Uint8Array(await readFile(path.join(dir, `${name}.gics`)));
    const json = JSON.parse(await readFile(path.join(dir, `${name}.expected.json`), 'utf8')) as GoldenFile;
    return { bytes, json };
}

function flipOneBit(bytes: Uint8Array, offset: number): Uint8Array {
    const copy = new Uint8Array(bytes);
    if (offset >= 0 && offset < copy.length) copy[offset] ^= 0x01;
    return copy;
}

function truncate(bytes: Uint8Array, newLen: number): Uint8Array {
    return bytes.subarray(0, Math.max(0, Math.min(newLen, bytes.length)));
}

describe('GICS v1.3 Golden Corpus', () => {
    it('legacy_plain: sha256 matches, verify ok, unpack matches expected', async () => {
        const { bytes, json } = await loadFixture('legacy_plain');
        expect(sha256Hex(bytes)).toBe(json.sha256);

        await expect(GICS.verify(bytes)).resolves.toBe(true);
        const decoded = await GICS.unpack(bytes);
        expect(normalizeResult(decoded)).toEqual(json.expected);
    });

    it('legacy_multisegment: verify ok, unpack matches expected', async () => {
        const { bytes, json } = await loadFixture('legacy_multisegment');
        await expect(GICS.verify(bytes)).resolves.toBe(true);
        const decoded = await GICS.unpack(bytes);
        expect(normalizeResult(decoded)).toEqual(json.expected);
    });

    it('legacy_encrypted: verify ok, unpack requires password and matches expected', async () => {
        const password = 'correct-horse-battery-staple';
        const { bytes, json } = await loadFixture('legacy_encrypted');

        // verify() does not need password: it validates chain+CRCs without decompression
        await expect(GICS.verify(bytes)).resolves.toBe(true);

        // unpack without password must fail
        await expect(GICS.unpack(bytes)).rejects.toThrow();

        const decoded = await GICS.unpack(bytes, { password });
        expect(normalizeResult(decoded)).toEqual(json.expected);
    });

    it('schema_trust_events_plain: verify ok, schema is readable and generic query works', async () => {
        const { bytes, json } = await loadFixture('schema_trust_events_plain');
        await expect(GICS.verify(bytes)).resolves.toBe(true);

        // Validate schema header is embedded and parseable
        const decoder = new GICS.Decoder(bytes);
        await decoder.parseHeader();
        const schema = decoder.getSchema();
        expect(schema.id).toBe('gimo_trust_v1');

        // Validate queryGeneric path doesn't crash and returns results
        const found = await decoder.queryGeneric('alice');
        expect(found.length).toBeGreaterThan(0);

        // Decode full file as generic and compare to expected fixture
        const generic = await decoder.getAllGenericSnapshots();
        expect(normalizeResult(generic)).toEqual(json.expected);
    });

    it('tamper: 1-bit flip must fail (IntegrityError)', async () => {
        const { bytes } = await loadFixture('legacy_plain');
        const tampered = flipOneBit(bytes, 60);
        await expect(GICS.verify(tampered)).resolves.toBe(false);
        await expect(GICS.unpack(tampered)).rejects.toThrow(IntegrityError);
    });

    it('truncation: missing EOS must fail (IncompleteDataError)', async () => {
        const { bytes } = await loadFixture('legacy_plain');
        const truncated = truncate(bytes, bytes.length - 10);
        await expect(GICS.verify(truncated)).resolves.toBe(false);
        await expect(GICS.unpack(truncated)).rejects.toThrow(IncompleteDataError);
    });

    it('wrong password: encrypted file rejects', async () => {
        const { bytes } = await loadFixture('legacy_encrypted');
        await expect(GICS.unpack(bytes, { password: 'wrong-password' })).rejects.toThrow(IntegrityError);
    });
});
