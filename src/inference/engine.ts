import * as os from 'os';
import { createHash } from 'crypto';
import { InferenceStateStore, type ScopeProfile, type StoredDecisionRecord } from './state-store.js';
import type { InferenceDecision, InferenceRequest, RecommendationQuery } from '../daemon/module-registry.js';

interface CandidateInput {
    id: string;
    payload: Record<string, unknown>;
}

function stableId(raw: unknown): string {
    return createHash('sha256').update(JSON.stringify(raw)).digest('hex').slice(0, 16);
}

function clamp(value: number, min: number = 0, max: number = 1): number {
    return Math.max(min, Math.min(max, value));
}

function toNumber(value: unknown, fallback: number = 0): number {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
}

export class GICSInferenceEngine {
    private readonly hostFingerprint: string;
    private readonly policyVersion = 'gics-infer-v1';

    constructor(private readonly store: InferenceStateStore, private readonly defaultScope: string) {
        this.hostFingerprint = `${os.hostname()}|${os.platform()}|${os.arch()}`;
    }

    async load(): Promise<void> {
        await this.store.load();
    }

    async save(): Promise<void> {
        await this.store.save();
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
    ): void {
        const candidateId = String(
            context?.candidateId ??
            context?.chosenCandidateId ??
            this.store.getDecision(decisionId ?? '')?.recommendedId ??
            ''
        );
        if (!candidateId) return;

        this.store.recordOutcome(domain, candidateId, {
            success: result === 'success' || result === 'ok' || result === 'true',
            latencyMs: metrics?.latencyMs,
            costScore: metrics?.costScore ?? metrics?.costUsd,
        });
    }

    infer(request: InferenceRequest): InferenceDecision {
        const scope = String(request.context?.scope ?? this.defaultScope);
        const subject = request.subject ? String(request.subject) : undefined;
        const profile = this.store.getProfile(scope, this.hostFingerprint);
        const candidates = this.resolveCandidates(request);
        const ranking = candidates.map((candidate) => this.scoreCandidate(request.domain, candidate, profile));
        ranking.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

        const decisionId = `${request.domain}|${Date.now()}|${stableId({ scope, subject, candidates: ranking.map((c) => c.id) })}`;
        const recommended = ranking[0];
        const evidenceKeys = [`_infer|profile|${scope}`, `_infer|policy|${request.domain}`];
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
            policyVersion: this.policyVersion,
            profileVersion: `profile-v${profile.version}`,
            evidenceKeys,
            recommended: recommended ? {
                id: recommended.id,
                score: recommended.score,
                confidence: recommended.confidence,
                basis: recommended.basis,
            } : undefined,
            createdAt: Date.now(),
        };

        const record: StoredDecisionRecord = {
            decisionId,
            domain: request.domain,
            subject,
            recommendedId: recommended?.id,
            createdAt: decision.createdAt,
            policyVersion: decision.policyVersion,
            profileVersion: decision.profileVersion,
            ranking: decision.ranking.map((item) => ({
                id: item.id,
                score: item.score,
                confidence: item.confidence,
                basis: item.basis,
            })),
            evidenceKeys,
        };
        this.store.appendDecision(record);

        return decision;
    }

    getProfile(scope: string): Record<string, unknown> {
        return { ...this.store.getProfile(scope, this.hostFingerprint) };
    }

    getRecommendations(query: RecommendationQuery): Array<Record<string, unknown>> {
        return this.store.getDecisions(query.domain, query.subject, query.limit ?? 20).map((decision) => ({
            type: 'inference_decision',
            domain: decision.domain,
            subject: decision.subject,
            decisionId: decision.decisionId,
            recommendedId: decision.recommendedId,
            ranking: decision.ranking,
            policyVersion: decision.policyVersion,
            profileVersion: decision.profileVersion,
            createdAt: decision.createdAt,
            evidenceKeys: decision.evidenceKeys,
        }));
    }

    private resolveCandidates(request: InferenceRequest): CandidateInput[] {
        if (request.candidates?.length) {
            return request.candidates.map((candidate, index) => ({
                id: String(candidate.id ?? candidate.name ?? candidate.model ?? `${request.domain}-${index}`),
                payload: { ...candidate },
            }));
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

    private scoreCandidate(domain: string, candidate: CandidateInput, profile: ScopeProfile): {
        id: string;
        score: number;
        confidence: number;
        basis: string[];
        candidate: Record<string, unknown>;
    } {
        const stats = this.store.getOutcomeStats(domain, candidate.id);
        const successes = stats?.successes ?? 0;
        const failures = stats?.failures ?? 0;
        const pulls = successes + failures;
        const banditScore = (successes + 3) / (pulls + 4);
        const basis: string[] = [`bandit=${banditScore.toFixed(3)}`];
        let heuristic = 0.5;

        if (domain === 'compression.encode') {
            const readHeavy = profile.stats.reads > Math.max(1, profile.stats.writes * 2);
            const ratioLow = profile.stats.avgCompressionRatio > 0 && profile.stats.avgCompressionRatio < 20;
            if (candidate.id === 'low_latency') heuristic += readHeavy ? 0.2 : 0.05;
            if (candidate.id === 'max_ratio') heuristic += ratioLow ? 0.2 : 0.08;
            if (candidate.id === 'balanced') heuristic += 0.15;
            basis.push(`reads=${profile.stats.reads}`, `writes=${profile.stats.writes}`, `ratio=${profile.stats.avgCompressionRatio.toFixed(2)}`);
        } else if (domain === 'ops.provider_select') {
            const latencyPenalty = stats?.avgLatencyMs ? clamp(1 - (stats.avgLatencyMs / 5000)) : 0.5;
            const costBonus = stats?.avgCostScore ? clamp(1 - stats.avgCostScore) : 0.5;
            heuristic += (latencyPenalty * 0.2) + (costBonus * 0.15);
            basis.push(`latency=${stats?.avgLatencyMs ?? 0}`, `cost=${stats?.avgCostScore ?? 0}`);
        } else if (domain === 'ops.plan_rank') {
            const estRisk = toNumber(candidate.payload.risk, 0.5);
            const estConfidence = toNumber(candidate.payload.confidence, 0.5);
            const estCost = toNumber(candidate.payload.estimated_cost, 0.5);
            heuristic += clamp(estConfidence) * 0.25;
            heuristic += clamp(1 - estRisk) * 0.15;
            heuristic += clamp(1 - estCost) * 0.1;
            basis.push(`risk=${estRisk}`, `confidence=${estConfidence}`, `cost=${estCost}`);
        } else if (domain === 'storage.policy') {
            const scanHeavy = profile.stats.scans > profile.stats.writes;
            const writeHeavy = profile.stats.writes >= profile.stats.reads;
            if (candidate.id === 'policy.read_heavy' && scanHeavy) heuristic += 0.2;
            if (candidate.id === 'policy.write_heavy' && writeHeavy) heuristic += 0.2;
            if (candidate.id === 'policy.current') heuristic += 0.15;
            basis.push(`scans=${profile.stats.scans}`, `flushes=${profile.stats.flushes}`);
            candidate.payload = {
                ...candidate.payload,
                recommendedMaxMemSizeBytes: writeHeavy ? 64 * 1024 * 1024 : 24 * 1024 * 1024,
                recommendedMaxDirtyCount: scanHeavy ? 1500 : 4000,
                recommendedWarmRetentionMs: scanHeavy ? 14 * 24 * 60 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000,
            };
        }

        const score = clamp((banditScore * 0.65) + (heuristic * 0.35));
        const confidence = clamp(0.35 + Math.min(pulls, 20) / 30);

        return {
            id: candidate.id,
            score,
            confidence,
            basis,
            candidate: candidate.payload,
        };
    }
}
