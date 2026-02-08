
export enum Regime {
    ORDERED = 'ORDERED', // Low entropy, highly predictable
    MIXED = 'MIXED',     // Moderate entropy
    CHAOTIC = 'CHAOTIC'  // High entropy, random
}

export interface BlockMetrics {
    unique_ratio: number;
    zero_ratio: number;
    mean_abs_delta: number;
    p90_abs_delta: number;
    sign_flip_rate: number;
    monotonicity_score: number;
    outlier_score: number;
    // Split-5.2 Delta-Aware Metrics
    unique_delta_ratio: number;
    unique_dod_ratio: number;
    dod_zero_ratio: number;
    mean_abs_dod: number;
    p90_abs_dod: number;
}

/**
 * Deterministic Metric Calculation
 * @param values Raw values (integers)
 */
export function calculateBlockMetrics(values: number[]): BlockMetrics {
    if (values.length === 0) {
        return {
            unique_ratio: 0,
            zero_ratio: 0,
            mean_abs_delta: 0,
            p90_abs_delta: 0,
            sign_flip_rate: 0,
            monotonicity_score: 1,
            outlier_score: 0,
            unique_delta_ratio: 0,
            unique_dod_ratio: 0,
            dod_zero_ratio: 1,
            mean_abs_dod: 0,
            p90_abs_dod: 0
        };
    }

    const set = new Set(values);
    const unique_ratio = set.size / values.length;

    let zeroCount = 0;
    for (const v of values) {
        if (v === 0) zeroCount++;
    }
    const zero_ratio = zeroCount / values.length;

    // --- Compute Deltas ---
    const deltas: number[] = [];
    let sumAbsDelta = 0;
    let signFlips = 0;
    let increasingCount = 0;
    let decreasingCount = 0;

    for (let i = 1; i < values.length; i++) {
        const d = values[i] - values[i - 1];
        deltas.push(d);
        sumAbsDelta += Math.abs(d);

        if (i > 1) {
            const prevD = deltas[deltas.length - 2];
            if ((d > 0 && prevD < 0) || (d < 0 && prevD > 0)) {
                signFlips++;
            }
        }
        if (d >= 0) increasingCount++;
        if (d <= 0) decreasingCount++;
    }

    // --- Compute Delta-of-Deltas (DoD) ---
    const dods: number[] = [];
    let sumAbsDod = 0;
    let zeroDodCount = 0;

    if (deltas.length > 0) {
        // First DoD is usually 0 or delta[0] depending on init? 
        // Standard def: dod[i] = delta[i] - delta[i-1].
        // We start from i=1 of deltas.
        for (let i = 1; i < deltas.length; i++) {
            const dd = deltas[i] - deltas[i - 1];
            dods.push(dd);
            sumAbsDod += Math.abs(dd);
            if (dd === 0) zeroDodCount++;
        }
    }

    // --- Metrics ---

    // Delta Metrics
    const mean_abs_delta = deltas.length > 0 ? sumAbsDelta / deltas.length : 0;
    const sign_flip_rate = deltas.length > 1 ? signFlips / (deltas.length - 1) : 0;
    const monotonicity_score = deltas.length > 0
        ? Math.max(increasingCount, decreasingCount) / deltas.length
        : 1;

    // Unique Ratio for Deltas
    const deltaSet = new Set(deltas);
    const unique_delta_ratio = deltas.length > 0 ? deltaSet.size / deltas.length : 0;

    // DoD Metrics
    const mean_abs_dod = dods.length > 0 ? sumAbsDod / dods.length : 0;
    const dod_zero_ratio = dods.length > 0 ? zeroDodCount / dods.length : 0;

    const dodSet = new Set(dods);
    const unique_dod_ratio = dods.length > 0 ? dodSet.size / dods.length : 0;

    // P90 Stats (Sorted)
    const sortedAbsDeltas = deltas.map(Math.abs).sort((a, b) => a - b);
    const p90ChunkDelta = Math.floor(sortedAbsDeltas.length * 0.9);
    const p90_abs_delta = sortedAbsDeltas.length > 0 ? sortedAbsDeltas[p90ChunkDelta] : 0;

    const sortedAbsDods = dods.map(Math.abs).sort((a, b) => a - b);
    const p90ChunkDod = Math.floor(sortedAbsDods.length * 0.9);
    const p90_abs_dod = sortedAbsDods.length > 0 ? sortedAbsDods[p90ChunkDod] : 0;

    // Outlier Score (using mean_abs_delta as scale)
    let outliers = 0;
    const threshold = mean_abs_delta * 5;
    if (threshold > 0) {
        for (const ad of sortedAbsDeltas) {
            if (ad > threshold) outliers++;
        }
    }
    const outlier_score = deltas.length > 0 ? outliers / deltas.length : 0;

    return {
        unique_ratio,
        zero_ratio,
        mean_abs_delta,
        p90_abs_delta,
        sign_flip_rate,
        monotonicity_score,
        outlier_score,
        unique_delta_ratio,
        unique_dod_ratio,
        dod_zero_ratio,
        mean_abs_dod,
        p90_abs_dod
    };
}

/**
 * Classify Regime
 */
export function classifyRegime(metrics: BlockMetrics): Regime {
    // Deterministic Rules

    // 1. ORDERED
    // High monotonicity OR very low unique ratio (constants) OR very low mean delta
    if (metrics.monotonicity_score > 0.9 || metrics.unique_ratio < 0.05) {
        return Regime.ORDERED;
    }

    // 2. CHAOTIC
    // High sign flips AND high entropy (unique ratio)
    if (metrics.sign_flip_rate > 0.4 && metrics.unique_ratio > 0.8) {
        return Regime.CHAOTIC;
    }

    // High Outliers -> Chaotic handling usually
    if (metrics.outlier_score > 0.1) {
        return Regime.CHAOTIC;
    }

    // 3. MIXED (Default)
    return Regime.MIXED;
}
