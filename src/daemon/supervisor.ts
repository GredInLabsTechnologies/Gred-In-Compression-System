/**
 * GICSSupervisor — Phase 5: Auto-restart + DEGRADED mode
 *
 * Manages daemon subsystem lifecycle with health checks,
 * exponential backoff restarts, and degraded fallback.
 */

export type SupervisorState = 'STARTING' | 'HEALTHY' | 'RESTARTING' | 'DEGRADED';

export interface BufferedWrite {
    seq: number;
    key: string;
    fields: Record<string, number | string>;
    timestamp: number;
}

export interface SupervisorConfig {
    healthCheckIntervalMs?: number;      // default: 10000
    maxRestartsBeforeDegraded?: number;  // default: 5
    restartWindowMs?: number;            // default: 300000 (5 min)
    backoffBaseMs?: number;              // default: 1000
    backoffMaxMs?: number;               // default: 16000
}

export interface SubsystemHealthCheck {
    checkMemTable: () => boolean;
    checkWAL: () => boolean;
    restartSubsystem: () => Promise<boolean>;
}

export class GICSSupervisor {
    private state: SupervisorState = 'STARTING';
    private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
    private readonly healthCheckIntervalMs: number;
    private readonly maxRestarts: number;
    private readonly restartWindowMs: number;
    private readonly backoffBaseMs: number;
    private readonly backoffMaxMs: number;
    private restartTimestamps: number[] = [];
    private consecutiveFailures = 0;
    private readonly buffer: BufferedWrite[] = [];
    private bufferSeq = 0;
    private readonly transitions: Array<{ from: SupervisorState; to: SupervisorState; timestamp: number; reason: string }> = [];
    private healthChecks: SubsystemHealthCheck | null = null;
    private restartInProgress = false;

    constructor(config: SupervisorConfig = {}) {
        this.healthCheckIntervalMs = config.healthCheckIntervalMs ?? 10_000;
        this.maxRestarts = config.maxRestartsBeforeDegraded ?? 5;
        this.restartWindowMs = config.restartWindowMs ?? 300_000;
        this.backoffBaseMs = config.backoffBaseMs ?? 1000;
        this.backoffMaxMs = config.backoffMaxMs ?? 16_000;
    }

    registerHealthChecks(checks: SubsystemHealthCheck): void {
        this.healthChecks = checks;
    }

    start(): void {
        this.transition('HEALTHY', 'supervisor started');
        this.healthCheckTimer = setInterval(() => this.performHealthCheck(), this.healthCheckIntervalMs);
    }

    stop(): void {
        if (this.healthCheckTimer) {
            clearInterval(this.healthCheckTimer);
            this.healthCheckTimer = null;
        }
    }

    getState(): SupervisorState {
        return this.state;
    }

    getStatus(): {
        state: SupervisorState;
        consecutiveFailures: number;
        bufferedWrites: number;
        transitions: Array<{ from: SupervisorState; to: SupervisorState; timestamp: number; reason: string }>;
    } {
        return {
            state: this.state,
            consecutiveFailures: this.consecutiveFailures,
            bufferedWrites: this.buffer.length,
            transitions: [...this.transitions],
        };
    }

    isDegraded(): boolean {
        return this.state === 'DEGRADED';
    }

    bufferWrite(key: string, fields: Record<string, number | string>): BufferedWrite {
        const entry: BufferedWrite = {
            seq: ++this.bufferSeq,
            key,
            fields: { ...fields },
            timestamp: Date.now(),
        };
        this.buffer.push(entry);
        return entry;
    }

    /**
     * Flush buffered writes post-recovery. Returns writes that were applied
     * and writes that were discarded due to WAL conflicts.
     */
    flushBuffer(walHasKey: (key: string) => boolean, applyWrite: (key: string, fields: Record<string, number | string>) => void): {
        applied: number;
        discarded: number;
        discardedKeys: string[];
    } {
        let applied = 0;
        let discarded = 0;
        const discardedKeys: string[] = [];

        for (const entry of this.buffer) {
            if (walHasKey(entry.key)) {
                // WAL wins — discard buffered write
                discarded++;
                discardedKeys.push(entry.key);
                console.log(`[Supervisor] Conflict: WAL wins for key="${entry.key}", buffer write discarded.`);
            } else {
                applyWrite(entry.key, entry.fields);
                applied++;
            }
        }

        this.buffer.length = 0;
        this.bufferSeq = 0;
        return { applied, discarded, discardedKeys };
    }

    async resetDegraded(): Promise<boolean> {
        if (this.state !== 'DEGRADED') return false;
        this.consecutiveFailures = 0;
        this.restartTimestamps = [];
        this.transition('STARTING', 'manual reset from DEGRADED');

        if (this.healthChecks) {
            const ok = await this.healthChecks.restartSubsystem();
            if (ok) {
                this.transition('HEALTHY', 'subsystem restarted after manual reset');
                return true;
            }
            this.transition('DEGRADED', 'restart failed after manual reset');
            return false;
        }

        this.transition('HEALTHY', 'manual reset (no health checks registered)');
        return true;
    }

    getTransitions(): Array<{ from: SupervisorState; to: SupervisorState; timestamp: number; reason: string }> {
        return [...this.transitions];
    }

    private transition(to: SupervisorState, reason: string): void {
        const from = this.state;
        if (from === to) return;
        this.state = to;
        const ts = Date.now();
        this.transitions.push({ from, to, timestamp: ts, reason });
        const level = to === 'DEGRADED' ? 'error' : 'log';
        console[level](`[Supervisor] ${from} -> ${to}: ${reason} (${new Date(ts).toISOString()})`);
    }

    private async performHealthCheck(): Promise<void> {
        if (this.state === 'DEGRADED' || this.restartInProgress) return;
        if (!this.healthChecks) return;

        const memOk = this.healthChecks.checkMemTable();
        const walOk = this.healthChecks.checkWAL();

        if (memOk && walOk) {
            if (this.state === 'RESTARTING') {
                this.transition('HEALTHY', 'health check passed after restart');
            }
            this.consecutiveFailures = 0;
            return;
        }

        // Subsystem failure detected
        this.consecutiveFailures++;
        const now = Date.now();
        this.restartTimestamps.push(now);
        // Prune timestamps outside the restart window
        this.restartTimestamps = this.restartTimestamps.filter(t => now - t < this.restartWindowMs);

        if (this.restartTimestamps.length >= this.maxRestarts) {
            this.transition('DEGRADED', `${this.maxRestarts} restarts in ${this.restartWindowMs / 1000}s window`);
            return;
        }

        this.transition('RESTARTING', `subsystem failure (memOk=${memOk}, walOk=${walOk})`);
        await this.attemptRestart();
    }

    private async attemptRestart(): Promise<void> {
        if (!this.healthChecks) return;
        this.restartInProgress = true;

        const delay = Math.min(
            this.backoffBaseMs * Math.pow(2, this.consecutiveFailures - 1),
            this.backoffMaxMs
        );

        await new Promise(r => setTimeout(r, delay));

        try {
            const ok = await this.healthChecks.restartSubsystem();
            if (ok) {
                this.transition('HEALTHY', `restart succeeded after ${delay}ms backoff`);
                this.consecutiveFailures = 0;
            }
            // If not ok, next health check will detect it
        } catch (err) {
            console.error(`[Supervisor] Restart attempt failed:`, err);
        } finally {
            this.restartInProgress = false;
        }
    }
}
