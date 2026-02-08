/**
 * Compression Health Monitor (CHM)
 * Tracks entropy and compression ratio to detect anomalies (Regime Shifts).
 */

import { BlockMetrics } from './metrics.js';
import { HealthTag, BLOCK_FLAGS } from './format.js';

export interface AnomalyReport {
    schema_version: 1;
    run_id: string;
    gics_version: string;
    segments: AnomalySegment[];
    worst_blocks: WorstBlock[];
}

export interface AnomalySegment {
    segment_id: string;
    start_block_index: number;
    end_block_index?: number; // open if undefined
    reason_code: string;
    min_ratio: number;
    max_unique_ratio_proxy: number;
    suggested_action: string;
    probe_attempts?: number;
    probe_successes?: number;
}

export interface WorstBlock {
    block_index: number;
    ratio: number;
    entropy: number;
    codec_id: number;
}

export enum RoutingDecision {
    CORE = 'CORE',
    QUARANTINE = 'QUARANTINE'
}

export enum CHMState {
    NORMAL = 'NORMAL',
    QUARANTINE_ACTIVE = 'QUARANTINE_ACTIVE'
}

export class HealthMonitor {
    // Config (Fixed Defaults per Spec)
    // CHM Configuration (Split-4.2.1 Hardening)
    public readonly K_RATIO_DEV_TRIGGER = 3.0;   // Trigger threshold (Sigma)
    public readonly K_RATIO_DEV_RECOVERY = 10.0;  // Recovery threshold (Sigma)
    public readonly PROBE_INTERVAL: number;       // Blocks between probes (Injected)
    public readonly M_RECOVERY_BLOCKS = 3;       // Consecutive successes needed
    private readonly EMA_ALPHA = 0.1;            // Smoothing factor

    // State
    private state: CHMState = CHMState.NORMAL;

    // Baseline Statstics (Exponential Moving Average)
    private baselineRatio: number = 2.0; // Initial optimistic guess
    private baselineRatioDev: number = 0.5;
    private baselineUniqueRatioProxy: number = 0.5; // "Entropy"

    // Frozen Baselines (Snapshot at Anomaly Start)
    private frozenBaselineRatio: number | null = null;

    // State Tracking
    private totalBlocks = 0;
    private quarantineStartBlock = -1;
    private recoveryCounter = 0;

    // Split-5 Stats
    private stats = {
        core_blocks: 0,
        core_input_bytes: 0,
        core_output_bytes: 0,
        quar_blocks: 0,
        quar_input_bytes: 0,
        quar_output_bytes: 0
    };

    getStats() {
        return { ...this.stats };
    }

    // Reporting
    private anomalies: AnomalySegment[] = [];
    private worstBlocks: WorstBlock[] = []; // Top 10 worst

    // History
    private lastBlockIndexSeen = 0;

    private currentSegment: AnomalySegment | null = null;

    constructor(private runId: string, probeInterval: number = 4) {
        this.PROBE_INTERVAL = probeInterval;
    }

    /**
     * DECIDE ROUTE (Router-First)
     * Determines whether the block belongs in CORE or QUARANTINE.
     * Does NOT update state (stateless check).
     * @param probeRatio - Ratio from a dry-run encode (Normal Attempt). Required if in Normal or Probing.
     */
    decideRoute(metrics: BlockMetrics, probeRatio: number, blockIndex: number): { decision: RoutingDecision, reason: string | null } {


        // 0. ENTROPY GATE (Hard Guard)
        // Prevent high-entropy noise from ever entering CORE, regardless of ratio.
        if (metrics.unique_ratio > 0.85 && metrics.unique_delta_ratio > 0.85) {
            return { decision: RoutingDecision.QUARANTINE, reason: 'ENTROPY_GATE' };
        }

        // 1. If currently NORMAL, check for Anomaly (Entry Condition)
        if (this.state === CHMState.NORMAL) {
            const detection = this.detectAnomaly(probeRatio, metrics.unique_ratio);
            if (detection.isAnomaly) {
                console.log(`[CHM] ANOMALY DETECTED! Ratio=${probeRatio.toFixed(2)} < Threshold. Base=${this.baselineRatio.toFixed(2)} Reason=${detection.reason}`);
                return { decision: RoutingDecision.QUARANTINE, reason: detection.reason };
            }
            return { decision: RoutingDecision.CORE, reason: null };
        }

        // 2. If currently QUARANTINE (Active), check for Recovery (Exit Condition)
        if (this.state === CHMState.QUARANTINE_ACTIVE) {
            // Recovery is evaluated only on probe blocks to avoid short-circuit recovery.
            // (See PROBE_INTERVAL + M_RECOVERY_BLOCKS contract.)
            const shouldProbe = (blockIndex % this.PROBE_INTERVAL) === 0;
            if (!shouldProbe) {
                return { decision: RoutingDecision.QUARANTINE, reason: 'QUARANTINE_ACTIVE' };
            }

            const isGood = this.checkRecoveryCriteria(probeRatio);
            if (isGood) {
                if (this.recoveryCounter + 1 >= this.M_RECOVERY_BLOCKS) {
                    return { decision: RoutingDecision.CORE, reason: 'RECOVERY_MATCH' };
                }
                return { decision: RoutingDecision.QUARANTINE, reason: 'RECOVERY_PENDING' };
            }

            return { decision: RoutingDecision.QUARANTINE, reason: 'RECOVERY_PROBE_FAIL' };
        }

        return { decision: RoutingDecision.CORE, reason: null };
    }

    /**
     * Updates the CHM state based on the Routing Decision executed by the Encoder.
     */
    update(
        decision: RoutingDecision,
        metrics: BlockMetrics,
        payloadIn: number,
        payloadOut: number,
        headerBytes: number,
        blockIndex: number,
        codecId: number
    ): { flags: number; healthTag: HealthTag; isAnomaly: boolean; inQuarantine: boolean; reasonCode: string | null } {
        this.totalBlocks++;
        this.lastBlockIndexSeen = blockIndex;

        // Stats Update
        if (decision === RoutingDecision.CORE) {
            this.stats.core_blocks++;
            this.stats.core_input_bytes += payloadIn;
            this.stats.core_output_bytes += (payloadOut + headerBytes); // Honest KPI: Include Headers
        } else {
            this.stats.quar_blocks++;
            this.stats.quar_input_bytes += payloadIn;
            this.stats.quar_output_bytes += (payloadOut + headerBytes); // Honest KPI: Include Headers
        }

        // 1. Compute Ratio (for logging/worst block)
        const safeOut = payloadOut > 0 ? payloadOut : 1;
        const currentRatio = payloadIn / safeOut;

        // 2. State Logic - Transition based on DECISION
        let flags = 0;
        let healthTag = HealthTag.OK;
        let blockAnomalous = false;
        let reasonCode: string | null = null; // We might need to persist reason from decideRoute?

        if (this.state === CHMState.NORMAL) {
            if (decision === RoutingDecision.QUARANTINE) {
                // TRANSITION: NORMAL -> QUARANTINE
                this.state = CHMState.QUARANTINE_ACTIVE;
                this.frozenBaselineRatio = this.baselineRatio; // Freeze
                this.recoveryCounter = 0;
                this.quarantineStartBlock = blockIndex;

                flags |= BLOCK_FLAGS.ANOMALY_START;
                flags |= BLOCK_FLAGS.HEALTH_QUAR;
                healthTag = HealthTag.QUAR;
                blockAnomalous = true;
                reasonCode = 'RATIO_DROP'; // Simplify or pass in? Using detection for consistency.
                // Re-detect to get reason if needed? Or just generic.
                const det = this.detectAnomaly(currentRatio, metrics.unique_ratio);
                reasonCode = det.reason || 'UNKNOWN';

                // Start Segment
                this.currentSegment = {
                    segment_id: `seg_${this.anomalies.length + 1}`,
                    start_block_index: blockIndex,
                    reason_code: reasonCode,
                    min_ratio: currentRatio,
                    max_unique_ratio_proxy: metrics.unique_ratio,
                    suggested_action: 'INSPECT',
                    probe_attempts: 0,
                    probe_successes: 0
                };
                this.anomalies.push(this.currentSegment);
            } else {
                // REMAIN NORMAL
                healthTag = HealthTag.OK;
            }

        } else {
            // QUARANTINE ACTIVE
            if (decision === RoutingDecision.CORE) {
                // TRANSITION: QUARANTINE -> NORMAL
                // This block is MARKED as the End.
                this.state = CHMState.NORMAL;
                this.frozenBaselineRatio = null; // Unfreeze

                flags |= BLOCK_FLAGS.ANOMALY_END;
                healthTag = HealthTag.OK; // Signal resolution

                // Close Segment
                if (this.currentSegment) {
                    this.currentSegment.end_block_index = blockIndex;
                    this.currentSegment = null;
                }
                this.recoveryCounter = 0;
            } else {
                // REMAIN QUARANTINE
                const shouldProbe = (blockIndex % this.PROBE_INTERVAL) === 0;
                const isGood = shouldProbe && this.checkRecoveryCriteria(currentRatio);

                // Update Recovery Counter ONLY on probes.
                if (shouldProbe) {
                    if (isGood) {
                        this.recoveryCounter++;
                        if (this.currentSegment) this.currentSegment.probe_successes = (this.currentSegment.probe_successes || 0) + 1;
                    } else {
                        this.recoveryCounter = 0;
                    }

                    if (this.currentSegment) {
                        this.currentSegment.probe_attempts = (this.currentSegment.probe_attempts || 0) + 1;
                    }
                }

                flags |= BLOCK_FLAGS.ANOMALY_MID;
                flags |= BLOCK_FLAGS.HEALTH_QUAR;
                healthTag = HealthTag.QUAR;
                blockAnomalous = true;

                // Update Segment Stats
                if (this.currentSegment) {
                    this.currentSegment.min_ratio = Math.min(this.currentSegment.min_ratio, currentRatio);
                    this.currentSegment.max_unique_ratio_proxy = Math.max(this.currentSegment.max_unique_ratio_proxy, metrics.unique_ratio);
                }
            }
        }



        // 3. Train Baseline (Hard Guard)
        // Train ONLY if CORE decision (which implies Normal state or Recovery point)
        // AND not high entropy (prevent adaptation to noise)
        const effectiveTrain = (decision === RoutingDecision.CORE)
            && ((flags & BLOCK_FLAGS.ANOMALY_END) === 0)
            && (metrics.unique_ratio <= 0.8);

        if (effectiveTrain) {
            // Fast Start: If this is the first training block, snap to it.
            // (Or close to it, to avoid startup shock deviation)
            // We use a flag or check totalBlocks.
            // Note: totalBlocks increments on every update.
            // If this is the *first* effective train, we might want to snap.
            // But let's just check if baseline is still at default (2.0) and dev is default (0.5) 
            // and we have a huge jump.
            // Simpler: Just snap on first few blocks?
            // "Train only if Normal".
            // Let's rely on totalBlocks for now, assuming we start Clean.

            if (this.totalBlocks <= 1) {
                this.baselineRatio = currentRatio;
                this.baselineRatioDev = currentRatio * 0.1; // Assume 10% variability initially
                this.baselineUniqueRatioProxy = metrics.unique_ratio;
            } else {
                const prevBaseline = this.baselineRatio;

                // EMA Update Ratio
                this.baselineRatio = (this.EMA_ALPHA * currentRatio) + ((1 - this.EMA_ALPHA) * this.baselineRatio);

                // Deviation: |Current - PrevBaseline|
                const dev = Math.abs(currentRatio - prevBaseline);
                this.baselineRatioDev = (this.EMA_ALPHA * dev) + ((1 - this.EMA_ALPHA) * this.baselineRatioDev);

                // EMA Update Proxy
                this.baselineUniqueRatioProxy = (this.EMA_ALPHA * metrics.unique_ratio) + ((1 - this.EMA_ALPHA) * this.baselineUniqueRatioProxy);
            }
        }

        // 4. Update Worst Blocks
        this.updateWorstBlocks(blockIndex, currentRatio, metrics.unique_ratio, codecId);



        return {
            flags,
            healthTag,
            isAnomaly: blockAnomalous, // Return true if this block is part of anomaly (Start/Mid)
            inQuarantine: this.state === CHMState.QUARANTINE_ACTIVE, // Current state AFTER update (End -> Normal)
            reasonCode
        };
    }

    private checkRecoveryCriteria(probeRatio: number): boolean {
        const referenceRatio = this.frozenBaselineRatio || this.baselineRatio;
        const effectiveDev = Math.max(this.baselineRatioDev, 0.1);
        const recoveryThreshold = referenceRatio - (this.K_RATIO_DEV_RECOVERY * effectiveDev);
        return probeRatio >= recoveryThreshold;
    }


    /**
     * Preview Check (Stateless deviation check)
     */
    checkAnomaly(payloadIn: number, payloadOut: number, metrics: BlockMetrics): boolean {
        const safeOut = payloadOut > 0 ? payloadOut : 1;
        const r = payloadIn / safeOut;
        return this.detectAnomaly(r, metrics.unique_ratio).isAnomaly;
    }

    private detectAnomaly(currentRatio: number, uniqueRatio: number): { isAnomaly: boolean, reason: string } {
        const expectedRatio = this.state === CHMState.NORMAL ? this.baselineRatio : (this.frozenBaselineRatio || this.baselineRatio);

        // [HARDENING] Clamp Deviation to prevent negative threshold (infinite tolerance)
        // If 3*Dev > Expected, threshold < 0.
        // We cap effectiveDev so that 3*Dev is at most 90% of Expected?
        // Or simply floor the threshold at 1.0 (Compression > 1.0).
        // Let's clamp dev.

        let effectiveDev = this.baselineRatioDev;
        const maxDev = expectedRatio * 0.25; // Max 25% of baseline allowed as "sigma"? 
        // 3 * 0.25 = 0.75. Threshold = 0.25 * Baseline. Safe.
        // But if real volatility is high, we might want to respect it.
        // But huge dev usually means "Startup Shock" or "Regime Shift".
        // Let's cap effectiveDev for the TRIGGER check.

        if (effectiveDev * this.K_RATIO_DEV_TRIGGER > expectedRatio * 0.9) {
            effectiveDev = (expectedRatio * 0.9) / this.K_RATIO_DEV_TRIGGER;
        }

        const threshold = expectedRatio - (this.K_RATIO_DEV_TRIGGER * effectiveDev);

        const isRatioDrop = currentRatio < threshold;

        // Entropy Burst: High entropy (> 1.5x baseline) + LOW ratio (below expected)
        const isEntropyBurst = (uniqueRatio > (this.baselineUniqueRatioProxy * 1.5)) &&
            (uniqueRatio > 0.5) &&
            (currentRatio < expectedRatio);

        if (isRatioDrop) return { isAnomaly: true, reason: 'RATIO_DROP' };
        if (isEntropyBurst) return { isAnomaly: true, reason: 'ENTROPY_BURST' };

        return { isAnomaly: false, reason: '' };
    }

    getReport(): AnomalyReport {
        // Close any open segment
        if (this.currentSegment) {
            this.currentSegment.end_block_index = this.lastBlockIndexSeen; // Force close
            // Already pushed to array when created?
            // Yes: `this.anomalies.push(this.currentSegment);` in UPDATE
            // So we just update the reference.
            this.currentSegment = null;
        }

        return {
            schema_version: 1,
            run_id: this.runId,
            gics_version: '1.2',
            segments: this.anomalies,
            worst_blocks: this.worstBlocks
        };
    }

    private updateWorstBlocks(blockIndex: number, ratio: number, uniqueRatio: number, codecId: number) {
        this.worstBlocks.push({ block_index: blockIndex, ratio, entropy: uniqueRatio, codec_id: codecId });
        this.worstBlocks.sort((a, b) => a.ratio - b.ratio); // Ascending (worst first)
        if (this.worstBlocks.length > 10) {
            this.worstBlocks = this.worstBlocks.slice(0, 10);
        }
    }

    getTotalBlocks() { return this.totalBlocks; }
    getState() { return this.state; }
}
