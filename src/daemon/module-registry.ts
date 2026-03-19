import type { StateIndexEntry, StateIndexScanResult } from './state-index.js';
import type { TelemetrySink } from '../telemetry/collector.js';

export interface ModuleManifest {
    id: string;
    version: string;
    description: string;
    capabilities?: string[];
}

export interface ModuleWriteEvent {
    key: string;
    fields: Record<string, number | string>;
    timestamp: number;
}

export interface ModuleDeleteEvent {
    key: string;
    timestamp: number;
    tombstoneKey: string;
}

export interface ModuleReadEvent {
    key: string;
    timestamp: number;
}

export interface ModuleOutcomeEvent {
    insightId?: string;
    result?: string;
    domain?: string;
    decisionId?: string;
    context?: unknown;
    metrics?: Record<string, number>;
    timestamp: number;
}

export interface ModuleFlushEvent {
    trigger: 'manual' | 'auto';
    recordsFlushed: number;
    bytesWritten: number;
    segmentCreated: string | null;
}

export interface ModuleRotateEvent {
    rotated: boolean;
    filesArchived: number;
}

export interface ModuleCompactEvent {
    compacted: boolean;
    segmentsMerged: number;
}

export interface InferenceRequest {
    domain: string;
    objective?: string;
    subject?: string;
    context?: Record<string, unknown>;
    candidates?: Array<Record<string, unknown>>;
}

export interface InferenceDecision {
    domain: string;
    decisionId: string;
    ranking: Array<{
        id: string;
        score: number;
        confidence: number;
        basis: string[];
        candidate: Record<string, unknown>;
    }>;
    policyVersion: string;
    profileVersion: string;
    evidenceKeys: string[];
    recommended?: {
        id: string;
        score: number;
        confidence: number;
        basis: string[];
    };
    createdAt: number;
}

export interface RecommendationQuery {
    domain?: string;
    subject?: string;
    limit?: number;
}

export interface ModuleContext {
    emitEvent(type: string, data: unknown): void;
    upsertSystemRecord(key: string, fields: Record<string, number | string>): Promise<void>;
    now(): number;
    getStateSnapshot(): StateIndexEntry[];
    telemetry?: TelemetrySink | null;
}

export interface DaemonModule {
    manifest: ModuleManifest;
    enabled: boolean;
    init?(ctx: ModuleContext): Promise<void>;
    restore?(ctx: ModuleContext): Promise<void>;
    beforeWrite?(event: ModuleWriteEvent, ctx: ModuleContext): Promise<void>;
    beforeDelete?(event: ModuleDeleteEvent, ctx: ModuleContext): Promise<void>;
    onWrite?(event: ModuleWriteEvent, ctx: ModuleContext): Promise<void>;
    onDelete?(event: ModuleDeleteEvent, ctx: ModuleContext): Promise<void>;
    onRead?(event: ModuleReadEvent, ctx: ModuleContext): Promise<void>;
    onScan?(result: StateIndexScanResult, ctx: ModuleContext): Promise<void>;
    onFlush?(event: ModuleFlushEvent, ctx: ModuleContext): Promise<void>;
    onCompact?(event: ModuleCompactEvent, ctx: ModuleContext): Promise<void>;
    onRotate?(event: ModuleRotateEvent, ctx: ModuleContext): Promise<void>;
    onOutcome?(event: ModuleOutcomeEvent, ctx: ModuleContext): Promise<void>;
    infer?(request: InferenceRequest, ctx: ModuleContext): Promise<InferenceDecision | null>;
    getProfile?(scope: string, ctx: ModuleContext): Promise<Record<string, unknown> | null>;
    getRecommendations?(query: RecommendationQuery, ctx: ModuleContext): Promise<Array<Record<string, unknown>>>;
    health?(): Promise<Record<string, unknown>>;
    snapshot?(): Promise<Record<string, unknown>>;
    forceFlush?(): Promise<void>;
    stop?(): Promise<void>;
}

export class ModuleRegistry {
    private readonly modules = new Map<string, DaemonModule>();

    register(module: DaemonModule): void {
        this.modules.set(module.manifest.id, module);
    }

    get(moduleId: string): DaemonModule | null {
        return this.modules.get(moduleId) ?? null;
    }

    list(): DaemonModule[] {
        return Array.from(this.modules.values());
    }

    enabled(): DaemonModule[] {
        return this.list().filter((module) => module.enabled);
    }

    async initAll(ctx: ModuleContext): Promise<void> {
        for (const module of this.enabled()) {
            await module.init?.(ctx);
        }
    }

    async restoreAll(ctx: ModuleContext): Promise<void> {
        for (const module of this.enabled()) {
            await module.restore?.(ctx);
        }
    }

    async beforeWrite(event: ModuleWriteEvent, ctx: ModuleContext): Promise<void> {
        for (const module of this.enabled()) {
            await module.beforeWrite?.(event, ctx);
        }
    }

    async beforeDelete(event: ModuleDeleteEvent, ctx: ModuleContext): Promise<void> {
        for (const module of this.enabled()) {
            await module.beforeDelete?.(event, ctx);
        }
    }

    async onWrite(event: ModuleWriteEvent, ctx: ModuleContext): Promise<void> {
        for (const module of this.enabled()) {
            await module.onWrite?.(event, ctx);
        }
    }

    async onDelete(event: ModuleDeleteEvent, ctx: ModuleContext): Promise<void> {
        for (const module of this.enabled()) {
            await module.onDelete?.(event, ctx);
        }
    }

    async onRead(event: ModuleReadEvent, ctx: ModuleContext): Promise<void> {
        for (const module of this.enabled()) {
            await module.onRead?.(event, ctx);
        }
    }

    async onScan(result: StateIndexScanResult, ctx: ModuleContext): Promise<void> {
        for (const module of this.enabled()) {
            await module.onScan?.(result, ctx);
        }
    }

    async onFlush(event: ModuleFlushEvent, ctx: ModuleContext): Promise<void> {
        for (const module of this.enabled()) {
            await module.onFlush?.(event, ctx);
        }
    }

    async onCompact(event: ModuleCompactEvent, ctx: ModuleContext): Promise<void> {
        for (const module of this.enabled()) {
            await module.onCompact?.(event, ctx);
        }
    }

    async onRotate(event: ModuleRotateEvent, ctx: ModuleContext): Promise<void> {
        for (const module of this.enabled()) {
            await module.onRotate?.(event, ctx);
        }
    }

    async onOutcome(event: ModuleOutcomeEvent, ctx: ModuleContext): Promise<void> {
        for (const module of this.enabled()) {
            await module.onOutcome?.(event, ctx);
        }
    }

    async infer(request: InferenceRequest, ctx: ModuleContext): Promise<InferenceDecision | null> {
        for (const module of this.enabled()) {
            const result = await module.infer?.(request, ctx);
            if (result) return result;
        }
        return null;
    }

    async getProfile(scope: string, ctx: ModuleContext): Promise<Record<string, unknown> | null> {
        for (const module of this.enabled()) {
            const result = await module.getProfile?.(scope, ctx);
            if (result) return result;
        }
        return null;
    }

    async getRecommendations(query: RecommendationQuery, ctx: ModuleContext): Promise<Array<Record<string, unknown>>> {
        const out: Array<Record<string, unknown>> = [];
        for (const module of this.enabled()) {
            const result = await module.getRecommendations?.(query, ctx);
            if (result?.length) out.push(...result);
        }
        const limit = Math.max(0, Number(query.limit ?? 0));
        if (limit > 0) return out.slice(0, limit);
        return out;
    }

    async health(): Promise<Record<string, unknown>> {
        const out: Record<string, unknown> = {};
        for (const module of this.enabled()) {
            out[module.manifest.id] = await module.health?.() ?? { enabled: true };
        }
        return out;
    }

    async stopAll(): Promise<void> {
        for (const module of this.enabled()) {
            await module.stop?.();
        }
    }
}
