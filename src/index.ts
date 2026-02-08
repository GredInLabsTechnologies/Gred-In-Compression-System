/**
 * GICS Core API
 * 
 * @module gics
 */

import { GICSv2Encoder } from './gics/encode.js';
import { GICSv2Decoder } from './gics/decode.js';
import type { Snapshot } from './gics-types.js';
import type { HybridConfig } from './gics-hybrid.js';

export { GICSv2Encoder } from './gics/encode.js';
export { GICSv2Decoder } from './gics/decode.js';
export * from './gics/errors.js';
export * from './gics-types.js';
export * from './gics-hybrid.js'; // Keep types but not usage?
export * from './gics-utils.js';
export * from './HeatClassifier.js';
export * from './IntegrityGuardian.js';
export * from './CryptoProvider.js';
export * from './gics-range-reader.js';

/**
 * Public Encoder Entry Point - v1.2 Canonical
 */
export async function gics_encode(snapshots: Snapshot[], config?: HybridConfig): Promise<Uint8Array> {
    const encoder = new GICSv2Encoder();
    for (const s of snapshots) await encoder.addSnapshot(s);
    return await encoder.finish();
}

/**
 * Public Decoder Entry Point - v1.2 Canonical
 */
export async function gics_decode(data: Uint8Array): Promise<Snapshot[]> {
    const decoder = new GICSv2Decoder(data);
    return await decoder.getAllSnapshots();
}

/**
 * GICS v1.3 Standard API
 */
export const GICS = {
    pack: gics_encode,
    unpack: gics_decode,
    /**
     * Verifies the entire file integrity (Hash Chain, CRCs) WITHOUT decompressing payloads.
     */
    verify: async (data: Uint8Array): Promise<boolean> => {
        const decoder = new GICSv2Decoder(data);
        return await decoder.verifyIntegrityOnly();
    }
};
