import * as os from 'node:os';
import { createHash } from 'node:crypto';
import {
    InferenceKeys,
    InferenceStateStore,
    type CandidateOutcomeStats,
    type SeedPolicyInput,
    type SeedProfileInput,
    type ScopeProfile,
    type StoredDecisionRecord,
    type StoredFeedbackRecord,
    type StoredPolicyRecord
} from './state-store.js';
import type { InferenceDecision, InferenceRequest, RecommendationQuery } from '../daemon/module-registry.js';

interface CandidateInput {
    id: string;
    payload: Record<string, unknown>;
}

interface ScoredCandidate {
    id: string;
    score: number;
    confidence: number;
    basis: string[];
    candidate: Record<string, unknown>;
}

export interface InferenceArtifacts {
    decision: InferenceDecision;
    decisionRecord: StoredDecisionRecord;
    profile: ScopeProfile;
    policy: StoredPolicyRecord;
}

export interface OutcomeArtifacts {
    feedback: StoredFeedbackRecord;
    stats: CandidateOutcomeStats;
    profile: ScopeProfile;
    policy: StoredPolicyRecord | null;
    linkedDecision: boolean;
    decisionLagMs: number | null;
    feedbackScore: number;
}

function stableId(raw: unknown): string {
    return createHash('sha256').update(stableStringify(raw)).digest('hex').slice(0, 16);
}

function stableStringify(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort((a, b) => a.localeCompare(b));
    return '{' + keys.map((key) => JSON.stringify(key) + ':' + stableStringify(obj[key])).join(',') + '}';
}

function clamp(value: number, min: number = 0, max: number = 1): number {
    return Math.max(min, Math.min(max, value));
}

function toNumber(value: unknown, fallback: number = 0): number {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
}

function feedbackScore(result: string | undefined, success: boolean): number {
    if (success) return 1;
    switch (String(result ?? '').toLowerCase()) {
        case 'partial':
        case 'retry':
            return 0.35;
        case 'timeout':
        case 'error':
        case 'fail':
        case 'failed':
            return 0;
        default:
            return success ? 1 : 0.1;
    }
}

function normalizeStorageMode(value: unknown): 'current' | 'read_heavy' | 'write_heavy' {
    const raw = String(value ?? '').trim().toLowerCase();
    if (raw === 'policy.read_heavy' || raw === 'read_heavy') return 'read_heavy';
    if (raw === 'policy.write_heavy' || raw === 'write_heavy') return 'write_heavy';
    return 'current';
}

export class GICSInferenceEngine {
    private readonly hostFingerprint: string;
    private readonly engineVersion = 'gics-inference-engine-v1';
    private readonly policyVersion = 'gics-infer-policy-v1';

    constructor(private readonly store: InferenceStateStore, private readonly defaultScope: string) {
        this.hostFingerprint = `${os.hostname()}|${os.platform()}|${os.arch()}`;
    }

    async load(): Promise<void> {
        await this.store.load();
        this.store.setRuntimeMetadata({ engineVersion: this.engineVersion });
    }

    async save(): Promise<void> {
        await this.store.save();
    }

    seedProfile(seed: SeedProfileInput): ScopeProfile {
        return this.store.seedProfile(seed);
    }

    seedPolicy(seed: SeedPolicyInput): StoredPolicyRecord {
        return this.store.seedPolicy(seed);
    }

    recordWrite(scope: string, payloadBytes: number): ScopeProfile {
        return this.store.recordWrite(scope, this.hostFingerprint, payloadBytes);
    }

    recordRead(scope: string, latencyMs: number = 0): ScopeProfile {
        return this.store.recordRead(scope, this.hostFingerprint, latencyMs);
    }

    recordScan(scope: string): ScopeProfile {
        return this.store.recordScan(scope, this.hostFingerprint);
    }

    recordFlush(scope: string, compressionRatio?: number): ScopeProfile {
        return this.store.recordFlush(scope, this.hostFingerprint, compressionRatio);
    }

    recordCompaction(scope: string): ScopeProfile {
        return this.store.recordCompaction(scope, this.hostFingerprint);
    }

    recordRotation(scope: string): ScopeProfile {
        return this.store.recordRotation(scope, this.hostFingerprint);
    }

    recordOutcome(
        domain: string,
        decisionId: string | undefined,
        context: Record<string, unknown> | undefined,
        metrics: Record<string, number> | undefined,
        result: string | undefined
    ): OutcomeArtifacts | null {
        const decision = decisionId ? this.store.getDecision(decisionId) : null;
        const { candidateId, scope, subject } = this.extractIdentifiers(context, decision);
        if (!candidateId) return null;

        const success = result === 'success' || result === 'ok' || result === 'true';
        const feedbackScoreValue = feedbackScore(result, success);
        const feedback: StoredFeedbackRecord = {
            feedbackId: `${Date.now()}|${stableId({ domain, candidateId, decisionId, scope, subject, result, metrics })}`,
            systemKey: '',
            domain,
            scope,
            subject,
            decisionId,
            candidateId,
            success,
            result: String(result ?? (success ? 'success' : 'failure')),
            metrics: { ...metrics },
            context: context ? { ...context } : undefined,
            recordedAt: Date.now(),
        };
        feedback.systemKey = InferenceKeys.buildFeedbackSystemKey(feedback.feedbackId);
        this.store.appendFeedback(feedback);

        const stats = this.store.recordOutcome(domain, candidateId, {
            success,
            latencyMs: metrics?.latencyMs,
            costScore: metrics?.costScore ?? metrics?.costUsd,
            feedbackScore: feedbackScoreValue,
            result: feedback.result,
        });

        let profile = this.store.getProfile(scope, this.hostFingerprint);
        if (success && decision) {
            const chosen = decision.ranking.find((item) => item.id === candidateId);
            if (domain === 'compression.encode') {
                profile = this.store.updateProfile(scope, this.hostFingerprint, (draft) => {
                    draft.preferences.preferredCompressionPreset = candidateId;
                });
            } else if (domain === 'ops.provider_select') {
                profile = this.store.updateProfile(scope, this.hostFingerprint, (draft) => {
                    draft.preferences.preferredProviderId = candidateId;
                });
            } else if (domain === 'ops.plan_rank' && chosen) {
                profile = this.store.updateProfile(scope, this.hostFingerprint, (draft) => {
                    const risk = toNumber(chosen.candidate.risk, 0.5);
                    const confidence = toNumber(chosen.candidate.confidence, 0.5);
                    draft.preferences.preferredPlanBias = confidence >= (1 - risk) ? 'high_confidence' : 'low_risk';
                });
            } else if (domain === 'storage.policy') {
                profile = this.store.updateProfile(scope, this.hostFingerprint, (draft) => {
                    draft.policyHints.storageMode = normalizeStorageMode(candidateId);
                });
            }
        }

        const policy = this.buildPolicy(domain, scope, subject, profile, decision?.ranking.map((item) => ({
            id: item.id,
            payload: { ...item.candidate },
        })) ?? []);
        this.store.upsertPolicy(policy);

        return {
            feedback,
            stats,
            profile,
            policy,
            linkedDecision: decision != null,
            decisionLagMs: decision ? Math.max(0, feedback.recordedAt - decision.createdAt) : null,
            feedbackScore: feedbackScoreValue,
        };
    }

    infer(request: InferenceRequest): InferenceDecision {
        return this.inferDetailed(request).decision;
    }

    inferDetailed(request: InferenceRequest): InferenceArtifacts {
        const scope = this.resolveScope(request.context);
        const subject = request.subject ? String(request.subject) : undefined;
        const now = Date.now();
        const profile = this.store.getProfile(scope, this.hostFingerprint);
        const candidates = this.resolveCandidates(request);
        const policy = this.buildPolicy(request.domain, scope, subject, profile, candidates);
        const ranking = candidates
            .map((candidate) => this.scoreCandidate(request.domain, candidate, profile, policy))
            .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

        const recommended = ranking[0];
        const finalizedPolicy: StoredPolicyRecord = {
            ...policy,
            recommendedCandidateId: recommended?.id,
            payload: {
                ...policy.payload,
                recommendedCandidateId: recommended?.id,
                rankingPreview: ranking.slice(0, 3).map((item) => ({
                    id: item.id,
                    score: item.score,
                    confidence: item.confidence,
                })),
            },
            generatedAt: now,
        };
        this.store.upsertPolicy(finalizedPolicy);

        const decisionId = `${request.domain}|${now}|${stableId({ scope, subject, candidates: ranking.map((item) => item.id), objective: request.objective })}`;
        const evidenceKeys = [`_infer|profile|${scope}`, finalizedPolicy.systemKey];
        const decision: InferenceDecision = {
            domain: request.domain,
            decisionId,
            ranking: ranking.map((item) => ({
                id: item.id,
                score: item.score,
                confidence: item.confidence,
                basis: item.basis,
                candidate: item.candidate,
            })),
            policyVersion: finalizedPolicy.policyVersion,
            profileVersion: `profile-v${profile.version}`,
            evidenceKeys,
            recommended: recommended ? {
                id: recommended.id,
                score: recommended.score,
                confidence: recommended.confidence,
                basis: recommended.basis,
            } : undefined,
            createdAt: now,
        };

        const decisionRecord: StoredDecisionRecord = {
            decisionId,
            systemKey: InferenceKeys.buildDecisionSystemKey(decisionId),
            domain: request.domain,
            scope,
            subject,
            recommendedId: recommended?.id,
            createdAt: now,
            policyKey: finalizedPolicy.key,
            policyVersion: finalizedPolicy.policyVersion,
            profileVersion: decision.profileVersion,
            ranking: decision.ranking.map((item) => ({
                id: item.id,
                score: item.score,
                confidence: item.confidence,
                basis: [...item.basis],
                candidate: { ...item.candidate },
            })),
            evidenceKeys,
        };
        this.store.appendDecision(decisionRecord);

        const profileHints = this.deriveProfileHints(request.domain, recommended?.id, recommended?.candidate ?? {}, finalizedPolicy.payload);
        const updatedProfile = this.store.updatePolicyHints(scope, this.hostFingerprint, profileHints);

        return {
            decision,
            decisionRecord,
            profile: updatedProfile,
            policy: finalizedPolicy,
        };
    }

    getProfile(scope: string): ScopeProfile {
        return this.store.getProfile(scope, this.hostFingerprint);
    }

    getPolicy(domain: string, scope: string, subject?: string): StoredPolicyRecord | null {
        return this.store.getPolicy(domain, scope, subject);
    }

    getPolicyByKey(policyKey: string): StoredPolicyRecord | null {
        return this.store.getPolicyByKey(policyKey);
    }

    getDecision(decisionId: string): StoredDecisionRecord | null {
        return this.store.getDecision(decisionId);
    }

    getFeedback(feedbackId: string): StoredFeedbackRecord | null {
        return this.store.getFeedback(feedbackId);
    }

    getRecommendations(query: RecommendationQuery): Array<Record<string, unknown>> {
        const limit = query.limit ?? 20;
        const decisions = this.store.getDecisions(query.domain, query.subject, limit).map((decision) => ({
            type: 'inference_decision',
            domain: decision.domain,
            scope: decision.scope,
            subject: decision.subject,
            decisionId: decision.decisionId,
            recommendedId: decision.recommendedId,
            ranking: decision.ranking,
            policyVersion: decision.policyVersion,
            profileVersion: decision.profileVersion,
            createdAt: decision.createdAt,
            evidenceKeys: decision.evidenceKeys,
        }));
        const policies = this.store.getPolicies(query.domain, this.defaultScope, query.subject, Math.max(1, Math.floor(limit / 2))).map((policy) => ({
            type: 'inference_policy',
            domain: policy.domain,
            scope: policy.scope,
            subject: policy.subject,
            policyKey: policy.key,
            policyVersion: policy.policyVersion,
            profileVersion: policy.profileVersion,
            recommendedCandidateId: policy.recommendedCandidateId,
            payload: policy.payload,
            generatedAt: policy.generatedAt,
            evidenceKeys: policy.evidenceKeys,
        }));
        return [...decisions, ...policies]
            .sort((a, b) => {
                const aTime = Number((a as { createdAt?: number; generatedAt?: number; }).createdAt ?? (a as { generatedAt?: number; }).generatedAt ?? 0);
                const bTime = Number((b as { createdAt?: number; generatedAt?: number; }).createdAt ?? (b as { generatedAt?: number; }).generatedAt ?? 0);
                return bTime - aTime;
            })
            .slice(0, limit);
    }

    getRuntimeSnapshot(): Record<string, unknown> {
        return {
            ...this.store.getRuntime(),
            ...this.store.getSummary(),
            hostFingerprint: this.hostFingerprint,
            defaultScope: this.defaultScope,
        };
    }

    private resolveScope(context: Record<string, unknown> | undefined): string {
        return typeof context?.scope === 'string' ? context.scope : this.defaultScope;
    }

    private extractIdentifiers(
        context: Record<string, unknown> | undefined,
        decision: StoredDecisionRecord | null
    ): { candidateId: string; scope: string; subject?: string } {
        let candidateId = '';
        if (typeof context?.candidateId === 'string') candidateId = context.candidateId;
        else if (typeof context?.chosenCandidateId === 'string') candidateId = context.chosenCandidateId;
        else if (typeof decision?.recommendedId === 'string') candidateId = decision.recommendedId;

        let scope = this.defaultScope;
        if (typeof context?.scope === 'string') scope = context.scope;
        else if (typeof decision?.scope === 'string') scope = decision.scope;
        
        let subject: string | undefined;
        if (typeof context?.subject === 'string') subject = context.subject;
        else if (typeof decision?.subject === 'string') subject = decision.subject;
        
        return { candidateId, scope, subject };
    }

    private resolveCandidates(request: InferenceRequest): CandidateInput[] {
        if (request.candidates?.length) {
            return request.candidates.map((candidate, index) => {
                let id = `${request.domain}-${index}`;
                if (typeof candidate.id === 'string') id = candidate.id;
                else if (typeof candidate.name === 'string') id = candidate.name;
                else if (typeof candidate.model === 'string') id = candidate.model;
                return {
                    id,
                    payload: { ...candidate },
                };
            });
        }

        switch (request.domain) {
            case 'compression.encode':
                return [
                    { id: 'balanced', payload: { preset: 'balanced' } },
                    { id: 'max_ratio', payload: { preset: 'max_ratio' } },
                    { id: 'low_latency', payload: { preset: 'low_latency' } },
                ];
            case 'storage.policy':
                return [
                    { id: 'policy.current', payload: { mode: 'current' } },
                    { id: 'policy.read_heavy', payload: { mode: 'read_heavy' } },
                    { id: 'policy.write_heavy', payload: { mode: 'write_heavy' } },
                ];
            default:
                return [];
        }
    }

    private buildPolicy(domain: string, scope: string, subject: string | undefined, profile: ScopeProfile, candidates: CandidateInput[]): StoredPolicyRecord {
        const key = InferenceKeys.buildPolicyStorageKey(domain, scope, subject);
        const base: StoredPolicyRecord = {
            key,
            systemKey: InferenceKeys.buildPolicySystemKey(domain, scope, subject),
            domain,
            scope,
            subject,
            policyVersion: `${this.policyVersion}:${domain}`,
            profileVersion: `profile-v${profile.version}`,
            generatedAt: Date.now(),
            basis: [],
            weights: {},
            thresholds: {},
            payload: {},
            evidenceKeys: [`_infer|profile|${scope}`],
        };

        switch (domain) {
            case 'compression.encode': return this.buildCompressionPolicy(profile, candidates, base);
            case 'ops.provider_select': return this.buildProviderPolicy(profile, base);
            case 'ops.plan_rank': return this.buildPlanPolicy(profile, base);
            case 'storage.policy': return this.buildStoragePolicy(profile, base);
            default:
                return {
                    ...base,
                    basis: [`candidates=${candidates.length}`],
                    weights: { bandit: 0.65, heuristic: 0.35 },
                    thresholds: {},
                    payload: {},
                };
        }
    }

    private buildCompressionPolicy(profile: ScopeProfile, candidates: CandidateInput[], base: StoredPolicyRecord): StoredPolicyRecord {
        const readHeavy = profile.stats.reads > Math.max(1, profile.stats.writes * 2);
        const ratioLow = profile.stats.avgCompressionRatio > 0 && profile.stats.avgCompressionRatio < 20;
        let suggestedPreset = profile.preferences.preferredCompressionPreset ?? 'balanced';
        if (readHeavy) suggestedPreset = 'low_latency';
        else if (ratioLow) suggestedPreset = 'max_ratio';
        return {
            ...base,
            basis: [`reads=${profile.stats.reads}`, `writes=${profile.stats.writes}`, `avgCompressionRatio=${profile.stats.avgCompressionRatio.toFixed(2)}`],
            weights: { bandit: 0.55, readPressure: readHeavy ? 0.25 : 0.08, ratioPressure: ratioLow ? 0.25 : 0.12, baseline: 0.15 },
            thresholds: { ratioLowCutoff: 20, readHeavyFactor: 2 },
            payload: { suggestedPreset, workloadClass: readHeavy ? 'read_heavy' : 'balanced', candidateCount: candidates.length },
        };
    }

    private buildProviderPolicy(profile: ScopeProfile, base: StoredPolicyRecord): StoredPolicyRecord {
        return {
            ...base,
            basis: [`preferredProvider=${profile.preferences.preferredProviderId ?? 'none'}`, `avgLatency=${profile.stats.avgReadLatencyMs.toFixed(2)}`],
            weights: { bandit: 0.5, latency: 0.3, cost: 0.2 },
            thresholds: { maxLatencyMs: 5000, maxCostScore: 1 },
            payload: { objective: 'provider_select', preferredProviderId: profile.preferences.preferredProviderId ?? null },
        };
    }

    private buildPlanPolicy(profile: ScopeProfile, base: StoredPolicyRecord): StoredPolicyRecord {
        return {
            ...base,
            basis: [`preferredPlanBias=${profile.preferences.preferredPlanBias ?? 'balanced'}`, `reads=${profile.stats.reads}`, `writes=${profile.stats.writes}`],
            weights: { bandit: 0.35, confidence: 0.3, risk: 0.2, cost: 0.15 },
            thresholds: { maxRisk: 0.65, minConfidence: 0.55 },
            payload: { objective: 'plan_rank', preferredBias: profile.preferences.preferredPlanBias ?? 'balanced' },
        };
    }

    private buildStoragePolicy(profile: ScopeProfile, base: StoredPolicyRecord): StoredPolicyRecord {
        const scanHeavy = profile.stats.scans > Math.max(1, profile.stats.writes);
        const writeHeavy = profile.stats.writes >= Math.max(1, profile.stats.reads);
        let mode = normalizeStorageMode(profile.policyHints.storageMode);
        if (mode === 'current') {
            if (scanHeavy) mode = 'read_heavy';
            else if (writeHeavy) mode = 'write_heavy';
        }
        return {
            ...base,
            basis: [`scans=${profile.stats.scans}`, `writes=${profile.stats.writes}`, `flushes=${profile.stats.flushes}`],
            weights: { bandit: 0.35, modeMatch: 0.2, scanPressure: scanHeavy ? 0.2 : 0.1, writePressure: writeHeavy ? 0.2 : 0.1, safety: 0.15 },
            thresholds: { scanHeavyCutoff: profile.stats.writes || 1, writeHeavyCutoff: profile.stats.reads || 1 },
            payload: {
                mode,
                recommendedCandidateId: `policy.${mode}`,
                recommendedMaxMemSizeBytes: writeHeavy ? 64 * 1024 * 1024 : 24 * 1024 * 1024,
                recommendedMaxDirtyCount: scanHeavy ? 1500 : 4000,
                recommendedWarmRetentionMs: scanHeavy ? 14 * 24 * 60 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000,
            },
        };
    }

    private scoreCandidate(domain: string, candidate: CandidateInput, profile: ScopeProfile, policy: StoredPolicyRecord): ScoredCandidate {
        const stats = this.store.getOutcomeStats(domain, candidate.id);
        const pulls = (stats?.successes ?? 0) + (stats?.failures ?? 0);
        const banditScore = ((stats?.successes ?? 0) + 3) / (pulls + 4);
        const basis: string[] = [`bandit=${banditScore.toFixed(3)}`];
        const components: number[] = [banditScore];
        const weights: number[] = [policy.weights.bandit ?? 0.65];

        switch (domain) {
            case 'compression.encode': this.scoreCompression(candidate, policy, components, weights, basis); break;
            case 'ops.provider_select': this.scoreProvider(candidate, stats ?? null, policy, components, weights, basis); break;
            case 'ops.plan_rank': this.scorePlan(candidate, policy, components, weights, basis); break;
            case 'storage.policy': this.scoreStorage(candidate, profile, policy, components, weights, basis); break;
            default:
                components.push(clamp(0.45 + ((stats?.avgFeedbackScore ?? 0.5) * 0.5)));
                weights.push(policy.weights.heuristic ?? 0.35);
                break;
        }

        const totalWeight = Math.max(0.0001, weights.reduce((sum, current) => sum + current, 0));
        const weightedScore = components.reduce((sum, component, index) => sum + (component * weights[index]), 0);
        const score = clamp(weightedScore / totalWeight);
        const confidence = clamp(0.35 + (Math.min(pulls, 25) / 35) + ((stats?.avgFeedbackScore ?? 0) * 0.15));

        if (stats) basis.push(`outcomes=${stats.totalOutcomes}`, `success=${stats.successes}`, `feedback=${stats.avgFeedbackScore.toFixed(2)}`);

        return { id: candidate.id, score, confidence, basis, candidate: { ...candidate.payload } };
    }

    private scoreCompression(candidate: CandidateInput, policy: StoredPolicyRecord, components: number[], weights: number[], basis: string[]): void {
        const suggested = typeof policy.payload.suggestedPreset === 'string' ? policy.payload.suggestedPreset : 'balanced';
        
        let readMatch = 0.25;
        if (candidate.id === 'low_latency') readMatch = 1;
        else if (candidate.id === 'balanced') readMatch = 0.6;
        
        let ratioMatch = 0.25;
        if (candidate.id === 'max_ratio') ratioMatch = 1;
        else if (candidate.id === 'balanced') ratioMatch = 0.55;
        
        let baseline = 0.4;
        if (candidate.id === suggested) baseline = 1;
        else if (candidate.id === 'balanced') baseline = 0.7;

        components.push(readMatch, ratioMatch, baseline);
        weights.push(policy.weights.readPressure ?? 0.15, policy.weights.ratioPressure ?? 0.15, policy.weights.baseline ?? 0.15);
        basis.push(`suggestedPreset=${suggested}`);
    }

    private scoreProvider(candidate: CandidateInput, stats: CandidateOutcomeStats | null, policy: StoredPolicyRecord, components: number[], weights: number[], basis: string[]): void {
        const latency = toNumber(candidate.payload.latencyMs ?? candidate.payload.latency, stats?.avgLatencyMs ?? 2500);
        const cost = toNumber(candidate.payload.costScore ?? candidate.payload.cost ?? candidate.payload.costUsd, stats?.avgCostScore ?? 0.5);
        components.push(clamp(1 - (latency / Math.max(1, policy.thresholds.maxLatencyMs ?? 5000))), clamp(1 - (cost / Math.max(0.001, policy.thresholds.maxCostScore ?? 1))));
        weights.push(policy.weights.latency ?? 0.2, policy.weights.cost ?? 0.15);
        basis.push(`latency=${latency}`, `cost=${cost}`);
    }

    private scorePlan(candidate: CandidateInput, policy: StoredPolicyRecord, components: number[], weights: number[], basis: string[]): void {
        const risk = toNumber(candidate.payload.risk, 0.5);
        const confidence = toNumber(candidate.payload.confidence, 0.5);
        const cost = toNumber(candidate.payload.estimated_cost ?? candidate.payload.cost, 0.5);
        components.push(clamp(confidence), clamp(1 - risk), clamp(1 - cost));
        weights.push(policy.weights.confidence ?? 0.3, policy.weights.risk ?? 0.2, policy.weights.cost ?? 0.15);
        basis.push(`risk=${risk}`, `confidence=${confidence}`, `cost=${cost}`);
    }

    private scoreStorage(candidate: CandidateInput, profile: ScopeProfile, policy: StoredPolicyRecord, components: number[], weights: number[], basis: string[]): void {
        const mode = normalizeStorageMode(candidate.payload.mode ?? candidate.id);
        const recMode = normalizeStorageMode(policy.payload.mode ?? policy.payload.recommendedCandidateId);

        let modeScore = 0.4;
        if (mode === recMode) modeScore = 1;
        else if (mode === 'current') modeScore = 0.65;

        const scanDemand = profile.stats.scans > Math.max(1, profile.stats.writes);
        const writeDemand = profile.stats.writes >= Math.max(1, profile.stats.reads);
        const scanMatch = mode === 'read_heavy'
            ? (scanDemand ? 1 : 0.3)
            : (mode === 'current' ? 0.55 : 0.15);
        const writeMatch = mode === 'write_heavy'
            ? (writeDemand ? 1 : 0.3)
            : (mode === 'current' ? 0.55 : 0.15);
        const safety = mode === 'current' ? 1 : 0.75;

        components.push(modeScore, scanMatch, writeMatch, safety);
        weights.push(
            policy.weights.modeMatch ?? 0.2,
            policy.weights.scanPressure ?? 0.2,
            policy.weights.writePressure ?? 0.2,
            policy.weights.safety ?? 0.15,
        );
        Object.assign(candidate.payload, {
            mode,
            recommendedMaxMemSizeBytes: policy.payload.recommendedMaxMemSizeBytes,
            recommendedMaxDirtyCount: policy.payload.recommendedMaxDirtyCount,
            recommendedWarmRetentionMs: policy.payload.recommendedWarmRetentionMs,
        });
        basis.push(`mode=${mode}`, `recommendedMode=${recMode}`, `scanDemand=${scanDemand ? 1 : 0}`, `writeDemand=${writeDemand ? 1 : 0}`);
    }

    private deriveProfileHints(
        domain: string,
        recommendedId: string | undefined,
        recommendedCandidate: Record<string, unknown>,
        policyPayload: Record<string, unknown>
    ): ScopeProfile['policyHints'] {
        if (domain === 'compression.encode') {
            const preset = typeof policyPayload.suggestedPreset === 'string' ? policyPayload.suggestedPreset : 'balanced';
            return {
                compressionPreset: recommendedId ?? preset,
            };
        }

        if (domain === 'ops.provider_select') {
            return {
                providerId: recommendedId,
            };
        }

        if (domain === 'storage.policy') {
            const mode = normalizeStorageMode(policyPayload.mode);
            return {
                storageMode: normalizeStorageMode(recommendedId ?? mode),
                maxMemSizeBytes: Math.floor(toNumber(recommendedCandidate.recommendedMaxMemSizeBytes ?? policyPayload.recommendedMaxMemSizeBytes, 0)),
                maxDirtyCount: toNumber(recommendedCandidate.recommendedMaxDirtyCount ?? policyPayload.recommendedMaxDirtyCount, 0),
                warmRetentionMs: toNumber(recommendedCandidate.recommendedWarmRetentionMs ?? policyPayload.recommendedWarmRetentionMs, 0),
            };
        }

        return {};
    }
}
