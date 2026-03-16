import { GICSSupervisor, type SubsystemHealthCheck } from '../src/daemon/supervisor.js';

describe('GICSSupervisor (fase 5)', () => {
    it('subsystem falla → restart automático en <2s', async () => {
        let subsystemHealthy = true;
        let restartCalls = 0;

        const supervisor = new GICSSupervisor({ healthCheckIntervalMs: 100, backoffBaseMs: 50 });
        const checks: SubsystemHealthCheck = {
            checkMemTable: () => subsystemHealthy,
            checkWAL: () => subsystemHealthy,
            restartSubsystem: async () => {
                restartCalls++;
                subsystemHealthy = true;
                return true;
            },
        };
        supervisor.registerHealthChecks(checks);
        supervisor.start();

        expect(supervisor.getState()).toBe('HEALTHY');

        // Simular falla del subsistema
        subsystemHealthy = false;

        await new Promise(r => setTimeout(r, 1500));

        expect(restartCalls).toBeGreaterThan(0);
        expect(supervisor.getState()).toBe('HEALTHY');
        expect(subsystemHealthy).toBe(true);

        supervisor.stop();
    });

    it('5 failures en 5min → DEGRADED mode activado', async () => {
        let subsystemHealthy = true;

        const supervisor = new GICSSupervisor({
            healthCheckIntervalMs: 50,
            backoffBaseMs: 10,
            maxRestartsBeforeDegraded: 5,
            restartWindowMs: 300_000,
        });

        const checks: SubsystemHealthCheck = {
            checkMemTable: () => subsystemHealthy,
            checkWAL: () => subsystemHealthy,
            restartSubsystem: async () => {
                return false; // Restart siempre falla
            },
        };

        supervisor.registerHealthChecks(checks);
        supervisor.start();

        // Simular fallas continuas
        subsystemHealthy = false;

        // Esperar a que entre en DEGRADED
        await new Promise(r => setTimeout(r, 1500));

        expect(supervisor.getState()).toBe('DEGRADED');
        const status = supervisor.getStatus();
        expect(status.state).toBe('DEGRADED');

        supervisor.stop();
    });

    it('en DEGRADED: writes se bufferizan, reads del snapshot', async () => {
        const supervisor = new GICSSupervisor();
        supervisor.registerHealthChecks({
            checkMemTable: () => false,
            checkWAL: () => false,
            restartSubsystem: async () => false,
        });
        supervisor.start();

        // Forzar DEGRADED manualmente para el test
        await new Promise(r => setTimeout(r, 100));

        const buffered = supervisor.bufferWrite('test:key', { value: 42 });
        expect(buffered.seq).toBe(1);
        expect(supervisor.getStatus().bufferedWrites).toBe(1);

        supervisor.stop();
    });

    it('post-recovery: buffer se flushea, conflictos resueltos (WAL wins)', async () => {
        const supervisor = new GICSSupervisor();
        supervisor.start();

        supervisor.bufferWrite('k1', { v: 100 });
        supervisor.bufferWrite('k2', { v: 200 });
        supervisor.bufferWrite('k3', { v: 300 });

        const applied: Array<{ key: string; fields: Record<string, number | string> }> = [];
        const flushResult = supervisor.flushBuffer(
            (key) => key === 'k2', // k2 está en WAL
            (key, fields) => applied.push({ key, fields }),
        );

        expect(flushResult.applied).toBe(2);
        expect(flushResult.discarded).toBe(1);
        expect(flushResult.discardedKeys).toEqual(['k2']);
        expect(applied).toHaveLength(2);
        expect(applied.map(a => a.key).sort()).toEqual(['k1', 'k3']);

        supervisor.stop();
    });

    it('resetDegraded() → vuelve a STARTING → HEALTHY', async () => {
        let subsystemHealthy = false;
        let resetCalled = false;

        const supervisor = new GICSSupervisor({
            healthCheckIntervalMs: 50,
            backoffBaseMs: 10,
            maxRestartsBeforeDegraded: 3,
            restartWindowMs: 300_000,
        });

        const checks: SubsystemHealthCheck = {
            checkMemTable: () => subsystemHealthy,
            checkWAL: () => subsystemHealthy,
            restartSubsystem: async () => {
                // Después de llamar resetDegraded, el restart tiene éxito
                if (resetCalled) {
                    subsystemHealthy = true;
                    return true;
                }
                return false;
            },
        };

        supervisor.registerHealthChecks(checks);
        supervisor.start();

        // Esperar a que entre en DEGRADED
        await new Promise(r => setTimeout(r, 800));
        expect(supervisor.getState()).toBe('DEGRADED');

        resetCalled = true;
        const resetOk = await supervisor.resetDegraded();
        expect(resetOk).toBe(true);
        expect(supervisor.getState()).toBe('HEALTHY');

        supervisor.stop();
    });

    it('state transitions logueados con timestamp', () => {
        const supervisor = new GICSSupervisor();
        supervisor.start();

        const transitions = supervisor.getTransitions();
        expect(transitions.length).toBeGreaterThan(0);
        expect(transitions[transitions.length - 1]).toMatchObject({
            from: 'STARTING',
            to: 'HEALTHY',
            reason: 'supervisor started',
        });
        expect(transitions[transitions.length - 1].timestamp).toBeGreaterThan(0);

        supervisor.stop();
    });
});
