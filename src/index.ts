/**
 * GICS v1.1 - Canonical Public API
 * 
 * @module gics
 * @version 1.1.0 (Active Dev)
 * @status FROZEN - Canonical implementation available via version switch
 * @see docs/GICS_V1.1_SPEC.md
 */

import { gics11_encode, gics11_decode } from '../gics_frozen/v1_1_0/index.js';
export { GICSv2Encoder } from './gics/v1_2/encode.js'; // [NEW] v1.2
export { GICSv2Decoder } from './gics/v1_2/decode.js'; // [NEW] v1.2
import { HybridReader, HybridWriter, type HybridConfig } from './gics-hybrid.js';
import type { Snapshot } from './gics-types.js';

export * from './gics-types.js';
export * from './gics-hybrid.js';
export * from './gics-utils.js';
export * from './HeatClassifier.js';
export * from './IntegrityGuardian.js';
export * from './CryptoProvider.js';
export * from './gics-range-reader.js';

/**
 * Public Encoder Entry Point
 * Routes to Fixed v1.1 or Active Development (v1.2+) based on GICS_VERSION env var.
 */
export async function gics_encode(snapshots: Snapshot[], config?: HybridConfig): Promise<Uint8Array> {
    if (process.env.GICS_VERSION === '1.1') {
        // Route to immutable frozen snapshot
        return gics11_encode(snapshots, config);
    }
    else if (process.env.GICS_VERSION === '1.2') {
        // [NEW] Route to v1.2 module
        const encoder = new GICSv2Encoder();
        for (const s of snapshots) await encoder.addSnapshot(s);
        const data = await encoder.flush();
        await encoder.finalize();
        return data;
    }

    // Default: Route to active implementation (current main)
    const writer = new HybridWriter(config);
    for (const s of snapshots) await writer.addSnapshot(s);
    return await writer.finish();
}

/**
 * Public Decoder Entry Point
 * Routes to Fixed v1.1 or Active Development (v1.2+) based on GICS_VERSION env var.
 */
export async function gics_decode(data: Uint8Array): Promise<Snapshot[]> {
    if (process.env.GICS_VERSION === '1.1') {
        // Route to immutable frozen snapshot
        return gics11_decode(data);
    }
    else if (process.env.GICS_VERSION === '1.2') {
        // [NEW] Route to v1.2 module (which handles backward compat too)
        const decoder = new GICSv2Decoder(data);
        return await decoder.getAllSnapshots();
    }

    // Default: Route to active implementation (current main)
    const reader = new HybridReader(data);
    return await reader.getAllSnapshots();
}
