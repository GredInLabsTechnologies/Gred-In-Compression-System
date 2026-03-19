/**
 * ResilienceShell — Phase 6: Circuit Breaker + Retry + Backpressure
 *
 * Protects daemon ingest layer with circuit breaker, retry with jitter,
 * and backpressure control. Transparente para callers via error metadata.
 */

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface ResilienceConfig {
    circuitBreaker?: {
        failureThreshold?: number;     // default: 5
        windowMs?: number;             // default: 60000
        halfOpenAfterMs?: number;      // default: 30000
        halfOpenMaxProbes?: number;    // default: 3
    };
    backpressure?: {
        highWaterMark?: number;        // default: 1000
        lowWaterMark?: number;         // default: 200
    };
    retry?: {
        maxAttempts?: number;          // default: 3
        baseDelayMs?: number;          // default: 100
        maxDelayMs?: number;           // default: 5000
        jitterFactor?: number;         // default: 0.3
    };
    timeout?: {
        readMs?: number;               // default: 2000
        writeMs?: number;              // default: 5000
        scanMs?: number;               // default: 10000
    };
}

export interface ResilienceMetadata {
    attempts: number;
    lastError?: string;
    circuitState: CircuitState;
    queueDepth: number;
}

export class GICSUnavailable extends Error {
    metadata: ResilienceMetadata;
    constructor(message: string, metadata: ResilienceMetadata) {
        super(message);
        this.name = 'GICSUnavailable';
        this.metadata = metadata;
    }
}

export class GICSTimeout extends Error {
    metadata: ResilienceMetadata;
    constructor(message: string, metadata: ResilienceMetadata) {
        super(message);
        this.name = 'GICSTimeout';
        this.metadata = metadata;
    }
}

export class GICSCircuitOpen extends Error {
    metadata: ResilienceMetadata;
    constructor(message: string, metadata: ResilienceMetadata) {
        super(message);
        this.name = 'GICSCircuitOpen';
        this.metadata = metadata;
    }
}

export class ResilienceShell {
    private circuitState: CircuitState = 'CLOSED';
    private readonly failureThreshold: number;
    private readonly windowMs: number;
    private readonly halfOpenAfterMs: number;
    private readonly halfOpenMaxProbes: number;
    private readonly highWaterMark: number;
    private readonly lowWaterMark: number;
    private readonly retryMaxAttempts: number;
    private readonly retryBaseDelayMs: number;
    private readonly retryMaxDelayMs: number;
    private readonly jitterFactor: number;
    private readonly timeoutRead: number;
    private readonly timeoutWrite: number;
    private readonly timeoutScan: number;

    private failures: number[] = [];
    private circuitOpenedAt = 0;
    private halfOpenSuccessfulProbes = 0;
    private halfOpenInFlight = 0;
    private pendingOps = 0;
    private backpressureActive = false;

    constructor(config: ResilienceConfig = {}) {
        this.failureThreshold = config.circuitBreaker?.failureThreshold ?? 5;
        this.windowMs = config.circuitBreaker?.windowMs ?? 60_000;
        this.halfOpenAfterMs = config.circuitBreaker?.halfOpenAfterMs ?? 30_000;
        this.halfOpenMaxProbes = config.circuitBreaker?.halfOpenMaxProbes ?? 3;
        this.highWaterMark = config.backpressure?.highWaterMark ?? 1000;
        this.lowWaterMark = config.backpressure?.lowWaterMark ?? 200;
        this.retryMaxAttempts = config.retry?.maxAttempts ?? 3;
        this.retryBaseDelayMs = config.retry?.baseDelayMs ?? 100;
        this.retryMaxDelayMs = config.retry?.maxDelayMs ?? 5000;
        this.jitterFactor = config.retry?.jitterFactor ?? 0.3;
        this.timeoutRead = config.timeout?.readMs ?? 2000;
        this.timeoutWrite = config.timeout?.writeMs ?? 5000;
        this.timeoutScan = config.timeout?.scanMs ?? 10_000;
    }

    getCircuitState(): CircuitState {
        this.updateCircuitState();
        return this.circuitState;
    }

    getPendingOps(): number {
        return this.pendingOps;
    }

    async executeRead<T>(operation: () => Promise<T>): Promise<T> {
        return this.execute(operation, 'read', this.timeoutRead);
    }

    async executeWrite<T>(operation: () => Promise<T>): Promise<T> {
        return this.execute(operation, 'write', this.timeoutWrite);
    }

    async executeScan<T>(operation: () => Promise<T>): Promise<T> {
        return this.execute(operation, 'scan', this.timeoutScan);
    }

    private async execute<T>(
        operation: () => Promise<T>,
        type: 'read' | 'write' | 'scan',
        timeoutMs: number
    ): Promise<T> {
        this.updateCircuitState();
        this.updateBackpressureState();

        if (this.backpressureActive) {
            throw new GICSUnavailable(
                `Backpressure: queue above lowWaterMark (${this.lowWaterMark})`,
                this.getMetadata(0, 'Backpressure limit reached')
            );
        }
        if (this.pendingOps >= this.highWaterMark) {
            this.backpressureActive = true;
            throw new GICSUnavailable(
                `Backpressure: queue at highWaterMark (${this.highWaterMark})`,
                this.getMetadata(0, 'Backpressure limit reached')
            );
        }

        if (this.circuitState === 'OPEN') {
            throw new GICSCircuitOpen(
                'Circuit breaker is OPEN',
                this.getMetadata(0, 'Circuit OPEN')
            );
        }

        const halfOpenProbe = this.circuitState === 'HALF_OPEN';
        if (halfOpenProbe && this.halfOpenInFlight >= this.halfOpenMaxProbes) {
            throw new GICSCircuitOpen(
                'Circuit breaker is HALF_OPEN and probe limit is exhausted',
                this.getMetadata(0, 'Circuit HALF_OPEN probe limit reached')
            );
        }

        this.pendingOps++;
        if (halfOpenProbe) {
            this.halfOpenInFlight++;
        }
        let attempts = 0;
        let lastError: Error | null = null;

        try {
            while (attempts < this.retryMaxAttempts) {
                attempts++;

                try {
                    const result = await this.withTimeout(operation(), timeoutMs);
                    this.recordSuccess();
                    return result;
                } catch (err: any) {
                    lastError = err;
                    if (err.name === 'TimeoutError') {
                        this.recordFailure();
                        // Check si circuit se abrió tras el failure
                        this.updateCircuitState();
                        if (this.getCircuitState() === 'OPEN' && attempts < this.retryMaxAttempts) {
                            break; // No más retries si circuit abrió
                        }
                        if (attempts < this.retryMaxAttempts) {
                            await this.delay(attempts);
                        }
                    } else {
                        this.recordFailure();
                        throw err; // No retry en errores no-timeout
                    }
                }
            }

            throw new GICSTimeout(
                `Operation timed out after ${attempts} attempts`,
                this.getMetadata(attempts, lastError?.message)
            );
        } finally {
            this.pendingOps--;
            if (halfOpenProbe) {
                this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1);
            }
            this.updateBackpressureState();
        }
    }

    private async withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const timeout = new Promise<T>((_, reject) => {
            timer = setTimeout(() => {
                const err = new Error('Operation timed out');
                err.name = 'TimeoutError';
                reject(err);
            }, ms);
        });

        try {
            return await Promise.race([promise, timeout]);
        } finally {
            if (timer) {
                clearTimeout(timer);
            }
        }
    }

    private async delay(attempt: number): Promise<void> {
        const baseDelay = Math.min(
            this.retryBaseDelayMs * Math.pow(2, attempt - 1),
            this.retryMaxDelayMs
        );
        // eslint-disable-next-line sonarjs/pseudo-random
        const jitter = baseDelay * this.jitterFactor * (Math.random() - 0.5);
        const delay = Math.max(0, baseDelay + jitter);
        await new Promise(r => setTimeout(r, delay));
    }

    private recordSuccess(): void {
        if (this.circuitState === 'HALF_OPEN') {
            this.halfOpenSuccessfulProbes++;
            if (this.halfOpenSuccessfulProbes >= this.halfOpenMaxProbes) {
                this.circuitState = 'CLOSED';
                this.failures = [];
                this.halfOpenSuccessfulProbes = 0;
                this.halfOpenInFlight = 0;
            }
        }
    }

    private recordFailure(): void {
        const now = Date.now();
        this.failures.push(now);
        this.pruneFailures(now);

        if (this.circuitState === 'HALF_OPEN') {
            this.circuitState = 'OPEN';
            this.circuitOpenedAt = now;
            this.halfOpenSuccessfulProbes = 0;
            this.halfOpenInFlight = 0;
        } else if (this.failures.length >= this.failureThreshold) {
            this.circuitState = 'OPEN';
            this.circuitOpenedAt = now;
        }
    }

    private updateCircuitState(): void {
        const now = Date.now();
        this.pruneFailures(now);

        if (this.circuitState === 'OPEN') {
            if (now - this.circuitOpenedAt >= this.halfOpenAfterMs) {
                this.circuitState = 'HALF_OPEN';
                this.halfOpenSuccessfulProbes = 0;
                this.halfOpenInFlight = 0;
            }
        } else if (this.circuitState === 'CLOSED') {
            if (this.failures.length >= this.failureThreshold) {
                this.circuitState = 'OPEN';
                this.circuitOpenedAt = now;
            }
        }
    }

    private updateBackpressureState(): void {
        if (!this.backpressureActive) return;
        if (this.pendingOps <= this.lowWaterMark) {
            this.backpressureActive = false;
        }
    }

    private pruneFailures(now: number): void {
        this.failures = this.failures.filter(t => now - t < this.windowMs);
    }

    private getMetadata(attempts: number, lastError?: string): ResilienceMetadata {
        return {
            attempts,
            lastError,
            circuitState: this.circuitState,
            queueDepth: this.pendingOps,
        };
    }
}
