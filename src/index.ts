/**
 * GICS v1.3 Public API
 *
 * @module gics
 */

import { GICSv2Encoder } from './gics/encode.js';
import { GICSv2Decoder } from './gics/decode.js';
import type { Snapshot } from './gics-types.js';
import type { GICSv2EncoderOptions, GICSv2DecoderOptions, GICSv2Logger } from './gics/types.js';

// Re-export specific types and errors
export type { Snapshot } from './gics-types.js';
export type { GICSv2EncoderOptions as EncoderOptions, GICSv2DecoderOptions as DecoderOptions, GICSv2Logger as Logger } from './gics/types.js';
export { IncompleteDataError, IntegrityError } from './gics/errors.js';

// The GICS Namespace Object
export const GICS = {
    /**
     * Packs an array of snapshots into GICS format.
     */
    pack: async (snapshots: Snapshot[], options?: GICSv2EncoderOptions): Promise<Uint8Array> => {
        const encoder = new GICSv2Encoder(options);
        for (const s of snapshots) await encoder.addSnapshot(s);
        return await encoder.finish();
    },

    /**
     * Unpacks GICS formatted data into an array of snapshots.
     */
    unpack: async (data: Uint8Array, options?: GICSv2DecoderOptions): Promise<Snapshot[]> => {
        const decoder = new GICSv2Decoder(data, options);
        return await decoder.getAllSnapshots();
    },

    /**
     * Verifies the entire file integrity (Hash Chain, CRCs) WITHOUT decompressing payloads.
     */
    verify: async (data: Uint8Array): Promise<boolean> => {
        const decoder = new GICSv2Decoder(data);
        return await decoder.verifyIntegrityOnly();
    },

    /**
     * GICS Encoder class for streaming/append operations.
     */
    Encoder: GICSv2Encoder,

    /**
     * GICS Decoder class for advanced reading/querying.
     */
    Decoder: GICSv2Decoder
};

export default GICS;
