import * as path from 'path';
import { GICSInferenceEngine } from './engine.js';
import { InferenceStateStore } from './state-store.js';
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

export class InferenceEngineModule implements DaemonModule {
    public enabled = true;
    public readonly manifest = {
        id: 'inference-engine',
        version: '1.0.0',
        description: 'Deterministic inference engine for scoring, ranking, and policy tuning',
        capabilities: ['infer', 'profile', 'recommendations'],
    };

    private readonly engine: GICSInferenceEngine;

    constructor(dataPath: string, private readonly defaultScope: string) {
        const statePath = path.join(dataPath, 'inference', 'state.json');
        this.engine = new GICSInferenceEngine(new InferenceStateStore(statePath), defaultScope);
    }

    async init(): Promise<void> {
        await this.engine.load();
    }

    async stop(): Promise<void> {
        await this.engine.save();
    }

    async onWrite(event: ModuleWriteEvent): Promise<void> {
        this.engine.recordWrite(this.defaultScope, Buffer.byteLength(JSON.stringify(event.fields), 'utf8'));
        await this.engine.save();
    }

    async onDelete(): Promise<void> {
        this.engine.recordWrite(this.defaultScope, 0);
        await this.engine.save();
    }

    async onRead(_event: ModuleReadEvent): Promise<void> {
        this.engine.recordRead(this.defaultScope, 0);
        await this.engine.save();
    }

    async onScan(): Promise<void> {
        this.engine.recordScan(this.defaultScope);
        await this.engine.save();
    }

    async onFlush(event: ModuleFlushEvent): Promise<void> {
        const compressionRatio = event.bytesWritten > 0 && event.recordsFlushed > 0
            ? Math.max(1, (event.recordsFlushed * 128) / event.bytesWritten)
            : undefined;
        this.engine.recordFlush(this.defaultScope, compressionRatio);
        await this.engine.save();
    }

    async onCompact(_event: ModuleCompactEvent): Promise<void> {
        this.engine.recordCompaction(this.defaultScope);
        await this.engine.save();
    }

    async onRotate(_event: ModuleRotateEvent): Promise<void> {
        this.engine.recordRotation(this.defaultScope);
        await this.engine.save();
    }

    async onOutcome(event: ModuleOutcomeEvent): Promise<void> {
        if (!event.domain) return;
        this.engine.recordOutcome(event.domain, event.decisionId, event.context as Record<string, unknown> | undefined, event.metrics, event.result);
        await this.engine.save();
    }

    async infer(request: InferenceRequest, ctx: ModuleContext): Promise<InferenceDecision | null> {
        const decision = this.engine.infer(request);
        await ctx.upsertSystemRecord(`_infer|decision|${decision.decisionId}`, {
            domain: decision.domain,
            decision_id: decision.decisionId,
            recommended_id: decision.recommended?.id ?? '',
            policy_version: decision.policyVersion,
            profile_version: decision.profileVersion,
            created_at_ms: decision.createdAt,
            ranking_json: JSON.stringify(decision.ranking),
        });
        await this.engine.save();
        return decision;
    }

    async getProfile(scope: string, ctx: ModuleContext): Promise<Record<string, unknown> | null> {
        const profile = this.engine.getProfile(scope);
        await ctx.upsertSystemRecord(`_infer|profile|${scope}`, {
            scope,
            version: Number(profile.version ?? 1),
            updated_at_ms: Number(profile.updatedAt ?? Date.now()),
            profile_json: JSON.stringify(profile),
        });
        await this.engine.save();
        return profile;
    }

    async getRecommendations(query: RecommendationQuery): Promise<Array<Record<string, unknown>>> {
        return this.engine.getRecommendations(query);
    }

    async health(): Promise<Record<string, unknown>> {
        return {
            enabled: true,
            defaultScope: this.defaultScope,
        };
    }
}
