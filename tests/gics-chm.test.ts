
import { HealthMonitor, RoutingDecision, CHMState } from '../src/gics/chm.js';
import { BlockMetrics } from '../src/gics/metrics.js';
import { HealthTag, BLOCK_FLAGS } from '../src/gics/format.js';

describe('HealthMonitor (CHM)', () => {
    let chm: HealthMonitor;
    const runId = 'test-run-1';

    beforeEach(() => {
        chm = new HealthMonitor(runId);
    });

    it('starts in NORMAL state', () => {
        expect(chm.getState()).toBe(CHMState.NORMAL);
        expect(chm.getTotalBlocks()).toBe(0);
    });

    it('routes to CORE in normal conditions', () => {
        const metrics: BlockMetrics = {
            unique_ratio: 0.5,
            unique_delta_ratio: 0.5,
            zero_ratio: 0,
            mean_abs_delta: 1,
            p90_abs_delta: 2,
            sign_flip_rate: 0,
            monotonicity_score: 1,
            outlier_score: 0,
            unique_dod_ratio: 0.5,
            dod_zero_ratio: 0.5,
            mean_abs_dod: 1,
            p90_abs_dod: 2,
        };
        const probeRatio = 2.0;

        const decision = chm.decideRoute(metrics, probeRatio, 0);
        expect(decision.decision).toBe(RoutingDecision.CORE);

        const update = chm.update(decision.decision, metrics, 100, 50, 10, 0, 1);
        expect(update.flags).toBe(0);
        expect(update.healthTag).toBe(HealthTag.OK);
        expect(update.isAnomaly).toBe(false);
    });

    it('triggers ENTROPY_GATE when entropy is too high', () => {
        const metrics: BlockMetrics = {
            unique_ratio: 0.9,
            unique_delta_ratio: 0.9, // Both > 0.85
            zero_ratio: 0,
            mean_abs_delta: 10,
            p90_abs_delta: 20,
            sign_flip_rate: 0.8,
            monotonicity_score: 0.5,
            outlier_score: 0.2,
            unique_dod_ratio: 0.9,
            dod_zero_ratio: 0.1,
            mean_abs_dod: 10,
            p90_abs_dod: 20,
        };
        const decision = chm.decideRoute(metrics, 2.0, 0);
        expect(decision.decision).toBe(RoutingDecision.QUARANTINE);
        expect(decision.reason).toBe('ENTROPY_GATE');
    });

    it('detects RATIO_DROP anomaly and switches to QUARANTINE', () => {
        // Train baseline first
        for (let i = 0; i < 5; i++) {
            chm.update(RoutingDecision.CORE, { unique_ratio: 0.5 } as any, 100, 50, 0, i, 1); // Ratio 2.0
        }

        const metrics: BlockMetrics = { unique_ratio: 0.5 } as any;
        const badRatio = 0.5; // Very low

        const decision = chm.decideRoute(metrics, badRatio, 10);
        expect(decision.decision).toBe(RoutingDecision.QUARANTINE);
        expect(decision.reason).toBe('RATIO_DROP');

        const update = chm.update(decision.decision, metrics, 100, 200, 0, 10, 1);
        expect(chm.getState()).toBe(CHMState.QUARANTINE_ACTIVE);
        expect(update.isAnomaly).toBe(true);
        expect(update.flags & BLOCK_FLAGS.ANOMALY_START).toBeTruthy();
    });

    it('detects ENTROPY_BURST', () => {
        // Train baseline
        for (let i = 0; i < 5; i++) {
            chm.update(RoutingDecision.CORE, { unique_ratio: 0.2 } as any, 100, 50, 0, i, 1);
        }

        // Burst: High entropy (0.8) + Low Ratio (1.0 < 2.0)
        const metrics: BlockMetrics = {
            unique_ratio: 0.8,
            unique_delta_ratio: 0.5,
            zero_ratio: 0,
            mean_abs_delta: 5,
            p90_abs_delta: 10,
            sign_flip_rate: 0.4,
            monotonicity_score: 0.5,
            outlier_score: 0.1,
            unique_dod_ratio: 0.5,
            dod_zero_ratio: 0.5,
            mean_abs_dod: 5,
            p90_abs_dod: 10,
        };
        const decision = chm.decideRoute(metrics, 1.8, 10);

        expect(decision.decision).toBe(RoutingDecision.QUARANTINE);
        expect(decision.reason).toBe('ENTROPY_BURST');
    });

    it('recovers from QUARANTINE after M_RECOVERY_BLOCKS successes', () => {
        // Force quarantine
        chm.update(RoutingDecision.QUARANTINE, { unique_ratio: 0.5 } as any, 100, 200, 0, 0, 1);
        expect(chm.getState()).toBe(CHMState.QUARANTINE_ACTIVE);

        // Good ratio (recovery)
        const goodRatio = 2.0;
        const metrics = { unique_ratio: 0.5 } as any;

        // Block 1: Probe success
        // Probe interval default is 4. Index 0 was anomaly. Next probe at 4? 
        // Constructor defaults probeInterval=4. 
        // We need to hit blockIndex % 4 === 0.

        // Let's manually step
        // Anomaly at 0.
        // 1: No probe
        // 2: No probe
        // 3: No probe
        // 4: Probe -> Success 1

        const decision4 = chm.decideRoute(metrics, goodRatio, 4);
        expect(decision4.decision).toBe(RoutingDecision.QUARANTINE); // Pending
        chm.update(RoutingDecision.QUARANTINE, metrics, 100, 50, 0, 4, 1);

        // 8: Probe -> Success 2
        const decision8 = chm.decideRoute(metrics, goodRatio, 8);
        expect(decision8.decision).toBe(RoutingDecision.QUARANTINE); // Pending
        chm.update(RoutingDecision.QUARANTINE, metrics, 100, 50, 0, 8, 1);

        // 12: Probe -> Success 3 (TARGET REACHED, M_RECOVERY_BLOCKS=3)
        // Note: Logic says if recoveryCounter+1 >= M... return CORE.
        // We have 2 successes recorded. This detect call is the 3rd.
        const decision12 = chm.decideRoute(metrics, goodRatio, 12);
        expect(decision12.decision).toBe(RoutingDecision.CORE);
        expect(decision12.reason).toBe('RECOVERY_MATCH');

        // Update with CORE to transition state
        const update12 = chm.update(RoutingDecision.CORE, metrics, 100, 50, 0, 12, 1);
        expect(chm.getState()).toBe(CHMState.NORMAL);
        expect(update12.flags & BLOCK_FLAGS.ANOMALY_END).toBeTruthy();
    });
});
