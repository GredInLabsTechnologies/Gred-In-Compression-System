export type TelemetryLabelValue = string | number | boolean;
export type TelemetryLabels = Record<string, TelemetryLabelValue>;
export type TelemetryUnit = 'count' | 'seconds' | 'bytes' | 'ratio' | 'score' | 'unknown';

export interface TelemetryCounterSample {
    labels: Record<string, string>;
    value: number;
}

export interface TelemetryGaugeSample {
    labels: Record<string, string>;
    value: number;
}

export interface TelemetryHistogramBucket {
    le: number;
    count: number;
}

export interface TelemetryHistogramSample {
    labels: Record<string, string>;
    count: number;
    sum: number;
    min: number | null;
    max: number | null;
    buckets: TelemetryHistogramBucket[];
}

export interface TelemetryMetricSnapshot {
    name: string;
    type: 'counter' | 'gauge' | 'histogram';
    unit: TelemetryUnit;
    description?: string;
    samples: TelemetryCounterSample[] | TelemetryGaugeSample[] | TelemetryHistogramSample[];
}

export interface TelemetryEvent {
    type: string;
    data: unknown;
    recordedAt: number;
}

export interface TelemetrySnapshot {
    capturedAt: number;
    metrics: TelemetryMetricSnapshot[];
}

export interface TelemetrySink {
    incrementCounter(name: string, labels?: TelemetryLabels, value?: number, description?: string): void;
    setGauge(name: string, value: number, labels?: TelemetryLabels, options?: {
        unit?: TelemetryUnit;
        description?: string;
    }): void;
    observeHistogram(name: string, value: number, labels?: TelemetryLabels, options?: {
        unit?: TelemetryUnit;
        buckets?: number[];
        description?: string;
    }): void;
    recordEvent(type: string, data: unknown): void;
}

type MetricSeries<T> = Map<string, { labels: Record<string, string>; state: T }>;

interface CounterState {
    value: number;
}

interface GaugeState {
    value: number;
}

interface HistogramState {
    count: number;
    sum: number;
    min: number | null;
    max: number | null;
    bucketCounts: number[];
}

interface HistogramDefinition {
    unit: TelemetryUnit;
    description?: string;
    buckets: number[];
    series: MetricSeries<HistogramState>;
}

function normalizeLabels(labels: TelemetryLabels | undefined): Record<string, string> {
    if (!labels) return {};
    const out: Record<string, string> = {};
    for (const key of Object.keys(labels).sort((a, b) => a.localeCompare(b))) {
        const value = labels[key];
        if (value === undefined) continue;
        out[key] = String(value);
    }
    return out;
}

function labelsKey(labels: Record<string, string>): string {
    return Object.entries(labels)
        .map(([key, value]) => `${key}=${value}`)
        .join('|');
}

function defaultBuckets(unit: TelemetryUnit): number[] {
    switch (unit) {
        case 'seconds':
            return [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];
        case 'bytes':
            return [128, 512, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304, 16777216];
        case 'ratio':
        case 'score':
            return [0.1, 0.25, 0.5, 0.75, 1, 2, 5, 10, 20, 50];
        case 'count':
        case 'unknown':
        default:
            return [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 4096];
    }
}

export class TelemetryCollector implements TelemetrySink {
    private readonly counters = new Map<string, { unit: TelemetryUnit; description?: string; series: MetricSeries<CounterState> }>();
    private readonly gauges = new Map<string, { unit: TelemetryUnit; description?: string; series: MetricSeries<GaugeState> }>();
    private readonly histograms = new Map<string, HistogramDefinition>();
    private readonly events: TelemetryEvent[] = [];

    constructor(private readonly options: { maxEvents?: number; } = {}) { }

    incrementCounter(name: string, labels: TelemetryLabels = {}, value: number = 1, description?: string): void {
        const normalized = normalizeLabels(labels);
        const entry = this.counters.get(name) ?? {
            unit: 'count' as const,
            description,
            series: new Map<string, { labels: Record<string, string>; state: CounterState }>(),
        };
        if (description && !entry.description) entry.description = description;
        const key = labelsKey(normalized);
        const sample = entry.series.get(key) ?? { labels: normalized, state: { value: 0 } };
        sample.state.value += value;
        entry.series.set(key, sample);
        this.counters.set(name, entry);
    }

    setGauge(name: string, value: number, labels: TelemetryLabels = {}, options: {
        unit?: TelemetryUnit;
        description?: string;
    } = {}): void {
        const normalized = normalizeLabels(labels);
        const entry = this.gauges.get(name) ?? {
            unit: options.unit ?? 'count',
            description: options.description,
            series: new Map<string, { labels: Record<string, string>; state: GaugeState }>(),
        };
        if (options.description && !entry.description) entry.description = options.description;
        const key = labelsKey(normalized);
        entry.series.set(key, { labels: normalized, state: { value } });
        this.gauges.set(name, entry);
    }

    observeHistogram(name: string, value: number, labels: TelemetryLabels = {}, options: {
        unit?: TelemetryUnit;
        buckets?: number[];
        description?: string;
    } = {}): void {
        const normalized = normalizeLabels(labels);
        const definition = this.histograms.get(name) ?? {
            unit: options.unit ?? 'count',
            description: options.description,
            buckets: (options.buckets ?? defaultBuckets(options.unit ?? 'count')).slice().sort((a, b) => a - b),
            series: new Map<string, { labels: Record<string, string>; state: HistogramState }>(),
        };
        if (options.description && !definition.description) definition.description = options.description;
        const key = labelsKey(normalized);
        const sample = definition.series.get(key) ?? {
            labels: normalized,
            state: {
                count: 0,
                sum: 0,
                min: null,
                max: null,
                bucketCounts: new Array(definition.buckets.length).fill(0),
            },
        };

        sample.state.count += 1;
        sample.state.sum += value;
        sample.state.min = sample.state.min == null ? value : Math.min(sample.state.min, value);
        sample.state.max = sample.state.max == null ? value : Math.max(sample.state.max, value);
        for (let i = 0; i < definition.buckets.length; i++) {
            if (value <= definition.buckets[i]) {
                sample.state.bucketCounts[i] += 1;
            }
        }
        definition.series.set(key, sample);
        this.histograms.set(name, definition);
    }

    recordEvent(type: string, data: unknown): void {
        this.events.push({
            type,
            data,
            recordedAt: Date.now(),
        });
        const maxEvents = this.options.maxEvents ?? 256;
        if (this.events.length > maxEvents) {
            this.events.splice(0, this.events.length - maxEvents);
        }
    }

    snapshot(): TelemetrySnapshot {
        const metrics: TelemetryMetricSnapshot[] = [];

        for (const [name, entry] of Array.from(this.counters.entries()).sort(([a], [b]) => a.localeCompare(b))) {
            metrics.push({
                name,
                type: 'counter',
                unit: entry.unit,
                description: entry.description,
                samples: Array.from(entry.series.values())
                    .sort((a, b) => labelsKey(a.labels).localeCompare(labelsKey(b.labels)))
                    .map((sample) => ({
                        labels: { ...sample.labels },
                        value: sample.state.value,
                    })),
            });
        }

        for (const [name, entry] of Array.from(this.gauges.entries()).sort(([a], [b]) => a.localeCompare(b))) {
            metrics.push({
                name,
                type: 'gauge',
                unit: entry.unit,
                description: entry.description,
                samples: Array.from(entry.series.values())
                    .sort((a, b) => labelsKey(a.labels).localeCompare(labelsKey(b.labels)))
                    .map((sample) => ({
                        labels: { ...sample.labels },
                        value: sample.state.value,
                    })),
            });
        }

        for (const [name, entry] of Array.from(this.histograms.entries()).sort(([a], [b]) => a.localeCompare(b))) {
            metrics.push({
                name,
                type: 'histogram',
                unit: entry.unit,
                description: entry.description,
                samples: Array.from(entry.series.values())
                    .sort((a, b) => labelsKey(a.labels).localeCompare(labelsKey(b.labels)))
                    .map((sample) => ({
                        labels: { ...sample.labels },
                        count: sample.state.count,
                        sum: sample.state.sum,
                        min: sample.state.min,
                        max: sample.state.max,
                        buckets: entry.buckets.map((bucket, index) => ({
                            le: bucket,
                            count: sample.state.bucketCounts[index],
                        })),
                    })),
            });
        }

        return {
            capturedAt: Date.now(),
            metrics,
        };
    }

    getEvents(limit: number = 100, type?: string): TelemetryEvent[] {
        const filtered = type
            ? this.events.filter((event) => event.type === type)
            : this.events.slice();
        const bounded = filtered.slice(-Math.max(0, limit));
        return bounded.map((event) => ({
            type: event.type,
            data: structuredClone(event.data),
            recordedAt: event.recordedAt,
        }));
    }
}
