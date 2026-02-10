import { ForensicRng } from './rng.forensics.js';

export interface PostfreezeRow {
    t: number;
    v: number;
}

export interface PostfreezeDataset {
    name: 'Structured_TrendNoise' | 'Mixed_RegimeSwitch' | 'HighEntropy_Random';
    seed: number;
    data: PostfreezeRow[];
}

export function genStructuredTrendNoise(seed: number): PostfreezeDataset {
    const rng = new ForensicRng(seed);
    const data: PostfreezeRow[] = [];
    let current = 1000;
    for (let i = 0; i < 50_000; i++) {
        const delta = 10;
        const noise = (i % 50 === 0) ? rng.nextInt(-5, 5) : 0;
        current += (delta + noise);
        data.push({ t: i * 1000, v: current });
    }
    return { name: 'Structured_TrendNoise', seed, data };
}

export function genMixedRegimeSwitch(seed: number): PostfreezeDataset {
    const rng = new ForensicRng(seed);
    const data: PostfreezeRow[] = [];
    let currentVal = 1000;
    for (let i = 0; i < 50_000; i++) {
        const regime = Math.floor(i / 2000) % 2;
        if (regime === 0) currentVal += 10;
        else currentVal = rng.nextInt(0, 1_000_000_000);
        data.push({ t: i * 1000, v: currentVal });
    }
    return { name: 'Mixed_RegimeSwitch', seed, data };
}

export function genHighEntropyRandom(seed: number): PostfreezeDataset {
    const rng = new ForensicRng(seed);
    const data: PostfreezeRow[] = [];
    for (let i = 0; i < 50_000; i++) {
        data.push({ t: i * 1000, v: rng.nextInt(0, 2_000_000_000) });
    }
    return { name: 'HighEntropy_Random', seed, data };
}

export function getPostfreezeDatasets() {
    return [
        genStructuredTrendNoise(11111),
        genMixedRegimeSwitch(33333),
        genHighEntropyRandom(55555),
    ] as const;
}
