/**
 * BanditRouter (Phase 11) — Thompson Sampling for adaptive model selection
 *
 * Uses Beta distributions per arm (model × taskType) to balance exploration/exploitation.
 * Feature flag GICS_BANDIT_ENABLED controls activation (default: false, zero disruption).
 * Temporal decay ensures old data doesn't dominate forever.
 */

export type ModelArm = 'sonnet' | 'opus' | 'haiku';
export type TaskType = 'encode' | 'decode' | 'query' | 'analysis';

export interface ArmStats {
    alpha: number; // Successes + prior
    beta: number;  // Failures + prior
    totalPulls: number;
    lastUpdate: number; // Timestamp for temporal decay
}

export interface BanditDecision {
    chosenArm: ModelArm;
    sampledTheta: number;
    allThetas: Record<ModelArm, number>;
    timestamp: number;
}

export interface BanditConfig {
    /** Feature flag: if false, always returns blended score (no-op mode) */
    enabled?: boolean;
    /** Cold start prior: Beta(alphaPrior, betaPrior) */
    alphaPrior?: number;
    betaPrior?: number;
    /** Temporal decay factor applied daily: alpha *= decay, beta *= decay */
    temporalDecay?: number;
    /** RNG seed for deterministic tests */
    seed?: number;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Seeded LCG random number generator for deterministic tests
 */
class SeededRandom {
    private state: number;
    private readonly a = 1664525;
    private readonly c = 1013904223;
    private readonly m = 2 ** 32;

    constructor(seed: number) {
        this.state = seed >>> 0;
    }

    next(): number {
        this.state = (this.a * this.state + this.c) % this.m;
        return this.state / this.m;
    }
}

export class BanditRouter {
    private readonly enabled: boolean;
    private readonly alphaPrior: number;
    private readonly betaPrior: number;
    private readonly temporalDecay: number;
    private readonly arms = new Map<string, ArmStats>(); // key: `${model}|${taskType}`
    private readonly rng: SeededRandom | null;

    constructor(config: BanditConfig = {}) {
        this.enabled = config.enabled ?? (process.env.GICS_BANDIT_ENABLED === 'true');
        this.alphaPrior = config.alphaPrior ?? 3;
        this.betaPrior = config.betaPrior ?? 1;
        this.temporalDecay = config.temporalDecay ?? 0.995;
        this.rng = config.seed !== undefined ? new SeededRandom(config.seed) : null;
    }

    /**
     * Select model arm using Thompson Sampling.
     * If disabled, returns 'sonnet' (blended score fallback).
     */
    selectArm(taskType: TaskType, candidateArms: ModelArm[]): BanditDecision {
        const now = Date.now();

        if (!this.enabled || candidateArms.length === 0) {
            // No-op mode: return blended default
            return {
                chosenArm: 'sonnet',
                sampledTheta: 0.5,
                allThetas: { sonnet: 0.5, opus: 0.5, haiku: 0.5 },
                timestamp: now,
            };
        }

        const thetas: Record<string, number> = {};

        for (const arm of candidateArms) {
            const key = this.getArmKey(arm, taskType);
            const stats = this.getOrCreateArm(key, now);
            this.applyTemporalDecay(stats, now);
            thetas[arm] = this.sampleBeta(stats.alpha, stats.beta);
        }

        // Pick arm with highest sampled theta
        let bestArm: ModelArm = candidateArms[0];
        let bestTheta = thetas[bestArm] ?? 0;

        for (const arm of candidateArms) {
            if (thetas[arm] > bestTheta) {
                bestArm = arm;
                bestTheta = thetas[arm];
            }
        }

        return {
            chosenArm: bestArm,
            sampledTheta: bestTheta,
            allThetas: thetas as Record<ModelArm, number>,
            timestamp: now,
        };
    }

    /**
     * Record outcome: success (reward=1) or failure (reward=0).
     */
    recordOutcome(arm: ModelArm, taskType: TaskType, success: boolean): void {
        if (!this.enabled) return;

        const key = this.getArmKey(arm, taskType);
        const stats = this.getOrCreateArm(key, Date.now());

        if (success) {
            stats.alpha += 1;
        } else {
            stats.beta += 1;
        }

        stats.totalPulls += 1;
        stats.lastUpdate = Date.now();
    }

    /**
     * Get all arm statistics (for inspection/debugging).
     */
    getStats(): Map<string, ArmStats> {
        const snapshot = new Map<string, ArmStats>();
        for (const [key, stats] of this.arms) {
            snapshot.set(key, { ...stats });
        }
        return snapshot;
    }

    /**
     * Reset all arms (for testing).
     */
    reset(): void {
        this.arms.clear();
    }

    // --- Private helpers ---

    private getArmKey(arm: ModelArm, taskType: TaskType): string {
        return `${arm}|${taskType}`;
    }

    private getOrCreateArm(key: string, now: number): ArmStats {
        let stats = this.arms.get(key);
        if (!stats) {
            stats = {
                alpha: this.alphaPrior,
                beta: this.betaPrior,
                totalPulls: 0,
                lastUpdate: now,
            };
            this.arms.set(key, stats);
        }
        return stats;
    }

    private applyTemporalDecay(stats: ArmStats, now: number): void {
        const daysSinceUpdate = (now - stats.lastUpdate) / MS_PER_DAY;
        if (daysSinceUpdate < 1) return; // No decay if < 1 day

        const decayFactor = Math.pow(this.temporalDecay, Math.floor(daysSinceUpdate));
        stats.alpha *= decayFactor;
        stats.beta *= decayFactor;
        stats.lastUpdate = now;
    }

    /**
     * Sample from Beta(alpha, beta) using Gamma ratio trick.
     * Beta(a,b) = Gamma(a) / (Gamma(a) + Gamma(b))
     */
    private sampleBeta(alpha: number, beta: number): number {
        const x = this.sampleGamma(alpha);
        const y = this.sampleGamma(beta);
        return x / (x + y);
    }

    /**
     * Sample from Gamma(shape, scale=1) using Marsaglia-Tsang method.
     */
    private sampleGamma(shape: number): number {
        if (shape < 1) {
            // Boost shape to >= 1, then adjust
            return this.sampleGamma(shape + 1) * Math.pow(this.random(), 1 / shape);
        }

        const d = shape - 1 / 3;
        const c = 1 / Math.sqrt(9 * d);

        // eslint-disable-next-line no-constant-condition
        while (true) {
            let x, v;
            do {
                x = this.randomNormal();
                v = 1 + c * x;
            } while (v <= 0);

            v = v * v * v;
            const u = this.random();
            const x2 = x * x;

            if (u < 1 - 0.0331 * x2 * x2) {
                return d * v;
            }

            if (Math.log(u) < 0.5 * x2 + d * (1 - v + Math.log(v))) {
                return d * v;
            }
        }
    }

    /**
     * Sample from standard normal using Box-Muller transform.
     */
    private randomNormal(): number {
        const u1 = this.random();
        const u2 = this.random();
        return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    }

    /**
     * Uniform [0,1) random number (seeded if configured, otherwise Math.random).
     */
    private random(): number {
        return this.rng ? this.rng.next() : Math.random();
    }
}
