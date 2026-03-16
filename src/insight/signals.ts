/**
 * Insight Engine — Phase 3.3: Predictive Signals
 *
 * Converts behavioral and correlation patterns into actionable signals:
 * - Anomaly detection (z-score based)
 * - Trend forecasting (EMA + momentum)
 * - Recommendations (rule-based over insights)
 */

import type { ItemBehavior, FieldTrend, LifecycleStage } from './tracker.js';
import type { ConfidenceTracker, OutcomeResult } from './confidence.js';

export interface Anomaly {
    item: string;
    field: string;
    expectedValue: number;
    actualValue: number;
    zScore: number;
    severity: 'low' | 'medium' | 'high' | 'critical';
    timestamp: number;
}

export interface TrendForecast {
    item: string;
    field: string;
    currentValue: number;
    projectedValue: number;
    horizon: number;
    confidence: number;
    basis: 'ema' | 'linear';
}

export interface Recommendation {
    insightId: string;
    type: 'promote' | 'demote' | 'alert' | 'investigate' | 'act';
    target: string;
    message: string;
    confidence: number;
    basis: string[];
    expiresAt: number;
}

export interface BehaviorUpdateResult {
    newAnomalies: Anomaly[];
    newRecommendations: Recommendation[];
}

export interface PredictiveSignalsConfig {
    anomalyZScoreThreshold?: number;
    forecastHorizon?: number;
    recommendationTtlMs?: number;
}

export class PredictiveSignals {
    private readonly anomalies: Anomaly[] = [];
    private readonly recommendations = new Map<string, Recommendation>();
    private readonly anomalyZScoreThreshold: number;
    private readonly forecastHorizon: number;
    private readonly recommendationTtlMs: number;
    private nextInsightId = 1;

    constructor(config: PredictiveSignalsConfig = {}) {
        this.anomalyZScoreThreshold = config.anomalyZScoreThreshold ?? 2.0;
        this.forecastHorizon = config.forecastHorizon ?? 5;
        this.recommendationTtlMs = config.recommendationTtlMs ?? (24 * 60 * 60 * 1000);
    }

    /**
     * Called after each put() with the updated behavior.
     * Detects anomalies, generates forecasts if requested, and emits recommendations.
     * Returns newly generated anomalies and recommendations for event streaming.
     */
    onBehaviorUpdate(behavior: ItemBehavior, fields: Record<string, number | string>): BehaviorUpdateResult {
        const now = Date.now();
        const newAnomalies: Anomaly[] = [];
        const newRecommendations: Recommendation[] = [];

        // Detect anomalies from field trends
        for (const [fieldName, trend] of Object.entries(behavior.fieldTrends)) {
            const absZ = Math.abs(trend.zScore);
            if (absZ >= this.anomalyZScoreThreshold) {
                const value = typeof fields[fieldName] === 'number' ? fields[fieldName] as number : trend.ema;
                const anomaly: Anomaly = {
                    item: behavior.key,
                    field: fieldName,
                    expectedValue: trend.ema,
                    actualValue: value,
                    zScore: trend.zScore,
                    severity: this.classifySeverity(absZ),
                    timestamp: now
                };
                this.anomalies.push(anomaly);
                newAnomalies.push(anomaly);

                // Cap anomaly history
                if (this.anomalies.length > 1000) {
                    this.anomalies.splice(0, this.anomalies.length - 1000);
                }

                // Generate alert recommendation
                const alertRec = this.emitRecommendation({
                    type: 'alert',
                    target: behavior.key,
                    message: `Anomaly detected on field "${fieldName}": z-score ${trend.zScore.toFixed(2)}, severity ${anomaly.severity}`,
                    confidence: Math.min(1, absZ / 5),
                    basis: [`anomaly.${fieldName}.zscore.${trend.zScore.toFixed(1)}`],
                    expiresAt: now + this.recommendationTtlMs
                });
                if (alertRec) newRecommendations.push(alertRec);
            }
        }

        // Lifecycle-based recommendations
        const lifecycleRecs = this.evaluateLifecycleRecommendations(behavior, now);
        newRecommendations.push(...lifecycleRecs);

        // Streak-based recommendations
        if (Math.abs(behavior.streak) >= 5) {
            const direction = behavior.streak > 0 ? 'positive' : 'negative';
            const streakRec = this.emitRecommendation({
                type: 'investigate',
                target: behavior.key,
                message: `${direction} streak of ${Math.abs(behavior.streak)} consecutive changes`,
                confidence: Math.min(1, Math.abs(behavior.streak) / 20),
                basis: [`behavioral.streak.${direction}.${Math.abs(behavior.streak)}`],
                expiresAt: now + this.recommendationTtlMs
            });
            if (streakRec) newRecommendations.push(streakRec);
        }

        // Prune expired recommendations
        this.pruneExpired(now);

        return { newAnomalies, newRecommendations };
    }

    /**
     * Record outcome of following/ignoring a recommendation (Phase 9).
     * Returns metadata about the outcome recording, including disability state changes.
     */
    recordOutcome(insightId: string, result: OutcomeResult, confidenceTracker: ConfidenceTracker): { found: boolean; wasDisabled: boolean; nowDisabled: boolean } | null {
        const recommendation = this.recommendations.get(insightId);
        if (!recommendation) return null;
        const metadata = confidenceTracker.recordOutcome(insightId, result, recommendation);
        return { found: true, ...metadata };
    }

    getForecast(behavior: ItemBehavior, field: string, horizon?: number): TrendForecast | null {
        const trend = behavior.fieldTrends[field];
        if (!trend) return null;

        const h = horizon ?? this.forecastHorizon;
        const momentum = trend.direction === 'up' ? trend.magnitude : trend.direction === 'down' ? -trend.magnitude : 0;
        const range = trend.max - trend.min;
        const projectedDelta = momentum * range * h;
        const projectedValue = trend.ema + projectedDelta;

        // Confidence decays with horizon
        const baseConfidence = Math.min(1, (trend.max !== trend.min) ? 0.8 : 0.3);
        const confidence = baseConfidence * Math.exp(-0.1 * h);

        return {
            item: behavior.key,
            field,
            currentValue: trend.ema,
            projectedValue,
            horizon: h,
            confidence,
            basis: 'ema'
        };
    }

    getAnomalies(since?: number): Anomaly[] {
        if (since === undefined) return [...this.anomalies];
        return this.anomalies.filter((a) => a.timestamp >= since);
    }

    getRecommendations(filter?: { type?: string; target?: string }): Recommendation[] {
        const all = Array.from(this.recommendations.values());
        let result = all;
        if (filter?.type) result = result.filter((r) => r.type === filter.type);
        if (filter?.target) result = result.filter((r) => r.target === filter.target);
        return result.sort((a, b) => b.confidence - a.confidence);
    }

    getRecommendation(insightId: string): Recommendation | null {
        return this.recommendations.get(insightId) ?? null;
    }

    private classifySeverity(absZScore: number): 'low' | 'medium' | 'high' | 'critical' {
        if (absZScore >= 4) return 'critical';
        if (absZScore >= 3) return 'high';
        if (absZScore >= 2.5) return 'medium';
        return 'low';
    }

    private evaluateLifecycleRecommendations(behavior: ItemBehavior, now: number): Recommendation[] {
        const { lifecycle, velocity, key } = behavior;
        const recs: Recommendation[] = [];

        if (lifecycle === 'active' && velocity > 2) {
            const rec = this.emitRecommendation({
                type: 'promote',
                target: key,
                message: `High velocity (${velocity.toFixed(2)} writes/hr) suggests promotion to higher priority`,
                confidence: Math.min(1, velocity / 5),
                basis: [`behavioral.velocity.high`, `lifecycle.active`],
                expiresAt: now + this.recommendationTtlMs
            });
            if (rec) recs.push(rec);
        }

        if (lifecycle === 'declining') {
            const rec = this.emitRecommendation({
                type: 'demote',
                target: key,
                message: `Declining activity — consider demoting to lower tier`,
                confidence: 0.6,
                basis: [`lifecycle.declining`, `behavioral.velocity.low`],
                expiresAt: now + this.recommendationTtlMs
            });
            if (rec) recs.push(rec);
        }

        if (lifecycle === 'resurrected') {
            const rec = this.emitRecommendation({
                type: 'investigate',
                target: key,
                message: `Item was dead and has been resurrected — investigate cause`,
                confidence: 0.8,
                basis: [`lifecycle.resurrected`],
                expiresAt: now + this.recommendationTtlMs
            });
            if (rec) recs.push(rec);
        }

        return recs;
    }

    private emitRecommendation(partial: Omit<Recommendation, 'insightId'>): Recommendation | null {
        const insightId = `insight_${this.nextInsightId++}`;
        const rec: Recommendation = { insightId, ...partial };
        this.recommendations.set(insightId, rec);
        return rec;
    }

    private pruneExpired(now: number): void {
        for (const [id, rec] of this.recommendations) {
            if (rec.expiresAt < now) {
                this.recommendations.delete(id);
            }
        }
    }
}
