/**
 * CompressionProfiler — Pluggable module that discovers optimal encoder parameters.
 *
 * This module wraps the GICS encoder and benchmarks it across a matrix of
 * compressionLevel × blockSize combinations. It returns a reproducible
 * ProfileResult with the recommended configuration.
 *
 * The core encoder does NOT depend on this module. It's purely additive.
 */

import { GICSv2Encoder } from './encode.js';
import type { GICSv2EncoderOptions } from './types.js';
import type { CompressionPreset } from './types.js';
import { COMPRESSION_PRESETS } from './types.js';
import type { Snapshot, GenericSnapshot } from '../gics-types.js';
import { createHash } from 'node:crypto';

export type ProfileMode = 'quick' | 'deep';

export interface ProfileResult {
    /** Recommended zstd compression level */
    compressionLevel: number;
    /** Recommended block size (items per block) */
    blockSize: number;
    /** Closest matching preset, if any */
    preset: CompressionPreset | null;
    /** Best compression ratio achieved */
    bestRatio: number;
    /** Encode time in ms for the best configuration */
    bestEncodeMs: number;
    /** All trial results for inspection */
    trials: TrialResult[];
    /** Metadata for reproducibility and persistence */
    meta: ProfileMeta;
}

export interface TrialResult {
    compressionLevel: number;
    blockSize: number;
    ratio: number;
    encodeMs: number;
    outputBytes: number;
    inputBytes: number;
}

export interface ProfileMeta {
    /** SHA-256 of first N snapshot timestamps (sample fingerprint) */
    sampleHash: string;
    /** Number of snapshots profiled */
    sampleSize: number;
    /** Encoder version used */
    encoderVersion: string;
    /** ISO 8601 timestamp */
    date: string;
    /** Profile mode used */
    mode: ProfileMode;
}

const ENCODER_VERSION = '1.3.2';

const QUICK_LEVELS = [1, 3, 6];
const QUICK_BLOCK_SIZES = [1000, 4000];

const DEEP_LEVELS = [1, 3, 6, 9, 12, 15];
const DEEP_BLOCK_SIZES = [512, 1000, 2000, 4000, 8000];

export class CompressionProfiler {
    /**
     * Profile a sample of snapshots to find optimal encoder parameters.
     *
     * @param sample - Array of snapshots to profile (recommended: 1000-5000)
     * @param mode - 'quick' (fewer combinations) or 'deep' (exhaustive)
     * @param baseOptions - Base encoder options (contextMode, schema, etc.)
     * @returns ProfileResult with recommended configuration
     */
    static async profile(
        sample: Array<Snapshot | GenericSnapshot<Record<string, number | string>>>,
        mode: ProfileMode = 'quick',
        baseOptions: Omit<GICSv2EncoderOptions, 'compressionLevel' | 'blockSize' | 'preset'> = {}
    ): Promise<ProfileResult> {
        if (sample.length === 0) {
            throw new Error('CompressionProfiler: sample must not be empty');
        }

        const levels = mode === 'quick' ? QUICK_LEVELS : DEEP_LEVELS;
        const blockSizes = mode === 'quick' ? QUICK_BLOCK_SIZES : DEEP_BLOCK_SIZES;

        const sampleHash = CompressionProfiler.computeSampleHash(sample);
        const inputBytes = CompressionProfiler.estimateInputSize(sample);

        const trials: TrialResult[] = [];

        for (const level of levels) {
            for (const bs of blockSizes) {
                const opts: GICSv2EncoderOptions = {
                    ...baseOptions,
                    compressionLevel: level,
                    blockSize: bs,
                    runId: `profile_L${level}_B${bs}`,
                    sidecarWriter: null,
                    logger: null,
                };

                const t0 = performance.now();
                const encoder = new GICSv2Encoder(opts);
                for (const s of sample) await encoder.addSnapshot(s);
                const output = await encoder.finish();
                const encodeMs = performance.now() - t0;

                trials.push({
                    compressionLevel: level,
                    blockSize: bs,
                    ratio: inputBytes / (output.length || 1),
                    encodeMs,
                    outputBytes: output.length,
                    inputBytes,
                });
            }
        }

        // Select best: highest ratio, with tie-break on lower encodeMs
        const sorted = [...trials].sort((a, b) => {
            if (Math.abs(a.ratio - b.ratio) > 0.01) return b.ratio - a.ratio;
            return a.encodeMs - b.encodeMs;
        });
        const best = sorted[0];

        // Match to closest preset
        const preset = CompressionProfiler.matchPreset(best.compressionLevel, best.blockSize);

        return {
            compressionLevel: best.compressionLevel,
            blockSize: best.blockSize,
            preset,
            bestRatio: best.ratio,
            bestEncodeMs: best.encodeMs,
            trials,
            meta: {
                sampleHash,
                sampleSize: sample.length,
                encoderVersion: ENCODER_VERSION,
                date: new Date().toISOString(),
                mode,
            },
        };
    }

    /**
     * Compute a fingerprint of the sample data for reproducibility tracking.
     */
    private static computeSampleHash(sample: Array<Snapshot | GenericSnapshot<Record<string, number | string>>>): string {
        const hash = createHash('sha256');
        const maxSamples = Math.min(sample.length, 200);
        for (let i = 0; i < maxSamples; i++) {
            hash.update(String(sample[i].timestamp));
            hash.update(String(sample[i].items.size));
        }
        return hash.digest('hex').slice(0, 16);
    }

    /**
     * Estimate raw input size in bytes (8 bytes per value).
     */
    private static estimateInputSize(sample: Array<Snapshot | GenericSnapshot<Record<string, number | string>>>): number {
        let count = 0;
        for (const s of sample) {
            count += 1; // timestamp
            count += s.items.size * 3; // ~3 fields per item (id, price/value, quantity/count)
        }
        return count * 8;
    }

    /**
     * Find the closest matching preset for a given level + blockSize.
     */
    private static matchPreset(level: number, blockSize: number): CompressionPreset | null {
        for (const [name, cfg] of Object.entries(COMPRESSION_PRESETS)) {
            if (cfg.compressionLevel === level && cfg.blockSize === blockSize) {
                return name as CompressionPreset;
            }
        }
        return null;
    }
}
