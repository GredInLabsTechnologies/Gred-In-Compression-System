import * as fs from 'fs/promises';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { GICSDaemon } from '../src/daemon/server.js';
import type { ModuleContext } from '../src/daemon/module-registry.js';
import { GICSInferenceEngine } from '../src/inference/engine.js';
import { InferenceEngineModule } from '../src/inference/module.js';
import { InferenceStateStore } from '../src/inference/state-store.js';
import { TelemetryCollector } from '../src/telemetry/collector.js';

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gics-inference-runtime-'));
    try {
        await run(dir);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
}

function makeSocketPath(name: string): string {
    return process.platform === 'win32'
        ? `\\\\.\\pipe\\${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`
        : path.join(os.tmpdir(), `${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
}

function makeContext(
    systemRecords: Map<string, Record<string, number | string>> = new Map(),
    telemetry?: TelemetryCollector,
): ModuleContext {
    return {
        emitEvent: () => undefined,
        upsertSystemRecord: async (key, fields) => {
            systemRecords.set(key, { ...fields });
        },
        now: () => Date.now(),
        getStateSnapshot: () => [],
        telemetry,
    };
}

async function rpcCall(socketPath: string, request: Record<string, unknown>): Promise<any> {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection(socketPath, () => {
            socket.write(JSON.stringify({ jsonrpc: '2.0', ...request }) + '\n');
        });

        let buffer = '';
        socket.on('data', (data) => {
            buffer += data.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            if (lines.length === 0) return;
            socket.end();
            resolve(JSON.parse(lines[0]!));
        });
        socket.on('error', reject);
    });
}

describe('Inference engine runtime', () => {
    it('batches persistence instead of saving once per event', async () => {
        await withTempDir(async (dir) => {
            const records = new Map<string, Record<string, number | string>>();
            const ctx = makeContext(records);
            const module = new InferenceEngineModule(dir, 'host:default', {
                flushIntervalMs: 60_000,
                flushOpsThreshold: 10_000,
                eagerFlushOnInfer: false,
                eagerFlushOnOutcome: false,
            });

            await module.init(ctx);

            const engine = (module as any).engine as GICSInferenceEngine;
            const originalSave = engine.save.bind(engine);
            let saveCount = 0;
            (engine as any).save = async () => {
                saveCount += 1;
                await originalSave();
            };

            for (let i = 0; i < 12; i++) {
                await module.onWrite({
                    key: `orders:${i}`,
                    fields: { value: i },
                    timestamp: i + 1,
                }, ctx);
            }

            expect(saveCount).toBe(0);
            const healthBefore = await module.health();
            expect(healthBefore.dirty).toBe(true);

            await module.forceFlush();

            expect(saveCount).toBe(1);
            const statePath = path.join(dir, 'inference', 'state.json');
            const raw = JSON.parse(await fs.readFile(statePath, 'utf8'));
            expect(raw.profiles['host:default'].stats.writes).toBe(12);
            expect(records.has('_infer|profile|host:default')).toBe(true);
        });
    });

    it('flushes pending runtime state during stop()', async () => {
        await withTempDir(async (dir) => {
            const ctx = makeContext();
            const module = new InferenceEngineModule(dir, 'host:default', {
                flushIntervalMs: 60_000,
                flushOpsThreshold: 10_000,
                eagerFlushOnInfer: false,
                eagerFlushOnOutcome: false,
            });

            await module.init(ctx);
            await module.onWrite({
                key: 'jobs:1',
                fields: { value: 99 },
                timestamp: 1,
            }, ctx);

            await module.stop();

            const statePath = path.join(dir, 'inference', 'state.json');
            const raw = JSON.parse(await fs.readFile(statePath, 'utf8'));
            expect(raw.profiles['host:default'].stats.writes).toBe(1);
            expect(raw.runtime.saveCount).toBeGreaterThan(0);
        });
    });

    it('changes ranking deterministically after feedback', async () => {
        await withTempDir(async (dir) => {
            const store = new InferenceStateStore(path.join(dir, 'state.json'), 'host:default');
            const engine = new GICSInferenceEngine(store, 'host:default');
            await engine.load();

            const request = {
                domain: 'ops.provider_select',
                subject: 'gimo',
                context: { scope: 'host:default' },
                candidates: [
                    { id: 'haiku', latencyMs: 90, cost: 0.2 },
                    { id: 'sonnet', latencyMs: 140, cost: 0.35 },
                    { id: 'opus', latencyMs: 240, cost: 0.7 },
                ],
            };

            const baseline = engine.infer(request).ranking.map((item) => item.id);

            for (let i = 0; i < 5; i++) {
                engine.recordOutcome('ops.provider_select', undefined, {
                    scope: 'host:default',
                    subject: 'gimo',
                    candidateId: 'sonnet',
                }, {
                    latencyMs: 110,
                    costScore: 0.25,
                }, 'success');
            }

            for (let i = 0; i < 4; i++) {
                engine.recordOutcome('ops.provider_select', undefined, {
                    scope: 'host:default',
                    subject: 'gimo',
                    candidateId: 'haiku',
                }, {
                    latencyMs: 280,
                    costScore: 0.8,
                }, 'error');
            }

            const rankedA = engine.infer(request).ranking.map((item) => item.id);
            const rankedB = engine.infer(request).ranking.map((item) => item.id);

            expect(rankedA).toEqual(rankedB);
            expect(rankedA[0]).toBe('sonnet');
            expect(rankedA).not.toEqual(baseline);
        });
    });

    it('persists policies, decisions, feedback and runtime health across restart', async () => {
        await withTempDir(async (dir) => {
            const dataPath = path.join(dir, 'data');
            const tokenPath = path.join(dir, 'gics.token');
            const socketPath = makeSocketPath('gics-inference-daemon');

            const daemonA = new GICSDaemon({
                socketPath,
                dataPath,
                tokenPath,
                walType: 'binary',
                modules: {
                    'inference-engine': {
                        enabled: true,
                        options: {
                            flushIntervalMs: 60_000,
                            flushOpsThreshold: 10_000,
                            eagerFlushOnInfer: true,
                            eagerFlushOnOutcome: true,
                        },
                    },
                },
            });
            await daemonA.start();
            const token = (await fs.readFile(tokenPath, 'utf8')).trim();

            const infer = await rpcCall(socketPath, {
                method: 'infer',
                params: {
                    domain: 'ops.provider_select',
                    subject: 'gimo',
                    context: { scope: 'host:default' },
                    candidates: [
                        { id: 'haiku', latencyMs: 90, cost: 0.2 },
                        { id: 'sonnet', latencyMs: 120, cost: 0.25 },
                        { id: 'opus', latencyMs: 220, cost: 0.8 },
                    ],
                },
                id: 1,
                token,
            });
            expect(infer.error).toBeUndefined();

            const chosen = infer.result.recommended.id;
            const outcome = await rpcCall(socketPath, {
                method: 'reportOutcome',
                params: {
                    domain: 'ops.provider_select',
                    decisionId: infer.result.decisionId,
                    result: 'success',
                    context: {
                        scope: 'host:default',
                        subject: 'gimo',
                        candidateId: chosen,
                    },
                    metrics: {
                        latencyMs: 100,
                        costScore: 0.2,
                    },
                },
                id: 2,
                token,
            });
            expect(outcome.error).toBeUndefined();

            const runtime = await rpcCall(socketPath, {
                method: 'getInferenceRuntime',
                id: 3,
                token,
            });
            expect(runtime.error).toBeUndefined();
            expect(runtime.result.pendingDecisions).toBe(0);
            expect(runtime.result.pendingFeedback).toBe(0);
            expect(runtime.result.flushCount).toBeGreaterThan(0);

            const flush = await rpcCall(socketPath, {
                method: 'flushInference',
                id: 4,
                token,
            });
            expect(flush.result.ok).toBe(true);

            await daemonA.stop();

            const daemonB = new GICSDaemon({
                socketPath,
                dataPath,
                tokenPath,
                walType: 'binary',
                modules: {
                    'inference-engine': { enabled: true },
                },
            });
            await daemonB.start();

            const profile = await rpcCall(socketPath, {
                method: 'getProfile',
                params: { scope: 'host:default' },
                id: 5,
                token,
            });
            expect(profile.error).toBeUndefined();
            expect(profile.result.preferences.preferredProviderId).toBe(chosen);

            const hidden = await rpcCall(socketPath, {
                method: 'scan',
                params: { prefix: '_infer|', includeSystem: true },
                id: 6,
                token,
            });
            const keys = hidden.result.items.map((item: any) => item.key);
            expect(keys.some((key: string) => key.startsWith('_infer|policy|ops.provider_select|host:default'))).toBe(true);
            expect(keys.some((key: string) => key.startsWith('_infer|decision|'))).toBe(true);
            expect(keys.some((key: string) => key.startsWith('_infer|feedback|'))).toBe(true);

            const recommendations = await rpcCall(socketPath, {
                method: 'getRecommendations',
                params: { domain: 'ops.provider_select', subject: 'gimo', limit: 5 },
                id: 7,
                token,
            });
            expect(recommendations.error).toBeUndefined();
            expect(recommendations.result.some((item: any) => item.type === 'inference_decision')).toBe(true);

            await daemonB.stop();
        });
    });

    it('emits inference runtime and quality telemetry', async () => {
        await withTempDir(async (dir) => {
            const telemetry = new TelemetryCollector();
            const records = new Map<string, Record<string, number | string>>();
            const ctx = makeContext(records, telemetry);
            const module = new InferenceEngineModule(dir, 'host:default', {
                flushIntervalMs: 60_000,
                flushOpsThreshold: 10_000,
                eagerFlushOnInfer: false,
                eagerFlushOnOutcome: false,
            });

            await module.init(ctx);
            const decision = await module.infer({
                domain: 'ops.provider_select',
                subject: 'gimo',
                context: { scope: 'host:default' },
                candidates: [
                    { id: 'haiku', latencyMs: 90, cost: 0.2 },
                    { id: 'sonnet', latencyMs: 110, cost: 0.25 },
                ],
            }, ctx);

            expect(decision?.decisionId).toBeDefined();

            await module.onOutcome({
                domain: 'ops.provider_select',
                decisionId: decision!.decisionId,
                result: 'success',
                context: {
                    scope: 'host:default',
                    subject: 'gimo',
                    candidateId: decision!.recommended?.id ?? decision!.ranking[0].id,
                },
                metrics: {
                    latencyMs: 100,
                    costScore: 0.2,
                },
                timestamp: Date.now(),
            }, ctx);

            await module.forceFlush();

            const metricNames = telemetry.snapshot().metrics.map((metric) => metric.name);
            expect(metricNames).toContain('gics_infer_requests_total');
            expect(metricNames).toContain('gics_infer_outcomes_total');
            expect(metricNames).toContain('gics_infer_feedback_score');
            expect(metricNames).toContain('gics_infer_publish_total');
            expect(metricNames).toContain('gics_infer_flush_total');
        });
    });

    it('supports explicit profile/policy seeds and uses them in storage scoring', async () => {
        await withTempDir(async (dir) => {
            const store = new InferenceStateStore(path.join(dir, 'state.json'), 'host:default');
            const engine = new GICSInferenceEngine(store, 'host:default');
            await engine.load();

            engine.seedProfile({
                scope: 'host:default',
                stats: {
                    scans: 50,
                    writes: 4,
                    reads: 12,
                },
                policyHints: {
                    storageMode: 'read_heavy',
                },
            });
            engine.seedPolicy({
                domain: 'storage.policy',
                scope: 'host:default',
                recommendedCandidateId: 'policy.read_heavy',
                payload: {
                    mode: 'read_heavy',
                    recommendedMaxMemSizeBytes: 16 * 1024 * 1024,
                    recommendedMaxDirtyCount: 1200,
                    recommendedWarmRetentionMs: 7 * 24 * 60 * 60 * 1000,
                },
                weights: {
                    bandit: 0.2,
                    modeMatch: 0.3,
                    scanPressure: 0.25,
                    writePressure: 0.1,
                    safety: 0.15,
                },
            });

            const decision = engine.infer({
                domain: 'storage.policy',
                context: { scope: 'host:default' },
            });

            expect(engine.getProfile('host:default').policyHints.storageMode).toBe('read_heavy');
            expect(engine.getPolicy('storage.policy', 'host:default')?.recommendedCandidateId).toBe('policy.read_heavy');
            expect(decision.recommended?.id).toBe('policy.read_heavy');
        });
    });
});
