/**
 * BanditRouter Tests (Phase 11)
 *
 * Verifies:
 * - Feature flag OFF → blended score (zero disruption)
 * - Thompson Sampling converges to best arm
 * - Temporal decay works
 * - Determinism with seed
 * - A/B test: bandit outperforms random selection
 */

import { BanditRouter, type ModelArm, type TaskType } from '../src/daemon/bandit-router.js';

describe('BanditRouter (Phase 11)', () => {
    it('feature flag OFF → always returns blended score', () => {
        const bandit = new BanditRouter({ enabled: false });

        for (let i = 0; i < 100; i++) {
            const decision = bandit.selectArm('encode', ['sonnet', 'opus', 'haiku']);
            expect(decision.chosenArm).toBe('sonnet'); // Blended default
            expect(decision.sampledTheta).toBe(0.5);
        }

        // Recording outcomes should be no-op
        bandit.recordOutcome('opus', 'encode', true);
        const stats = bandit.getStats();
        expect(stats.size).toBe(0); // No arms created when disabled
    });

    it('Thompson Sampling converges to best arm', () => {
        const bandit = new BanditRouter({ enabled: true, seed: 12345 });

        // Simulate environment: opus has 80% success, sonnet 50%, haiku 20%
        const trueRewards: Record<ModelArm, number> = { opus: 0.8, sonnet: 0.5, haiku: 0.2 };

        const pulls: Record<ModelArm, number> = { opus: 0, sonnet: 0, haiku: 0 };

        for (let i = 0; i < 1000; i++) {
            const decision = bandit.selectArm('encode', ['sonnet', 'opus', 'haiku']);
            const arm = decision.chosenArm;
            pulls[arm]++;

            // Simulate reward: bernoulli trial
            const success = Math.random() < trueRewards[arm];
            bandit.recordOutcome(arm, 'encode', success);
        }

        // After 1000 trials, opus should be pulled most (it has highest true reward)
        expect(pulls.opus).toBeGreaterThan(pulls.sonnet);
        expect(pulls.opus).toBeGreaterThan(pulls.haiku);
    });

    it('temporal decay reduces old alpha/beta over time', () => {
        const bandit = new BanditRouter({ enabled: true, temporalDecay: 0.995 });

        // Record outcomes
        bandit.recordOutcome('sonnet', 'encode', true);
        bandit.recordOutcome('sonnet', 'encode', false);

        const before = bandit.getStats().get('sonnet|encode');
        expect(before).toBeDefined();
        expect(before!.alpha).toBeGreaterThan(3); // Prior + 1 success

        // Simulate 10 days passing
        const tenDaysMs = 10 * 24 * 60 * 60 * 1000;
        const futureNow = Date.now() + tenDaysMs;

        // Trigger decay by selecting arm (applyTemporalDecay is called internally)
        // Mock Date.now to simulate future
        const originalNow = Date.now;
        Date.now = () => futureNow;

        bandit.selectArm('encode', ['sonnet']);

        const after = bandit.getStats().get('sonnet|encode');
        expect(after!.alpha).toBeLessThan(before!.alpha);
        expect(after!.beta).toBeLessThan(before!.beta);

        // Restore
        Date.now = originalNow;
    });

    it('deterministic with seed', () => {
        const bandit1 = new BanditRouter({ enabled: true, seed: 42 });
        const bandit2 = new BanditRouter({ enabled: true, seed: 42 });

        const decisions1: string[] = [];
        const decisions2: string[] = [];

        for (let i = 0; i < 50; i++) {
            const d1 = bandit1.selectArm('query', ['sonnet', 'haiku']);
            const d2 = bandit2.selectArm('query', ['sonnet', 'haiku']);
            decisions1.push(d1.chosenArm);
            decisions2.push(d2.chosenArm);

            // Record same outcomes to keep them in sync
            bandit1.recordOutcome(d1.chosenArm, 'query', true);
            bandit2.recordOutcome(d2.chosenArm, 'query', true);
        }

        expect(decisions1).toEqual(decisions2);
    });

    it('A/B test: bandit outperforms random selection (1000 trials)', () => {
        // Simulate environment with skewed rewards
        const trueRewards: Record<ModelArm, number> = { opus: 0.7, sonnet: 0.5, haiku: 0.3 };

        // Strategy A: BanditRouter
        const bandit = new BanditRouter({ enabled: true, seed: 999 });
        let banditReward = 0;

        for (let i = 0; i < 1000; i++) {
            const decision = bandit.selectArm('analysis', ['opus', 'sonnet', 'haiku']);
            const success = Math.random() < trueRewards[decision.chosenArm];
            if (success) banditReward++;
            bandit.recordOutcome(decision.chosenArm, 'analysis', success);
        }

        // Strategy B: Random uniform selection
        const arms: ModelArm[] = ['opus', 'sonnet', 'haiku'];
        let randomReward = 0;

        for (let i = 0; i < 1000; i++) {
            const randomArm = arms[Math.floor(Math.random() * arms.length)];
            const success = Math.random() < trueRewards[randomArm];
            if (success) randomReward++;
        }

        // Bandit should accumulate more reward than random
        expect(banditReward).toBeGreaterThan(randomReward);
    });

    it('cold start with Beta(3,1) prior', () => {
        const bandit = new BanditRouter({ enabled: true, alphaPrior: 3, betaPrior: 1 });

        // Before any pulls, arms should start with prior
        const decision = bandit.selectArm('decode', ['opus']);
        const stats = bandit.getStats().get('opus|decode');

        expect(stats).toBeDefined();
        expect(stats!.alpha).toBe(3);
        expect(stats!.beta).toBe(1);
        expect(stats!.totalPulls).toBe(0);
    });
});
