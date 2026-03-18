import * as path from 'path';
import { AuditChain } from './audit-chain.js';
import { ModuleRegistry, type DaemonModule, type ModuleContext, type ModuleDeleteEvent, type ModuleOutcomeEvent, type ModuleReadEvent, type ModuleWriteEvent, type RecommendationQuery } from './module-registry.js';
import { PromptDistiller } from './prompt-distiller.js';
import { InferenceEngineModule, type InferenceEngineModuleOptions } from '../inference/module.js';
import { InsightTracker, type ItemBehavior, type LifecycleStage } from '../insight/tracker.js';
import { CorrelationAnalyzer } from '../insight/correlation.js';
import { PredictiveSignals } from '../insight/signals.js';
import { ConfidenceTracker, type OutcomeResult } from '../insight/confidence.js';
import { InsightPersistence } from '../insight/persistence.js';
import type { GICSModuleRuntimeConfig } from './config.js';

export class AuditChainModule implements DaemonModule {
    public enabled = true;
    public readonly manifest = {
        id: 'audit-chain',
        version: '1.0.0',
        description: 'Durable audit chain for write/delete operations',
        capabilities: ['audit'],
    };

    constructor(private readonly auditChain: AuditChain) {}

    async beforeWrite(event: ModuleWriteEvent): Promise<void> {
        await this.auditChain.append('system:unknown', 'put', event.key, event.fields);
    }

    async beforeDelete(event: ModuleDeleteEvent): Promise<void> {
        await this.auditChain.append('system:unknown', 'delete', event.key, { tombstoneKey: event.tombstoneKey });
    }

    async health(): Promise<Record<string, unknown>> {
        const stats = this.auditChain.getQuickStats();
        return {
            enabled: true,
            entries: stats.totalEntries,
            lastVerifyValid: stats.lastVerifyValid,
        };
    }

    async verify() {
        return this.auditChain.verify();
    }

    async export() {
        return this.auditChain.export();
    }

    async stop(): Promise<void> {
        await this.auditChain.close();
    }
}

export class PromptDistillerModule implements DaemonModule {
    public enabled = true;
    public readonly manifest = {
        id: 'prompt-distiller',
        version: '1.0.0',
        description: 'Retention and distillation of prompt history',
        capabilities: ['retention'],
    };

    constructor(private readonly distiller: PromptDistiller) {}

    async init(): Promise<void> {
        await this.distiller.initialize();
    }

    async health(): Promise<Record<string, unknown>> {
        const tiers = await this.distiller.getStats();
        return { enabled: true, tiers };
    }

    async stop(): Promise<void> {
        await this.distiller.stop();
    }

    async runRetentionPolicy(): Promise<void> {
        await this.distiller.runRetentionPolicy();
    }
}

export class NativeInsightModule implements DaemonModule {
    public enabled = true;
    public readonly manifest = {
        id: 'native-insight',
        version: '1.0.0',
        description: 'Incremental behavioral, correlation, and predictive insight engine',
        capabilities: ['insight', 'forecast', 'correlation'],
    };

    private readonly insightTracker = new InsightTracker();
    private readonly correlationAnalyzer = new CorrelationAnalyzer();
    private readonly predictiveSignals = new PredictiveSignals();
    private readonly confidenceTracker = new ConfidenceTracker();
    private readonly insightPersistence = new InsightPersistence();

    constructor(private readonly promptDistiller?: PromptDistillerModule | null) {}

    async restore(ctx: ModuleContext): Promise<void> {
        const records = new Map<string, Record<string, number | string>>();
        for (const entry of ctx.getStateSnapshot()) {
            if (!entry.fields || !InsightPersistence.isInsightKey(entry.key)) continue;
            records.set(entry.key, { ...entry.fields });
        }
        this.restoreBehavioral(records);
        this.restoreConfidence(records);
    }

    async onWrite(event: ModuleWriteEvent, ctx: ModuleContext): Promise<void> {
        const prevBehavior = this.insightTracker.getInsight(event.key);
        const prevCorrelations = new Set(this.correlationAnalyzer.getCorrelations().map((corr) => `${corr.itemA}|${corr.itemB}`));
        const prevClusters = new Set(this.correlationAnalyzer.getClusters().map((cluster) => cluster.id));

        const behavior = this.insightTracker.onWrite(event.key, event.timestamp, event.fields);
        this.correlationAnalyzer.onItemUpdate(event.key, event.fields, event.timestamp);
        this.correlationAnalyzer.setLifecycleHint(event.key, behavior.lifecycle);
        const signalResult = this.predictiveSignals.onBehaviorUpdate(behavior, event.fields);

        if (prevBehavior && prevBehavior.lifecycle !== behavior.lifecycle) {
            ctx.emitEvent('lifecycle_change', { key: event.key, from: prevBehavior.lifecycle, to: behavior.lifecycle });
            if ((behavior.lifecycle === 'dormant' || behavior.lifecycle === 'dead') && this.promptDistiller) {
                await this.promptDistiller.runRetentionPolicy().catch(() => undefined);
            }
        }

        for (const anomaly of signalResult.newAnomalies) {
            ctx.emitEvent('anomaly_detected', anomaly);
        }
        for (const recommendation of signalResult.newRecommendations) {
            ctx.emitEvent('recommendation_new', recommendation);
        }

        const nextCorrelations = new Set(this.correlationAnalyzer.getCorrelations().map((corr) => `${corr.itemA}|${corr.itemB}`));
        for (const correlation of this.correlationAnalyzer.getCorrelations()) {
            const key = `${correlation.itemA}|${correlation.itemB}`;
            if (!prevCorrelations.has(key)) {
                ctx.emitEvent('correlation_discovered', correlation);
            }
        }

        const nextClusters = new Set(this.correlationAnalyzer.getClusters().map((cluster) => cluster.id));
        for (const clusterId of nextClusters) {
            if (!prevClusters.has(clusterId)) ctx.emitEvent('cluster_formed', { clusterId });
        }
        for (const clusterId of prevClusters) {
            if (!nextClusters.has(clusterId)) ctx.emitEvent('cluster_dissolved', { clusterId });
        }
    }

    async onDelete(event: ModuleDeleteEvent): Promise<void> {
        this.insightTracker.onWrite(event.key, event.timestamp, { deleted: 1 });
    }

    async onRead(event: ModuleReadEvent): Promise<void> {
        this.insightTracker.onRead(event.key, event.timestamp);
    }

    async onOutcome(event: ModuleOutcomeEvent, ctx: ModuleContext): Promise<void> {
        const insightId = String(event.insightId ?? '');
        const result = String(event.result ?? '') as OutcomeResult;
        if (!insightId || !result) return;

        const recorded = this.recordOutcome(insightId, result);
        if (recorded?.nowDisabled && !recorded.wasDisabled) {
            ctx.emitEvent('insight_disabled', { insightId, result });
        }
    }

    async health(): Promise<Record<string, unknown>> {
        return {
            enabled: true,
            tracked: this.insightTracker.count,
            recommendations: this.predictiveSignals.getRecommendations().length,
        };
    }

    getInsight(key: string): ItemBehavior | null {
        return this.insightTracker.getInsight(key);
    }

    getInsights(filter?: { lifecycle?: LifecycleStage; }): ItemBehavior[] {
        return this.insightTracker.getInsights(filter);
    }

    getAccuracy(insightType?: string, scope?: string): ReturnType<ConfidenceTracker['getAccuracy']> {
        return this.confidenceTracker.getAccuracy(insightType, scope);
    }

    getCorrelations(key?: string) {
        return this.correlationAnalyzer.getCorrelations(key);
    }

    getClusters() {
        return this.correlationAnalyzer.getClusters();
    }

    getLeadingIndicators(key?: string) {
        return this.correlationAnalyzer.getLeadingIndicators(key);
    }

    getSeasonalPatterns(key?: string) {
        return this.correlationAnalyzer.getSeasonalPatterns(key);
    }

    getForecast(key: string, field: string, horizon?: number) {
        const behavior = this.insightTracker.getInsight(key);
        if (!behavior) return null;
        return this.predictiveSignals.getForecast(behavior, field, horizon);
    }

    getAnomalies(since?: number) {
        return this.predictiveSignals.getAnomalies(since);
    }

    async getRecommendations(query: RecommendationQuery = {}): Promise<Array<Record<string, unknown>>> {
        return this.predictiveSignals.getRecommendations(query as Record<string, unknown>) as unknown as Array<Record<string, unknown>>;
    }

    getSignalRecommendations(filter?: Record<string, unknown>) {
        return this.predictiveSignals.getRecommendations(filter);
    }

    recordOutcome(insightId: string, result: OutcomeResult) {
        return this.predictiveSignals.recordOutcome(insightId, result, this.confidenceTracker);
    }

    snapshotBehavioral() {
        return this.insightPersistence.snapshotBehavioral(this.insightTracker);
    }

    snapshotCorrelations() {
        return this.insightPersistence.snapshotCorrelations(this.correlationAnalyzer);
    }

    snapshotConfidence() {
        return this.insightPersistence.snapshotConfidence(this.confidenceTracker);
    }

    restoreBehavioral(records: Map<string, Record<string, number | string>>) {
        return this.insightPersistence.restoreBehavioral(records, this.insightTracker);
    }

    restoreConfidence(records: Map<string, Record<string, number | string>>) {
        return this.insightPersistence.restoreConfidence(records, this.confidenceTracker);
    }

    coldStartBootstrap(key: string): void {
        if (this.insightTracker.getInsight(key)) return;
        const similar = this.correlationAnalyzer.findSimilarKeys(key);
        if (similar.length > 0) {
            const cluster = this.correlationAnalyzer.getClusterForKey(similar[0]!);
            if (cluster) {
                const mean = this.correlationAnalyzer.getClusterMeanBehavior(cluster, this.insightTracker);
                this.insightTracker.bootstrapFromCluster(key, mean);
                return;
            }
        }
        this.insightTracker.bootstrapRecord(key);
    }
}

export interface BuiltinModuleSet {
    registry: ModuleRegistry;
    nativeInsight: NativeInsightModule;
    auditChain: AuditChainModule;
    promptDistiller: PromptDistillerModule | null;
    inferenceEngine: InferenceEngineModule | null;
}

export function createBuiltinModuleSet(options: {
    dataPath: string;
    enablePromptDistiller?: boolean;
    enableInferenceEngine?: boolean;
    defaultScope: string;
    moduleConfigs?: Record<string, GICSModuleRuntimeConfig>;
}): BuiltinModuleSet {
    const registry = new ModuleRegistry();
    const audit = new AuditChainModule(new AuditChain({ filePath: path.join(options.dataPath, 'audit.chain') }));
    registry.register(audit);

    const promptDistiller = options.enablePromptDistiller
        ? new PromptDistillerModule(new PromptDistiller({ dataPath: path.join(options.dataPath, 'distilled') }))
        : null;
    if (promptDistiller) registry.register(promptDistiller);

    const nativeInsight = new NativeInsightModule(promptDistiller);
    registry.register(nativeInsight);

    const inferenceEngine = options.enableInferenceEngine
        ? new InferenceEngineModule(
            options.dataPath,
            options.defaultScope,
            options.moduleConfigs?.['inference-engine']?.options as InferenceEngineModuleOptions | undefined
        )
        : null;
    if (inferenceEngine) registry.register(inferenceEngine);

    return {
        registry,
        nativeInsight,
        auditChain: audit,
        promptDistiller,
        inferenceEngine,
    };
}
