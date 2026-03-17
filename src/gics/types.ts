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
    /**
     * Soft minimum temporal depth for stable multi-item segments.
     * When item-major layout is active, GICS prefers keeping at least this many
     * snapshots together to avoid ratio collapse from shallow temporal windows.
     * Default: 256.
     */
    minSnapshotsPerSegment?: number;
    /**
     * Safety cap for temporal segment depth in stable multi-item mode.
     * Prevents pathological memory growth while still allowing long-horizon compression.
     * Default: 1024.
     */
    maxSnapshotsPerSegment?: number;
    /**
     * Safety cap for total items per segment.
     * Applies to both stable multi-item and size-based fallback grouping.
     * Default: 1,000,000.
     */
    maxItemsPerSegment?: number;
    /**
     * Auto-flush after this many buffered snapshots.
     * Set to 0 to disable. Default: 0.
     */
    autoFlushThreshold?: number;
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

export type GICSv2AdaptiveRotationOptions = {
    /** Enable adaptive rotation decisions. Default: true. */
    enabled?: boolean;
    /** EWMA smoothing factor in range (0, 1]. Default: 0.25. */
    ewmaAlpha?: number;
    /** Rotate when latency EWMA exceeds this budget (microseconds per snapshot). Default: 4000. */
    latencyPerSnapshotUsBudget?: number;
    /** Rotate when ratio EWMA drops by this percentage from best observed EWMA. Default: 25. */
    ratioDropPct?: number;
    /** Rotate when process heap goes above this threshold. Default: 768 MB. */
    heapHighWaterMB?: number;
    /** Consecutive adaptive breaches required before rotating. Default: 3. */
    consecutiveBreachesToRotate?: number;
    /** Minimum flushes between adaptive rotations. Default: 2. */
    cooldownFlushes?: number;
};

export type GICSv2RotationOptions = {
    /** Directory where session manifest + rotated parts are stored. */
    sessionDir: string;
    /** Session identifier used in deterministic file names. */
    sessionId?: string;
    /** Optional explicit manifest path. Defaults to <sessionDir>/<sessionId>.manifest.json */
    manifestPath?: string;
    /** Encoder options passed to each part encoder instance. */
    encoderOptions?: GICSv2EncoderOptions;
    /** Auto-flush cadence managed by rotator. Default: 1024 snapshots. */
    flushEverySnapshots?: number;
    /** Hard limit: rotate when current file reaches this size. Default: 512 MB. */
    maxFileBytes?: number;
    /** Hard limit: rotate when current file reaches this many snapshots. Default: 1,000,000. */
    maxSnapshotsPerFile?: number;
    /** Hard limit: rotate when current file reaches this many segments. Default: 4096. */
    maxSegmentsPerFile?: number;
    /** Hard limit: rotate when file age exceeds this duration. Default: 24h. */
    maxFileDurationMs?: number;
    /** Hybrid adaptive policy settings. */
    adaptive?: GICSv2AdaptiveRotationOptions;
};

export type GICSSessionFileEntry = {
    path: string;
    seq: number;
    firstTs: number | null;
    lastTs: number | null;
    snapshots: number;
    bytes: number;
    segmentCount: number;
    startSeedHash: string;
    endRootHash: string;
    sha256: string;
    rotationReason: string;
    orphaned?: boolean;
};

export type GICSSessionManifest = {
    sessionId: string;
    formatVersion: 1;
    createdAt: string;
    closedAt: string | null;
    files: GICSSessionFileEntry[];
    lastCommittedSeq: number;
    lastRootHash: string | null;
};

export type GICSSessionReadOptions = {
    /** Strict mode throws on any verification or continuity mismatch. Default: true. */
    strict?: boolean;
    /** Verify only (skip decode); readSession returns an empty array when true. Default: false. */
    integrityOnly?: boolean;
    /** Maximum number of files to process (0 = no limit). Default: 0. */
    maxFiles?: number;
    /** When true, include orphaned files in processing. Default: false. */
    includeOrphaned?: boolean;
    /** Optional decoder options forwarded to per-file decoder. */
    decoderOptions?: GICSv2DecoderOptions;
};

export type GICSSessionVerifyResult = {
    ok: boolean;
    filesChecked: number;
    orphanedSkipped: number;
    lastRootHash: string | null;
};
