import type { FileHandle } from 'node:fs/promises';
import {
    FILE_EOS_SIZE,
    GICS_ENC_HEADER_SIZE_V3,
    GICS_FLAGS_V3,
    GICS_HEADER_SIZE_V3,
    GICS_EOS_MARKER,
    GICS_MAGIC_V2,
} from './format.js';
import { SegmentHeader } from './segment.js';

export interface ExistingEncryptionHeader {
    encMode: number;
    salt: Uint8Array;
    authVerify: Uint8Array;
    iterations: number;
    fileNonce: Uint8Array;
}

export interface AppendPreparationResult {
    prevRootHash: Uint8Array | null;
    encryptionHeader: ExistingEncryptionHeader | null;
    segmentCount: number;
}

/**
 * File access utilities for GICS v1.3 append support.
 */
export class FileAccess {
    /**
     * Finds the EOS marker and truncates the file to prepare for append.
     * Returns the previous root hash found in the EOS if any, plus enough metadata
     * to decide whether append can safely continue.
     */
    static async prepareForAppend(handle: FileHandle): Promise<AppendPreparationResult> {
        const stats = await handle.stat();
        if (stats.size < 12) {
            return {
                prevRootHash: null,
                encryptionHeader: null,
                segmentCount: 0,
            };
        }

        const eosOffset = stats.size - FILE_EOS_SIZE;
        if (eosOffset < 12) {
            return {
                prevRootHash: null,
                encryptionHeader: null,
                segmentCount: 0,
            };
        }

        const raw = new Uint8Array(await handle.readFile());

        const buffer = new Uint8Array(FILE_EOS_SIZE);
        await handle.read(buffer, 0, FILE_EOS_SIZE, eosOffset);

        if (buffer[0] !== GICS_EOS_MARKER) {
            // Might not have an EOS if it crashed during previous write?
            // For now, let's be strict.
            throw new Error("Cannot append: File EOS marker not found at expected position.");
        }

        const prevRootHash = buffer.slice(1, 33);
        const appendMetadata = FileAccess.inspectAppendMetadata(raw);

        // Truncate to remove the EOS
        await handle.truncate(eosOffset);

        return {
            prevRootHash,
            encryptionHeader: appendMetadata.encryptionHeader,
            segmentCount: appendMetadata.segmentCount,
        };
    }

    /**
     * Writes data at the provided file offset and returns the new offset.
     */
    static async appendData(handle: FileHandle, data: Uint8Array, offset: number): Promise<number> {
        try {
            return await FileAccess.writeFully(handle, data, offset);
        } catch {
            const stats = await handle.stat();
            return await FileAccess.writeFully(handle, data, stats.size);
        }
    }

    private static async writeFully(handle: FileHandle, data: Uint8Array, offset: number): Promise<number> {
        let written = 0;
        while (written < data.length) {
            const { bytesWritten } = await handle.write(
                data,
                written,
                data.length - written,
                offset + written,
            );
            if (bytesWritten <= 0) {
                throw new Error('Failed to append data: zero bytes written.');
            }
            written += bytesWritten;
        }
        return offset + written;
    }

    private static inspectAppendMetadata(raw: Uint8Array): {
        encryptionHeader: ExistingEncryptionHeader | null;
        segmentCount: number;
    } {
        if (raw.length < GICS_HEADER_SIZE_V3) {
            return { encryptionHeader: null, segmentCount: 0 };
        }

        const magicMatch = GICS_MAGIC_V2.every((byte, index) => raw[index] === byte);
        if (!magicMatch || raw[4] !== 0x03) {
            return { encryptionHeader: null, segmentCount: 0 };
        }

        const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
        const flags = view.getUint32(5, true);
        const encrypted = (flags & GICS_FLAGS_V3.ENCRYPTED) !== 0;
        const hasSchema = (flags & GICS_FLAGS_V3.HAS_SCHEMA) !== 0;

        let pos = GICS_HEADER_SIZE_V3;
        let encryptionHeader: ExistingEncryptionHeader | null = null;

        if (encrypted) {
            if (raw.length < pos + GICS_ENC_HEADER_SIZE_V3) {
                throw new Error('Cannot append: Encrypted header is truncated.');
            }

            const encMode = raw[pos++];
            const salt = raw.slice(pos, pos + 16); pos += 16;
            const authVerify = raw.slice(pos, pos + 32); pos += 32;
            pos += 1; // kdfId
            const iterations = view.getUint32(pos, true); pos += 4;
            pos += 1; // digestId
            const fileNonce = raw.slice(pos, pos + 12); pos += 12;

            encryptionHeader = {
                encMode,
                salt,
                authVerify,
                iterations,
                fileNonce,
            };
        }

        if (hasSchema) {
            if (raw.length < pos + 4) {
                throw new Error('Cannot append: Schema length is truncated.');
            }
            const schemaLen = view.getUint32(pos, true);
            pos += 4;
            if (raw.length < pos + schemaLen) {
                throw new Error('Cannot append: Schema payload is truncated.');
            }
            pos += schemaLen;
        }

        const dataEnd = raw.length - FILE_EOS_SIZE;
        let segmentCount = 0;

        while (pos < dataEnd) {
            if (pos + 14 > dataEnd) {
                throw new Error('Cannot append: Trailing segment header is truncated.');
            }
            const header = SegmentHeader.deserialize(raw.subarray(pos, pos + 14));
            if (header.totalLength <= 0) {
                throw new Error('Cannot append: Segment header has invalid totalLength.');
            }
            const nextPos = pos + header.totalLength;
            if (nextPos > dataEnd) {
                throw new Error('Cannot append: Segment exceeds file boundary.');
            }
            pos = nextPos;
            segmentCount++;
        }

        return { encryptionHeader, segmentCount };
    }
}
