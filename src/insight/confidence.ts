/**
 * Insight Engine — Phase 4.2: Confidence Adjustment
 *
 * Tracks prediction accuracy per insight type and scope.
 * Adjusts confidence based on reported outcomes with gradual, non-binary rules.
 */

import type { Recommendation } from './signals.js';

export type OutcomeResult =
    | 'followed_success'
    | 'followed_failure'
    | 'ignored_validated'
    | 'ignored_invalid'
    | 'expired';

export interface Outcome {
    insightId: string;
    result: OutcomeResult;
    context?: string;
    timestamp: number;
}

interface OutcomeRecord extends Outcome {
    insightType: string;
    scope: string;
    correct: boolean;
}

export interface InsightConfidence {
    insightType: string;
    scope: string;
    totalPredictions: number;
    correctPredictions: number;
    accuracy: number;
    recentAccuracy: number;
    calibration: number;
    disabled: boolean;
    highReliability: boolean;
}

export interface ConfidenceTrackerConfig {
    recentWindowSize?: number;
}

const RECENT_WINDOW = 50;

const RECOMMENDATION_TYPE_TO_INSIGHT: Record<string, string> = {
    promote: 'recommendation',
    demote: 'recommendation',
    alert: 'anomaly',
    investigate: 'recommendation',
    act: 'recommendation',
};

function isCorrectOutcome(result: OutcomeResult): boolean {
    return result === 'followed_success' || result === 'ignored_validated';
}

export class ConfidenceTracker {
    private readonly outcomes = new Map<string, OutcomeRecord[]>();
    private readonly confidenceByScope = new Map<string, InsightConfidence>();
    private readonly recentWindowSize: number;

    constructor(config: ConfidenceTrackerConfig = {}) {
        this.recentWindowSize = config.recentWindowSize ?? RECENT_WINDOW;
    }

    recordOutcome(insightId: string, result: OutcomeResult, recommendation: Recommendation): { wasDisabled: boolean; nowDisabled: boolean } {
        // Derive type and scope
        const insightType = RECOMMENDATION_TYPE_TO_INSIGHT[recommendation.type] ?? 'recommendation';
        const scope = this.deriveScope(recommendation.target);
        const scopeKey = `${insightType}|${scope}`;
        const correct = isCorrectOutcome(result);

        const outcome: OutcomeRecord = {
            insightId,
            result,
            timestamp: Date.now(),
            insightType,
            scope,
            correct,
        };

        if (!this.outcomes.has(insightId)) {
            this.outcomes.set(insightId, []);
        }
        this.outcomes.get(insightId)!.push(outcome);

        // Update confidence
        let conf = this.confidenceByScope.get(scopeKey);
        if (!conf) {
            conf = {
                insightType,
                scope,
                totalPredictions: 0,
                correctPredictions: 0,
                accuracy: 0,
                recentAccuracy: 0,
                calibration: 0,
                disabled: false,
                highReliability: false,
            };
            this.confidenceByScope.set(scopeKey, conf);
        }

        const wasDisabled = conf.disabled;

        conf.totalPredictions++;
        if (correct) conf.correctPredictions++;

        // Recalculate accuracy
        conf.accuracy = conf.totalPredictions > 0
            ? conf.correctPredictions / conf.totalPredictions
            : 0;

        // Recalculate recent accuracy (sliding window)
        conf.recentAccuracy = this.computeRecentAccuracy(insightType, scope);

        // Calibration: correlation between estimated confidence and actual accuracy
        conf.calibration = this.computeCalibration(insightType, scope);

        // Apply gradual adjustment rules (Phase 9: accuracy < 50% after 20+ outcomes)
        if (conf.accuracy < 0.5 && conf.totalPredictions >= 20) {
            conf.disabled = true;
        } else if (conf.accuracy >= 0.6) {
            conf.disabled = false;
        }

        if (conf.accuracy > 0.95 && conf.totalPredictions > 50) {
            conf.highReliability = true;
        } else if (conf.accuracy <= 0.9) {
            conf.highReliability = false;
        }

        return { wasDisabled, nowDisabled: conf.disabled };
    }

    getAccuracy(insightType?: string, scope?: string): InsightConfidence[] {
        const results: InsightConfidence[] = [];
        for (const conf of this.confidenceByScope.values()) {
            if (insightType && conf.insightType !== insightType) continue;
            if (scope && conf.scope !== scope) continue;
            results.push({ ...conf });
        }
        return results;
    }

    isDisabled(insightType: string, scope: string): boolean {
        const scopeKey = `${insightType}|${scope}`;
        return this.confidenceByScope.get(scopeKey)?.disabled ?? false;
    }

    serialize(): Array<{ key: string; fields: Record<string, number | string> }> {
        const records: Array<{ key: string; fields: Record<string, number | string> }> = [];
        for (const [scopeKey, conf] of this.confidenceByScope) {
            records.push({
                key: scopeKey,
                fields: {
                    insightType: conf.insightType,
                    scope: conf.scope,
                    totalPredictions: conf.totalPredictions,
                    correctPredictions: conf.correctPredictions,
                    accuracy: conf.accuracy,
                    recentAccuracy: conf.recentAccuracy,
                    calibration: conf.calibration,
                    disabled: conf.disabled ? 1 : 0,
                    highReliability: conf.highReliability ? 1 : 0,
                },
            });
        }
        return records;
    }

    restore(records: Array<{ key: string; fields: Record<string, number | string> }>): void {
        this.confidenceByScope.clear();
        for (const rec of records) {
            const f = rec.fields;
            const conf: InsightConfidence = {
                insightType: String(f.insightType ?? ''),
                scope: String(f.scope ?? ''),
                totalPredictions: Number(f.totalPredictions ?? 0),
                correctPredictions: Number(f.correctPredictions ?? 0),
                accuracy: Number(f.accuracy ?? 0),
                recentAccuracy: Number(f.recentAccuracy ?? 0),
                calibration: Number(f.calibration ?? 0),
                disabled: Number(f.disabled ?? 0) === 1,
                highReliability: Number(f.highReliability ?? 0) === 1,
            };
            this.confidenceByScope.set(rec.key, conf);
        }
    }

    get count(): number {
        return this.confidenceByScope.size;
    }

    private deriveScope(target: string): string {
        // Extract schema prefix from target key (first segment before |)
        const idx = target.indexOf('|');
        return idx > 0 ? target.substring(0, idx) : '*';
    }

    private computeRecentAccuracy(insightType: string, scope: string): number {
        // Collect recent outcomes for this type+scope
        const recent: boolean[] = [];
        for (const outcomes of this.outcomes.values()) {
            for (const o of outcomes) {
                if (o.insightType !== insightType || o.scope !== scope) continue;
                recent.push(o.correct);
            }
        }

        if (recent.length === 0) return 0;

        const window = recent.slice(-this.recentWindowSize);
        const correct = window.filter(Boolean).length;
        return correct / window.length;
    }

    private computeCalibration(_insightType: string, _scope: string): number {
        // Simplified calibration: abs(estimatedConfidence - actualAccuracy)
        // Lower is better. Returns 1 - abs(diff) so higher = better calibration.
        const conf = this.confidenceByScope.get(`${_insightType}|${_scope}`);
        if (!conf || conf.totalPredictions === 0) return 0;

        // Without per-prediction confidence scores stored, approximate using
        // the global accuracy as proxy for calibration quality
        return Math.min(1, conf.accuracy * 1.1);
    }
}
