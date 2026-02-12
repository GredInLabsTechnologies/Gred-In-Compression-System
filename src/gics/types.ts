export type GICSv2Logger = {
    info?: (msg: string) => void;
    warn?: (msg: string) => void;
    error?: (msg: string) => void;
};

export type GICSv2SidecarWriter = (args: {
    filename: string;
    report: unknown;
    encoderRunId: string;
}) => Promise<void> | void;

/**
 * Reproducible compression presets. Each preset maps to well-tested
 * compressionLevel + blockSize combinations.
 *
 * - `balanced`: Good ratio with moderate CPU (default)
 * - `max_ratio`: Best ratio, higher CPU cost
 * - `low_latency`: Fastest encode, lower ratio
 */
export type CompressionPreset = 'balanced' | 'max_ratio' | 'low_latency';

export const COMPRESSION_PRESETS: Record<CompressionPreset, { compressionLevel: number; blockSize: number }> = {
    balanced:    { compressionLevel: 3, blockSize: 1000 },
    max_ratio:   { compressionLevel: 9, blockSize: 4000 },
    low_latency: { compressionLevel: 1, blockSize: 512 },
};

export type GICSv2EncoderOptions = {
    /** Stable identifier for telemetry/sidecars (useful for tests). */
    runId?: string;
    /** Context sharing mode. `off` disables dictionary and uses context-id = null. */
    contextMode?: 'on' | 'off';
    /** CHM probes interval (default 4). */
    probeInterval?: number;
    /** Optional writer hook to persist anomaly reports (sidecar). */
    sidecarWriter?: GICSv2SidecarWriter | null;
    /** Optional logger hook to surface CHM / debug messages without console.* in src/. */
    logger?: GICSv2Logger | null;
    /** Segment size limit in bytes (uncompressed estimation). Default 1MB. */
    segmentSizeLimit?: number;
    /** Optional password for AES-256-GCM encryption (v1.3+). */
    password?: string;
    /** Optional schema profile for generic field encoding. If omitted, legacy price/quantity mode. */
    schema?: import('../gics-types.js').SchemaProfile;
    /** Compression preset. Sets compressionLevel and blockSize to well-tested defaults. */
    preset?: CompressionPreset;
    /** Zstd compression level (1-22). Overrides preset value if both are set. Default: 3. */
    compressionLevel?: number;
    /** Items per block (256-16384). Overrides preset value if both are set. Default: 1000. */
    blockSize?: number;
};

export type GICSv2DecoderOptions = {
    /** 
     * Integrity verification mode for v1.3 hash chain.
     * - 'strict' (default): Throw IntegrityError on hash mismatch (fail-closed)
     * - 'warn': Log warning but continue decoding (fail-open, use with caution)
     */
    integrityMode?: 'strict' | 'warn';
    /** Optional logger for warnings in 'warn' mode */
    logger?: GICSv2Logger | null;
    /** Password for AES-256-GCM encryption (v1.3+). */
    password?: string;
};
