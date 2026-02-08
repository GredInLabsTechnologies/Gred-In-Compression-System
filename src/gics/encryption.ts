import { pbkdf2Sync, createHmac, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { IntegrityError } from './errors.js';

/**
 * GICS v1.3 Encryption Implementation
 * 
 * Provides AES-256-GCM encryption with PBKDF2 key derivation.
 * Ensures deterministic IVs per stream using HMAC(key, fileNonce || streamId).
 */

const AUTH_CONSTANT = Buffer.from('GICS_V1.3_AUTH_VERIFY');

export interface EncryptionContext {
    key: Buffer;
    fileNonce: Uint8Array;
}

/**
 * Derives a 256-bit key from a password and salt using PBKDF2-SHA256.
 */
export function deriveKey(password: string, salt: Uint8Array, iterations: number): Buffer {
    return pbkdf2Sync(password, Buffer.from(salt), iterations, 32, 'sha256');
}

/**
 * Generates an authVerify tag (32 bytes) to verify the password later.
 */
export function generateAuthVerify(key: Buffer): Buffer {
    return createHmac('sha256', key).update(AUTH_CONSTANT).digest();
}

/**
 * Verifies if the provided key is correct using the stored authVerify tag.
 */
export function verifyAuth(key: Buffer, storedAuthVerify: Uint8Array): boolean {
    const currentAuth = generateAuthVerify(key);
    return Buffer.compare(currentAuth, Buffer.from(storedAuthVerify)) === 0;
}

/**
 * Derives a deterministic 12-byte IV for a specific stream.
 * IV = HMAC-SHA256(key, fileNonce || streamId).slice(0, 12)
 */
function deriveStreamIV(key: Buffer, fileNonce: Uint8Array, streamId: number): Buffer {
    const hmac = createHmac('sha256', key);
    hmac.update(Buffer.from(fileNonce));
    hmac.update(Buffer.from([streamId]));
    return Buffer.from(hmac.digest().subarray(0, 12));
}

/**
 * Encrypts data using AES-256-GCM.
 */
export function encryptSection(
    data: Uint8Array,
    key: Buffer,
    fileNonce: Uint8Array,
    streamId: number,
    aad: Uint8Array
): { ciphertext: Uint8Array; tag: Uint8Array } {
    const iv = deriveStreamIV(key, fileNonce, streamId);
    const cipher = createCipheriv('aes-256-gcm', key, iv);

    cipher.setAAD(Buffer.from(aad));

    const ciphertext = Buffer.concat([
        cipher.update(Buffer.from(data)),
        cipher.final()
    ]);

    const tag = cipher.getAuthTag();

    return {
        ciphertext: new Uint8Array(ciphertext),
        tag: new Uint8Array(tag)
    };
}

/**
 * Decrypts data using AES-256-GCM.
 */
export function decryptSection(
    ciphertext: Uint8Array,
    tag: Uint8Array,
    key: Buffer,
    fileNonce: Uint8Array,
    streamId: number,
    aad: Uint8Array
): Uint8Array {
    const iv = deriveStreamIV(key, fileNonce, streamId);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);

    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(Buffer.from(tag));

    try {
        const plaintext = Buffer.concat([
            decipher.update(Buffer.from(ciphertext)),
            decipher.final()
        ]);
        return new Uint8Array(plaintext);
    } catch (err) {
        throw new IntegrityError(`GICS v1.3: Decryption failed for stream ${streamId}. Possible wrong password or tampered data: ${err instanceof Error ? err.message : String(err)}`);
    }
}

/**
 * Generates a random 16-byte salt and 8-byte file nonce.
 */
export function generateEncryptionSecrets(): { salt: Uint8Array; fileNonce: Uint8Array } {
    return {
        salt: new Uint8Array(randomBytes(16)),
        fileNonce: new Uint8Array(randomBytes(8))
    };
}
