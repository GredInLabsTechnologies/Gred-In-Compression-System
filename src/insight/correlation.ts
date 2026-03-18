/**
 * Insight Engine — Phase 3.2: Correlation Analyzer
 *
 * Cross-item incremental intelligence:
 * - Co-movement correlations
 * - Cluster detection (union-find over strong edges)
 * - Leading indicators (lagged correlation)
 * - Seasonal pattern hints (autocorrelation-based)
 */

import type { ItemBehavior } from './tracker.js';

export interface Correlation {
    itemA: string;
    itemB: string;
    coefficient: number;
    direction: 'positive' | 'negative';
    lag: number;
    confidence: number;
    since: number;
}

export interface Cluster {
    id: string;
    members: string[];
    cohesion: number;
    dominantLifecycle: string;
}

export interface LeadingIndicator {
    leader: string;
    follower: string;
    lagPeriods: number;
    predictiveStrength: number;
    sampleSize: number;
}

export interface SeasonalPattern {
    item: string;
    period: 'daily' | 'weekly' | 'monthly' | 'custom';
    periodLength: number;
    peakOffset: number;
    amplitude: number;
    confidence: number;
}

export interface CorrelationAnalyzerConfig {
    threshold?: number;
    minSamples?: number;
    maxLag?: number;
    candidateWindowMs?: number;
    maxSeriesLength?: number;
    maxCorrelationsPerItem?: number;
    seasonalMinSamples?: number;
}

interface Sample {
    ts: number;
    signal: number;
}

interface PairStats {
    itemA: string;
    itemB: string;
    coefficient: number;
    lag: number;
    sampleSize: number;
    confidence: number;
    since: number;
    updatedAt: number;
}

const MS_PER_HOUR = 60 * 60 * 1000;

export class CorrelationAnalyzer {
    private readonly itemSeries = new Map<string, Sample[]>();
    private readonly lastUpdateByItem = new Map<string, number>();
    private readonly pairStats = new Map<string, PairStats>();
    private readonly pairKeysByItem = new Map<string, Set<string>>();
    private readonly lifecycleHints = new Map<string, string>();

    private readonly threshold: number;
    private readonly minSamples: number;
    private readonly maxLag: number;
    private readonly candidateWindowMs: number;
    private readonly maxSeriesLength: number;
    private readonly maxCorrelationsPerItem: number;
    private readonly seasonalMinSamples: number;

    constructor(config: CorrelationAnalyzerConfig = {}) {
        this.threshold = config.threshold ?? 0.7;
        this.minSamples = config.minSamples ?? 6;
        this.maxLag = Math.max(0, config.maxLag ?? 3);
        this.candidateWindowMs = config.candidateWindowMs ?? (6 * MS_PER_HOUR);
        this.maxSeriesLength = Math.max(16, config.maxSeriesLength ?? 128);
        this.maxCorrelationsPerItem = Math.max(1, config.maxCorrelationsPerItem ?? 50);
        this.seasonalMinSamples = Math.max(8, config.seasonalMinSamples ?? 24);
    }

    onItemUpdate(key: string, fields: Record<string, number | string>, timestamp: number = Date.now()): void {
        this.appendSeriesSample(key, {
            ts: timestamp,
            signal: this.extractSignal(fields)
        });
        this.lastUpdateByItem.set(key, timestamp);

        const candidates = Array.from(this.lastUpdateByItem.entries())
            .filter(([otherKey, ts]) => otherKey !== key && Math.abs(timestamp - ts) <= this.candidateWindowMs)
            .map(([otherKey]) => otherKey)
            .slice(0, this.maxCorrelationsPerItem * 4);

        for (const otherKey of candidates) {
            this.recomputePair(key, otherKey, timestamp);
        }

        this.enforceCap(key);
    }

    setLifecycleHint(key: string, lifecycle: string): void {
        this.lifecycleHints.set(key, lifecycle);
    }

    getCorrelations(key?: string): Correlation[] {
        const all = Array.from(this.pairStats.values())
            .filter((pair) => !key || pair.itemA === key || pair.itemB === key)
            .sort((a, b) => Math.abs(b.coefficient) - Math.abs(a.coefficient));

        return all.map((pair) => ({
            itemA: pair.itemA,
            itemB: pair.itemB,
            coefficient: pair.coefficient,
            direction: pair.coefficient >= 0 ? 'positive' : 'negative',
            lag: pair.lag,
            confidence: pair.confidence,
            since: pair.since
        }));
    }

    getClusters(): Cluster[] {
        const edges = this.getCorrelations();
        if (edges.length === 0) return [];

        const nodes = new Set<string>();
        for (const edge of edges) {
            nodes.add(edge.itemA);
            nodes.add(edge.itemB);
        }

        const parent = new Map<string, string>();
        for (const node of nodes) parent.set(node, node);

        const find = (x: string): string => {
            const p = parent.get(x);
            if (!p || p === x) return x;
            const root = find(p);
            parent.set(x, root);
            return root;
        };

        const union = (a: string, b: string): void => {
            const ra = find(a);
            const rb = find(b);
            if (ra !== rb) parent.set(rb, ra);
        };

        for (const edge of edges) {
            if (Math.abs(edge.coefficient) >= this.threshold) {
                union(edge.itemA, edge.itemB);
            }
        }

        const groups = new Map<string, string[]>();
        for (const node of nodes) {
            const root = find(node);
            if (!groups.has(root)) groups.set(root, []);
            groups.get(root)!.push(node);
        }

        const clusters: Cluster[] = [];
        for (const membersRaw of groups.values()) {
            if (membersRaw.length < 2) continue;
            const members = [...membersRaw].sort((a, b) => a.localeCompare(b));

            const intra = edges.filter((edge) => members.includes(edge.itemA) && members.includes(edge.itemB));
            const cohesion = intra.length > 0
                ? intra.reduce((acc, edge) => acc + Math.abs(edge.coefficient), 0) / intra.length
                : 0;

            const lifecycleCount = new Map<string, number>();
            for (const member of members) {
                const lifecycle = this.lifecycleHints.get(member) ?? 'stable';
                lifecycleCount.set(lifecycle, (lifecycleCount.get(lifecycle) ?? 0) + 1);
            }
            const dominantLifecycle = Array.from(lifecycleCount.entries())
                .sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'stable';

            clusters.push({
                id: `cluster_${members.join('|')}`,
                members,
                cohesion,
                dominantLifecycle
            });
        }

        return [...clusters].sort((a, b) => b.cohesion - a.cohesion);
    }

    getLeadingIndicators(key?: string): LeadingIndicator[] {
        const indicators: LeadingIndicator[] = [];

        for (const pair of this.pairStats.values()) {
            if (pair.lag === 0) continue;
            if (Math.abs(pair.coefficient) < this.threshold) continue;

            const leader = pair.lag > 0 ? pair.itemA : pair.itemB;
            const follower = pair.lag > 0 ? pair.itemB : pair.itemA;
            if (key && leader !== key && follower !== key) continue;

            indicators.push({
                leader,
                follower,
                lagPeriods: Math.abs(pair.lag),
                predictiveStrength: Math.min(1, Math.abs(pair.coefficient) * pair.confidence),
                sampleSize: pair.sampleSize
            });
        }

        return [...indicators].sort((a, b) => b.predictiveStrength - a.predictiveStrength);
    }

    getSeasonalPatterns(key?: string): SeasonalPattern[] {
        const keys = key ? [key] : Array.from(this.itemSeries.keys());
        const output: SeasonalPattern[] = [];

        for (const item of keys) {
            const samples = this.itemSeries.get(item) ?? [];
            if (samples.length < this.seasonalMinSamples) continue;

            const values = samples.map((s) => s.signal);
            const avgHoursPerStep = this.estimateAverageHoursPerStep(samples);
            const candidates = this.buildSeasonalLagCandidates(avgHoursPerStep, values.length);
            if (candidates.length === 0) continue;

            let best: { lag: number; confidence: number; periodLength: number; } | null = null;
            for (const lag of candidates) {
                const coefficient = Math.abs(this.pearsonAtLag(values, values, lag));
                if (!Number.isFinite(coefficient)) continue;
                if (!best || coefficient > best.confidence) {
                    best = {
                        lag,
                        confidence: coefficient,
                        periodLength: lag * avgHoursPerStep
                    };
                }
            }

            if (!best || best.confidence < 0.5) continue;

            const phaseMeans = this.phaseMeans(values, best.lag);
            const maxMean = Math.max(...phaseMeans);
            const minMean = Math.min(...phaseMeans);
            const peakOffsetStep = phaseMeans.indexOf(maxMean);

            output.push({
                item,
                period: this.classifyPeriod(best.periodLength),
                periodLength: best.periodLength,
                peakOffset: peakOffsetStep * avgHoursPerStep,
                amplitude: maxMean - minMean,
                confidence: best.confidence
            });
        }

        return [...output].sort((a, b) => b.confidence - a.confidence);
    }

    /**
     * Phase 4.4 Cold-Start: Find tracked keys similar to the given key
     * by partial prefix matching (split on '|' separator).
     */
    findSimilarKeys(key: string, maxResults: number = 5): string[] {
        const segments = key.split('|');
        if (segments.length === 0) return [];

        const scored: Array<{ key: string; score: number }> = [];

        for (const trackedKey of this.itemSeries.keys()) {
            if (trackedKey === key) continue;
            const trackedSegments = trackedKey.split('|');
            let overlap = 0;

            const minLen = Math.min(segments.length, trackedSegments.length);
            for (let i = 0; i < minLen; i++) {
                if (segments[i] === trackedSegments[i]) {
                    overlap += 2; // Exact match at same position
                } else if (trackedSegments.includes(segments[i])) {
                    overlap += 1; // Match at different position
                }
            }

            if (overlap > 0) {
                scored.push({ key: trackedKey, score: overlap });
            }
        }

        return [...scored]
            .sort((a, b) => b.score - a.score)
            .slice(0, maxResults)
            .map((s) => s.key);
    }

    /**
     * Find the cluster that contains the given key, if any.
     */
    getClusterForKey(key: string): Cluster | null {
        const clusters = this.getClusters();
        return clusters.find((c) => c.members.includes(key)) ?? null;
    }

    /**
     * Compute mean behavioral metrics across cluster members.
     * Used by cold-start to derive priors for new items.
     */
    getClusterMeanBehavior(
        cluster: Cluster,
        tracker: { getInsight(key: string): Pick<ItemBehavior, 'velocity' | 'entropy' | 'volatility' | 'writeCount'> | null }
    ): Partial<ItemBehavior> {
        let sumVelocity = 0;
        let sumEntropy = 0;
        let sumVolatility = 0;
        let sumWriteCount = 0;
        let count = 0;

        for (const member of cluster.members) {
            const behavior = tracker.getInsight(member);
            if (!behavior) continue;
            sumVelocity += behavior.velocity;
            sumEntropy += behavior.entropy;
            sumVolatility += behavior.volatility;
            sumWriteCount += behavior.writeCount;
            count++;
        }

        if (count === 0) {
            return { velocity: 0, entropy: 0, volatility: 0, writeCount: 0 };
        }

        return {
            velocity: sumVelocity / count,
            entropy: sumEntropy / count,
            volatility: sumVolatility / count,
            writeCount: sumWriteCount / count,
        };
    }

    private recomputePair(itemA: string, itemB: string, timestamp: number): void {
        const seriesA = this.itemSeries.get(itemA) ?? [];
        const seriesB = this.itemSeries.get(itemB) ?? [];

        let best: { coefficient: number; lag: number; sampleSize: number; } | null = null;

        for (let lag = -this.maxLag; lag <= this.maxLag; lag++) {
            const aligned = this.alignSeriesByLag(seriesA, seriesB, lag);
            if (aligned.x.length < this.minSamples) continue;

            const coefficient = this.pearson(aligned.x, aligned.y);
            if (!Number.isFinite(coefficient)) continue;

            if (!best || Math.abs(coefficient) > Math.abs(best.coefficient)) {
                best = {
                    coefficient,
                    lag,
                    sampleSize: aligned.x.length
                };
            }
        }

        const pairKey = this.pairKey(itemA, itemB);
        if (!best || Math.abs(best.coefficient) < this.threshold) {
            this.dropPair(pairKey);
            return;
        }

        const prevSince = this.pairStats.get(pairKey)?.since ?? timestamp;
        const normalized = this.normalizePair(itemA, itemB, best.coefficient, best.lag);

        const confidence = Math.min(1, Math.sqrt(best.sampleSize) / 10);
        const next: PairStats = {
            itemA: normalized.itemA,
            itemB: normalized.itemB,
            coefficient: normalized.coefficient,
            lag: normalized.lag,
            sampleSize: best.sampleSize,
            confidence,
            since: prevSince,
            updatedAt: timestamp
        };

        this.pairStats.set(pairKey, next);
        this.linkPairToItem(next.itemA, pairKey);
        this.linkPairToItem(next.itemB, pairKey);
    }

    private appendSeriesSample(key: string, sample: Sample): void {
        const arr = this.itemSeries.get(key) ?? [];
        arr.push(sample);
        if (arr.length > this.maxSeriesLength) {
            arr.splice(0, arr.length - this.maxSeriesLength);
        }
        this.itemSeries.set(key, arr);
    }

    private extractSignal(fields: Record<string, number | string>): number {
        const numericValues = Object.values(fields).filter((v): v is number => typeof v === 'number');
        if (numericValues.length > 0) {
            return numericValues.reduce((acc, v) => acc + v, 0) / numericValues.length;
        }

        const text = Object.values(fields).map((v) => String(v)).join('|');
        let hash = 0;
        for (let i = 0; i < text.length; i++) {
            hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
        }
        return hash / 0xffffffff;
    }

    private alignSeriesByLag(seriesA: Sample[], seriesB: Sample[], lag: number): { x: number[]; y: number[]; } {
        const a = seriesA.map((s) => s.signal);
        const b = seriesB.map((s) => s.signal);

        if (lag === 0) {
            const n = Math.min(a.length, b.length);
            return {
                x: a.slice(a.length - n),
                y: b.slice(b.length - n)
            };
        }

        if (lag > 0) {
            const n = Math.min(a.length, b.length - lag);
            if (n <= 0) return { x: [], y: [] };
            return {
                x: a.slice(a.length - n),
                y: b.slice(b.length - n - lag, b.length - lag)
            };
        }

        const n = Math.min(a.length + lag, b.length);
        if (n <= 0) return { x: [], y: [] };
        return {
            x: a.slice(a.length - n + lag, a.length + lag),
            y: b.slice(b.length - n)
        };
    }

    private pearson(x: number[], y: number[]): number {
        if (x.length !== y.length || x.length < 2) return 0;
        const n = x.length;
        let sumX = 0;
        let sumY = 0;
        let sumXY = 0;
        let sumXX = 0;
        let sumYY = 0;

        for (let i = 0; i < n; i++) {
            const xi = x[i]!;
            const yi = y[i]!;
            sumX += xi;
            sumY += yi;
            sumXY += xi * yi;
            sumXX += xi * xi;
            sumYY += yi * yi;
        }

        const numerator = (n * sumXY) - (sumX * sumY);
        const denomLeft = (n * sumXX) - (sumX * sumX);
        const denomRight = (n * sumYY) - (sumY * sumY);
        const denominator = Math.sqrt(Math.max(0, denomLeft * denomRight));
        if (denominator === 0) return 0;
        return numerator / denominator;
    }

    private pearsonAtLag(x: number[], y: number[], lag: number): number {
        if (lag <= 0 || lag >= Math.min(x.length, y.length)) return 0;
        const left = x.slice(0, x.length - lag);
        const right = y.slice(lag);
        const n = Math.min(left.length, right.length);
        return this.pearson(left.slice(0, n), right.slice(0, n));
    }

    private normalizePair(itemA: string, itemB: string, coefficient: number, lag: number): {
        itemA: string;
        itemB: string;
        coefficient: number;
        lag: number;
    } {
        if (itemA <= itemB) {
            return { itemA, itemB, coefficient, lag };
        }
        return {
            itemA: itemB,
            itemB: itemA,
            coefficient,
            lag: -lag
        };
    }

    private pairKey(itemA: string, itemB: string): string {
        return itemA <= itemB ? `${itemA}|${itemB}` : `${itemB}|${itemA}`;
    }

    private linkPairToItem(item: string, pairKey: string): void {
        if (!this.pairKeysByItem.has(item)) this.pairKeysByItem.set(item, new Set<string>());
        this.pairKeysByItem.get(item)!.add(pairKey);
    }

    private dropPair(pairKey: string): void {
        const pair = this.pairStats.get(pairKey);
        if (!pair) return;

        this.pairStats.delete(pairKey);
        this.pairKeysByItem.get(pair.itemA)?.delete(pairKey);
        this.pairKeysByItem.get(pair.itemB)?.delete(pairKey);
    }

    private enforceCap(item: string): void {
        const pairKeys = Array.from(this.pairKeysByItem.get(item) ?? []);
        if (pairKeys.length <= this.maxCorrelationsPerItem) return;

        const ordered = pairKeys
            .map((key) => this.pairStats.get(key))
            .filter((pair): pair is PairStats => Boolean(pair))
            .sort((a, b) => Math.abs(a.coefficient) - Math.abs(b.coefficient));

        const overflow = ordered.length - this.maxCorrelationsPerItem;
        for (let i = 0; i < overflow; i++) {
            const pair = ordered[i]!;
            this.dropPair(this.pairKey(pair.itemA, pair.itemB));
        }
    }

    private estimateAverageHoursPerStep(samples: Sample[]): number {
        if (samples.length < 2) return 1;
        let sum = 0;
        let count = 0;
        for (let i = 1; i < samples.length; i++) {
            const dt = Math.max(1, samples[i]!.ts - samples[i - 1]!.ts);
            sum += dt / MS_PER_HOUR;
            count += 1;
        }
        return count > 0 ? sum / count : 1;
    }

    private buildSeasonalLagCandidates(hoursPerStep: number, sampleCount: number): number[] {
        const targetHours = [24, 24 * 7, 24 * 30];
        const lags = targetHours
            .map((hours) => Math.max(2, Math.round(hours / Math.max(0.1, hoursPerStep))))
            .filter((lag) => lag < Math.floor(sampleCount / 2));

        return Array.from(new Set(lags)).sort((a, b) => a - b);
    }

    private phaseMeans(values: number[], periodLag: number): number[] {
        const sums = new Array(periodLag).fill(0);
        const counts = new Array(periodLag).fill(0);

        for (let i = 0; i < values.length; i++) {
            const phase = i % periodLag;
            sums[phase] += values[i]!;
            counts[phase] += 1;
        }

        return sums.map((sum, i) => counts[i] > 0 ? sum / counts[i] : 0);
    }

    private classifyPeriod(periodLengthHours: number): 'daily' | 'weekly' | 'monthly' | 'custom' {
        const near = (value: number, target: number, tolerance: number): boolean =>
            Math.abs(value - target) <= tolerance;

        if (near(periodLengthHours, 24, 6)) return 'daily';
        if (near(periodLengthHours, 168, 24)) return 'weekly';
        if (near(periodLengthHours, 720, 120)) return 'monthly';
        return 'custom';
    }
}
