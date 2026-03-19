import * as path from 'path';
import { GICSInferenceEngine } from './engine.js';
import { InferenceStateStore, type SeedPolicyInput, type SeedProfileInput } from './state-store.js';
import type {
    DaemonModule,
    InferenceDecision,
    InferenceRequest,
    ModuleCompactEvent,
    ModuleContext,
    ModuleDeleteEvent,
    ModuleFlushEvent,
    ModuleOutcomeEvent,
    ModuleReadEvent,
    ModuleRotateEvent,
    ModuleWriteEvent,
    RecommendationQuery
} from '../daemon/module-registry.js';
import { durationSeconds, normalizeErrorType, normalizeOutcomeResult } from '../telemetry/utils.js';

export interface InferenceEngineModuleOptions {
    flushIntervalMs?: number;
    flushOpsThreshold?: number;
    eagerFlushOnInfer?: boolean;
    eagerFlushOnOutcome?: boolean;
}

const DEFAULT_OPTIONS: Required<InferenceEngineModuleOptions> = {
    flushIntervalMs: 1500,
    flushOpsThreshold: 32,
    eagerFlushOnInfer: true,
    eagerFlushOnOutcome: true,
};

function normalizeOptions(options?: InferenceEngineModuleOptions): Required<InferenceEngineModuleOptions> {
    return {
        flushIntervalMs: Math.max(100, Number(options?.flushIntervalMs ?? DEFAULT_OPTIONS.flushIntervalMs)),
        flushOpsThreshold: Math.max(1, Number(options?.flushOpsThreshold ?? DEFAULT_OPTIONS.flushOpsThreshold)),
        eagerFlushOnInfer: options?.eagerFlushOnInfer ?? DEFAULT_OPTIONS.eagerFlushOnInfer,
        eagerFlushOnOutcome: options?.eagerFlushOnOutcome ?? DEFAULT_OPTIONS.eagerFlushOnOutcome,
    };
}

export class InferenceEngineModule implements DaemonModule {
    public enabled = true;
    public readonly manifest = {
        id: 'inference-engine',
        version: '1.1.0',
        description: 'Deterministic inference engine for scoring, ranking, policy tuning, and feedback learning',
        capabilities: ['infer', 'profile', 'recommendations', 'feedback', 'policy'],
    };

    private readonly engine: GICSInferenceEngine;
    private readonly options: Required<InferenceEngineModuleOptions>;
    private ctx: ModuleContext | null = null;
    private flushTimer: ReturnType<typeof setTimeout> | null = null;
    private flushChain: Promise<void> = Promise.resolve();
    private dirtyVersion = 0;
    private flushedVersion = 0;
    private pendingOps = 0;
    private flushCount = 0;
    private lastFlushAt = 0;
    private lastFlushDurationMs = 0;
    private lastDecisionAt = 0;
    private lastOutcomeAt = 0;
    private lastError: string | null = null;
    private readonly profileVersions = new Map<string, number>();
    private readonly publishedProfileVersions = new Map<string, number>();
    private readonly policyVersions = new Map<string, number>();
    private readonly publishedPolicyVersions = new Map<string, number>();
    private readonly pendingDecisionIds = new Set<string>();
    private readonly pendingFeedbackIds = new Set<string>();

    constructor(dataPath: string, private readonly defaultScope: string, options?: InferenceEngineModuleOptions) {
        const statePath = path.join(dataPath, 'inference', 'state.json');
        this.engine = new GICSInferenceEngine(new InferenceStateStore(statePath, defaultScope), defaultScope);
        this.options = normalizeOptions(options);
    }

    async init(ctx: ModuleContext): Promise<void> {
        this.ctx = ctx;
        await this.engine.load();
        this.syncPendingTelemetry();
    }

    async restore(ctx: ModuleContext): Promise<void> {
        this.ctx = ctx;
        this.syncPendingTelemetry();
    }

    async stop(): Promise<void> {
        await this.flushNow('stop');
    }

    async onWrite(event: ModuleWriteEvent, ctx: ModuleContext): Promise<void> {
        if (event.key.startsWith('_infer|') || event.key.startsWith('_sys|')) return;
        this.ctx = ctx;
        this.engine.recordWrite(this.defaultScope, Buffer.byteLength(JSON.stringify(event.fields), 'utf8'));
        this.markProfileDirty(this.defaultScope);
        this.noteMutation();
    }

    async onDelete(event: ModuleDeleteEvent, ctx: ModuleContext): Promise<void> {
        if (event.key.startsWith('_infer|') || event.key.startsWith('_sys|')) return;
        this.ctx = ctx;
        this.engine.recordWrite(this.defaultScope, 0);
        this.markProfileDirty(this.defaultScope);
        this.noteMutation();
    }

    async onRead(event: ModuleReadEvent, ctx: ModuleContext): Promise<void> {
        if (event.key.startsWith('_infer|') || event.key.startsWith('_sys|')) return;
        this.ctx = ctx;
        this.engine.recordRead(this.defaultScope, 0);
        this.markProfileDirty(this.defaultScope);
        this.noteMutation();
    }

    async onScan(_result: unknown, ctx: ModuleContext): Promise<void> {
        this.ctx = ctx;
        this.engine.recordScan(this.defaultScope);
        this.markProfileDirty(this.defaultScope);
        this.noteMutation();
    }

    async onFlush(event: ModuleFlushEvent, ctx: ModuleContext): Promise<void> {
        this.ctx = ctx;
        const compressionRatio = event.bytesWritten > 0 && event.recordsFlushed > 0
            ? Math.max(1, (event.recordsFlushed * 128) / event.bytesWritten)
            : undefined;
        this.engine.recordFlush(this.defaultScope, compressionRatio);
        this.markProfileDirty(this.defaultScope);
        this.markPolicyDirtyByParts('storage.policy', this.defaultScope);
        this.noteMutation();
    }

    async onCompact(_event: ModuleCompactEvent, ctx: ModuleContext): Promise<void> {
        this.ctx = ctx;
        this.engine.recordCompaction(this.defaultScope);
        this.markProfileDirty(this.defaultScope);
        this.noteMutation();
    }

    async onRotate(_event: ModuleRotateEvent, ctx: ModuleContext): Promise<void> {
        this.ctx = ctx;
        this.engine.recordRotation(this.defaultScope);
        this.markProfileDirty(this.defaultScope);
        this.markPolicyDirtyByParts('storage.policy', this.defaultScope);
        this.noteMutation();
    }

    async onOutcome(event: ModuleOutcomeEvent, ctx: ModuleContext): Promise<void> {
        if (!event.domain) return;
        this.ctx = ctx;
        const telemetry = this.telemetry();
        const normalizedResult = normalizeOutcomeResult(event.result);
        telemetry?.incrementCounter(
            'gics_infer_outcomes_total',
            { domain: event.domain, result: normalizedResult },
            1,
            'Inference outcome events observed by the inference engine.',
        );
        const artifacts = this.engine.recordOutcome(
            event.domain,
            event.decisionId,
            event.context as Record<string, unknown> | undefined,
            event.metrics,
            event.result
        );
        if (!artifacts) {
            telemetry?.incrementCounter(
                'gics_infer_outcome_linkage_total',
                { domain: event.domain, linked: 'false' },
                1,
                'Whether inference outcomes could be linked back to a known decision/candidate.',
            );
            telemetry?.recordEvent('inference_outcome_orphaned', {
                domain: event.domain,
                decisionId: event.decisionId ?? null,
            });
            return;
        }

        telemetry?.incrementCounter(
            'gics_infer_outcome_linkage_total',
            { domain: event.domain, linked: artifacts.linkedDecision ? 'true' : 'false' },
            1,
            'Whether inference outcomes could be linked back to a known decision/candidate.',
        );
        telemetry?.observeHistogram(
            'gics_infer_feedback_score',
            artifacts.feedbackScore,
            { domain: event.domain },
            {
                unit: 'score',
                description: 'Feedback score assigned to inference outcomes.',
            },
        );
        if (artifacts.decisionLagMs != null) {
            telemetry?.observeHistogram(
                'gics_infer_decision_to_outcome_seconds',
                artifacts.decisionLagMs / 1000,
                { domain: event.domain },
                {
                    unit: 'seconds',
                    description: 'Elapsed time between an inference decision and its eventual outcome.',
                },
            );
        } else {
            telemetry?.recordEvent('inference_outcome_orphaned', {
                domain: event.domain,
                decisionId: event.decisionId ?? null,
                feedbackId: artifacts.feedback.feedbackId,
            });
        }

        this.markProfileDirty(artifacts.profile.scope);
        if (artifacts.policy) {
            this.markPolicyDirty(artifacts.policy.key);
            telemetry?.incrementCounter(
                'gics_infer_policy_regenerations_total',
                { domain: event.domain },
                1,
                'Policy regenerations triggered by inference feedback and outcomes.',
            );
        }
        this.pendingFeedbackIds.add(artifacts.feedback.feedbackId);
        this.lastOutcomeAt = artifacts.feedback.recordedAt;
        this.noteMutation();

        if (this.options.eagerFlushOnOutcome) {
            await this.flushNow('outcome');
        }
    }

    async infer(request: InferenceRequest, ctx: ModuleContext): Promise<InferenceDecision | null> {
        this.ctx = ctx;
        const telemetry = this.telemetry();
        const startedAt = Date.now();
        try {
            const artifacts = this.engine.inferDetailed(request);
            this.pendingDecisionIds.add(artifacts.decisionRecord.decisionId);
            this.markProfileDirty(artifacts.profile.scope);
            this.markPolicyDirty(artifacts.policy.key);
            this.lastDecisionAt = artifacts.decision.createdAt;
            this.noteMutation();

            telemetry?.observeHistogram(
                'gics_infer_candidates',
                artifacts.decision.ranking.length,
                { domain: request.domain },
                {
                    unit: 'count',
                    description: 'Number of candidates scored per inference request.',
                },
            );
            telemetry?.incrementCounter(
                'gics_infer_policy_regenerations_total',
                { domain: request.domain },
                1,
                'Policy regenerations triggered by inference feedback and outcomes.',
            );

            await this.publishDecision(ctx, artifacts.decisionRecord.decisionId);
            await this.publishProfile(ctx, artifacts.profile.scope);
            await this.publishPolicy(ctx, artifacts.policy.key);

            if (this.options.eagerFlushOnInfer) {
                await this.flushNow('infer');
            }

            telemetry?.incrementCounter(
                'gics_infer_requests_total',
                { domain: request.domain, result: 'ok' },
                1,
                'Inference requests processed by the inference engine.',
            );
            telemetry?.observeHistogram(
                'gics_infer_duration_seconds',
                durationSeconds(startedAt),
                { domain: request.domain },
                {
                    unit: 'seconds',
                    description: 'Latency of inference requests handled by the inference engine.',
                },
            );
            return artifacts.decision;
        } catch (error) {
            telemetry?.incrementCounter(
                'gics_infer_requests_total',
                { domain: request.domain, result: 'error', error_type: normalizeErrorType(error) },
                1,
                'Inference requests processed by the inference engine.',
            );
            telemetry?.observeHistogram(
                'gics_infer_duration_seconds',
                durationSeconds(startedAt),
                { domain: request.domain },
                {
                    unit: 'seconds',
                    description: 'Latency of inference requests handled by the inference engine.',
                },
            );
            throw error;
        }
    }

    async getProfile(scope: string, ctx: ModuleContext): Promise<Record<string, unknown> | null> {
        this.ctx = ctx;
        this.markProfileDirty(scope);
        await this.publishProfile(ctx, scope);
        if (this.hasDirtyState()) {
            await this.flushNow('getProfile');
        }
        return structuredClone(this.engine.getProfile(scope)) as unknown as Record<string, unknown>;
    }

    async getRecommendations(query: RecommendationQuery): Promise<Array<Record<string, unknown>>> {
        return this.engine.getRecommendations(query);
    }

    async seedProfile(seed: SeedProfileInput, ctx: ModuleContext): Promise<Record<string, unknown>> {
        this.ctx = ctx;
        const profile = this.engine.seedProfile(seed);
        this.markProfileDirty(profile.scope);
        this.noteMutation();
        await this.publishProfile(ctx, profile.scope);
        await this.flushNow('seedProfile');
        return structuredClone(profile) as unknown as Record<string, unknown>;
    }

    async seedPolicy(seed: SeedPolicyInput, ctx: ModuleContext): Promise<Record<string, unknown>> {
        this.ctx = ctx;
        const policy = this.engine.seedPolicy(seed);
        this.markPolicyDirty(policy.key);
        this.noteMutation();
        await this.publishPolicy(ctx, policy.key);
        await this.flushNow('seedPolicy');
        return structuredClone(policy) as unknown as Record<string, unknown>;
    }

    async health(): Promise<Record<string, unknown>> {
        return {
            enabled: true,
            defaultScope: this.defaultScope,
            ...this.engine.getRuntimeSnapshot(),
            dirty: this.hasDirtyState(),
            pendingOps: this.pendingOps,
            flushCount: this.flushCount,
            lastFlushAt: this.lastFlushAt,
            lastFlushDurationMs: this.lastFlushDurationMs,
            lastDecisionAt: this.lastDecisionAt,
            lastOutcomeAt: this.lastOutcomeAt,
            lastError: this.lastError,
            flushIntervalMs: this.options.flushIntervalMs,
            flushOpsThreshold: this.options.flushOpsThreshold,
            pendingProfiles: this.pendingProfilesCount(),
            pendingPolicies: this.pendingPoliciesCount(),
            pendingDecisions: this.pendingDecisionIds.size,
            pendingFeedback: this.pendingFeedbackIds.size,
        };
    }

    async snapshot(): Promise<Record<string, unknown>> {
        return this.health();
    }

    async forceFlush(): Promise<void> {
        await this.flushNow('manual');
    }

    private telemetry() {
        return this.ctx?.telemetry ?? null;
    }

    private pendingProfilesCount(): number {
        return Array.from(this.profileVersions.entries())
            .filter(([scope, version]) => this.publishedProfileVersions.get(scope) !== version)
            .length;
    }

    private pendingPoliciesCount(): number {
        return Array.from(this.policyVersions.entries())
            .filter(([key, version]) => this.publishedPolicyVersions.get(key) !== version)
            .length;
    }

    private syncPendingTelemetry(): void {
        const telemetry = this.telemetry();
        if (!telemetry) return;
        telemetry.setGauge('gics_infer_pending_ops', this.pendingOps, {}, {
            unit: 'count',
            description: 'Pending inference mutations waiting to be durably flushed.',
        });
        telemetry.setGauge('gics_infer_pending_profiles', this.pendingProfilesCount(), {}, {
            unit: 'count',
            description: 'Inference profiles changed but not yet published to system storage.',
        });
        telemetry.setGauge('gics_infer_pending_policies', this.pendingPoliciesCount(), {}, {
            unit: 'count',
            description: 'Inference policies changed but not yet published to system storage.',
        });
        telemetry.setGauge('gics_infer_pending_decisions', this.pendingDecisionIds.size, {}, {
            unit: 'count',
            description: 'Inference decisions queued for publication.',
        });
        telemetry.setGauge('gics_infer_pending_feedback', this.pendingFeedbackIds.size, {}, {
            unit: 'count',
            description: 'Inference feedback records queued for publication.',
        });
    }

    private noteMutation(): void {
        this.dirtyVersion += 1;
        this.pendingOps += 1;
        this.syncPendingTelemetry();
        if (this.pendingOps >= this.options.flushOpsThreshold) {
            void this.flushNow('threshold').catch(() => undefined);
            return;
        }
        this.scheduleFlush();
    }

    private scheduleFlush(): void {
        if (this.flushTimer) return;
        this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            void this.flushNow('timer').catch(() => undefined);
        }, this.options.flushIntervalMs);
    }

    private clearScheduledFlush(): void {
        if (!this.flushTimer) return;
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
    }

    private hasDirtyState(): boolean {
        return this.dirtyVersion !== this.flushedVersion
            || this.pendingDecisionIds.size > 0
            || this.pendingFeedbackIds.size > 0
            || Array.from(this.profileVersions.entries()).some(([scope, version]) => this.publishedProfileVersions.get(scope) !== version)
            || Array.from(this.policyVersions.entries()).some(([key, version]) => this.publishedPolicyVersions.get(key) !== version);
    }

    private async flushNow(reason: string): Promise<void> {
        const startedAt = Date.now();
        const run = async () => {
            this.clearScheduledFlush();
            while (this.hasDirtyState()) {
                const targetVersion = this.dirtyVersion;
                const startedAt = Date.now();
                if (this.ctx) {
                    await this.publishPendingArtifacts(this.ctx);
                }
                try {
                    await this.engine.save();
                    this.telemetry()?.incrementCounter(
                        'gics_infer_save_total',
                        { result: 'ok' },
                        1,
                        'Durable inference state saves performed by the inference engine.',
                    );
                } catch (error) {
                    this.telemetry()?.incrementCounter(
                        'gics_infer_save_total',
                        { result: 'error', error_type: normalizeErrorType(error) },
                        1,
                        'Durable inference state saves performed by the inference engine.',
                    );
                    throw error;
                }
                this.flushedVersion = targetVersion;
                this.pendingOps = this.dirtyVersion === this.flushedVersion ? 0 : this.pendingOps;
                this.flushCount += 1;
                this.lastFlushAt = Date.now();
                this.lastFlushDurationMs = this.lastFlushAt - startedAt;
                this.lastError = null;
                this.syncPendingTelemetry();
                if (!this.hasDirtyState()) break;
            }
        };

        this.flushChain = this.flushChain.then(run, async () => {
            await run();
        });

        try {
            await this.flushChain;
            this.telemetry()?.incrementCounter(
                'gics_infer_flush_total',
                { reason, result: 'ok' },
                1,
                'Inference flush attempts executed by the inference engine module.',
            );
            this.telemetry()?.observeHistogram(
                'gics_infer_flush_duration_seconds',
                durationSeconds(startedAt),
                { reason },
                {
                    unit: 'seconds',
                    description: 'Latency of inference flush cycles.',
                },
            );
        } catch (err: any) {
            this.lastError = `${reason}: ${err.message}`;
            this.syncPendingTelemetry();
            this.telemetry()?.incrementCounter(
                'gics_infer_flush_total',
                { reason, result: 'error', error_type: normalizeErrorType(err) },
                1,
                'Inference flush attempts executed by the inference engine module.',
            );
            this.telemetry()?.observeHistogram(
                'gics_infer_flush_duration_seconds',
                durationSeconds(startedAt),
                { reason },
                {
                    unit: 'seconds',
                    description: 'Latency of inference flush cycles.',
                },
            );
            this.telemetry()?.recordEvent('flush_failed', {
                reason,
                errorType: normalizeErrorType(err),
                message: err.message,
            });
            throw err;
        }
    }

    private markProfileDirty(scope: string): void {
        this.profileVersions.set(scope, (this.profileVersions.get(scope) ?? 0) + 1);
    }

    private markPolicyDirty(policyKey: string): void {
        this.policyVersions.set(policyKey, (this.policyVersions.get(policyKey) ?? 0) + 1);
    }

    private markPolicyDirtyByParts(domain: string, scope: string, subject?: string): void {
        const policy = this.engine.getPolicy(domain, scope, subject);
        if (policy) {
            this.markPolicyDirty(policy.key);
        }
    }

    private async publishPendingArtifacts(ctx: ModuleContext): Promise<void> {
        const pendingProfiles = Array.from(this.profileVersions.entries())
            .filter(([scope, version]) => this.publishedProfileVersions.get(scope) !== version)
            .map(([scope]) => scope);
        for (const scope of pendingProfiles) {
            await this.publishProfile(ctx, scope);
        }

        const pendingPolicies = Array.from(this.policyVersions.entries())
            .filter(([policyKey, version]) => this.publishedPolicyVersions.get(policyKey) !== version)
            .map(([policyKey]) => policyKey);
        for (const policyKey of pendingPolicies) {
            await this.publishPolicy(ctx, policyKey);
        }

        for (const decisionId of Array.from(this.pendingDecisionIds)) {
            await this.publishDecision(ctx, decisionId);
        }

        for (const feedbackId of Array.from(this.pendingFeedbackIds)) {
            await this.publishFeedback(ctx, feedbackId);
        }
    }

    private async publishProfile(ctx: ModuleContext, scope: string): Promise<void> {
        const profile = this.engine.getProfile(scope);
        try {
            await ctx.upsertSystemRecord(`_infer|profile|${scope}`, {
                scope,
                version: profile.version,
                updated_at_ms: profile.updatedAt,
                profile_json: JSON.stringify(profile),
            });
            this.telemetry()?.incrementCounter(
                'gics_infer_publish_total',
                { artifact: 'profile', result: 'ok' },
                1,
                'Inference artifacts published into daemon system storage.',
            );
            this.telemetry()?.incrementCounter(
                'gics_infer_profile_updates_total',
                {},
                1,
                'Published profile updates performed by the inference engine.',
            );
            const version = this.profileVersions.get(scope);
            if (version !== undefined) {
                this.publishedProfileVersions.set(scope, version);
            }
            this.syncPendingTelemetry();
        } catch (error) {
            this.telemetry()?.incrementCounter(
                'gics_infer_publish_total',
                { artifact: 'profile', result: 'error', error_type: normalizeErrorType(error) },
                1,
                'Inference artifacts published into daemon system storage.',
            );
            this.telemetry()?.recordEvent('inference_publish_failed', {
                artifact: 'profile',
                scope,
                errorType: normalizeErrorType(error),
            });
            throw error;
        }
    }

    private async publishPolicy(ctx: ModuleContext, policyKey: string): Promise<void> {
        const policy = this.engine.getPolicyByKey(policyKey);
        if (!policy) return;
        try {
            await ctx.upsertSystemRecord(policy.systemKey, {
                domain: policy.domain,
                scope: policy.scope,
                subject: policy.subject ?? '',
                policy_version: policy.policyVersion,
                profile_version: policy.profileVersion,
                generated_at_ms: policy.generatedAt,
                recommended_candidate_id: policy.recommendedCandidateId ?? '',
                basis_json: JSON.stringify(policy.basis),
                weights_json: JSON.stringify(policy.weights),
                thresholds_json: JSON.stringify(policy.thresholds),
                payload_json: JSON.stringify(policy.payload),
                evidence_json: JSON.stringify(policy.evidenceKeys),
            });
            this.telemetry()?.incrementCounter(
                'gics_infer_publish_total',
                { artifact: 'policy', result: 'ok' },
                1,
                'Inference artifacts published into daemon system storage.',
            );
            const version = this.policyVersions.get(policyKey);
            if (version !== undefined) {
                this.publishedPolicyVersions.set(policyKey, version);
            }
            this.syncPendingTelemetry();
        } catch (error) {
            this.telemetry()?.incrementCounter(
                'gics_infer_publish_total',
                { artifact: 'policy', result: 'error', error_type: normalizeErrorType(error) },
                1,
                'Inference artifacts published into daemon system storage.',
            );
            this.telemetry()?.recordEvent('inference_publish_failed', {
                artifact: 'policy',
                policyKey,
                errorType: normalizeErrorType(error),
            });
            throw error;
        }
    }

    private async publishDecision(ctx: ModuleContext, decisionId: string): Promise<void> {
        const decision = this.engine.getDecision(decisionId);
        if (!decision) return;
        try {
            await ctx.upsertSystemRecord(decision.systemKey, {
                domain: decision.domain,
                scope: decision.scope,
                subject: decision.subject ?? '',
                decision_id: decision.decisionId,
                recommended_id: decision.recommendedId ?? '',
                policy_key: decision.policyKey,
                policy_version: decision.policyVersion,
                profile_version: decision.profileVersion,
                created_at_ms: decision.createdAt,
                ranking_json: JSON.stringify(decision.ranking),
                evidence_json: JSON.stringify(decision.evidenceKeys),
            });
            this.telemetry()?.incrementCounter(
                'gics_infer_publish_total',
                { artifact: 'decision', result: 'ok' },
                1,
                'Inference artifacts published into daemon system storage.',
            );
            this.pendingDecisionIds.delete(decisionId);
            this.syncPendingTelemetry();
        } catch (error) {
            this.telemetry()?.incrementCounter(
                'gics_infer_publish_total',
                { artifact: 'decision', result: 'error', error_type: normalizeErrorType(error) },
                1,
                'Inference artifacts published into daemon system storage.',
            );
            this.telemetry()?.recordEvent('inference_publish_failed', {
                artifact: 'decision',
                decisionId,
                errorType: normalizeErrorType(error),
            });
            throw error;
        }
    }

    private async publishFeedback(ctx: ModuleContext, feedbackId: string): Promise<void> {
        const feedback = this.engine.getFeedback(feedbackId);
        if (!feedback) return;
        try {
            await ctx.upsertSystemRecord(feedback.systemKey, {
                domain: feedback.domain,
                scope: feedback.scope,
                subject: feedback.subject ?? '',
                feedback_id: feedback.feedbackId,
                decision_id: feedback.decisionId ?? '',
                candidate_id: feedback.candidateId,
                success: feedback.success ? 1 : 0,
                result: feedback.result,
                recorded_at_ms: feedback.recordedAt,
                metrics_json: JSON.stringify(feedback.metrics),
                context_json: JSON.stringify(feedback.context ?? {}),
            });
            this.telemetry()?.incrementCounter(
                'gics_infer_publish_total',
                { artifact: 'feedback', result: 'ok' },
                1,
                'Inference artifacts published into daemon system storage.',
            );
            this.pendingFeedbackIds.delete(feedbackId);
            this.syncPendingTelemetry();
        } catch (error) {
            this.telemetry()?.incrementCounter(
                'gics_infer_publish_total',
                { artifact: 'feedback', result: 'error', error_type: normalizeErrorType(error) },
                1,
                'Inference artifacts published into daemon system storage.',
            );
            this.telemetry()?.recordEvent('inference_publish_failed', {
                artifact: 'feedback',
                feedbackId,
                errorType: normalizeErrorType(error),
            });
            throw error;
        }
    }
}
