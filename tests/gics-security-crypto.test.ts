import { GICS } from '../src/index.js';
import {
    deriveKey,
    generateEncryptionSecrets,
    generateAuthVerify,
    verifyAuth,
    encryptSection,
    decryptSection,
} from '../src/gics/encryption.js';
import { performance } from 'node:perf_hooks';

describe('GICS cryptographic security checks', () => {
    it('PBKDF2 key derivation is deterministic for same password/salt/iterations', () => {
        const { salt } = generateEncryptionSecrets();
        const k1 = deriveKey('same-password', salt, 100_000);
        const k2 = deriveKey('same-password', salt, 100_000);
        expect(Buffer.compare(k1, k2)).toBe(0);
    });

    it('auth verification succeeds for correct key and fails for wrong key', () => {
        const { salt } = generateEncryptionSecrets();
        const good = deriveKey('good-password', salt, 100_000);
        const bad = deriveKey('bad-password', salt, 100_000);
        const token = generateAuthVerify(good);

        expect(verifyAuth(good, token)).toBe(true);
        expect(verifyAuth(bad, token)).toBe(false);
    });

    it('auth verification has bounded timing delta between match/mismatch paths', () => {
        const { salt } = generateEncryptionSecrets();
        const key = deriveKey('timing-password', salt, 100_000);
        const token = generateAuthVerify(key);
        const wrongToken = new Uint8Array(token);
        wrongToken[0] ^= 0x01;

        const samples = Number(process.env.GICS_TEST_TIMING_SAMPLES ?? '3000');
        const maxDeltaRatio = Number(process.env.GICS_TEST_TIMING_MAX_DELTA_RATIO ?? '0.35');

        let equalMs = 0;
        let mismatchMs = 0;
        for (let i = 0; i < samples; i++) {
            const tEq = performance.now();
            verifyAuth(key, token);
            equalMs += performance.now() - tEq;

            const tNe = performance.now();
            verifyAuth(key, wrongToken);
            mismatchMs += performance.now() - tNe;
        }

        const avgEq = equalMs / Math.max(1, samples);
        const avgNe = mismatchMs / Math.max(1, samples);
        const deltaRatio = Math.abs(avgEq - avgNe) / Math.max(1e-9, avgEq);

        expect(deltaRatio).toBeLessThanOrEqual(maxDeltaRatio);
    });

    it('stream IV domain separation produces different ciphertext/tag across stream IDs', () => {
        const { salt, fileNonce } = generateEncryptionSecrets();
        const key = deriveKey('iv-domain-password', salt, 100_000);
        const aad = new Uint8Array([0x47, 0x49, 0x43, 0x53, 0x03]);
        const payload = Buffer.from('same-plaintext-for-two-streams');

        const a = encryptSection(payload, key, fileNonce, 10, aad);
        const b = encryptSection(payload, key, fileNonce, 20, aad);

        expect(Buffer.compare(Buffer.from(a.ciphertext), Buffer.from(b.ciphertext))).not.toBe(0);
        expect(Buffer.compare(Buffer.from(a.tag), Buffer.from(b.tag))).not.toBe(0);
    });

    it('tampered ciphertext/tag is rejected by decryptSection', () => {
        const { salt, fileNonce } = generateEncryptionSecrets();
        const key = deriveKey('tamper-password', salt, 100_000);
        const aad = new Uint8Array([0x47, 0x49, 0x43, 0x53, 0x03]);
        const payload = Buffer.from('secret payload');

        const encrypted = encryptSection(payload, key, fileNonce, 30, aad);

        const tamperedCipher = new Uint8Array(encrypted.ciphertext);
        tamperedCipher[0] ^= 0x01;
        expect(() => decryptSection(tamperedCipher, encrypted.tag, key, fileNonce, 30, aad)).toThrow();

        const tamperedTag = new Uint8Array(encrypted.tag);
        tamperedTag[0] ^= 0x01;
        expect(() => decryptSection(encrypted.ciphertext, tamperedTag, key, fileNonce, 30, aad)).toThrow();
    });

    it('encrypted pack/unpack succeeds with correct password and fails with wrong password', async () => {
        const snapshots = [
            { timestamp: 1, items: new Map([[1, { price: 100, quantity: 1 }]]) },
            { timestamp: 2, items: new Map([[1, { price: 101, quantity: 1 }]]) },
        ];

        const packed = await GICS.pack(snapshots, { password: 'correct-password' });
        const decoded = await GICS.unpack(packed, { password: 'correct-password' });

        expect(decoded.length).toBe(2);
        expect(decoded[1].items.get(1)?.price).toBe(101);

        await expect(GICS.unpack(packed, { password: 'wrong-password' })).rejects.toThrow();
    });
});
