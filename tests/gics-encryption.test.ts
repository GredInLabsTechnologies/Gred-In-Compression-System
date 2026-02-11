import { describe, it, expect, beforeEach } from 'vitest';
import {
    deriveKey,
    generateAuthVerify,
    verifyAuth,
    encryptSection,
    decryptSection,
    generateEncryptionSecrets,
} from '../src/gics/encryption.js';
import { IntegrityError } from '../src/gics/errors.js';

describe('GICS Encryption Module', () => {
    // Fixed Test Vectors
    const password = 'secure-password-123';
    const salt = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    const iterations = 1000;
    const fileNonce = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120]);
    const streamId = 42;
    const aad = new Uint8Array([0xAA, 0xBB, 0xCC]);
    const testData = new Uint8Array(Buffer.from('Hello, World! This is a test payload.'));

    // Derived Key (for reuse in tests)
    let key: Buffer;

    beforeEach(() => {
        key = deriveKey(password, salt, iterations);
    });

    describe('deriveKey', () => {
        it('should derive a key deterministically', () => {
            const key2 = deriveKey(password, salt, iterations);
            expect(key).toBeInstanceOf(Buffer);
            expect(key.length).toBe(32); // SHA-256 => 32 bytes
            expect(key.equals(key2)).toBe(true);
        });

        it('should generate different keys for different inputs', () => {
            const diffPassword = deriveKey('different-password', salt, iterations);
            const diffSalt = deriveKey(password, new Uint8Array(16).fill(0), iterations);
            const diffIterations = deriveKey(password, salt, iterations + 1);

            expect(key.equals(diffPassword)).toBe(false);
            expect(key.equals(diffSalt)).toBe(false);
            expect(key.equals(diffIterations)).toBe(false);
        });
    });

    describe('generateEncryptionSecrets', () => {
        it('should generate valid encryption secrets', () => {
            const secrets = generateEncryptionSecrets();
            expect(secrets).toHaveProperty('salt');
            expect(secrets).toHaveProperty('fileNonce');
            expect(secrets.salt.length).toBe(16);
            expect(secrets.fileNonce.length).toBe(12);

            // Check non-zero (highly unlikely to be all zeros)
            expect(secrets.salt.some(b => b !== 0)).toBe(true);
            expect(secrets.fileNonce.some(b => b !== 0)).toBe(true);
        });

        it('should generate unique secrets on subsequent calls', () => {
            const s1 = generateEncryptionSecrets();
            const s2 = generateEncryptionSecrets();
            // Compare bytes
            expect(Buffer.from(s1.salt).equals(Buffer.from(s2.salt))).toBe(false);
            expect(Buffer.from(s1.fileNonce).equals(Buffer.from(s2.fileNonce))).toBe(false);
        });
    });

    describe('Auth Verification', () => {
        it('should generate and verify auth successfully with correct key', () => {
            const authVerify = generateAuthVerify(key);
            expect(authVerify.length).toBe(32); // HMAC-SHA256 => 32 bytes

            const isValid = verifyAuth(key, authVerify);
            expect(isValid).toBe(true);
        });

        it('should fail verification with incorrect key', () => {
            const authVerify = generateAuthVerify(key);
            const wrongKey = deriveKey('wrong-password', salt, iterations);

            const isValid = verifyAuth(wrongKey, authVerify);
            expect(isValid).toBe(false);
        });

        it('should fail verification with tampered auth tag', () => {
            const authVerify = generateAuthVerify(key);
            const tamperedAuth = new Uint8Array(authVerify);
            tamperedAuth[0] ^= 0xFF; // Flip bits in first byte

            const isValid = verifyAuth(key, tamperedAuth);
            expect(isValid).toBe(false);
        });
    });

    describe('Encryption & Decryption (Round-trip)', () => {
        it('should encrypt and decrypt correctly', () => {
            const { ciphertext, tag } = encryptSection(testData, key, fileNonce, streamId, aad);

            // Basic checks on output structure
            expect(ciphertext).toBeInstanceOf(Uint8Array);
            expect(tag).toBeInstanceOf(Uint8Array);
            expect(tag.length).toBe(16); // GCM default tag length
            // Ciphertext length matches plaintext length for GCM (no padding needed usually, but block size is 16)
            expect(ciphertext.length).toBe(testData.length);

            const plaintext = decryptSection(ciphertext, tag, key, fileNonce, streamId, aad);
            expect(Buffer.from(plaintext).equals(Buffer.from(testData))).toBe(true);
        });

        it('should produce deterministic ciphertext for same inputs (IV determinism)', () => {
            const result1 = encryptSection(testData, key, fileNonce, streamId, aad);
            const result2 = encryptSection(testData, key, fileNonce, streamId, aad);

            expect(Buffer.from(result1.ciphertext).equals(Buffer.from(result2.ciphertext))).toBe(true);
            expect(Buffer.from(result1.tag).equals(Buffer.from(result2.tag))).toBe(true);
        });

        it('should produce different ciphertext for different streamId (IV separation)', () => {
            const result1 = encryptSection(testData, key, fileNonce, streamId, aad);
            const result2 = encryptSection(testData, key, fileNonce, streamId + 1, aad); // Diff streamId

            // Ciphertext must differ because IV is different
            expect(Buffer.from(result1.ciphertext).equals(Buffer.from(result2.ciphertext))).toBe(false);
            // Tag will also differ
            expect(Buffer.from(result1.tag).equals(Buffer.from(result2.tag))).toBe(false);
        });

        it('should produce different ciphertext for different fileNonce', () => {
             const diffFileNonce = new Uint8Array(fileNonce);
             diffFileNonce[0] ^= 0xFF;

             const result1 = encryptSection(testData, key, fileNonce, streamId, aad);
             const result2 = encryptSection(testData, key, diffFileNonce, streamId, aad);

             expect(Buffer.from(result1.ciphertext).equals(Buffer.from(result2.ciphertext))).toBe(false);
        });
    });

    describe('Error Handling (IntegrityError)', () => {
        let encrypted: { ciphertext: Uint8Array; tag: Uint8Array };

        beforeEach(() => {
            encrypted = encryptSection(testData, key, fileNonce, streamId, aad);
        });

        it('should throw IntegrityError on tampered ciphertext', () => {
            const tamperedCiphertext = new Uint8Array(encrypted.ciphertext);
            if (tamperedCiphertext.length > 0) {
                tamperedCiphertext[0] ^= 0xFF; // Modify first byte
            } else {
                 throw new Error("Test data too short");
            }

            expect(() => {
                decryptSection(tamperedCiphertext, encrypted.tag, key, fileNonce, streamId, aad);
            }).toThrow(IntegrityError);
        });

        it('should throw IntegrityError on tampered tag', () => {
            const tamperedTag = new Uint8Array(encrypted.tag);
            tamperedTag[0] ^= 0xFF; // Modify first byte

            expect(() => {
                decryptSection(encrypted.ciphertext, tamperedTag, key, fileNonce, streamId, aad);
            }).toThrow(IntegrityError);
        });

        it('should throw IntegrityError on incorrect AAD', () => {
            const wrongAad = new Uint8Array(aad);
            wrongAad[0] ^= 0xFF; // Modify first byte

            expect(() => {
                decryptSection(encrypted.ciphertext, encrypted.tag, key, fileNonce, streamId, wrongAad);
            }).toThrow(IntegrityError);
        });

        it('should throw IntegrityError on incorrect Key', () => {
            const wrongKey = deriveKey('wrong-password', salt, iterations);

            expect(() => {
                decryptSection(encrypted.ciphertext, encrypted.tag, wrongKey, fileNonce, streamId, aad);
            }).toThrow(IntegrityError);
        });

         it('should throw IntegrityError on incorrect StreamID', () => {
            // Decrypting with wrong streamID means wrong IV => GCM failure
            expect(() => {
                decryptSection(encrypted.ciphertext, encrypted.tag, key, fileNonce, streamId + 999, aad);
            }).toThrow(IntegrityError);
        });
    });
});
