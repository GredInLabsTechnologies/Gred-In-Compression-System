
import { Codecs } from '../src/gics/codecs.js';

// --- BASELINE IMPLEMENTATION (Copy of original) ---
class CodecsBaseline {
    static encodeBitPack(values: number[]): Uint8Array {
        if (values.length === 0) return new Uint8Array(0);

        // 1. ZigZag encode to handle negative values and make them positive.
        const unsigned = values.map(v => (v >= 0 ? v * 2 : (Math.abs(v) * 2) - 1));

        // Find max
        let max = 0;
        for (const u of unsigned) {
            if (u > max) max = u;
        }

        // Determine bit width (support up to 53 bits for JS safe integers)
        let bits = 0;
        let tempMax = max;
        while (tempMax > 0) {
            tempMax = Math.floor(tempMax / 2);
            bits++;
        }
        if (max === 0) bits = 1;

        const dataBytes = Math.ceil((unsigned.length * bits) / 8);
        const result = new Uint8Array(1 + dataBytes);
        result[0] = bits;

        let bitPos = 0;
        for (const val of unsigned) {
            let currentVal = val;
            for (let b = 0; b < bits; b++) {
                const bit = currentVal % 2;
                if (bit) {
                    const totalBit = bitPos + b;
                    const byteIdx = 1 + Math.floor(totalBit / 8);
                    const bitIdx = totalBit % 8;
                    result[byteIdx] |= (1 << bitIdx);
                }
                currentVal = Math.floor(currentVal / 2);
            }
            bitPos += bits;
        }

        return result;
    }
}

// --- BENCHMARK ---
function runBench() {
    const N = 50000;
    const iterations = 50;
    const values: number[] = [];

    // Generate random values: mixed small (32-bit safe) and larger (53-bit safe)
    for(let i=0; i<N; i++) {
        const rand = Math.random();
        if (rand < 0.7) {
            // Small values (fit in ~7-10 bits)
            values.push(Math.floor(Math.random() * 1024));
        } else if (rand < 0.9) {
            // Medium values (fit in 32 bits)
            values.push(Math.floor(Math.random() * 0xFFFFFFFF));
        } else {
            // Large values (up to 53 bits)
            values.push(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER));
        }
    }

    console.log(`Benchmark: ${N} items, ${iterations} iterations.`);
    console.log(`Data distribution: 70% small, 20% 32-bit, 10% 53-bit.`);

    // Warmup
    for(let i=0; i<10; i++) {
        CodecsBaseline.encodeBitPack(values);
        Codecs.encodeBitPack(values);
    }

    // Measure Baseline
    const startBase = performance.now();
    for(let i=0; i<iterations; i++) {
        CodecsBaseline.encodeBitPack(values);
    }
    const endBase = performance.now();
    const timeBase = endBase - startBase;

    // Measure Current/Optimized
    const startOpt = performance.now();
    for(let i=0; i<iterations; i++) {
        Codecs.encodeBitPack(values);
    }
    const endOpt = performance.now();
    const timeOpt = endOpt - startOpt;

    console.log(`\nResults:`);
    console.log(`Baseline:  ${timeBase.toFixed(2)}ms (avg: ${(timeBase/iterations).toFixed(2)}ms)`);
    console.log(`Optimized: ${timeOpt.toFixed(2)}ms (avg: ${(timeOpt/iterations).toFixed(2)}ms)`);
    console.log(`Speedup:   ${(timeBase / timeOpt).toFixed(2)}x`);

    if (timeOpt > timeBase * 1.1) {
        console.warn('WARNING: Optimized version is slower!');
    }
}

runBench();
