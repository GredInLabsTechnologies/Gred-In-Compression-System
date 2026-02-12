/**
 * GICS v1.3 Public API
 *
 * @module gics
 */

import { GICSv2Encoder } from './gics/encode.js';
import { GICSv2Decoder } from './gics/decode.js';
import type { Snapshot } from './gics-types.js';
import type { GICSv2EncoderOptions, GICSv2DecoderOptions } from './gics/types.js';

// Re-export specific types and errors
export type { Snapshot, GenericSnapshot, SchemaProfile, FieldDef } from './gics-types.js';
export type { GICSv2EncoderOptions as EncoderOptions, GICSv2DecoderOptions as DecoderOptions, GICSv2Logger as Logger, CompressionPreset } from './gics/types.js';
export { COMPRESSION_PRESETS } from './gics/types.js';
export { IncompleteDataError, IntegrityError } from './gics/errors.js';
export { CompressionProfiler } from './gics/profiler.js';
export type { ProfileResult, ProfileMode, TrialResult, ProfileMeta } from './gics/profiler.js';

import type { SchemaProfile } from './gics-types.js';

/** Predefined schema profiles */
const PREDEFINED_SCHEMAS: Record<string, SchemaProfile> = {
    /** Legacy market data schema (price + quantity) — equivalent to no-schema mode */
    MARKET_DATA: {
        id: 'market_data_v1',
        version: 1,
        itemIdType: 'number',
        fields: [
            { name: 'price', type: 'numeric', codecStrategy: 'value' },
            { name: 'quantity', type: 'numeric', codecStrategy: 'structural' },
        ],
    },
    /** Trust events schema for GIMO integration */
    TRUST_EVENTS: {
        id: 'gimo_trust_v1',
        version: 1,
        itemIdType: 'string',
        fields: [
            { name: 'score', type: 'numeric', codecStrategy: 'value' },
            { name: 'approvals', type: 'numeric', codecStrategy: 'structural' },
            { name: 'rejections', type: 'numeric', codecStrategy: 'structural' },
            { name: 'failures', type: 'numeric', codecStrategy: 'structural' },
            { name: 'streak', type: 'numeric', codecStrategy: 'structural' },
            { name: 'outcome', type: 'categorical', enumMap: { approved: 0, rejected: 1, error: 2, timeout: 3, auto_approved: 4 } },
        ],
    },
};

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
    Decoder: GICSv2Decoder,

    /**
     * Predefined schema profiles for common use cases.
     */
    schemas: PREDEFINED_SCHEMAS,
};

export default GICS;

// v1.3.2: Daemon and Insight Engine modules
export { GICSDaemon } from './daemon/server.js';
export type { GICSDaemonConfig } from './daemon/server.js';
export { MemTable } from './daemon/memtable.js';
export type { MemRecord, MemTableConfig } from './daemon/memtable.js';
export { FileLock } from './daemon/file-lock.js';
export { InsightTracker } from './insight/tracker.js';
export type { ItemBehavior, FieldTrend, LifecycleStage, InsightTrackerConfig } from './insight/tracker.js';
export { CorrelationAnalyzer } from './insight/correlation.js';
export type { Correlation, Cluster, LeadingIndicator, SeasonalPattern } from './insight/correlation.js';
export { PredictiveSignals } from './insight/signals.js';
export type { Anomaly, TrendForecast, Recommendation } from './insight/signals.js';
export { ConfidenceTracker } from './insight/confidence.js';
export type { InsightConfidence, Outcome } from './insight/confidence.js';
export { InsightPersistence } from './insight/persistence.js';
