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
};
