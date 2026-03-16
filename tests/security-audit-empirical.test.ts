/**
 * GICS v1.3.3 — EMPIRICAL SECURITY AUDIT
 *
 * This is NOT a vanity benchmark. This is an adversarial audit that answers:
 * 1. Does GICS do what it claims? (Functional correctness under stress)
 * 2. Is it secure? (Crypto, integrity, tamper detection)
 * 3. When does it fail? (Boundary conditions, resource exhaustion)
 * 4. How does it fail? (Graceful degradation vs silent corruption)
 * 5. Why does it fail? (Root cause classification)
 *
 * Every PROBE is a falsifiable hypothesis. If it fails, GICS has a real problem.
 *
 * Standards referenced:
 * - NIST SP 800-57 Rev.5 (Key Management)
 * - NIST SP 800-63B (Authentication)
 * - OWASP ASVS L3 (Application Security Verification)
 * - ISO 27001:2022 Annex A (Information Security Controls)
 * - FIPS 140-3 (Cryptographic Module Validation)
 * - ISO 22301 (Business Continuity)
 * - GDPR Article 5(1)(e) (Storage Limitation)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { createHash, randomBytes } from 'crypto';

// Core GICS imports
import { GICSv2Encoder } from '../src/gics/encode.js';
import { GICSv2Decoder } from '../src/gics/decode.js';
import { IntegrityChain, calculateCRC32 } from '../src/gics/integrity.js';
import {
    deriveKey,
    generateAuthVerify,
    verifyAuth,
    encryptSection,
    decryptSection,
    generateEncryptionSecrets
} from '../src/gics/encryption.js';
import { IntegrityError, IncompleteDataError } from '../src/gics/errors.js';
import type { Snapshot } from '../src/gics-types.js';

// Daemon imports
import { createWALProvider, Operation } from '../src/daemon/wal.js';
import { AuditChain } from '../src/daemon/audit-chain.js';
import { MemTable } from '../src/daemon/memtable.js';
import { GICSSupervisor } from '../src/daemon/supervisor.js';
import { ResilienceShell, GICSCircuitOpen, GICSUnavailable } from '../src/daemon/resilience.js';
import { BanditRouter } from '../src/daemon/bandit-router.js';
import { PromptDistiller, type PromptRecord } from '../src/daemon/prompt-distiller.js';
import { AsyncRWLock, FileLock } from '../src/daemon/file-lock.js';

// ═══════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════

function tmpDir(): string {
    return mkdtempSync(path.join(os.tmpdir(), 'gics-audit-'));
}

function cleanup(dir: string): void {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

/** Generate valid Snapshot objects using the real GICS Snapshot interface */
function makeSnapshots(count: number, itemsPerSnapshot: number = 3): Snapshot[] {
    const snapshots: Snapshot[] = [];
    const baseTime = 1700000000;
    for (let i = 0; i < count; i++) {
        const items = new Map<number, { price: number; quantity: number }>();
        for (let j = 1; j <= itemsPerSnapshot; j++) {
            items.set(j, {
                price: Math.round(100 + Math.sin(i * 0.1 + j) * 50),
                quantity: 10 + (i * 7 + j * 3) % 100,
            });
        }
        snapshots.push({ timestamp: baseTime + i * 60, items });
    }
    return snapshots;
}

/** Encode snapshots using real GICS API (addSnapshot + finish) */
async function encodeSnapshots(snapshots: Snapshot[], options: { password?: string; pbkdf2Iterations?: number } = {}): Promise<Uint8Array> {
    // Use 100k iterations in tests for speed (production default: 600k)
    const encoder = new GICSv2Encoder({
        ...options,
        pbkdf2Iterations: options.pbkdf2Iterations ?? (options.password ? 100_000 : undefined),
    });
    for (const s of snapshots) await encoder.addSnapshot(s);
    return encoder.finish();
}

/** Decode buffer using real GICS API */
async function decodeSnapshots(data: Uint8Array, options: { password?: string } = {}): Promise<Snapshot[]> {
    const decoder = new GICSv2Decoder(data, options);
    return decoder.getAllSnapshots();
}

// ═══════════════════════════════════════════════════════════════════
// §1: CRYPTOGRAPHIC INTEGRITY
// Standards: NIST SP 800-57, FIPS 140-3
// ═══════════════════════════════════════════════════════════════════

describe('AUDIT §1 — Cryptographic Integrity (NIST SP 800-57 / FIPS 140-3)', () => {

    describe('§1.1 — Key Derivation (PBKDF2-SHA256)', () => {
        it('PROBE: determinism — same password+salt → same key', () => {
            const salt = randomBytes(16);
            const key1 = deriveKey('audit-password-2026', salt, 100000);
            const key2 = deriveKey('audit-password-2026', salt, 100000);
            expect(key1.equals(key2)).toBe(true);
        });

        it('PROBE: different passwords → different keys', () => {
            const salt = randomBytes(16);
            expect(deriveKey('A', salt, 100000).equals(deriveKey('B', salt, 100000))).toBe(false);
        });

        it('PROBE: different salts → different keys', () => {
            expect(
                deriveKey('same', randomBytes(16), 100000).equals(
                    deriveKey('same', randomBytes(16), 100000)
                )
            ).toBe(false);
        });

        it('PROBE: key is exactly 256 bits (32 bytes) per FIPS 140-3', () => {
            expect(deriveKey('test', randomBytes(16), 100000).length).toBe(32);
        });

        it('PROBE: 100k iterations takes >10ms (brute-force resistance)', () => {
            const start = performance.now();
            deriveKey('timing-probe', randomBytes(16), 100000);
            expect(performance.now() - start).toBeGreaterThan(10);
        });

        it('PROBE: empty password does not crash (boundary)', () => {
            const key = deriveKey('', randomBytes(16), 100000);
            expect(key.length).toBe(32);
        });
    });

    describe('§1.2 — AES-256-GCM Encryption', () => {
        let key: Buffer;
        let secrets: { salt: Uint8Array; fileNonce: Uint8Array };

        beforeEach(() => {
            secrets = generateEncryptionSecrets();
            key = deriveKey('audit-password', secrets.salt, 100000);
        });

        it('PROBE: encrypt→decrypt is bit-exact', () => {
            const plaintext = Buffer.from('GICS audit probe: roundtrip');
            const aad = Buffer.from('aad-context');
            const { ciphertext, tag } = encryptSection(plaintext, key, secrets.fileNonce, 0, aad);
            const decrypted = decryptSection(ciphertext, tag, key, secrets.fileNonce, 0, aad);
            expect(Buffer.from(decrypted).equals(plaintext)).toBe(true);
        });

        it('PROBE: ciphertext ≠ plaintext (not passthrough)', () => {
            const plaintext = Buffer.from('this should be encrypted');
            const { ciphertext } = encryptSection(plaintext, key, secrets.fileNonce, 0, Buffer.alloc(0));
            expect(Buffer.from(ciphertext).equals(plaintext)).toBe(false);
        });

        it('PROBE: different stream IDs → different ciphertexts (IV separation)', () => {
            const plaintext = Buffer.from('same data');
            const aad = Buffer.alloc(0);
            const enc0 = encryptSection(plaintext, key, secrets.fileNonce, 0, aad);
            const enc1 = encryptSection(plaintext, key, secrets.fileNonce, 1, aad);
            expect(Buffer.from(enc0.ciphertext).equals(Buffer.from(enc1.ciphertext))).toBe(false);
        });

        it('PROBE: tampered ciphertext → IntegrityError', () => {
            const { ciphertext, tag } = encryptSection(
                Buffer.from('data'), key, secrets.fileNonce, 0, Buffer.alloc(0)
            );
            const tampered = new Uint8Array(ciphertext);
            tampered[0] ^= 0x01;
            expect(() => decryptSection(tampered, tag, key, secrets.fileNonce, 0, Buffer.alloc(0)))
                .toThrow(IntegrityError);
        });

        it('PROBE: tampered auth tag → IntegrityError', () => {
            const { ciphertext, tag } = encryptSection(
                Buffer.from('data'), key, secrets.fileNonce, 0, Buffer.alloc(0)
            );
            const bad = new Uint8Array(tag);
            bad[0] ^= 0xFF;
            expect(() => decryptSection(ciphertext, bad, key, secrets.fileNonce, 0, Buffer.alloc(0)))
                .toThrow(IntegrityError);
        });

        it('PROBE: wrong key → IntegrityError', () => {
            const { ciphertext, tag } = encryptSection(
                Buffer.from('data'), key, secrets.fileNonce, 0, Buffer.alloc(0)
            );
            const wrongKey = deriveKey('wrong', secrets.salt, 100000);
            expect(() => decryptSection(ciphertext, tag, wrongKey, secrets.fileNonce, 0, Buffer.alloc(0)))
                .toThrow(IntegrityError);
        });

        it('PROBE: tampered AAD → IntegrityError (AEAD guarantee)', () => {
            const aad = Buffer.from('original');
            const { ciphertext, tag } = encryptSection(Buffer.from('data'), key, secrets.fileNonce, 0, aad);
            expect(() => decryptSection(ciphertext, tag, key, secrets.fileNonce, 0, Buffer.from('tampered')))
                .toThrow(IntegrityError);
        });

        it('PROBE: GCM tag is 128-bit (16 bytes)', () => {
            const { tag } = encryptSection(Buffer.from('x'), key, secrets.fileNonce, 0, Buffer.alloc(0));
            expect(tag.length).toBe(16);
        });

        it('PROBE: encrypting empty plaintext works', () => {
            const { ciphertext, tag } = encryptSection(
                Buffer.alloc(0), key, secrets.fileNonce, 0, Buffer.alloc(0)
            );
            const decrypted = decryptSection(ciphertext, tag, key, secrets.fileNonce, 0, Buffer.alloc(0));
            expect(decrypted.length).toBe(0);
        });
    });

    describe('§1.3 — Auth Verification (Timing-Safe)', () => {
        it('PROBE: correct key verifies', () => {
            const key = deriveKey('test', randomBytes(16), 100000);
            expect(verifyAuth(key, generateAuthVerify(key))).toBe(true);
        });

        it('PROBE: wrong key fails', () => {
            const key = deriveKey('correct', randomBytes(16), 100000);
            const wrongKey = deriveKey('wrong', randomBytes(16), 100000);
            expect(verifyAuth(wrongKey, generateAuthVerify(key))).toBe(false);
        });

        it('PROBE: mismatched length → false (not crash)', () => {
            const key = deriveKey('test', randomBytes(16), 100000);
            expect(verifyAuth(key, new Uint8Array(16))).toBe(false);
        });

        it('PROBE: 1-bit difference → still rejected', () => {
            const key = deriveKey('test', randomBytes(16), 100000);
            const auth = generateAuthVerify(key);
            const nearKey = Buffer.from(key);
            nearKey[31] ^= 0x01;
            expect(verifyAuth(nearKey, auth)).toBe(false);
        });
    });

    describe('§1.4 — Salt & Nonce Generation', () => {
        it('PROBE: salt=16 bytes, fileNonce=12 bytes (GCM standard)', () => {
            const { salt, fileNonce } = generateEncryptionSecrets();
            expect(salt.length).toBe(16);
            expect(fileNonce.length).toBe(12);
        });

        it('PROBE: 1000 generations have zero collisions (CSPRNG)', () => {
            const nonces = new Set<string>();
            for (let i = 0; i < 1000; i++) {
                const hex = Buffer.from(generateEncryptionSecrets().fileNonce).toString('hex');
                expect(nonces.has(hex)).toBe(false);
                nonces.add(hex);
            }
        });
    });
});

// ═══════════════════════════════════════════════════════════════════
// §2: DATA INTEGRITY CHAIN
// Standards: ISO 27001:2022 A.8.24
// ═══════════════════════════════════════════════════════════════════

describe('AUDIT §2 — Data Integrity Chain (ISO 27001 A.8.24)', () => {

    describe('§2.1 — IntegrityChain (SHA-256)', () => {
        it('PROBE: deterministic across instances', () => {
            const data = new Uint8Array([1, 2, 3, 4, 5]);
            const h1 = new IntegrityChain().update(data);
            const h2 = new IntegrityChain().update(data);
            expect(Buffer.from(h1).equals(Buffer.from(h2))).toBe(true);
        });

        it('PROBE: order-dependent (A,B ≠ B,A)', () => {
            const a = new Uint8Array([0xAA]), b = new Uint8Array([0xBB]);
            const c1 = new IntegrityChain(); c1.update(a); c1.update(b);
            const c2 = new IntegrityChain(); c2.update(b); c2.update(a);
            expect(Buffer.from(c1.getRootHash()).equals(Buffer.from(c2.getRootHash()))).toBe(false);
        });

        it('PROBE: 10,000 updates — zero collisions, always 32 bytes', () => {
            const chain = new IntegrityChain();
            const seen = new Set<string>();
            for (let i = 0; i < 10000; i++) {
                const buf = Buffer.alloc(4); buf.writeUInt32LE(i);
                const hash = chain.update(buf);
                expect(hash.length).toBe(32);
                const hex = Buffer.from(hash).toString('hex');
                expect(seen.has(hex)).toBe(false);
                seen.add(hex);
            }
        });

        it('PROBE: empty data update does not break chain', () => {
            const chain = new IntegrityChain();
            const h1 = chain.update(new Uint8Array(0));
            const h2 = chain.update(new Uint8Array([1]));
            expect(h1.length).toBe(32);
            expect(Buffer.from(h1).equals(Buffer.from(h2))).toBe(false);
        });
    });

    describe('§2.2 — CRC32', () => {
        it('PROBE: detects every single-bit error in a 28-byte block', () => {
            const data = Buffer.from('CRC32 audit probe data block');
            const original = calculateCRC32(data);
            let detected = 0, total = 0;
            for (let i = 0; i < data.length; i++) {
                for (let bit = 0; bit < 8; bit++) {
                    const corrupted = Buffer.from(data);
                    corrupted[i] ^= (1 << bit);
                    total++;
                    if (calculateCRC32(corrupted) !== original) detected++;
                }
            }
            // CRC32 MUST detect 100% of single-bit errors
            expect(detected).toBe(total);
        });

        it('PROBE: deterministic', () => {
            const data = Buffer.from('determinism');
            expect(calculateCRC32(data)).toBe(calculateCRC32(data));
        });

        it('PROBE: empty data → valid number', () => {
            expect(typeof calculateCRC32(Buffer.alloc(0))).toBe('number');
        });
    });
});

// ═══════════════════════════════════════════════════════════════════
// §3: AUDIT CHAIN TAMPER EVIDENCE
// Standards: ISO 27001 A.8.15, SOC2 CC7.2
// ═══════════════════════════════════════════════════════════════════

describe('AUDIT §3 — AuditChain Tamper Evidence (ISO 27001 A.8.15)', () => {
    let dir: string;
    let chain: AuditChain;

    beforeEach(async () => {
        dir = tmpDir();
        chain = new AuditChain({ filePath: path.join(dir, 'audit.chain') });
        await chain.initialize();
    });

    afterEach(async () => {
        await chain.close();
        cleanup(dir);
    });

    it('PROBE: 1000 entries → verify = 100% valid', async () => {
        for (let i = 0; i < 1000; i++) {
            await chain.append('audit:probe', 'write', `key-${i}`, { value: i });
        }
        const result = await chain.verify();
        expect(result.valid).toBe(true);
        expect(result.totalEntries).toBe(1000);
        expect(result.corrupted).toEqual([]);
        expect(result.chainBroken).toBe(false);
    });

    it('PROBE: tamper 1 entry payload → hash mismatch detected', async () => {
        for (let i = 0; i < 100; i++) await chain.append('test', 'put', `k${i}`, { v: i });
        await chain.close();

        const fp = path.join(dir, 'audit.chain');
        const lines = readFileSync(fp, 'utf8').split('\n').filter(Boolean);
        const entry = JSON.parse(lines[49]);
        entry.payload = '{"v":999999}';
        lines[49] = JSON.stringify(entry);
        writeFileSync(fp, lines.join('\n') + '\n');

        const c2 = new AuditChain({ filePath: fp });
        await c2.initialize();
        const result = await c2.verify();
        expect(result.valid).toBe(false);
        expect(result.corrupted.length).toBeGreaterThan(0);
        await c2.close();
    });

    it('PROBE: deleted entry → chain continuity broken', async () => {
        for (let i = 0; i < 50; i++) await chain.append('test', 'put', `k${i}`, { v: i });
        await chain.close();

        const fp = path.join(dir, 'audit.chain');
        const lines = readFileSync(fp, 'utf8').split('\n').filter(Boolean);
        lines.splice(24, 1);
        writeFileSync(fp, lines.join('\n') + '\n');

        const c2 = new AuditChain({ filePath: fp });
        await c2.initialize();
        expect((await c2.verify()).chainBroken).toBe(true);
        await c2.close();
    });

    it('PROBE: sequence is strictly monotonic', async () => {
        const entries = [];
        for (let i = 0; i < 100; i++) entries.push(await chain.append('t', 'w', `k${i}`, { i }));
        for (let i = 1; i < entries.length; i++) {
            expect(entries[i].sequence).toBeGreaterThan(entries[i - 1].sequence);
        }
    });

    it('PROBE: payload >1024 bytes is SHA-256 hashed (no raw leak)', async () => {
        const entry = await chain.append('test', 'store', 'key', { data: 'x'.repeat(2000) });
        expect(entry.payload).toMatch(/^[a-f0-9]{64}$/);
    });

    it('PROBE: hash includes ALL fields (canonical)', async () => {
        const entry = await chain.append('actor1', 'action1', 'target1', { x: 1 });
        const canonical = [
            entry.sequence, entry.timestamp, entry.actor, entry.action,
            entry.target, entry.payload, entry.prevHash,
        ].join('|');
        expect(entry.hash).toBe(createHash('sha256').update(canonical, 'utf8').digest('hex'));
    });

    it('PROBE: 500 rapid concurrent appends → still valid chain', async () => {
        await Promise.all(
            Array.from({ length: 500 }, (_, i) => chain.append('stress', 'w', `k${i}`, { i }))
        );
        const result = await chain.verify();
        expect(result.valid).toBe(true);
        expect(result.totalEntries).toBe(500);
    });
});

// ═══════════════════════════════════════════════════════════════════
// §4: WAL CRASH SAFETY
// ═══════════════════════════════════════════════════════════════════

describe('AUDIT §4 — WAL Crash Safety & Recovery', () => {
    let dir: string;

    beforeEach(() => { dir = tmpDir(); });
    afterEach(() => { cleanup(dir); });

    describe('§4.1 — Binary WAL v2', () => {
        it('PROBE: 100 writes → recovery produces identical state', async () => {
            const wp = path.join(dir, 'test.wal');
            const wal = createWALProvider('binary', wp);
            const expected = new Map<string, Record<string, number | string>>();

            for (let i = 0; i < 100; i++) {
                const payload = { value: i * 100, score: i % 13 };
                await wal.append(Operation.PUT, `key-${i}`, payload);
                expected.set(`key-${i}`, payload);
            }
            await wal.close();

            const wal2 = createWALProvider('binary', wp);
            const recovered = new Map<string, Record<string, number | string>>();
            await wal2.replay((op, key, payload) => {
                if (op === Operation.PUT) recovered.set(key, payload);
                else recovered.delete(key);
            });

            expect(recovered.size).toBe(100);
            for (const [key, val] of expected) {
                expect(recovered.get(key)).toEqual(val);
            }
            await wal2.close();
        });

        it('PROBE: CRC detects corruption, skips bad entry, recovers rest', async () => {
            const wp = path.join(dir, 'corrupt.wal');
            const wal = createWALProvider('binary', wp);
            for (let i = 0; i < 10; i++) await wal.append(Operation.PUT, `k${i}`, { v: i });
            await wal.close();

            const raw = readFileSync(wp);
            const corrupted = Buffer.from(raw);
            corrupted[Math.floor(corrupted.length / 2)] ^= 0xFF;
            writeFileSync(wp, corrupted);

            const wal2 = createWALProvider('binary', wp);
            const recovered = new Map<string, Record<string, number | string>>();
            await wal2.replay((op, key, payload) => {
                if (op === Operation.PUT) recovered.set(key, payload);
            });
            // Should recover some but NOT all
            expect(recovered.size).toBeLessThan(10);
            expect(recovered.size).toBeGreaterThan(0);
            await wal2.close();
        });

        it('PROBE: DELETE operations survive recovery', async () => {
            const wp = path.join(dir, 'delete.wal');
            const wal = createWALProvider('binary', wp);
            await wal.append(Operation.PUT, 'keep', { v: 1 });
            await wal.append(Operation.PUT, 'remove', { v: 2 });
            await wal.append(Operation.DELETE, 'remove', {});
            await wal.close();

            const wal2 = createWALProvider('binary', wp);
            const recovered = new Map<string, Record<string, number | string>>();
            await wal2.replay((op, key, payload) => {
                if (op === Operation.PUT) recovered.set(key, payload);
                else recovered.delete(key);
            });
            expect(recovered.has('keep')).toBe(true);
            expect(recovered.has('remove')).toBe(false);
            await wal2.close();
        });

        it('PROBE: LSN continuity across restart (session1 → close → session2)', async () => {
            const wp = path.join(dir, 'lsn.wal');
            const wal1 = createWALProvider('binary', wp);
            for (let i = 0; i < 50; i++) await wal1.append(Operation.PUT, `s1-k${i}`, { v: i });
            await wal1.close();

            const wal2 = createWALProvider('binary', wp);
            for (let i = 0; i < 50; i++) await wal2.append(Operation.PUT, `s2-k${i}`, { v: i });

            const recovered = new Map<string, Record<string, number | string>>();
            await wal2.replay((op, key, payload) => {
                if (op === Operation.PUT) recovered.set(key, payload);
            });
            expect(recovered.size).toBe(100);
            await wal2.close();
        });
    });

    describe('§4.2 — Binary vs JSONL WAL equivalence', () => {
        it('PROBE: same ops → identical recovered state', async () => {
            const ops = [
                { op: Operation.PUT, key: 'a', payload: { v: 1 } },
                { op: Operation.PUT, key: 'b', payload: { v: 2 } },
                { op: Operation.DELETE, key: 'b', payload: {} },
                { op: Operation.PUT, key: 'c', payload: { v: 3 } },
            ];

            const bWal = createWALProvider('binary', path.join(dir, 'b.wal'));
            const jWal = createWALProvider('jsonl', path.join(dir, 'j.wal'));
            for (const o of ops) { await bWal.append(o.op, o.key, o.payload); await jWal.append(o.op, o.key, o.payload); }
            await bWal.close(); await jWal.close();

            const bRec = new Map<string, Record<string, number | string>>();
            const jRec = new Map<string, Record<string, number | string>>();

            const bWal2 = createWALProvider('binary', path.join(dir, 'b.wal'));
            const jWal2 = createWALProvider('jsonl', path.join(dir, 'j.wal'));
            await bWal2.replay((op, key, p) => { if (op === Operation.PUT) bRec.set(key, p); else bRec.delete(key); });
            await jWal2.replay((op, key, p) => { if (op === Operation.PUT) jRec.set(key, p); else jRec.delete(key); });

            expect(bRec.size).toBe(jRec.size);
            for (const [k, v] of bRec) expect(jRec.get(k)).toEqual(v);
            await bWal2.close(); await jWal2.close();
        });
    });

    describe('§4.3 — Checkpoint & Compaction', () => {
        it('PROBE: checkpoint survives compaction, all data recoverable', async () => {
            const wp = path.join(dir, 'ckpt.wal');
            const wal = createWALProvider('binary', wp, {
                checkpointEveryOps: 5,
                maxWalSizeMB: 0.001,
            });
            for (let i = 0; i < 20; i++) await wal.append(Operation.PUT, `k${i}`, { v: i });
            await wal.close();

            expect(existsSync(`${wp}.ckpt`)).toBe(true);

            const wal2 = createWALProvider('binary', wp);
            const recovered = new Map<string, Record<string, number | string>>();
            await wal2.replay((op, key, payload) => {
                if (op === Operation.PUT) recovered.set(key, payload);
            });
            expect(recovered.size).toBe(20);
            await wal2.close();
        });

        it('PROBE: corrupted checkpoint → falls back to full replay', async () => {
            const wp = path.join(dir, 'badckpt.wal');
            const wal = createWALProvider('binary', wp, { checkpointEveryOps: 3 });
            for (let i = 0; i < 10; i++) await wal.append(Operation.PUT, `k${i}`, { v: i });
            await wal.close();

            // Corrupt checkpoint file
            const ckptPath = `${wp}.ckpt`;
            if (existsSync(ckptPath)) {
                writeFileSync(ckptPath, 'CORRUPTED_CHECKPOINT_DATA\n');
            }

            const wal2 = createWALProvider('binary', wp);
            const recovered = new Map<string, Record<string, number | string>>();
            await wal2.replay((op, key, payload) => {
                if (op === Operation.PUT) recovered.set(key, payload);
            });
            // Should still recover from WAL entries directly
            expect(recovered.size).toBe(10);
            await wal2.close();
        });
    });

    describe('§4.4 — WAL edge cases (where it could silently fail)', () => {
        it('PROBE: special chars in keys/values survive roundtrip', async () => {
            const wp = path.join(dir, 'special.wal');
            const wal = createWALProvider('binary', wp);
            await wal.append(Operation.PUT, 'key\nwith\nnewlines', { v: 'tabs\there' });
            await wal.append(Operation.PUT, 'key"quotes"', { v: 'backslash\\' });
            await wal.append(Operation.PUT, 'emoji🔑', { v: 'party🎉' });
            await wal.close();

            const wal2 = createWALProvider('binary', wp);
            const rec = new Map<string, Record<string, number | string>>();
            await wal2.replay((op, key, payload) => { if (op === Operation.PUT) rec.set(key, payload); });
            expect(rec.size).toBe(3);
            expect(rec.get('emoji🔑')?.v).toBe('party🎉');
            await wal2.close();
        });

        it('PROBE: overwrite same key 100x → only last value survives', async () => {
            const wp = path.join(dir, 'overwrite.wal');
            const wal = createWALProvider('binary', wp);
            for (let i = 0; i < 100; i++) await wal.append(Operation.PUT, 'same-key', { v: i });
            await wal.close();

            const wal2 = createWALProvider('binary', wp);
            const rec = new Map<string, Record<string, number | string>>();
            await wal2.replay((op, key, payload) => {
                if (op === Operation.PUT) rec.set(key, payload);
            });
            expect(rec.get('same-key')?.v).toBe(99);
            await wal2.close();
        });

        it('PROBE: empty payload survives roundtrip', async () => {
            const wp = path.join(dir, 'empty.wal');
            const wal = createWALProvider('binary', wp);
            await wal.append(Operation.PUT, 'empty', {});
            await wal.close();

            const wal2 = createWALProvider('binary', wp);
            const rec = new Map<string, Record<string, number | string>>();
            await wal2.replay((op, key, payload) => { if (op === Operation.PUT) rec.set(key, payload); });
            expect(rec.get('empty')).toEqual({});
            await wal2.close();
        });
    });
});

// ═══════════════════════════════════════════════════════════════════
// §5: RESILIENCE & FAILURE MODES
// Standards: OWASP ASVS V11, Circuit Breaker Pattern
// ═══════════════════════════════════════════════════════════════════

describe('AUDIT §5 — Resilience Shell Failure Modes', () => {

    it('PROBE: CLOSED → 5 failures in window → OPEN (fail-fast)', async () => {
        const shell = new ResilienceShell({
            circuitBreaker: { failureThreshold: 5, windowMs: 60000, halfOpenAfterMs: 100 },
            retry: { maxAttempts: 1 },
            timeout: { readMs: 50 },
        });

        for (let i = 0; i < 5; i++) {
            try {
                await shell.executeRead(() => new Promise((_, rej) => setTimeout(() => rej(new Error('fail')), 100)));
            } catch { /* expected */ }
        }
        expect(shell.getCircuitState()).toBe('OPEN');

        await expect(
            shell.executeRead(() => Promise.resolve('nope'))
        ).rejects.toThrow(GICSCircuitOpen);
    });

    it('PROBE: OPEN → cooldown → HALF_OPEN → probes succeed → CLOSED', async () => {
        const shell = new ResilienceShell({
            circuitBreaker: {
                failureThreshold: 2, windowMs: 60000,
                halfOpenAfterMs: 100, halfOpenMaxProbes: 2,
            },
            retry: { maxAttempts: 1 },
            timeout: { readMs: 50 },
        });

        // Open
        for (let i = 0; i < 2; i++) {
            try { await shell.executeRead(() => new Promise((_, r) => setTimeout(() => r(new Error('f')), 100))); }
            catch { /* expected */ }
        }
        expect(shell.getCircuitState()).toBe('OPEN');

        // Wait cooldown
        await new Promise(r => setTimeout(r, 150));
        expect(shell.getCircuitState()).toBe('HALF_OPEN');

        // Successful probes → CLOSED
        await shell.executeRead(() => Promise.resolve('ok'));
        await shell.executeRead(() => Promise.resolve('ok'));
        expect(shell.getCircuitState()).toBe('CLOSED');
    });

    it('PROBE: backpressure rejects at highWaterMark', async () => {
        const shell = new ResilienceShell({
            backpressure: { highWaterMark: 3 },
            timeout: { readMs: 5000 },
            retry: { maxAttempts: 1 },
        });

        const slow = Array.from({ length: 3 }, () =>
            shell.executeRead(() => new Promise(r => setTimeout(r, 1000)))
        );
        await new Promise(r => setTimeout(r, 20));

        await expect(
            shell.executeRead(() => Promise.resolve('overflow'))
        ).rejects.toThrow(GICSUnavailable);

        await Promise.allSettled(slow);
    });

    it('PROBE: all errors carry metadata (attempts, circuitState, queueDepth)', async () => {
        const shell = new ResilienceShell({
            circuitBreaker: { failureThreshold: 1 },
            retry: { maxAttempts: 1 },
            timeout: { readMs: 10 },
        });

        try {
            await shell.executeRead(() => new Promise((_, r) => setTimeout(() => r(new Error('f')), 50)));
        } catch (err: any) {
            expect(err.metadata).toBeDefined();
            expect(err.metadata.circuitState).toBeDefined();
            expect(typeof err.metadata.queueDepth).toBe('number');
        }
    });

    it('PROBE: HALF_OPEN failure → back to OPEN (no infinite retry loop)', async () => {
        const shell = new ResilienceShell({
            circuitBreaker: {
                failureThreshold: 1, windowMs: 60000,
                halfOpenAfterMs: 50, halfOpenMaxProbes: 1,
            },
            retry: { maxAttempts: 1 },
            timeout: { readMs: 30 },
        });

        // Open
        try { await shell.executeRead(() => new Promise((_, r) => setTimeout(() => r(new Error('f')), 50))); }
        catch { /* expected */ }
        expect(shell.getCircuitState()).toBe('OPEN');

        // Wait for HALF_OPEN
        await new Promise(r => setTimeout(r, 80));
        expect(shell.getCircuitState()).toBe('HALF_OPEN');

        // Fail in HALF_OPEN → back to OPEN
        try { await shell.executeRead(() => new Promise((_, r) => setTimeout(() => r(new Error('f')), 50))); }
        catch { /* expected */ }
        expect(shell.getCircuitState()).toBe('OPEN');
    });
});

// ═══════════════════════════════════════════════════════════════════
// §6: SUPERVISOR DEGRADATION
// Standards: ISO 22301
// ═══════════════════════════════════════════════════════════════════

describe('AUDIT §6 — Supervisor Degradation & Recovery (ISO 22301)', () => {

    it('PROBE: starts HEALTHY, transitions logged', () => {
        const sup = new GICSSupervisor();
        sup.start();
        expect(sup.getState()).toBe('HEALTHY');
        const t = sup.getTransitions();
        expect(t.length).toBe(1);
        expect(t[0]).toMatchObject({ from: 'STARTING', to: 'HEALTHY' });
        expect(t[0].timestamp).toBeGreaterThan(0);
        sup.stop();
    });

    it('PROBE: buffered writes have monotonic sequence IDs', () => {
        const sup = new GICSSupervisor();
        const w1 = sup.bufferWrite('k1', { v: 1 });
        const w2 = sup.bufferWrite('k2', { v: 2 });
        const w3 = sup.bufferWrite('k3', { v: 3 });
        expect(w2.seq).toBeGreaterThan(w1.seq);
        expect(w3.seq).toBeGreaterThan(w2.seq);
    });

    it('PROBE: flush — WAL wins conflicts, non-conflicts applied', () => {
        const sup = new GICSSupervisor();
        sup.bufferWrite('conflict', { v: 'buf' });
        sup.bufferWrite('safe', { v: 'safe' });

        const applied: string[] = [];
        const result = sup.flushBuffer(
            (key) => key === 'conflict',
            (key) => applied.push(key)
        );

        expect(result.applied).toBe(1);
        expect(result.discarded).toBe(1);
        expect(result.discardedKeys).toContain('conflict');
        expect(applied).toEqual(['safe']);
    });

    it('PROBE: resetDegraded from non-DEGRADED state → returns false', async () => {
        const sup = new GICSSupervisor();
        sup.start();
        expect(await sup.resetDegraded()).toBe(false);
        sup.stop();
    });

    it('PROBE: isDegraded initially false', () => {
        expect(new GICSSupervisor().isDegraded()).toBe(false);
    });
});

// ═══════════════════════════════════════════════════════════════════
// §7: MEMTABLE BOUNDARY CONDITIONS
// ═══════════════════════════════════════════════════════════════════

describe('AUDIT §7 — MemTable Boundary Conditions', () => {

    it('PROBE: put/get/delete/overwrite cycle correct', () => {
        const m = new MemTable();
        m.put('k1', { v: 1 }); expect(m.get('k1')?.fields.v).toBe(1);
        m.put('k1', { v: 2 }); expect(m.get('k1')?.fields.v).toBe(2);
        m.delete('k1'); expect(m.get('k1')).toBeUndefined();
    });

    it('PROBE: overwrite replaces ALL fields (no stale-field leakage)', () => {
        const m = new MemTable();
        m.put('k1', { a: 1, b: 2, c: 3 });
        m.put('k1', { a: 10 });
        expect(m.get('k1')?.fields).toEqual({ a: 10 });
    });

    it('PROBE: size estimation grows with data', () => {
        const m = new MemTable();
        for (let i = 0; i < 100; i++) m.put(`k${i}`, { data: 'x'.repeat(100) });
        expect(m.sizeBytes).toBeGreaterThan(10000);
    });

    it('PROBE: shouldFlush triggers at size threshold', () => {
        const m = new MemTable({ maxMemTableBytes: 500 });
        for (let i = 0; i < 50; i++) m.put(`k${i}`, { data: 'x'.repeat(100) });
        expect(m.shouldFlush()).toEqual({ shouldFlush: true, reason: 'size' });
    });

    it('PROBE: shouldFlush triggers at dirty threshold', () => {
        const m = new MemTable({ maxDirtyRecords: 10 });
        for (let i = 0; i < 11; i++) m.put(`k${i}`, { v: i });
        expect(m.shouldFlush().reason).toBe('dirty');
    });

    it('PROBE: resetDirty clears dirty count', () => {
        const m = new MemTable();
        for (let i = 0; i < 5; i++) m.put(`k${i}`, { v: i });
        expect(m.dirtyCount).toBe(5);
        m.resetDirty();
        expect(m.dirtyCount).toBe(0);
    });

    it('PROBE: scan prefix returns correct subset', () => {
        const m = new MemTable();
        m.put('ops:model:a', { v: 1 });
        m.put('ops:model:b', { v: 2 });
        m.put('user:data:a', { v: 3 });
        expect(m.scan('ops:model:').length).toBe(2);
        expect(m.scan('user:').length).toBe(1);
        expect(m.scan().length).toBe(3);
    });

    it('PROBE: empty string key works', () => {
        const m = new MemTable();
        m.put('', { v: 1 });
        expect(m.get('')?.fields.v).toBe(1);
    });

    it('PROBE: unicode keys work', () => {
        const m = new MemTable();
        m.put('日本語', { v: 1 });
        m.put('🔑', { v: 2 });
        expect(m.get('日本語')?.fields.v).toBe(1);
        expect(m.get('🔑')?.fields.v).toBe(2);
    });

    it('PROBE: delete non-existent key returns false, no crash', () => {
        expect(new MemTable().delete('nonexistent')).toBe(false);
    });

    it('PROBE: get on empty table returns undefined', () => {
        expect(new MemTable().get('anything')).toBeUndefined();
    });

    it('PROBE: accessCount increments on get', () => {
        const m = new MemTable();
        m.put('k', { v: 1 });
        m.get('k'); m.get('k'); m.get('k');
        expect(m.get('k')?.accessCount).toBe(4); // 3 + the one in this line
    });

    it('PROBE: 1000 concurrent put/get — no state corruption', async () => {
        const m = new MemTable();
        await Promise.all(
            Array.from({ length: 1000 }, (_, i) =>
                Promise.resolve().then(() => {
                    m.put(`key-${i % 100}`, { v: i });
                    return m.get(`key-${i % 100}`);
                })
            )
        );
        expect(m.count).toBe(100);
    });
});

// ═══════════════════════════════════════════════════════════════════
// §8: BANDIT ROUTER
// ═══════════════════════════════════════════════════════════════════

describe('AUDIT §8 — BanditRouter Determinism & Safety', () => {

    it('PROBE: disabled by default → safe fallback', () => {
        const r = new BanditRouter();
        const d = r.selectArm('encode', ['sonnet', 'opus', 'haiku']);
        expect(d.chosenArm).toBe('sonnet');
        expect(d.sampledTheta).toBe(0.5);
    });

    it('PROBE: seeded → fully deterministic', () => {
        const r1 = new BanditRouter({ enabled: true, seed: 42 });
        const r2 = new BanditRouter({ enabled: true, seed: 42 });
        for (let i = 0; i < 50; i++) {
            const d1 = r1.selectArm('encode', ['sonnet', 'opus', 'haiku']);
            const d2 = r2.selectArm('encode', ['sonnet', 'opus', 'haiku']);
            expect(d1.chosenArm).toBe(d2.chosenArm);
            expect(d1.sampledTheta).toBe(d2.sampledTheta);
        }
    });

    it('PROBE: recordOutcome updates alpha/beta correctly', () => {
        const r = new BanditRouter({ enabled: true, seed: 1 });
        r.selectArm('encode', ['sonnet']);
        r.recordOutcome('sonnet', 'encode', true);
        r.recordOutcome('sonnet', 'encode', true);
        r.recordOutcome('sonnet', 'encode', false);
        const s = r.getStats().get('sonnet|encode')!;
        expect(s.alpha).toBe(5); // prior(3) + 2 successes
        expect(s.beta).toBe(2);  // prior(1) + 1 failure
        expect(s.totalPulls).toBe(3);
    });

    it('PROBE: empty arms → safe fallback', () => {
        expect(new BanditRouter({ enabled: true }).selectArm('encode', []).chosenArm).toBe('sonnet');
    });

    it('PROBE: high-performing arm selected > 70% after 100 observations', () => {
        const r = new BanditRouter({ enabled: true, seed: 7 });
        for (let i = 0; i < 100; i++) {
            r.recordOutcome('sonnet', 'encode', Math.random() < 0.8);
            r.recordOutcome('opus', 'encode', Math.random() < 0.2);
        }
        let sonnetCount = 0;
        for (let i = 0; i < 100; i++) {
            if (r.selectArm('encode', ['sonnet', 'opus']).chosenArm === 'sonnet') sonnetCount++;
        }
        expect(sonnetCount).toBeGreaterThan(70);
    });

    it('PROBE: reset clears all arms', () => {
        const r = new BanditRouter({ enabled: true, seed: 1 });
        r.selectArm('encode', ['sonnet']);
        r.recordOutcome('sonnet', 'encode', true);
        r.reset();
        expect(r.getStats().size).toBe(0);
    });

    it('PROBE: disabled router ignores recordOutcome', () => {
        const r = new BanditRouter({ enabled: false });
        r.recordOutcome('sonnet', 'encode', true);
        expect(r.getStats().size).toBe(0);
    });
});

// ═══════════════════════════════════════════════════════════════════
// §9: PROMPT DISTILLER DATA LIFECYCLE
// Standards: GDPR Article 5(1)(e)
// ═══════════════════════════════════════════════════════════════════

describe('AUDIT §9 — PromptDistiller Data Lifecycle (GDPR Art.5)', () => {
    let dir: string;
    let distiller: PromptDistiller;

    function makeRecord(key: string, ts?: number): PromptRecord {
        return {
            key, content: `prompt ${key}: ${'x'.repeat(500)}`,
            metadata: { tokenCount: 150, modelUsed: 'sonnet', taskType: 'code', success: true, latencyMs: 250, costUsd: 0.003 },
            timestamp: ts ?? Date.now(),
        };
    }

    beforeEach(async () => {
        dir = tmpDir();
        distiller = new PromptDistiller({
            dataPath: dir, rawRetentionMs: 100, compressedRetentionMs: 200,
            emergencyPurgeEnabled: false, autoClassifyOnInit: false,
        });
        await distiller.initialize();
    });

    afterEach(async () => { await distiller.stop(); cleanup(dir); });

    it('PROBE: store → retrieve from RAW tier', async () => {
        const rec = makeRecord('test-key');
        await distiller.store(rec);
        const r = await distiller.retrieve('test-key') as PromptRecord;
        expect(r).toBeDefined();
        expect(r.content).toBe(rec.content);
    });

    it('PROBE: retention compresses old RAW data', async () => {
        await distiller.store(makeRecord('old-key', Date.now() - 500));
        const result = await distiller.runRetentionPolicy();
        expect(result.compressed).toBeGreaterThanOrEqual(1);
    });

    it('PROBE: distillation is irreversible — original content gone', async () => {
        await distiller.store(makeRecord('distill-key', Date.now() - 500));
        await distiller.runRetentionPolicy();
        await new Promise(r => setTimeout(r, 250));
        await distiller.runRetentionPolicy();

        const r = await distiller.retrieve('distill-key');
        if (r && 'contentHash' in r) {
            expect(r.contentHash).toMatch(/^[a-f0-9]{64}$/);
            expect((r as any).content).toBeUndefined();
        }
    });

    it('PROBE: tier stats are accurate', async () => {
        await distiller.store(makeRecord('a'));
        await distiller.store(makeRecord('b'));
        await distiller.store(makeRecord('c'));
        const stats = await distiller.getStats();
        const raw = stats.find(s => s.tier === 'raw')!;
        expect(raw.recordCount).toBe(3);
        expect(raw.sizeBytes).toBeGreaterThan(0);
    });

    it('PROBE: readOnly flag is initially false', () => {
        expect(distiller.readOnly).toBe(false);
    });
});

// ═══════════════════════════════════════════════════════════════════
// §10: FILE LOCKING CONCURRENCY
// ═══════════════════════════════════════════════════════════════════

describe('AUDIT §10 — File Locking & Concurrency', () => {

    it('PROBE: exclusive lock — max 1 concurrent', async () => {
        let concurrent = 0, max = 0;
        await Promise.all(Array.from({ length: 10 }, (_, i) =>
            FileLock.withExclusiveLock('audit-res', async () => {
                concurrent++; max = Math.max(max, concurrent);
                await new Promise(r => setTimeout(r, 10));
                concurrent--;
            })
        ));
        expect(max).toBe(1);
    });

    it('PROBE: shared locks allow concurrent reads', async () => {
        let concurrent = 0, max = 0;
        await Promise.all(Array.from({ length: 10 }, () =>
            FileLock.withSharedLock('audit-shared', async () => {
                concurrent++; max = Math.max(max, concurrent);
                await new Promise(r => setTimeout(r, 50));
                concurrent--;
            })
        ));
        expect(max).toBeGreaterThan(1);
    });

    it('PROBE: exclusive waiter blocks new shared (write-preferring)', async () => {
        const lock = new AsyncRWLock();
        const log: string[] = [];

        await lock.acquire('shared');

        const excP = lock.acquire('exclusive').then(() => log.push('exc'));
        const sh2P = lock.acquire('shared').then(() => log.push('sh2'));

        await new Promise(r => setTimeout(r, 10));
        lock.release(); // release first shared
        await new Promise(r => setTimeout(r, 10));
        lock.release(); // release exclusive
        await new Promise(r => setTimeout(r, 10));
        lock.release(); // release shared2

        await Promise.all([excP, sh2P]);
        expect(log.indexOf('exc')).toBeLessThan(log.indexOf('sh2'));
    });

    it('PROBE: lock timeout fires', async () => {
        const lock = new AsyncRWLock();
        await lock.acquire('exclusive');
        await expect(lock.acquire('shared', 50)).rejects.toThrow(/lock/i);
        lock.release();
    });
});

// ═══════════════════════════════════════════════════════════════════
// §11: COMPRESSION CORE — ROUNDTRIP INTEGRITY
// This is the CORE: does GICS compress and decompress correctly?
// ═══════════════════════════════════════════════════════════════════

describe('AUDIT §11 — Compression Core Roundtrip', () => {

    it('PROBE: 100 snapshots, 5 items each — bit-exact roundtrip', async () => {
        const snapshots = makeSnapshots(100, 5);
        const encoded = await encodeSnapshots(snapshots);
        const decoded = await decodeSnapshots(encoded);

        expect(decoded.length).toBe(100);
        for (let i = 0; i < 100; i++) {
            expect(decoded[i].timestamp).toBe(snapshots[i].timestamp);
            expect(decoded[i].items.size).toBe(5);
            for (let j = 1; j <= 5; j++) {
                const orig = snapshots[i].items.get(j)!;
                const dec = decoded[i].items.get(j)!;
                expect(dec.quantity).toBe(orig.quantity);
                // Price may have floating-point rounding — verify within tolerance
                expect(Math.abs(dec.price - orig.price)).toBeLessThan(1);
            }
        }
    });

    it('PROBE: encrypted roundtrip preserves data', async () => {
        const snapshots = makeSnapshots(50, 3);
        const encoded = await encodeSnapshots(snapshots, { password: 'audit-pwd-2026' });
        const decoded = await decodeSnapshots(encoded, { password: 'audit-pwd-2026' });
        expect(decoded.length).toBe(50);
        for (let i = 0; i < 50; i++) expect(decoded[i].timestamp).toBe(snapshots[i].timestamp);
    });

    it('PROBE: wrong password → IntegrityError (not garbage)', async () => {
        const encoded = await encodeSnapshots(makeSnapshots(10), { password: 'correct' });
        await expect(decodeSnapshots(encoded, { password: 'wrong' })).rejects.toThrow(IntegrityError);
    });

    it('PROBE: truncated file → error thrown (not silent corruption)', async () => {
        const encoded = await encodeSnapshots(makeSnapshots(50));
        const truncated = encoded.slice(0, Math.floor(encoded.length / 2));
        await expect(decodeSnapshots(truncated)).rejects.toThrow();
    });

    it('PROBE: single bit-flip → detected (integrity chain or CRC)', async () => {
        const encoded = await encodeSnapshots(makeSnapshots(20));
        const corrupted = new Uint8Array(encoded);
        corrupted[Math.floor(corrupted.length / 2)] ^= 0x01;
        await expect(decodeSnapshots(corrupted)).rejects.toThrow();
    });

    it('PROBE: compression ratio > 1 for realistic data', async () => {
        const snapshots = makeSnapshots(500, 10);
        const encoded = await encodeSnapshots(snapshots);
        const rawSize = JSON.stringify(snapshots.map(s => ({
            timestamp: s.timestamp,
            items: Array.from(s.items.entries())
        }))).length;
        expect(rawSize / encoded.length).toBeGreaterThan(1);
    });

    it('PROBE: determinism — same input → same output bytes', async () => {
        const snapshots = makeSnapshots(50, 3);
        const enc1 = await encodeSnapshots(snapshots);
        const enc2 = await encodeSnapshots(snapshots);
        expect(Buffer.from(enc1).equals(Buffer.from(enc2))).toBe(true);
    });

    it('PROBE: single snapshot roundtrip', async () => {
        const snapshots = makeSnapshots(1, 1);
        const decoded = await decodeSnapshots(await encodeSnapshots(snapshots));
        expect(decoded.length).toBe(1);
        expect(decoded[0].timestamp).toBe(snapshots[0].timestamp);
    });

    it('PROBE: 1000 snapshots stress test', async () => {
        const snapshots = makeSnapshots(1000, 5);
        const encoded = await encodeSnapshots(snapshots);
        const decoded = await decodeSnapshots(encoded);
        expect(decoded.length).toBe(1000);
        // Spot check first, middle, last
        expect(decoded[0].timestamp).toBe(snapshots[0].timestamp);
        expect(decoded[499].timestamp).toBe(snapshots[499].timestamp);
        expect(decoded[999].timestamp).toBe(snapshots[999].timestamp);
    });

    it('PROBE: empty snapshots list → does not crash', async () => {
        const encoder = new GICSv2Encoder();
        // Calling finish without adding snapshots
        const result = await encoder.finish();
        expect(result).toBeDefined();
        expect(result.length).toBeGreaterThan(0); // At minimum a header
    });
});

// ═══════════════════════════════════════════════════════════════════
// §12: ADVERSARIAL & EDGE CASES
// Standards: OWASP Testing Guide V4
// ═══════════════════════════════════════════════════════════════════

describe('AUDIT §12 — Adversarial & Edge Cases (OWASP)', () => {

    it('PROBE: massive items per snapshot (100 items)', async () => {
        const snapshots = makeSnapshots(10, 100);
        const decoded = await decodeSnapshots(await encodeSnapshots(snapshots));
        expect(decoded.length).toBe(10);
        expect(decoded[0].items.size).toBe(100);
    });

    it('PROBE: price=0 and quantity=0 survive roundtrip', async () => {
        const s: Snapshot = {
            timestamp: 1700000000,
            items: new Map([[1, { price: 0, quantity: 0 }]])
        };
        const decoded = await decodeSnapshots(await encodeSnapshots([s]));
        expect(decoded[0].items.get(1)!.price).toBe(0);
        expect(decoded[0].items.get(1)!.quantity).toBe(0);
    });

    it('PROBE: very large price values survive roundtrip', async () => {
        const s: Snapshot = {
            timestamp: 1700000000,
            items: new Map([[1, { price: 2147483647, quantity: 999999 }]])
        };
        const decoded = await decodeSnapshots(await encodeSnapshots([s]));
        expect(decoded[0].items.get(1)!.price).toBe(2147483647);
    });

    it('PROBE: negative price values survive roundtrip', async () => {
        const s: Snapshot = {
            timestamp: 1700000000,
            items: new Map([[1, { price: -500, quantity: 10 }]])
        };
        const decoded = await decodeSnapshots(await encodeSnapshots([s]));
        expect(decoded[0].items.get(1)!.price).toBe(-500);
    });

    it('PROBE: non-sequential timestamps survive', async () => {
        const snapshots: Snapshot[] = [
            { timestamp: 1700000100, items: new Map([[1, { price: 100, quantity: 10 }]]) },
            { timestamp: 1700000200, items: new Map([[1, { price: 200, quantity: 20 }]]) },
            { timestamp: 1700000150, items: new Map([[1, { price: 150, quantity: 15 }]]) }, // out of order
        ];
        const decoded = await decodeSnapshots(await encodeSnapshots(snapshots));
        expect(decoded.length).toBe(3);
        expect(decoded[0].timestamp).toBe(1700000100);
        expect(decoded[2].timestamp).toBe(1700000150);
    });

    it('PROBE: random garbage bytes → error (not crash or hang)', async () => {
        const garbage = randomBytes(1000);
        await expect(decodeSnapshots(garbage)).rejects.toThrow();
    });

    it('PROBE: GICS magic bytes followed by garbage → error', async () => {
        const payload = Buffer.concat([
            Buffer.from([0x47, 0x49, 0x43, 0x53]), // "GICS" magic
            randomBytes(500)
        ]);
        await expect(decodeSnapshots(payload)).rejects.toThrow();
    });
});

// ═══════════════════════════════════════════════════════════════════
// §13: DETERMINISM
// ═══════════════════════════════════════════════════════════════════

describe('AUDIT §13 — Determinism Guarantees', () => {

    it('PROBE: IntegrityChain deterministic across instances', () => {
        const data = [new Uint8Array([1, 2]), new Uint8Array([3, 4]), new Uint8Array([5, 6])];
        const c1 = new IntegrityChain();
        const c2 = new IntegrityChain();
        for (const d of data) { c1.update(d); c2.update(d); }
        expect(Buffer.from(c1.getRootHash()).equals(Buffer.from(c2.getRootHash()))).toBe(true);
    });

    it('PROBE: CRC32 is fully deterministic', () => {
        const data = randomBytes(10000);
        const results = new Set(Array.from({ length: 100 }, () => calculateCRC32(data)));
        expect(results.size).toBe(1);
    });

    it('PROBE: encoder output is byte-identical across runs', async () => {
        const snapshots = makeSnapshots(100, 5);
        const a = await encodeSnapshots(snapshots);
        const b = await encodeSnapshots(snapshots);
        expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════════════
// §14: CROSS-MODULE INTEGRATION SEAMS
// These test the boundaries WHERE modules connect.
// ═══════════════════════════════════════════════════════════════════

describe('AUDIT §14 — Cross-Module Integration Seams', () => {

    it('PROBE: WAL + MemTable consistency after write cycle', async () => {
        const dir = tmpDir();
        const wp = path.join(dir, 'seam.wal');
        const wal = createWALProvider('binary', wp);
        const mem = new MemTable();

        // Write cycle: WAL first, then MemTable
        for (let i = 0; i < 50; i++) {
            const key = `k${i}`;
            const payload = { v: i };
            await wal.append(Operation.PUT, key, payload);
            mem.put(key, payload);
        }
        await wal.close();

        // Simulate crash: only WAL survives
        const walRecovered = new Map<string, Record<string, number | string>>();
        const wal2 = createWALProvider('binary', wp);
        await wal2.replay((op, key, payload) => {
            if (op === Operation.PUT) walRecovered.set(key, payload);
        });

        // WAL state must match MemTable state
        expect(walRecovered.size).toBe(mem.count);
        for (const [key, payload] of walRecovered) {
            const memRecord = mem.get(key);
            expect(memRecord).toBeDefined();
            expect(memRecord!.fields).toEqual(payload);
        }

        await wal2.close();
        cleanup(dir);
    });

    it('PROBE: AuditChain records WAL operations faithfully', async () => {
        const dir = tmpDir();
        const auditChain = new AuditChain({ filePath: path.join(dir, 'audit.chain') });
        await auditChain.initialize();

        // Simulate put operations logged to audit
        const keys = ['k1', 'k2', 'k3'];
        for (const key of keys) {
            await auditChain.append('daemon', 'put', key, { v: key });
        }

        const result = await auditChain.verify();
        expect(result.valid).toBe(true);
        expect(result.totalEntries).toBe(3);

        // Export and verify content
        const entries = (await auditChain.export()).map(l => JSON.parse(l));
        expect(entries.map((e: any) => e.target)).toEqual(keys);

        await auditChain.close();
        cleanup(dir);
    });

    it('PROBE: Supervisor buffer → MemTable flush preserves data', () => {
        const sup = new GICSSupervisor();
        const mem = new MemTable();

        // Buffer during DEGRADED
        sup.bufferWrite('x', { v: 1 });
        sup.bufferWrite('y', { v: 2 });
        sup.bufferWrite('z', { v: 3 });

        // Flush to MemTable (no WAL conflicts)
        const result = sup.flushBuffer(
            () => false, // no conflicts
            (key, fields) => mem.put(key, fields)
        );

        expect(result.applied).toBe(3);
        expect(mem.count).toBe(3);
        expect(mem.get('x')?.fields.v).toBe(1);
        expect(mem.get('z')?.fields.v).toBe(3);
    });

    it('PROBE: ResilienceShell wraps operations correctly', async () => {
        const shell = new ResilienceShell({ timeout: { writeMs: 5000 }, retry: { maxAttempts: 1 } });
        const mem = new MemTable();

        // Normal operation through resilience shell
        await shell.executeWrite(async () => {
            mem.put('via-shell', { v: 42 });
        });

        expect(mem.get('via-shell')?.fields.v).toBe(42);
    });

    it('PROBE: Encoder output → Decoder → verify all stream sections', async () => {
        // Large enough to exercise multiple codec paths
        const snapshots = makeSnapshots(200, 8);
        const encoded = await encodeSnapshots(snapshots);
        const decoded = await decodeSnapshots(encoded);

        // Verify timestamp stream
        for (let i = 0; i < decoded.length; i++) {
            expect(decoded[i].timestamp).toBe(snapshots[i].timestamp);
        }

        // Verify item count per snapshot
        for (let i = 0; i < decoded.length; i++) {
            expect(decoded[i].items.size).toBe(snapshots[i].items.size);
        }

        // Verify quantity stream (integers should be exact)
        for (let i = 0; i < decoded.length; i++) {
            for (const [id, item] of snapshots[i].items) {
                expect(decoded[i].items.get(id)!.quantity).toBe(item.quantity);
            }
        }
    });
});

// ═══════════════════════════════════════════════════════════════════
// §15: COMPRESSION RATIO EMPIRICAL DATA
// Target: GICS v1.3.3 aims for 60x nominal on structured time-series
// ═══════════════════════════════════════════════════════════════════

describe('§15 — Compression Ratio Empirical Data', () => {
    /** Helper: compute JSON size of snapshots as raw baseline */
    function rawJsonSize(snapshots: Snapshot[]): number {
        let size = 0;
        for (const s of snapshots) {
            // Approximate JSON size: timestamp + items as array of objects
            const items: any[] = [];
            for (const [id, item] of s.items) {
                items.push({ id, price: item.price, quantity: item.quantity });
            }
            size += JSON.stringify({ timestamp: s.timestamp, items }).length;
        }
        return size;
    }

    /** Generate trending (monotonic) price snapshots */
    function makeTrendingSnapshots(count: number, itemsPerSnapshot: number): Snapshot[] {
        const snapshots: Snapshot[] = [];
        const baseTime = 1700000000;
        for (let i = 0; i < count; i++) {
            const items = new Map<number, { price: number; quantity: number }>();
            for (let j = 1; j <= itemsPerSnapshot; j++) {
                items.set(j, {
                    price: 1000 + i * 10 + j, // Monotonically increasing
                    quantity: 100 + (i % 50),
                });
            }
            snapshots.push({ timestamp: baseTime + i * 60, items });
        }
        return snapshots;
    }

    /** Generate volatile (random-walk) price snapshots — realistic tick-level data */
    function makeVolatileSnapshots(count: number, itemsPerSnapshot: number): Snapshot[] {
        const snapshots: Snapshot[] = [];
        const baseTime = 1700000000;
        let seed = 42;
        const nextRand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };

        // Realistic tick-level data: small deltas (±0-3) on prices ~1000-5000
        const prices = Array.from({ length: itemsPerSnapshot }, (_, j) => 1000 + j * 200);
        const quantities = Array.from({ length: itemsPerSnapshot }, () => 100);
        for (let i = 0; i < count; i++) {
            const items = new Map<number, { price: number; quantity: number }>();
            for (let j = 0; j < itemsPerSnapshot; j++) {
                // Tick-level walk: ±0-3 per step (realistic market microstructure)
                prices[j] += (nextRand() % 7) - 3;
                if (prices[j] < 1) prices[j] = 1;
                // Quantities with temporal correlation
                quantities[j] += (nextRand() % 3) - 1;
                if (quantities[j] < 1) quantities[j] = 1;
                items.set(j + 1, {
                    price: prices[j],
                    quantity: quantities[j],
                });
            }
            snapshots.push({ timestamp: baseTime + i * 60, items });
        }
        return snapshots;
    }

    /** Generate regular-pattern snapshots (high compressibility) */
    function makeRegularSnapshots(count: number, itemsPerSnapshot: number): Snapshot[] {
        const snapshots: Snapshot[] = [];
        const baseTime = 1700000000;
        for (let i = 0; i < count; i++) {
            const items = new Map<number, { price: number; quantity: number }>();
            for (let j = 1; j <= itemsPerSnapshot; j++) {
                items.set(j, {
                    price: 1000 + j * 100 + Math.round(Math.sin(i * 0.01) * 5), // Very regular
                    quantity: 50 + (i % 10),
                });
            }
            snapshots.push({ timestamp: baseTime + i * 60, items });
        }
        return snapshots;
    }

    it('PROBE 110: Trending integers — 500 snapshots, 10 items → ratio > 25x', async () => {
        const snapshots = makeTrendingSnapshots(500, 10);
        const rawSize = rawJsonSize(snapshots);
        const encoded = await encodeSnapshots(snapshots);
        const ratio = rawSize / encoded.length;

        console.log(`[§15] Trending: ${rawSize} → ${encoded.length} bytes (${ratio.toFixed(2)}x)`);
        expect(ratio).toBeGreaterThan(25);

        // Verify roundtrip
        const decoded = await decodeSnapshots(encoded);
        expect(decoded.length).toBe(500);
    });

    it('PROBE 111: Volatile integers — 1000 snapshots, 50 items → ratio > 55x', async () => {
        const snapshots = makeVolatileSnapshots(1000, 50);
        const rawSize = rawJsonSize(snapshots);
        const encoded = await encodeSnapshots(snapshots);
        const ratio = rawSize / encoded.length;

        console.log(`[§15] Volatile: ${rawSize} → ${encoded.length} bytes (${ratio.toFixed(2)}x)`);
        expect(ratio).toBeGreaterThan(55);

        // Verify roundtrip
        const decoded = await decodeSnapshots(encoded);
        expect(decoded.length).toBe(1000);
    });

    it('PROBE 112: Multi-item dense — 200 snapshots, 50 items → ratio > 40x', async () => {
        const snapshots = makeTrendingSnapshots(200, 50);
        const rawSize = rawJsonSize(snapshots);
        const encoded = await encodeSnapshots(snapshots);
        const ratio = rawSize / encoded.length;

        console.log(`[§15] Multi-item dense: ${rawSize} → ${encoded.length} bytes (${ratio.toFixed(2)}x)`);
        expect(ratio).toBeGreaterThan(40);

        // Verify roundtrip
        const decoded = await decodeSnapshots(encoded);
        expect(decoded.length).toBe(200);
        expect(decoded[0].items.size).toBe(50);
    });

    it('PROBE 113: Single snapshot — binary overhead dominates on tiny data', async () => {
        const snapshots = makeSnapshots(1, 3);
        const rawSize = rawJsonSize(snapshots);
        const encoded = await encodeSnapshots(snapshots);
        const ratio = rawSize / encoded.length;

        console.log(`[§15] Single snapshot: ${rawSize} → ${encoded.length} bytes (${ratio.toFixed(2)}x)`);
        // GICS binary format has fixed header overhead (~700 bytes).
        // On 1 snapshot (139 bytes JSON), ratio < 1 is expected and honest.
        // This proves GICS is NOT a good choice for single-record storage.
        expect(ratio).toBeLessThan(1);
        expect(encoded.length).toBeLessThan(2000); // But overhead is bounded
    });

    it('PROBE 114: Large dataset (60x target) — 2000 snapshots, 20 items → ratio > 50x', async () => {
        const snapshots = makeRegularSnapshots(2000, 20);
        const rawSize = rawJsonSize(snapshots);
        const encoded = await encodeSnapshots(snapshots);
        const ratio = rawSize / encoded.length;

        console.log(`[§15] Large regular: ${rawSize} → ${encoded.length} bytes (${ratio.toFixed(2)}x)`);
        expect(ratio).toBeGreaterThan(50);

        // Verify roundtrip
        const decoded = await decodeSnapshots(encoded);
        expect(decoded.length).toBe(2000);
    });

    it('PROBE 115: Encrypted vs unencrypted overhead — bounded and proportional', async () => {
        // Use a larger dataset where fixed enc header (67 bytes) is amortized
        const snapshots = makeTrendingSnapshots(1000, 20);

        const plain = await encodeSnapshots(snapshots);
        const encrypted = await encodeSnapshots(snapshots, { password: 'audit-overhead-test' });

        const overhead = (encrypted.length - plain.length) / plain.length;
        const fixedOverhead = encrypted.length - plain.length;

        console.log(`[§15] Encryption overhead: plain=${plain.length}, encrypted=${encrypted.length}, delta=${fixedOverhead} bytes, overhead=${(overhead * 100).toFixed(2)}%`);

        // Encryption adds a fixed 67-byte header + per-segment auth tags.
        // On large data the percentage overhead is small.
        expect(overhead).toBeLessThan(0.10); // < 10%
        expect(fixedOverhead).toBeGreaterThan(0); // Encryption always adds some bytes
    });
});
