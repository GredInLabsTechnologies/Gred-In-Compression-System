import * as fs from 'fs/promises';
import * as path from 'path';
import { existsSync } from 'fs';

export interface CandidateOutcomeStats {
    successes: number;
    failures: number;
    avgLatencyMs: number;
    avgCostScore: number;
    lastOutcomeAt: number;
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
    };
    updatedAt: number;
}

export interface StoredDecisionRecord {
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
}

interface InferenceStateFile {
    version: 1;
    profiles: Record<string, ScopeProfile>;
    domainStats: Record<string, Record<string, CandidateOutcomeStats>>;
    decisions: StoredDecisionRecord[];
}

const STATE_VERSION = 1 as const;

function weightedAverage(previous: number, next: number, count: number): number {
    if (count <= 1) return next;
    return ((previous * (count - 1)) + next) / count;
}

export class InferenceStateStore {
    private readonly filePath: string;
    private profiles = new Map<string, ScopeProfile>();
    private domainStats = new Map<string, Map<string, CandidateOutcomeStats>>();
    private decisions: StoredDecisionRecord[] = [];

    constructor(filePath: string) {
        this.filePath = filePath;
    }

    async load(): Promise<void> {
        if (!existsSync(this.filePath)) return;
        const raw = await fs.readFile(this.filePath, 'utf8');
        const parsed = JSON.parse(raw) as InferenceStateFile;
        if (parsed.version !== STATE_VERSION) {
            throw new Error('InferenceStateStore version mismatch');
        }

        this.profiles = new Map(Object.entries(parsed.profiles ?? {}));
        this.domainStats = new Map(
            Object.entries(parsed.domainStats ?? {}).map(([domain, stats]) => [domain, new Map(Object.entries(stats))])
        );
        this.decisions = Array.isArray(parsed.decisions) ? parsed.decisions.slice(-200) : [];
    }

    async save(): Promise<void> {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        const tmp = `${this.filePath}.tmp`;
        const payload: InferenceStateFile = {
            version: STATE_VERSION,
            profiles: Object.fromEntries(this.profiles.entries()),
            domainStats: Object.fromEntries(
                Array.from(this.domainStats.entries()).map(([domain, stats]) => [domain, Object.fromEntries(stats.entries())])
            ),
            decisions: this.decisions.slice(-200),
        };
        await fs.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
        await fs.rename(tmp, this.filePath);
    }

    getProfile(scope: string, hostFingerprint: string): ScopeProfile {
        const existing = this.profiles.get(scope);
        if (existing) return structuredClone(existing);

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
            updatedAt: Date.now(),
        };
        this.profiles.set(scope, profile);
        return structuredClone(profile);
    }

    updateProfile(scope: string, hostFingerprint: string, updater: (profile: ScopeProfile) => void): ScopeProfile {
        const profile = this.getProfile(scope, hostFingerprint);
        updater(profile);
        profile.version += 1;
        profile.updatedAt = Date.now();
        this.profiles.set(scope, profile);
        return structuredClone(profile);
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

    recordOutcome(domain: string, candidateId: string, metrics: { success?: boolean; latencyMs?: number; costScore?: number; }): CandidateOutcomeStats {
        const domainStats = this.domainStats.get(domain) ?? new Map<string, CandidateOutcomeStats>();
        const existing = domainStats.get(candidateId) ?? {
            successes: 0,
            failures: 0,
            avgLatencyMs: 0,
            avgCostScore: 0,
            lastOutcomeAt: 0,
        };

        const totalBefore = existing.successes + existing.failures;
        const success = Boolean(metrics.success);
        if (success) existing.successes += 1;
        else existing.failures += 1;

        if (typeof metrics.latencyMs === 'number' && Number.isFinite(metrics.latencyMs)) {
            existing.avgLatencyMs = weightedAverage(existing.avgLatencyMs, metrics.latencyMs, totalBefore + 1);
        }
        if (typeof metrics.costScore === 'number' && Number.isFinite(metrics.costScore)) {
            existing.avgCostScore = weightedAverage(existing.avgCostScore, metrics.costScore, totalBefore + 1);
        }
        existing.lastOutcomeAt = Date.now();

        domainStats.set(candidateId, existing);
        this.domainStats.set(domain, domainStats);
        return { ...existing };
    }

    getOutcomeStats(domain: string, candidateId: string): CandidateOutcomeStats | null {
        const stats = this.domainStats.get(domain)?.get(candidateId);
        return stats ? { ...stats } : null;
    }

    appendDecision(record: StoredDecisionRecord): void {
        this.decisions.push(record);
        this.decisions = this.decisions.slice(-200);
    }

    getDecision(decisionId: string): StoredDecisionRecord | null {
        const found = this.decisions.find((decision) => decision.decisionId === decisionId);
        return found ? structuredClone(found) : null;
    }

    getDecisions(domain?: string, subject?: string, limit: number = 20): StoredDecisionRecord[] {
        return this.decisions
            .filter((decision) => (!domain || decision.domain === domain) && (!subject || decision.subject === subject))
            .sort((a, b) => b.createdAt - a.createdAt)
            .slice(0, limit)
            .map((decision) => structuredClone(decision));
    }
}
