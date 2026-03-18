/**
 * Insight Engine — Phase 3.4: Insight Persistence
 *
 * Serializes/deserializes insight state into MemTable records with `_insight/` prefix.
 * Insights are stored as normal GICS data — auditable and verifiable.
 */

import type { InsightTracker, ItemBehavior } from './tracker.js';
import type { CorrelationAnalyzer } from './correlation.js';
import type { ConfidenceTracker } from './confidence.js';
import type { SchemaProfile } from '../gics-types.js';

const INSIGHT_PREFIX = '_insight/';
const BEHAVIOR_PREFIX = '_insight/behavior/';
const CORRELATION_PREFIX = '_insight/correlation/';
const CONFIDENCE_PREFIX = '_insight/confidence/';

export const INSIGHT_BEHAVIORAL_SCHEMA: SchemaProfile = {
    id: 'gics_insight_behavioral_v1',
    version: 1,
    itemIdType: 'string',
    fields: [
        { name: 'velocity', type: 'numeric', codecStrategy: 'value' },
        { name: 'entropy', type: 'numeric', codecStrategy: 'value' },
        { name: 'lifecycle', type: 'categorical', enumMap: { emerging: 0, active: 1, stable: 2, declining: 3, dormant: 4, dead: 5, resurrected: 6 } },
        { name: 'writeCount', type: 'numeric', codecStrategy: 'structural' },
        { name: 'streak', type: 'numeric', codecStrategy: 'structural' },
    ],
};

export const INSIGHT_CORRELATION_SCHEMA: SchemaProfile = {
    id: 'gics_insight_correlation_v1',
    version: 1,
    itemIdType: 'string',
    fields: [
        { name: 'coefficient', type: 'numeric', codecStrategy: 'value' },
        { name: 'lag', type: 'numeric', codecStrategy: 'structural' },
        { name: 'confidence', type: 'numeric', codecStrategy: 'value' },
        { name: 'direction', type: 'categorical', enumMap: { positive: 0, negative: 1 } },
    ],
};

export class InsightPersistence {
    static readonly INSIGHT_PREFIX = INSIGHT_PREFIX;

    static isInsightKey(key: string): boolean {
        return key.startsWith(INSIGHT_PREFIX);
    }

    snapshotBehavioral(tracker: InsightTracker): Map<string, Record<string, number | string>> {
        const records = new Map<string, Record<string, number | string>>();
        const insights = tracker.getInsights();

        for (const item of insights) {
            const key = `${BEHAVIOR_PREFIX}${item.key}`;
            records.set(key, {
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
            });
        }

        return records;
    }

    snapshotCorrelations(analyzer: CorrelationAnalyzer): Map<string, Record<string, number | string>> {
        const records = new Map<string, Record<string, number | string>>();
        const correlations = analyzer.getCorrelations();

        for (const corr of correlations) {
            const key = `${CORRELATION_PREFIX}${corr.itemA}|${corr.itemB}`;
            records.set(key, {
                coefficient: corr.coefficient,
                lag: corr.lag,
                confidence: corr.confidence,
                direction: corr.direction,
            });
        }

        return records;
    }

    snapshotConfidence(confidenceTracker: ConfidenceTracker): Map<string, Record<string, number | string>> {
        const records = new Map<string, Record<string, number | string>>();
        const serialized = confidenceTracker.serialize();

        for (const rec of serialized) {
            const key = `${CONFIDENCE_PREFIX}${rec.key}`;
            records.set(key, rec.fields);
        }

        return records;
    }

    restoreBehavioral(
        records: Map<string, Record<string, number | string>>,
        tracker: InsightTracker
    ): number {
        let restored = 0;

        for (const [key, fields] of records) {
            if (!key.startsWith(BEHAVIOR_PREFIX)) continue;

            const itemKey = key.substring(BEHAVIOR_PREFIX.length);
            tracker.bootstrapRecord(itemKey, Number(fields.lastWrite || Date.now()));

            tracker.restoreState(itemKey, {
                velocity: Number(fields.velocity ?? 0),
                accessFrequency: Number(fields.accessFrequency ?? 0),
                lastWrite: Number(fields.lastWrite ?? 0),
                lastRead: Number(fields.lastRead ?? 0),
                writeCount: Number(fields.writeCount ?? 0),
                readCount: Number(fields.readCount ?? 0),
                entropy: Number(fields.entropy ?? 0),
                volatility: Number(fields.volatility ?? 0),
                streak: Number(fields.streak ?? 0),
                streakRecord: Number(fields.streakRecord ?? 0),
                lifecycle: String(fields.lifecycle ?? 'stable') as ItemBehavior['lifecycle'],
                lifecycleChangedAt: Number(fields.lifecycleChangedAt ?? 0),
            });

            restored++;
        }

        return restored;
    }

    restoreConfidence(
        records: Map<string, Record<string, number | string>>,
        confidenceTracker: ConfidenceTracker
    ): number {
        const confRecords: Array<{ key: string; fields: Record<string, number | string> }> = [];

        for (const [key, fields] of records) {
            if (!key.startsWith(CONFIDENCE_PREFIX)) continue;
            const scopeKey = key.substring(CONFIDENCE_PREFIX.length);
            confRecords.push({ key: scopeKey, fields });
        }

        if (confRecords.length > 0) {
            confidenceTracker.restore(confRecords);
        }

        return confRecords.length;
    }

    extractInsightRecords(
        allRecords: Map<string, Record<string, number | string>>
    ): Map<string, Record<string, number | string>> {
        const insightRecords = new Map<string, Record<string, number | string>>();
        for (const [key, fields] of allRecords) {
            if (InsightPersistence.isInsightKey(key)) {
                insightRecords.set(key, fields);
            }
        }
        return insightRecords;
    }
}
