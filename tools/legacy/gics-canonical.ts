/**
 * GICS Canonical Interface
 * 
 * Defines the domain-agnostic data structure for the GICS compression engine.
 * The core engine operates ONLY on these types, treating all data as abstract streams.
 */

/**
 * Universal entity identifier (e.g., "item:1234", "ticker:AAPL", "patient:99").
 * Must be a stable string.
 */
export type EntityId = string;

/**
 * Stream identifier (e.g., "price", "bpm", "close").
 * Used to map specific variables within a time-series.
 */
export type StreamName = string;

/**
 * A single point in a stream.
 * 
 * @property t - Timestamp (monotonic integer). Units defined by producer (e.g., ms, seconds).
 * @property v - Value (integer). Floats must be quantized before ingestion.
 */
export interface StreamPoint {
    t: number;
    v: number;
}

/**
 * A canonical frame representing a single event for an entity.
 * Equivalent to a "row" in a table or a "snapshot" in legacy terms.
 */
export interface GicsFrame {
    /** Who/What this data is about */
    entityId: EntityId;
    /** When this event occurred */
    timestamp: number;
    /** The data payload (map of streams) */
    streams: Record<StreamName, number>;
    /** Optional metadata (not compressed, pass-through) */
    meta?: Record<string, any>;
}

/**
 * A generic stream of data for an entity (Batch form).
 */
export interface GicsStream {
    entityId: EntityId;
    streamName: StreamName;
    points: StreamPoint[];
}

/**
 * Core Configuration for Agnostic Processing
 */
export interface GicsOptions {
    /** 
     * Quantization factor for values (if needed by adapter).
     * Core expects integers, so this is metadata for the consumer.
     */
    quantization?: number;

    /** 
     * Expected data frequency (hint for delta encoding).
     */
    frequencyHint?: number;
}
