import * as fs from 'fs/promises';
import * as path from 'path';
import { existsSync } from 'fs';

export interface CandidateOutcomeStats {
    successes: number;
    failures: number;
    totalOutcomes: number;
    avgLatencyMs: number;
    avgCostScore: number;
    avgFeedbackScore: number;
    lastOutcomeAt: number;
    lastResult?: string;
}

export interface ScopeProfileStats {
    writes: number;
    reads: number;
    scans: number;
    flushes: number;
    compactions: number;
    rotations: number;
    avgCompressionRatio: number;
    avgPayloadBytes: number;
    avgReadLatencyMs: number;
    lastActivityAt: number;
}

export interface ScopeProfile {
    scope: string;
    version: number;
    hostFingerprint: string;
    stats: ScopeProfileStats;
    preferences: {
        preferredCompressionPreset?: string;
        preferredProviderId?: string;
        preferredPlanBias?: string;
    };
    policyHints: {
        compressionPreset?: string;
        providerId?: string;
        storageMode?: string;
        maxMemSizeBytes?: number;
        maxDirtyCount?: number;
        warmRetentionMs?: number;
    };
    updatedAt: number;
}

export interface StoredPolicyRecord {
    key: string;
    systemKey: string;
    domain: string;
    scope: string;
    subject?: string;
    policyVersion: string;
    profileVersion: string;
    generatedAt: number;
    basis: string[];
    weights: Record<string, number>;
    thresholds: Record<string, number>;
    recommendedCandidateId?: string;
    payload: Record<string, unknown>;
    evidenceKeys: string[];
}

export interface StoredDecisionRecord {
    decisionId: string;
    systemKey: string;
    domain: string;
    scope: string;
    subject?: string;
    recommendedId?: string;
    createdAt: number;
    policyKey: string;
    policyVersion: string;
    profileVersion: string;
    ranking: Array<{
        id: string;
        score: number;
        confidence: number;
        basis: string[];
        candidate: Record<string, unknown>;
    }>;
    evidenceKeys: string[];
}

export interface StoredFeedbackRecord {
    feedbackId: string;
    systemKey: string;
    domain: string;
    scope: string;
    subject?: string;
    decisionId?: string;
    candidateId: string;
    success: boolean;
    result: string;
    metrics: Record<string, number>;
    context?: Record<string, unknown>;
    recordedAt: number;
}

export interface InferenceRuntimeState {
    engineVersion: string;
    stateVersion: number;
    loadedAt: number;
    lastSavedAt: number;
    lastDecisionAt: number;
    lastOutcomeAt: number;
    lastPolicyAt: number;
    saveCount: number;
}

interface LegacyInferenceStateFile {
    version: 1;
    profiles?: Record<string, ScopeProfile>;
    domainStats?: Record<string, Record<string, CandidateOutcomeStats>>;
    decisions?: Array<{
        decisionId: string;
        domain: string;
        subject?: string;
        recommendedId?: string;
        createdAt: number;
        policyVersion: string;
        profileVersion: string;
        ranking: Array<{
            id: string;
            score: number;
            confidence: number;
            basis: string[];
        }>;
        evidenceKeys: string[];
    }>;
}

interface InferenceStateFile {
    version: 2;
    runtime: InferenceRuntimeState;
    profiles: Record<string, ScopeProfile>;
    domainStats: Record<string, Record<string, CandidateOutcomeStats>>;
    policies: Record<string, StoredPolicyRecord>;
    decisions: StoredDecisionRecord[];
    feedback: StoredFeedbackRecord[];
}

const STATE_VERSION = 2 as const;
const ENGINE_VERSION = 'gics-inference-engine-v1';

function weightedAverage(previous: number, next: number, count: number): number {
    if (count <= 1) return next;
    return ((previous * (count - 1)) + next) / count;
}

function clone<T>(value: T): T {
    return structuredClone(value);
}

function defaultRuntime(): InferenceRuntimeState {
    return {
        engineVersion: ENGINE_VERSION,
        stateVersion: STATE_VERSION,
        loadedAt: 0,
        lastSavedAt: 0,
        lastDecisionAt: 0,
        lastOutcomeAt: 0,
        lastPolicyAt: 0,
        saveCount: 0,
    };
}

function buildPolicyStorageKey(domain: string, scope: string, subject?: string): string {
    return `${domain}::${scope}::${subject ?? ''}`;
}

function buildPolicySystemKey(domain: string, scope: string, subject?: string): string {
    return subject
        ? `_infer|policy|${domain}|${scope}|${subject}`
        : `_infer|policy|${domain}|${scope}`;
}

function buildDecisionSystemKey(decisionId: string): string {
    return `_infer|decision|${decisionId}`;
}

function buildFeedbackSystemKey(feedbackId: string): string {
    return `_infer|feedback|${feedbackId}`;
}

function inferLegacyScope(evidenceKeys: string[] | undefined, fallback: string): string {
    const profileKey = evidenceKeys?.find((key) => key.startsWith('_infer|profile|'));
    return profileKey ? profileKey.slice('_infer|profile|'.length) : fallback;
}

function migrateState(parsed: LegacyInferenceStateFile | InferenceStateFile, defaultScope: string): InferenceStateFile {
    if (parsed.version === STATE_VERSION) {
        return {
            version: STATE_VERSION,
            runtime: {
                ...defaultRuntime(),
                ...(parsed.runtime ?? {}),
                stateVersion: STATE_VERSION,
            },
            profiles: parsed.profiles ?? {},
            domainStats: parsed.domainStats ?? {},
            policies: parsed.policies ?? {},
            decisions: Array.isArray(parsed.decisions) ? parsed.decisions.slice(-500) : [],
            feedback: Array.isArray(parsed.feedback) ? parsed.feedback.slice(-1000) : [],
        };
    }

    const legacyDecisions = Array.isArray(parsed.decisions) ? parsed.decisions : [];
    return {
        version: STATE_VERSION,
        runtime: defaultRuntime(),
        profiles: parsed.profiles ?? {},
        domainStats: parsed.domainStats ?? {},
        policies: {},
        decisions: legacyDecisions.slice(-500).map((decision) => {
            const scope = inferLegacyScope(decision.evidenceKeys, defaultScope);
            return {
                decisionId: decision.decisionId,
                systemKey: buildDecisionSystemKey(decision.decisionId),
                domain: decision.domain,
                scope,
                subject: decision.subject,
                recommendedId: decision.recommendedId,
                createdAt: decision.createdAt,
                policyKey: buildPolicyStorageKey(decision.domain, scope, decision.subject),
                policyVersion: decision.policyVersion,
                profileVersion: decision.profileVersion,
                ranking: decision.ranking.map((item) => ({
                    ...item,
                    candidate: {},
                })),
                evidenceKeys: decision.evidenceKeys ?? [],
            };
        }),
        feedback: [],
    };
}

export class InferenceStateStore {
    private readonly filePath: string;
    private readonly defaultScope: string;
    private runtime = defaultRuntime();
    private profiles = new Map<string, ScopeProfile>();
    private domainStats = new Map<string, Map<string, CandidateOutcomeStats>>();
    private policies = new Map<string, StoredPolicyRecord>();
    private decisions: StoredDecisionRecord[] = [];
    private feedback: StoredFeedbackRecord[] = [];

    constructor(filePath: string, defaultScope: string) {
        this.filePath = filePath;
        this.defaultScope = defaultScope;
    }

    async load(): Promise<void> {
        if (!existsSync(this.filePath)) {
            this.runtime = {
                ...defaultRuntime(),
                loadedAt: Date.now(),
            };
            return;
        }

        const raw = await fs.readFile(this.filePath, 'utf8');
        const parsed = JSON.parse(raw) as LegacyInferenceStateFile | InferenceStateFile;
        const migrated = migrateState(parsed, this.defaultScope);

        this.runtime = {
            ...defaultRuntime(),
            ...migrated.runtime,
            loadedAt: Date.now(),
            stateVersion: STATE_VERSION,
        };
        this.profiles = new Map(Object.entries(migrated.profiles ?? {}));
        this.domainStats = new Map(
            Object.entries(migrated.domainStats ?? {}).map(([domain, stats]) => [domain, new Map(Object.entries(stats))])
        );
        this.policies = new Map(Object.entries(migrated.policies ?? {}));
        this.decisions = Array.isArray(migrated.decisions) ? migrated.decisions.slice(-500) : [];
        this.feedback = Array.isArray(migrated.feedback) ? migrated.feedback.slice(-1000) : [];
    }

    async save(): Promise<void> {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        const tmp = `${this.filePath}.tmp`;
        this.runtime.lastSavedAt = Date.now();
        this.runtime.saveCount += 1;
        const payload: InferenceStateFile = {
            version: STATE_VERSION,
            runtime: { ...this.runtime, stateVersion: STATE_VERSION, engineVersion: ENGINE_VERSION },
            profiles: Object.fromEntries(this.profiles.entries()),
            domainStats: Object.fromEntries(
                Array.from(this.domainStats.entries()).map(([domain, stats]) => [domain, Object.fromEntries(stats.entries())])
            ),
            policies: Object.fromEntries(this.policies.entries()),
            decisions: this.decisions.slice(-500),
            feedback: this.feedback.slice(-1000),
        };
        await fs.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
        await fs.rename(tmp, this.filePath);
    }

    getRuntime(): InferenceRuntimeState {
        return clone(this.runtime);
    }

    setRuntimeMetadata(patch: Partial<InferenceRuntimeState>): void {
        this.runtime = {
            ...this.runtime,
            ...patch,
            engineVersion: ENGINE_VERSION,
            stateVersion: STATE_VERSION,
        };
    }

    getProfile(scope: string, hostFingerprint: string): ScopeProfile {
        const existing = this.profiles.get(scope);
        if (existing) return clone(existing);

        const profile: ScopeProfile = {
            scope,
            version: 1,
            hostFingerprint,
            stats: {
                writes: 0,
                reads: 0,
                scans: 0,
                flushes: 0,
                compactions: 0,
                rotations: 0,
                avgCompressionRatio: 0,
                avgPayloadBytes: 0,
                avgReadLatencyMs: 0,
                lastActivityAt: Date.now(),
            },
            preferences: {},
            policyHints: {},
            updatedAt: Date.now(),
        };
        this.profiles.set(scope, profile);
        return clone(profile);
    }

    updateProfile(scope: string, hostFingerprint: string, updater: (profile: ScopeProfile) => void): ScopeProfile {
        const profile = this.getProfile(scope, hostFingerprint);
        updater(profile);
        profile.version += 1;
        profile.updatedAt = Date.now();
        this.profiles.set(scope, profile);
        return clone(profile);
    }

    recordWrite(scope: string, hostFingerprint: string, payloadBytes: number): ScopeProfile {
        return this.updateProfile(scope, hostFingerprint, (profile) => {
            profile.stats.writes += 1;
            profile.stats.avgPayloadBytes = weightedAverage(profile.stats.avgPayloadBytes, payloadBytes, profile.stats.writes);
            profile.stats.lastActivityAt = Date.now();
        });
    }

    recordRead(scope: string, hostFingerprint: string, latencyMs: number = 0): ScopeProfile {
        return this.updateProfile(scope, hostFingerprint, (profile) => {
            profile.stats.reads += 1;
            profile.stats.avgReadLatencyMs = weightedAverage(profile.stats.avgReadLatencyMs, latencyMs, profile.stats.reads);
            profile.stats.lastActivityAt = Date.now();
        });
    }

    recordScan(scope: string, hostFingerprint: string): ScopeProfile {
        return this.updateProfile(scope, hostFingerprint, (profile) => {
            profile.stats.scans += 1;
            profile.stats.lastActivityAt = Date.now();
        });
    }

    recordFlush(scope: string, hostFingerprint: string, compressionRatio?: number): ScopeProfile {
        return this.updateProfile(scope, hostFingerprint, (profile) => {
            profile.stats.flushes += 1;
            if (typeof compressionRatio === 'number' && Number.isFinite(compressionRatio)) {
                profile.stats.avgCompressionRatio = weightedAverage(
                    profile.stats.avgCompressionRatio,
                    compressionRatio,
                    profile.stats.flushes
                );
            }
            profile.stats.lastActivityAt = Date.now();
        });
    }

    recordCompaction(scope: string, hostFingerprint: string): ScopeProfile {
        return this.updateProfile(scope, hostFingerprint, (profile) => {
            profile.stats.compactions += 1;
            profile.stats.lastActivityAt = Date.now();
        });
    }

    recordRotation(scope: string, hostFingerprint: string): ScopeProfile {
        return this.updateProfile(scope, hostFingerprint, (profile) => {
            profile.stats.rotations += 1;
            profile.stats.lastActivityAt = Date.now();
        });
    }

    updatePolicyHints(scope: string, hostFingerprint: string, hints: ScopeProfile['policyHints']): ScopeProfile {
        return this.updateProfile(scope, hostFingerprint, (profile) => {
            profile.policyHints = {
                ...profile.policyHints,
                ...hints,
            };
            profile.stats.lastActivityAt = Date.now();
        });
    }

    recordOutcome(
        domain: string,
        candidateId: string,
        metrics: { success?: boolean; latencyMs?: number; costScore?: number; feedbackScore?: number; result?: string; }
    ): CandidateOutcomeStats {
        const domainStats = this.domainStats.get(domain) ?? new Map<string, CandidateOutcomeStats>();
        const existing = domainStats.get(candidateId) ?? {
            successes: 0,
            failures: 0,
            totalOutcomes: 0,
            avgLatencyMs: 0,
            avgCostScore: 0,
            avgFeedbackScore: 0,
            lastOutcomeAt: 0,
            lastResult: undefined,
        };

        const nextCount = existing.totalOutcomes + 1;
        const success = Boolean(metrics.success);
        existing.totalOutcomes = nextCount;
        if (success) existing.successes += 1;
        else existing.failures += 1;

        if (typeof metrics.latencyMs === 'number' && Number.isFinite(metrics.latencyMs)) {
            existing.avgLatencyMs = weightedAverage(existing.avgLatencyMs, metrics.latencyMs, nextCount);
        }
        if (typeof metrics.costScore === 'number' && Number.isFinite(metrics.costScore)) {
            existing.avgCostScore = weightedAverage(existing.avgCostScore, metrics.costScore, nextCount);
        }
        if (typeof metrics.feedbackScore === 'number' && Number.isFinite(metrics.feedbackScore)) {
            existing.avgFeedbackScore = weightedAverage(existing.avgFeedbackScore, metrics.feedbackScore, nextCount);
        }
        existing.lastOutcomeAt = Date.now();
        existing.lastResult = metrics.result;

        domainStats.set(candidateId, existing);
        this.domainStats.set(domain, domainStats);
        this.runtime.lastOutcomeAt = existing.lastOutcomeAt;
        return clone(existing);
    }

    getOutcomeStats(domain: string, candidateId: string): CandidateOutcomeStats | null {
        const stats = this.domainStats.get(domain)?.get(candidateId);
        return stats ? clone(stats) : null;
    }

    upsertPolicy(record: StoredPolicyRecord): StoredPolicyRecord {
        this.policies.set(record.key, clone(record));
        this.runtime.lastPolicyAt = record.generatedAt;
        return clone(record);
    }

    getPolicy(domain: string, scope: string, subject?: string): StoredPolicyRecord | null {
        return this.getPolicyByKey(buildPolicyStorageKey(domain, scope, subject));
    }

    getPolicyByKey(key: string): StoredPolicyRecord | null {
        const found = this.policies.get(key);
        return found ? clone(found) : null;
    }

    getPolicies(domain?: string, scope?: string, subject?: string, limit: number = 20): StoredPolicyRecord[] {
        return Array.from(this.policies.values())
            .filter((policy) => (!domain || policy.domain === domain) && (!scope || policy.scope === scope) && (!subject || policy.subject === subject))
            .sort((a, b) => b.generatedAt - a.generatedAt)
            .slice(0, limit)
            .map((policy) => clone(policy));
    }

    appendDecision(record: StoredDecisionRecord): StoredDecisionRecord {
        this.decisions.push(clone(record));
        this.decisions = this.decisions.slice(-500);
        this.runtime.lastDecisionAt = record.createdAt;
        return clone(record);
    }

    getDecision(decisionId: string): StoredDecisionRecord | null {
        const found = this.decisions.find((decision) => decision.decisionId === decisionId);
        return found ? clone(found) : null;
    }

    getDecisions(domain?: string, subject?: string, limit: number = 20): StoredDecisionRecord[] {
        return this.decisions
            .filter((decision) => (!domain || decision.domain === domain) && (!subject || decision.subject === subject))
            .sort((a, b) => b.createdAt - a.createdAt)
            .slice(0, limit)
            .map((decision) => clone(decision));
    }

    appendFeedback(record: StoredFeedbackRecord): StoredFeedbackRecord {
        this.feedback.push(clone(record));
        this.feedback = this.feedback.slice(-1000);
        this.runtime.lastOutcomeAt = record.recordedAt;
        return clone(record);
    }

    getFeedback(feedbackId: string): StoredFeedbackRecord | null {
        const found = this.feedback.find((entry) => entry.feedbackId === feedbackId);
        return found ? clone(found) : null;
    }

    getFeedbackRecords(domain?: string, subject?: string, limit: number = 50): StoredFeedbackRecord[] {
        return this.feedback
            .filter((entry) => (!domain || entry.domain === domain) && (!subject || entry.subject === subject))
            .sort((a, b) => b.recordedAt - a.recordedAt)
            .slice(0, limit)
            .map((entry) => clone(entry));
    }

    getSummary(): Record<string, number | string> {
        return {
            engineVersion: this.runtime.engineVersion,
            stateVersion: this.runtime.stateVersion,
            profiles: this.profiles.size,
            policies: this.policies.size,
            decisions: this.decisions.length,
            feedback: this.feedback.length,
            domains: this.domainStats.size,
            saveCount: this.runtime.saveCount,
            lastDecisionAt: this.runtime.lastDecisionAt,
            lastOutcomeAt: this.runtime.lastOutcomeAt,
            lastPolicyAt: this.runtime.lastPolicyAt,
        };
    }
}

export const InferenceKeys = {
    buildPolicyStorageKey,
    buildPolicySystemKey,
    buildDecisionSystemKey,
    buildFeedbackSystemKey,
};
