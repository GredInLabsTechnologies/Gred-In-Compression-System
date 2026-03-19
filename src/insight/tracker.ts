/**
 * Insight Engine tracker (Phase 3.1)
 *
 * Incremental per-item metadata with O(1) update cost per read/write.
 * Computes: velocity, entropy, volatility, streaks, lifecycle, and per-field trends.
 */

export type LifecycleStage =
    | 'emerging'
    | 'active'
    | 'stable'
    | 'declining'
    | 'dormant'
    | 'dead'
    | 'resurrected';

export interface FieldTrend {
    ema: number;
    direction: 'up' | 'down' | 'flat';
    magnitude: number;
    min: number;
    max: number;
    zScore: number;
}

export interface ItemBehavior {
    key: string;

    // Activity
    velocity: number;
    accessFrequency: number;
    lastWrite: number;
    lastRead: number;
    writeCount: number;
    readCount: number;

    // Stability
    entropy: number;
    volatility: number;
    streak: number;
    streakRecord: number;

    // Lifecycle
    lifecycle: LifecycleStage;
    lifecycleChangedAt: number;

    // Per-field trends
    fieldTrends: Record<string, FieldTrend>;
}

export interface InsightTrackerConfig {
    velocityAlpha?: number;
    highVelocityThreshold?: number;
    lowVelocityThreshold?: number;
    dormantWindowMs?: number;
    deadWindowMs?: number;
    entropyWindowSize?: number;
    fieldTrendAlpha?: number;
}

/** Internal state per field for incremental stats */
interface FieldStats {
    ema: number;
    previousValue: number;
    runningMean: number;
    runningM2: number;
    sampleCount: number;
    min: number;
    max: number;
}

interface InternalItemBehavior extends ItemBehavior {
    previousLifecycle: LifecycleStage | null;
    /** Circular buffer of recent delta signs for Shannon entropy (+1, -1, 0) */
    recentDeltaSigns: number[];
    /** Running variance for volatility (Welford's online algorithm) */
    welfordMean: number;
    welfordM2: number;
    welfordN: number;
    /** Per-field incremental stats */
    fieldStatsMap: Map<string, FieldStats>;
}

const MS_PER_HOUR = 60 * 60 * 1000;

export class InsightTracker {
    private readonly items = new Map<string, InternalItemBehavior>();
    private readonly velocityAlpha: number;
    private readonly highVelocityThreshold: number;
    private readonly lowVelocityThreshold: number;
    private readonly dormantWindowMs: number;
    private readonly deadWindowMs: number;
    private readonly entropyWindowSize: number;
    private readonly fieldTrendAlpha: number;

    constructor(config: InsightTrackerConfig = {}) {
        this.velocityAlpha = config.velocityAlpha ?? 0.35;
        this.highVelocityThreshold = config.highVelocityThreshold ?? 0.5;
        this.lowVelocityThreshold = config.lowVelocityThreshold ?? 0.05;
        this.dormantWindowMs = config.dormantWindowMs ?? (7 * 24 * MS_PER_HOUR);
        this.deadWindowMs = config.deadWindowMs ?? (30 * 24 * MS_PER_HOUR);
        this.entropyWindowSize = config.entropyWindowSize ?? 32;
        this.fieldTrendAlpha = config.fieldTrendAlpha ?? 0.3;
    }

    bootstrapRecord(key: string, timestamp: number = Date.now()): void {
        if (this.items.has(key)) return;
        this.items.set(key, this.createInitial(key, timestamp, 0));
    }

    onWrite(key: string, timestamp: number = Date.now(), fields?: Record<string, number | string>): ItemBehavior {
        const existing = this.items.get(key);
        if (!existing) {
            const initial = this.createInitial(key, timestamp, 1);
            if (fields) this.updateFieldTrends(initial, fields);
            this.items.set(key, initial);
            return this.toPublic(initial);
        }

        const wasDead = existing.lifecycle === 'dead' || (timestamp - existing.lastWrite) > this.deadWindowMs;

        // Velocity (EMA of writes per hour)
        const dtMs = Math.max(1, timestamp - existing.lastWrite);
        const instantaneousWritesPerHour = MS_PER_HOUR / dtMs;
        existing.velocity =
            (this.velocityAlpha * instantaneousWritesPerHour) +
            ((1 - this.velocityAlpha) * existing.velocity);

        existing.lastWrite = timestamp;
        existing.writeCount += 1;

        // Volatility via Welford's online algorithm on inter-write intervals
        this.updateVolatility(existing, dtMs);

        // Field trends + streak + entropy
        if (fields) {
            this.updateFieldTrends(existing, fields);
        }

        const nextLifecycle = wasDead ? 'resurrected' : this.classifyLifecycle(existing, timestamp);
        this.applyLifecycle(existing, nextLifecycle, timestamp);

        return this.toPublic(existing);
    }

    onRead(key: string, timestamp: number = Date.now()): ItemBehavior | null {
        const existing = this.items.get(key);
        if (!existing) return null;

        const dtMs = existing.lastRead > 0 ? Math.max(1, timestamp - existing.lastRead) : MS_PER_HOUR;
        const instantaneousReadsPerHour = MS_PER_HOUR / dtMs;
        existing.accessFrequency =
            (this.velocityAlpha * instantaneousReadsPerHour) +
            ((1 - this.velocityAlpha) * existing.accessFrequency);

        existing.lastRead = timestamp;
        existing.readCount += 1;

        const nextLifecycle = this.classifyLifecycle(existing, timestamp);
        this.applyLifecycle(existing, nextLifecycle, timestamp);

        return this.toPublic(existing);
    }

    getInsight(key: string): ItemBehavior | null {
        const item = this.items.get(key);
        return item ? this.toPublic(item) : null;
    }

    getInsights(filter?: { lifecycle?: LifecycleStage; }): ItemBehavior[] {
        const items = Array.from(this.items.values());
        const filtered = filter?.lifecycle
            ? items.filter((i) => i.lifecycle === filter.lifecycle)
            : items;
        return [...filtered]
            .sort((a, b) => b.lastWrite - a.lastWrite)
            .map((i) => this.toPublic(i));
    }

    get count(): number {
        return this.items.size;
    }

    /**
     * Restore persisted state into a bootstrapped record.
     * Used by InsightPersistence to hydrate from disk.
     */
    restoreState(key: string, state: Partial<ItemBehavior>): void {
        const item = this.items.get(key);
        if (!item) return;

        if (state.velocity !== undefined) item.velocity = state.velocity;
        if (state.accessFrequency !== undefined) item.accessFrequency = state.accessFrequency;
        if (state.lastWrite !== undefined) item.lastWrite = state.lastWrite;
        if (state.lastRead !== undefined) item.lastRead = state.lastRead;
        if (state.writeCount !== undefined) item.writeCount = state.writeCount;
        if (state.readCount !== undefined) item.readCount = state.readCount;
        if (state.entropy !== undefined) item.entropy = state.entropy;
        if (state.volatility !== undefined) item.volatility = state.volatility;
        if (state.streak !== undefined) item.streak = state.streak;
        if (state.streakRecord !== undefined) item.streakRecord = state.streakRecord;
        if (state.lifecycle !== undefined) {
            item.lifecycle = state.lifecycle;
        }
        if (state.lifecycleChangedAt !== undefined) item.lifecycleChangedAt = state.lifecycleChangedAt;
    }

    /**
     * Cold-start bootstrap from cluster-derived priors (Phase 4.4).
     * Initializes a new item with behavioral estimates from similar items.
     */
    bootstrapFromCluster(key: string, clusterMean: Partial<ItemBehavior>, timestamp: number = Date.now()): void {
        if (this.items.has(key)) return;

        const initial = this.createInitial(key, timestamp, 0);

        // Apply cluster priors
        if (clusterMean.velocity !== undefined) initial.velocity = clusterMean.velocity;
        if (clusterMean.entropy !== undefined) initial.entropy = clusterMean.entropy;
        if (clusterMean.volatility !== undefined) initial.volatility = clusterMean.volatility;
        if (clusterMean.writeCount !== undefined) initial.writeCount = Math.max(0, Math.floor(clusterMean.writeCount));

        // Mark as emerging with inherited confidence
        initial.lifecycle = 'emerging';
        initial.lifecycleChangedAt = timestamp;

        this.items.set(key, initial);
    }

    /**
     * Returns all tracked keys. Used by persistence layer for serialization.
     */
    getAllInternalState(): Map<string, ItemBehavior> {
        const out = new Map<string, ItemBehavior>();
        for (const [key, value] of this.items.entries()) {
            out.set(key, this.toPublic(value));
        }
        return out;
    }

    // --- Private helpers ---

    private createInitial(key: string, timestamp: number, velocity: number): InternalItemBehavior {
        return {
            key,
            velocity,
            accessFrequency: 0,
            lastWrite: timestamp,
            lastRead: 0,
            writeCount: velocity > 0 ? 1 : 0,
            readCount: 0,
            entropy: 0,
            volatility: 0,
            streak: 0,
            streakRecord: 0,
            lifecycle: 'emerging',
            lifecycleChangedAt: timestamp,
            fieldTrends: {},
            previousLifecycle: null,
            recentDeltaSigns: [],
            welfordMean: 0,
            welfordM2: 0,
            welfordN: 0,
            fieldStatsMap: new Map()
        };
    }

    private updateVolatility(item: InternalItemBehavior, deltaMs: number): void {
        item.welfordN += 1;
        const n = item.welfordN;
        const oldMean = item.welfordMean;
        item.welfordMean = oldMean + (deltaMs - oldMean) / n;
        item.welfordM2 += (deltaMs - oldMean) * (deltaMs - item.welfordMean);

        item.volatility = n > 1
            ? Math.sqrt(item.welfordM2 / (n - 1))
            : 0;
    }

    private updateFieldTrends(item: InternalItemBehavior, fields: Record<string, number | string>): void {
        const { aggregateDelta, numericFieldCount } = this.processNumericFields(item, fields);
        if (numericFieldCount > 0) {
            this.updateStreakAndEntropy(item, aggregateDelta);
        }
        this.buildPublicFieldTrends(item);
    }

    private processNumericFields(item: InternalItemBehavior, fields: Record<string, number | string>) {
        let aggregateDelta = 0;
        let numericFieldCount = 0;
        for (const [fieldName, value] of Object.entries(fields)) {
            if (typeof value !== 'number') continue;
            numericFieldCount++;
            let stats = item.fieldStatsMap.get(fieldName);
            if (!stats) {
                stats = { ema: value, previousValue: value, runningMean: value, runningM2: 0, sampleCount: 1, min: value, max: value };
                item.fieldStatsMap.set(fieldName, stats);
                continue;
            }
            aggregateDelta += value - stats.previousValue;
            stats.ema = (this.fieldTrendAlpha * value) + ((1 - this.fieldTrendAlpha) * stats.ema);
            stats.sampleCount += 1;
            const oldMean = stats.runningMean;
            stats.runningMean = oldMean + (value - oldMean) / stats.sampleCount;
            stats.runningM2 += (value - oldMean) * (value - stats.runningMean);
            if (value < stats.min) stats.min = value;
            if (value > stats.max) stats.max = value;
            stats.previousValue = value;
        }
        return { aggregateDelta, numericFieldCount };
    }

    private updateStreakAndEntropy(item: InternalItemBehavior, aggregateDelta: number): void {
        let sign = 0;
        if (aggregateDelta > 0) sign = 1;
        else if (aggregateDelta < 0) sign = -1;

        if (sign !== 0) {
            item.recentDeltaSigns.push(sign);
            if (item.recentDeltaSigns.length > this.entropyWindowSize) {
                item.recentDeltaSigns.shift();
            }
        }
        
        if (sign > 0) {
            if (item.streak >= 0) item.streak += 1;
            else item.streak = 1;
        } else if (sign < 0) {
            if (item.streak <= 0) item.streak -= 1;
            else item.streak = -1;
        }

        const absStreak = Math.abs(item.streak);
        if (absStreak > item.streakRecord) item.streakRecord = absStreak;

        item.entropy = this.shannonEntropy(item.recentDeltaSigns);
    }

    private buildPublicFieldTrends(item: InternalItemBehavior): void {
        item.fieldTrends = {};
        for (const [fieldName, stats] of item.fieldStatsMap.entries()) {
            const stddev = stats.sampleCount > 1 ? Math.sqrt(stats.runningM2 / (stats.sampleCount - 1)) : 0;
            const zScore = stddev > 0 ? (stats.previousValue - stats.runningMean) / stddev : 0;
            const range = stats.max - stats.min;
            const magnitude = range > 0 ? Math.abs(stats.previousValue - stats.ema) / range : 0;

            let direction: 'up' | 'down' | 'flat';
            if (stats.previousValue > stats.ema * 1.005) direction = 'up';
            else if (stats.previousValue < stats.ema * 0.995) direction = 'down';
            else direction = 'flat';

            item.fieldTrends[fieldName] = {
                ema: stats.ema,
                direction,
                magnitude,
                min: stats.min,
                max: stats.max,
                zScore
            };
        }
    }

    private shannonEntropy(signs: number[]): number {
        if (signs.length < 2) return 0;
        const counts = new Map<number, number>();
        for (const s of signs) {
            counts.set(s, (counts.get(s) ?? 0) + 1);
        }
        const n = signs.length;
        let entropy = 0;
        for (const count of counts.values()) {
            const p = count / n;
            if (p > 0) entropy -= p * Math.log2(p);
        }
        // Normalize to 0-1 range (max entropy = log2(distinct symbols))
        const maxEntropy = Math.log2(counts.size);
        return maxEntropy > 0 ? entropy / maxEntropy : 0;
    }

    private classifyLifecycle(item: InternalItemBehavior, now: number): LifecycleStage {
        const inactivityMs = Math.max(0, now - item.lastWrite);

        if (inactivityMs > this.deadWindowMs) return 'dead';
        if (inactivityMs > this.dormantWindowMs) return 'dormant';

        if (item.velocity > this.highVelocityThreshold) {
            return item.writeCount < 10 ? 'emerging' : 'active';
        }

        if (item.velocity < this.lowVelocityThreshold) return 'declining';
        return 'stable';
    }

    private applyLifecycle(item: InternalItemBehavior, next: LifecycleStage, now: number): void {
        if (item.lifecycle === next) return;
        item.previousLifecycle = item.lifecycle;
        item.lifecycle = next;
        item.lifecycleChangedAt = now;
    }

    private toPublic(item: InternalItemBehavior): ItemBehavior {
        return {
            key: item.key,
            velocity: item.velocity,
            accessFrequency: item.accessFrequency,
            lastWrite: item.lastWrite,
            lastRead: item.lastRead,
            writeCount: item.writeCount,
            readCount: item.readCount,
            entropy: item.entropy,
            volatility: item.volatility,
            streak: item.streak,
            streakRecord: item.streakRecord,
            lifecycle: item.lifecycle,
            lifecycleChangedAt: item.lifecycleChangedAt,
            fieldTrends: { ...item.fieldTrends }
        };
    }
}
