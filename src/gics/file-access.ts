import type { FileHandle } from 'node:fs/promises';
import { FILE_EOS_SIZE, GICS_EOS_MARKER } from './format.js';

/**
 * File access utilities for GICS v1.3 append support.
 */
export class FileAccess {
    /**
     * Finds the EOS marker and truncates the file to prepare for append.
     * Returns the previous root hash found in the EOS if any.
     */
    static async prepareForAppend(handle: FileHandle): Promise<Uint8Array | null> {
        const stats = await handle.stat();
        if (stats.size < 12) return null; // Too small to even have a header

        const eosOffset = stats.size - FILE_EOS_SIZE;
        if (eosOffset < 12) return null;

        const buffer = new Uint8Array(FILE_EOS_SIZE);
        await handle.read(buffer, 0, FILE_EOS_SIZE, eosOffset);

        if (buffer[0] !== GICS_EOS_MARKER) {
            // Might not have an EOS if it crashed during previous write?
            // For now, let's be strict.
            throw new Error("Cannot append: File EOS marker not found at expected position.");
        }

        const prevRootHash = buffer.slice(1, 33);

        // Truncate to remove the EOS
        await handle.truncate(eosOffset);

        return prevRootHash;
    }

    /**
     * Writes data to the end of the file.
     */
    static async appendData(handle: FileHandle, data: Uint8Array): Promise<void> {
        const stats = await handle.stat();
        await handle.write(data, 0, data.length, stats.size);
    }
}
