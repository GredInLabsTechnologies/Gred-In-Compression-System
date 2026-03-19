import { pbkdf2Sync, createHmac, createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { IntegrityError } from './errors.js';
import { GICS_ENC_MODE_LEGACY_STREAM, GICS_ENC_MODE_SEGMENT_STREAM } from './format.js';

/**
 * GICS v1.3 Encryption Implementation
 * 
 * Provides AES-256-GCM encryption with PBKDF2 key derivation.
 * Ensures deterministic IVs per stream/segment using HMAC(key, fileNonce || ...).
 */

const AUTH_CONSTANT = Buffer.from('GICS_V1.3_AUTH_VERIFY');

export interface EncryptionContext {
    key: Buffer;
    fileNonce: Uint8Array;
}

export interface SectionEncryptionOptions {
    encMode?: number;
    segmentOrdinal?: number;
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
    const stored = Buffer.from(storedAuthVerify);
    // Constant-time compare to reduce timing side-channel leakage.
    // Keep deterministic false when lengths mismatch.
    if (currentAuth.length !== stored.length) return false;
    return timingSafeEqual(currentAuth, stored);
}

/**
 * Derives the legacy deterministic 12-byte IV for a specific stream.
 * IV = HMAC-SHA256(key, fileNonce || streamId).slice(0, 12)
 */
function deriveLegacyStreamIV(key: Buffer, fileNonce: Uint8Array, streamId: number): Buffer {
    const hmac = createHmac('sha256', key);
    hmac.update(Buffer.from(fileNonce));
    hmac.update(Buffer.from([streamId]));
    return Buffer.from(hmac.digest().subarray(0, 12));
}

function deriveSegmentStreamIV(key: Buffer, fileNonce: Uint8Array, segmentOrdinal: number, streamId: number): Buffer {
    const hmac = createHmac('sha256', key);
    hmac.update(Buffer.from(fileNonce));

    const segmentBuf = Buffer.allocUnsafe(4);
    segmentBuf.writeUInt32LE(segmentOrdinal >>> 0, 0);
    hmac.update(segmentBuf);

    const streamBuf = Buffer.allocUnsafe(4);
    streamBuf.writeUInt32LE(streamId >>> 0, 0);
    hmac.update(streamBuf);

    return Buffer.from(hmac.digest().subarray(0, 12));
}

function deriveSectionIV(
    key: Buffer,
    fileNonce: Uint8Array,
    streamId: number,
    encMode: number,
    segmentOrdinal: number
): Buffer {
    switch (encMode) {
        case GICS_ENC_MODE_LEGACY_STREAM:
            return deriveLegacyStreamIV(key, fileNonce, streamId);
        case GICS_ENC_MODE_SEGMENT_STREAM:
            return deriveSegmentStreamIV(key, fileNonce, segmentOrdinal, streamId);
        default:
            throw new Error(`GICS v1.3: Unsupported encryption mode ${encMode}`);
    }
}

/**
 * Encrypts data using AES-256-GCM.
 */
export function encryptSection(
    data: Uint8Array,
    key: Buffer,
    fileNonce: Uint8Array,
    streamId: number,
    aad: Uint8Array,
    options: SectionEncryptionOptions = {}
): { ciphertext: Uint8Array; tag: Uint8Array } {
    const encMode = options.encMode ?? GICS_ENC_MODE_LEGACY_STREAM;
    const segmentOrdinal = options.segmentOrdinal ?? 0;
    const iv = deriveSectionIV(key, fileNonce, streamId, encMode, segmentOrdinal);
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
    aad: Uint8Array,
    options: SectionEncryptionOptions = {}
): Uint8Array {
    const encMode = options.encMode ?? GICS_ENC_MODE_LEGACY_STREAM;
    const segmentOrdinal = options.segmentOrdinal ?? 0;
    const iv = deriveSectionIV(key, fileNonce, streamId, encMode, segmentOrdinal);
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
 * Generates a random 16-byte salt and 12-byte file nonce.
 */
export function generateEncryptionSecrets(): { salt: Uint8Array; fileNonce: Uint8Array } {
    return {
        salt: new Uint8Array(randomBytes(16)),
        fileNonce: new Uint8Array(randomBytes(12))
    };
}
