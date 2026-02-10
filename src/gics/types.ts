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
