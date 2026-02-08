/**
 * HeatClassifier Unit Tests
 * 
 * Tests for Market Heatmap (GICS v1.1)
 */
import { HeatClassifier, HeatConfig } from '../src/HeatClassifier.js';
import type { Snapshot, HeatScoreResult } from '../src/gics-types.js';

describe('HeatClassifier', () => {
    // =========================================================================
    // Volatility Tests
    // =========================================================================
    describe('Volatility Component', () => {
        it('should return 0 volatility for constant prices', () => {
            const classifier = new HeatClassifier();
            const result = classifier.calculateItemHeat(1, [100, 100, 100, 100], [10, 10, 10, 10]);

            expect(result.components.volatility).toBe(0);
        });

        it('should return high volatility for wildly varying prices', () => {
            const classifier = new HeatClassifier();
            // Price swings from 50 to 150 (100% variation around mean of 100)
            const result = classifier.calculateItemHeat(1, [50, 150, 50, 150], [10, 10, 10, 10]);

            expect(result.components.volatility).toBeGreaterThan(0.8);
        });

        it('should return moderate volatility for typical price changes', () => {
            const classifier = new HeatClassifier();
            // 10% price variations
            const result = classifier.calculateItemHeat(1, [100, 110, 95, 105], [10, 10, 10, 10]);

            expect(result.components.volatility).toBeGreaterThan(0.1);
            expect(result.components.volatility).toBeLessThan(0.5);
        });
    });

    // =========================================================================
    // Demand Tests
    // =========================================================================
    describe('Demand Component', () => {
        it('should return neutral demand (0.5) for constant quantities', () => {
            const classifier = new HeatClassifier();
            const result = classifier.calculateItemHeat(1, [100, 100, 100, 100], [10, 10, 10, 10]);

            // Constant quantities should give neutral demand
            expect(result.components.demand).toBeCloseTo(0.5, 1);
        });

        it('should return high demand for rising quantities', () => {
            const classifier = new HeatClassifier();
            // Quantities increasing steadily
            const result = classifier.calculateItemHeat(1, [100, 100, 100, 100], [10, 20, 30, 40]);

            expect(result.components.demand).toBeGreaterThan(0.7);
        });

        it('should return low demand for falling quantities', () => {
            const classifier = new HeatClassifier();
            // Quantities decreasing steadily
            const result = classifier.calculateItemHeat(1, [100, 100, 100, 100], [40, 30, 20, 10]);

            expect(result.components.demand).toBeLessThan(0.3);
        });
    });

    // =========================================================================
    // Change Frequency Tests
    // =========================================================================
    describe('Change Frequency Component', () => {
        it('should return 0 for constant prices', () => {
            const classifier = new HeatClassifier();
            const result = classifier.calculateItemHeat(1, [100, 100, 100, 100], [10, 10, 10, 10]);

            expect(result.components.changeFrequency).toBe(0);
        });

        it('should return 1 for prices that change every snapshot', () => {
            const classifier = new HeatClassifier();
            // Every price is different from previous
            const result = classifier.calculateItemHeat(1, [100, 101, 102, 103], [10, 10, 10, 10]);

            expect(result.components.changeFrequency).toBe(1);
        });

        it('should return 0.5 for prices that change half the time', () => {
            const classifier = new HeatClassifier();
            // Changes: 100->101 (yes), 101->101 (no), 101->102 (yes), 102->102 (no)
            const result = classifier.calculateItemHeat(1, [100, 101, 101, 102, 102], [10, 10, 10, 10, 10]);

            expect(result.components.changeFrequency).toBe(0.5);
        });
    });

    // =========================================================================
    // Weight Application Tests
    // =========================================================================
    describe('Weight Application', () => {
        it('should apply default weights (0.4 + 0.4 + 0.2 = 1.0)', () => {
            const classifier = new HeatClassifier();
            // All components at 1.0 should give heatScore of 1.0
            const result = classifier.calculateItemHeat(1, [50, 150, 50, 150], [10, 20, 30, 40]);

            expect(result.heatScore).toBeLessThanOrEqual(1);
            expect(result.heatScore).toBeGreaterThan(0);
        });

        it('should allow custom weights', () => {
            const config: HeatConfig = {
                volatilityWeight: 1.0,
                demandWeight: 0,
                frequencyWeight: 0
            };
            const classifier = new HeatClassifier(config);

            // Only volatility should contribute
            const result = classifier.calculateItemHeat(1, [50, 150, 50, 150], [10, 10, 10, 10]);

            expect(result.heatScore).toBeCloseTo(result.components.volatility, 2);
        });
    });

    // =========================================================================
    // Block Analysis Tests
    // =========================================================================
    describe('Block Analysis', () => {
        it('should analyze all items in a block', () => {
            const classifier = new HeatClassifier();
            const snapshots: Snapshot[] = [
                { timestamp: 1000, items: new Map([[1, { price: 100, quantity: 10 }], [2, { price: 200, quantity: 20 }]]) },
                { timestamp: 2000, items: new Map([[1, { price: 110, quantity: 15 }], [2, { price: 200, quantity: 20 }]]) },
                { timestamp: 3000, items: new Map([[1, { price: 105, quantity: 12 }], [2, { price: 200, quantity: 20 }]]) },
            ];

            const results = classifier.analyzeBlock(snapshots);

            expect(results.size).toBe(2);
            expect(results.has(1)).toBe(true);
            expect(results.has(2)).toBe(true);

            // Item 1 should have higher heat (more volatile)
            const heat1 = results.get(1)!.heatScore;
            const heat2 = results.get(2)!.heatScore;
            expect(heat1).toBeGreaterThan(heat2);
        });

        it('should handle empty snapshots', () => {
            const classifier = new HeatClassifier();
            const results = classifier.analyzeBlock([]);

            expect(results.size).toBe(0);
        });
    });

    // =========================================================================
    // Edge Cases
    // =========================================================================
    describe('Edge Cases', () => {
        it('should handle single-price data', () => {
            const classifier = new HeatClassifier();
            const result = classifier.calculateItemHeat(1, [100], [10]);

            // Single price: volatility=0, demand=0.5 (neutral), changeFreq=0
            // heatScore = 0*0.4 + 0.5*0.4 + 0*0.2 = 0.2
            expect(result.heatScore).toBe(0.2);
        });

        it('should handle zero prices', () => {
            const classifier = new HeatClassifier();
            const result = classifier.calculateItemHeat(1, [0, 0, 0], [10, 10, 10]);

            expect(result.components.volatility).toBe(0);
        });

        it('should handle zero quantities', () => {
            const classifier = new HeatClassifier();
            const result = classifier.calculateItemHeat(1, [100, 100, 100], [0, 0, 0]);

            // Should not crash, demand should be neutral
            expect(result.components.demand).toBe(0.5);
        });

        it('should clamp heatScore between 0 and 1', () => {
            const classifier = new HeatClassifier();
            // Even with extreme inputs, score should be clamped
            const result = classifier.calculateItemHeat(1, [1, 10000, 1, 10000], [1, 1000, 1, 1000]);

            expect(result.heatScore).toBeLessThanOrEqual(1);
            expect(result.heatScore).toBeGreaterThanOrEqual(0);
        });
    });

    // =========================================================================
    // Block Average Tests
    // =========================================================================
    describe('Block Average Heat', () => {
        it('should calculate average heat for block', () => {
            const classifier = new HeatClassifier();
            const heatScores = new Map<number, HeatScoreResult>([
                [1, { itemId: 1, heatScore: 0.8, components: { volatility: 0.9, demand: 0.7, changeFrequency: 0.8 } }],
                [2, { itemId: 2, heatScore: 0.2, components: { volatility: 0.1, demand: 0.5, changeFrequency: 0.0 } }],
            ]);

            const avg = classifier.getBlockAverageHeat(heatScores);

            expect(avg).toBe(0.5); // (0.8 + 0.2) / 2
        });

        it('should return 0 for empty block', () => {
            const classifier = new HeatClassifier();
            const avg = classifier.getBlockAverageHeat(new Map());

            expect(avg).toBe(0);
        });
    });
});
