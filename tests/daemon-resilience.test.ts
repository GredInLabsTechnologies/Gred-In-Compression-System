import { ResilienceShell, GICSCircuitOpen, GICSTimeout, GICSUnavailable } from '../src/daemon/resilience.js';

describe('ResilienceShell (fase 6)', () => {
    it('5 failures en 60s → circuit OPEN → calls fail-fast', async () => {
        const shell = new ResilienceShell({
            circuitBreaker: { failureThreshold: 5, windowMs: 60_000 },
            retry: { maxAttempts: 1 },
            timeout: { readMs: 50 },
        });

        const failingOp = async () => {
            await new Promise(r => setTimeout(r, 100)); // Timeout
            return 'ok';
        };

        // 5 failures
        for (let i = 0; i < 5; i++) {
            await expect(shell.executeRead(failingOp)).rejects.toThrow(GICSTimeout);
        }

        expect(shell.getCircuitState()).toBe('OPEN');

        // Siguiente call fail-fast sin timeout
        const start = Date.now();
        await expect(shell.executeRead(failingOp)).rejects.toThrow(GICSCircuitOpen);
        const elapsed = Date.now() - start;
        expect(elapsed).toBeLessThan(20); // Fail-fast, no espera timeout
    });

    it('30s cooldown → HALF-OPEN → 3 probes OK → CLOSED', async () => {
        const shell = new ResilienceShell({
            circuitBreaker: {
                failureThreshold: 2,
                windowMs: 60_000,
                halfOpenAfterMs: 100,
                halfOpenMaxProbes: 3,
            },
            retry: { maxAttempts: 1 },
            timeout: { readMs: 50 },
        });

        const failingOp = async () => {
            await new Promise(r => setTimeout(r, 100));
            return 'fail';
        };

        const successOp = async () => 'success';

        // 2 failures → OPEN
        await expect(shell.executeRead(failingOp)).rejects.toThrow();
        await expect(shell.executeRead(failingOp)).rejects.toThrow();
        expect(shell.getCircuitState()).toBe('OPEN');

        // Wait for cooldown
        await new Promise(r => setTimeout(r, 150));
        expect(shell.getCircuitState()).toBe('HALF_OPEN');

        // 3 probes exitosos → CLOSED
        await shell.executeRead(successOp);
        await shell.executeRead(successOp);
        await shell.executeRead(successOp);
        expect(shell.getCircuitState()).toBe('CLOSED');
    });

    it('retry con jitter: delays no son idénticos en múltiples retries', async () => {
        const shell = new ResilienceShell({
            retry: { maxAttempts: 3, baseDelayMs: 100, jitterFactor: 0.3 },
            timeout: { writeMs: 50 },
        });

        let attemptCount = 0;
        const delays: number[] = [];
        let lastAttempt = Date.now();

        const failingOp = async () => {
            const now = Date.now();
            if (attemptCount > 0) {
                delays.push(now - lastAttempt);
            }
            lastAttempt = now;
            attemptCount++;
            await new Promise(r => setTimeout(r, 100)); // Force timeout
            return 'never';
        };

        await expect(shell.executeWrite(failingOp)).rejects.toThrow(GICSTimeout);

        expect(attemptCount).toBe(3);
        expect(delays.length).toBe(2); // 2 delays entre 3 intentos

        // Verificar que los delays tienen jitter (no son iguales)
        if (delays.length === 2) {
            expect(Math.abs(delays[0] - delays[1])).toBeGreaterThan(5);
        }
    });

    it('backpressure: >highWaterMark pending → caller recibe error con queueDepth', async () => {
        const shell = new ResilienceShell({
            backpressure: { highWaterMark: 10 },
            timeout: { writeMs: 5000 },
        });

        const slowOp = () => new Promise<string>(r => setTimeout(() => r('ok'), 100));

        // Llenar queue hasta highWaterMark
        const promises = Array.from({ length: 10 }, () => shell.executeWrite(slowOp));

        // El siguiente debe fallar con backpressure
        try {
            await shell.executeWrite(slowOp);
            throw new Error('Expected GICSUnavailable');
        } catch (err: any) {
            expect(err).toBeInstanceOf(GICSUnavailable);
            expect(err.metadata.queueDepth).toBeGreaterThanOrEqual(10);
        }

        await Promise.all(promises);
    });

    it('error metadata siempre presente: {attempts, circuitState, queueDepth}', async () => {
        const shell = new ResilienceShell({
            retry: { maxAttempts: 3 },
            timeout: { readMs: 50 },
        });

        const failingOp = async () => {
            await new Promise(r => setTimeout(r, 100));
            return 'timeout';
        };

        try {
            await shell.executeRead(failingOp);
        } catch (err: any) {
            expect(err).toBeInstanceOf(GICSTimeout);
            expect(err.metadata).toBeDefined();
            expect(err.metadata.attempts).toBe(3);
            expect(err.metadata.circuitState).toBeDefined();
            expect(err.metadata.queueDepth).toBeDefined();
            expect(typeof err.metadata.queueDepth).toBe('number');
        }
    });

    it('circuitState transitions: CLOSED → OPEN → HALF_OPEN → CLOSED', async () => {
        const shell = new ResilienceShell({
            circuitBreaker: {
                failureThreshold: 2,
                windowMs: 60_000,
                halfOpenAfterMs: 100,
                halfOpenMaxProbes: 2,
            },
            retry: { maxAttempts: 1 },
            timeout: { readMs: 50 },
        });

        expect(shell.getCircuitState()).toBe('CLOSED');

        const failOp = async () => {
            await new Promise(r => setTimeout(r, 100));
            return 'fail';
        };
        const successOp = async () => 'ok';

        // CLOSED → OPEN
        await expect(shell.executeRead(failOp)).rejects.toThrow();
        await expect(shell.executeRead(failOp)).rejects.toThrow();
        expect(shell.getCircuitState()).toBe('OPEN');

        // OPEN → HALF_OPEN
        await new Promise(r => setTimeout(r, 150));
        expect(shell.getCircuitState()).toBe('HALF_OPEN');

        // HALF_OPEN → CLOSED
        await shell.executeRead(successOp);
        await shell.executeRead(successOp);
        expect(shell.getCircuitState()).toBe('CLOSED');
    });

    it('backpressure aplica histéresis hasta bajar de lowWaterMark', async () => {
        const shell = new ResilienceShell({
            backpressure: { highWaterMark: 3, lowWaterMark: 1 },
            timeout: { writeMs: 5000 },
        });

        const releases: Array<() => void> = [];
        const slowOp = () => new Promise<string>((resolve) => {
            releases.push(() => resolve('ok'));
        });

        const p1 = shell.executeWrite(slowOp);
        const p2 = shell.executeWrite(slowOp);
        const p3 = shell.executeWrite(slowOp);

        await expect(shell.executeWrite(slowOp)).rejects.toBeInstanceOf(GICSUnavailable);

        releases[0]!();
        await p1;

        await expect(shell.executeWrite(async () => 'still_blocked')).rejects.toBeInstanceOf(GICSUnavailable);

        releases[1]!();
        releases[2]!();
        await Promise.all([p2, p3]);
        await expect(shell.executeWrite(async () => 'ok')).resolves.toBe('ok');
    });

    it('HALF_OPEN limita probes concurrentes', async () => {
        const shell = new ResilienceShell({
            circuitBreaker: {
                failureThreshold: 1,
                windowMs: 60_000,
                halfOpenAfterMs: 30,
                halfOpenMaxProbes: 1,
            },
            retry: { maxAttempts: 1 },
            timeout: { readMs: 20 },
        });

        await expect(shell.executeRead(async () => {
            await new Promise((resolve) => setTimeout(resolve, 50));
            return 'timeout';
        })).rejects.toThrow(GICSTimeout);

        await new Promise((resolve) => setTimeout(resolve, 40));
        expect(shell.getCircuitState()).toBe('HALF_OPEN');

        let release!: () => void;
        const probeGate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const firstProbe = shell.executeRead(async () => {
            await probeGate;
            return 'ok';
        });

        await expect(shell.executeRead(async () => 'second')).rejects.toThrow(GICSCircuitOpen);

        release();
        await expect(firstProbe).resolves.toBe('ok');
        expect(shell.getCircuitState()).toBe('CLOSED');
    });
});
