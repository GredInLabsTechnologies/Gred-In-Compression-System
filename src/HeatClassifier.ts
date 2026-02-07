/**
 * GICS HeatClassifier - Market Heatmap Intelligence
 * 
 * @module gics
 * @version 1.1.0
 * @status FROZEN - Canonical implementation
 * @see docs/GICS_V1.1_SPEC.md
 * 
 * Calculates continuous HeatScore for items based on market dynamics.
 * Formula: HeatScore = (Volatility × 0.4) + (Demand × 0.4) + (ChangeFrequency × 0.2)
 * 
 * @author GICS Team
 */

import type { Snapshot, HeatScoreResult } from './gics-types.js';

// ============================================================================
// Configuration
// ============================================================================

export interface HeatConfig {
    /** Weight for volatility component (default: 0.4) */
    volatilityWeight?: number;
    /** Weight for demand component (default: 0.4) */
    demandWeight?: number;
    /** Weight for change frequency component (default: 0.2) */
    frequencyWeight?: number;
}

const DEFAULT_VOLATILITY_WEIGHT = 0.4;
const DEFAULT_DEMAND_WEIGHT = 0.4;
const DEFAULT_FREQUENCY_WEIGHT = 0.2;

// ============================================================================
// HeatClassifier
// ============================================================================

export class HeatClassifier {
    private readonly volatilityWeight: number;
    private readonly demandWeight: number;
    private readonly frequencyWeight: number;

    constructor(config?: HeatConfig) {
        this.volatilityWeight = config?.volatilityWeight ?? DEFAULT_VOLATILITY_WEIGHT;
        this.demandWeight = config?.demandWeight ?? DEFAULT_DEMAND_WEIGHT;
        this.frequencyWeight = config?.frequencyWeight ?? DEFAULT_FREQUENCY_WEIGHT;

        // Validate weights sum to 1.0
        const total = this.volatilityWeight + this.demandWeight + this.frequencyWeight;
        if (Math.abs(total - 1) > 0.001) {
            console.warn(`[HeatClassifier] Weights sum to ${total}, expected 1.0`);
        }
    }

    /**
     * Calculate HeatScore for a single item given its price and quantity history
     * 
     * @param itemId The item's ID
     * @param prices Array of prices across snapshots
     * @param quantities Array of quantities across snapshots
     * @returns HeatScoreResult with score and component breakdown
     */
    calculateItemHeat(itemId: number, prices: number[], quantities: number[]): HeatScoreResult {
        if (prices.length === 0) {
            return {
                itemId,
                heatScore: 0,
                components: { volatility: 0, demand: 0, changeFrequency: 0 }
            };
        }

        const volatility = this.calculateVolatility(prices);
        const demand = this.calculateDemand(quantities);
        const changeFrequency = this.calculateChangeFrequency(prices);

        const heatScore =
            (volatility * this.volatilityWeight) +
            (demand * this.demandWeight) +
            (changeFrequency * this.frequencyWeight);

        return {
            itemId,
            heatScore: Math.min(1, Math.max(0, heatScore)), // Clamp 0-1
            components: {
                volatility,
                demand,
                changeFrequency
            }
        };
    }

    /**
     * Analyze all items in a block of snapshots
     * 
     * @param snapshots Array of snapshots to analyze
     * @returns Map of itemId → HeatScoreResult
     */
    analyzeBlock(snapshots: Snapshot[]): Map<number, HeatScoreResult> {
        const results = new Map<number, HeatScoreResult>();

        if (snapshots.length === 0) {
            return results;
        }

        const allItemIds = this.collectAllItemIds(snapshots);

        for (const itemId of allItemIds) {
            const { prices, quantities } = this.collectItemData(itemId, snapshots);
            results.set(itemId, this.calculateItemHeat(itemId, prices, quantities));
        }

        return results;
    }

    /**
     * Collect all unique item IDs from snapshots
     */
    private collectAllItemIds(snapshots: Snapshot[]): Set<number> {
        const allItemIds = new Set<number>();
        for (const snap of snapshots) {
            for (const itemId of snap.items.keys()) {
                allItemIds.add(itemId);
            }
        }
        return allItemIds;
    }

    /**
     * Collect price and quantity data for a specific item across snapshots
     */
    private collectItemData(itemId: number, snapshots: Snapshot[]): { prices: number[], quantities: number[] } {
        const prices: number[] = [];
        const quantities: number[] = [];

        for (const snap of snapshots) {
            const data = snap.items.get(itemId);
            if (data) {
                prices.push(data.price);
                quantities.push(data.quantity);
            } else {
                prices.push(prices.at(-1) ?? 0);
                quantities.push(quantities.at(-1) ?? 0);
            }
        }

        return { prices, quantities };
    }

    /**
     * Get average heat score for a block (useful for block-level classification)
     */
    getBlockAverageHeat(heatScores: Map<number, HeatScoreResult>): number {
        if (heatScores.size === 0) return 0;

        let sum = 0;
        for (const result of heatScores.values()) {
            sum += result.heatScore;
        }
        return sum / heatScores.size;
    }

    // ========================================================================
    // Private: Component Calculations
    // ========================================================================

    /**
     * Calculate price volatility using coefficient of variation (CV)
     * CV = stddev / mean, normalized to 0-1 range
     * 
     * High volatility → high score
     */
    private calculateVolatility(prices: number[]): number {
        if (prices.length < 2) return 0;

        const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
        if (mean === 0) return 0;

        const variance = prices.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / prices.length;
        const stddev = Math.sqrt(variance);
        const cv = stddev / mean;

        // Normalize: CV of 0.5 (50% variation) → score of 1.0
        // This is a reasonable max for typical price time-series
        return Math.min(1, cv * 2);
    }

    /**
     * Calculate demand trend indicator
     * Rising quantities → higher score
     * 
     * Uses linear regression slope, normalized to 0-1
     */
    private calculateDemand(quantities: number[]): number {
        if (quantities.length < 2) return 0.5; // Neutral

        // Simple linear regression for trend
        const n = quantities.length;
        let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;

        for (let i = 0; i < n; i++) {
            sumX += i;
            sumY += quantities[i];
            sumXY += i * quantities[i];
            sumX2 += i * i;
        }

        const meanY = sumY / n;
        if (meanY === 0) return 0.5;

        const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);

        // Normalize slope relative to mean quantity
        // Positive slope (rising demand) → score > 0.5
        // Negative slope (falling demand) → score < 0.5
        const normalizedSlope = slope / meanY;

        // Map to 0-1 range: -0.1 per snapshot → 0, +0.1 → 1
        return Math.min(1, Math.max(0, 0.5 + normalizedSlope * 5));
    }

    /**
     * Calculate change frequency
     * % of snapshots where price changed from previous
     */
    private calculateChangeFrequency(prices: number[]): number {
        if (prices.length < 2) return 0;

        let changes = 0;
        for (let i = 1; i < prices.length; i++) {
            if (prices[i] !== prices[i - 1]) {
                changes++;
            }
        }

        return changes / (prices.length - 1);
    }
}
