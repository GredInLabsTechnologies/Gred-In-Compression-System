// Deterministic RNG for forensic dataset generation.
// Intentionally inlined and dependency-free.

export class ForensicRng {
    private state: number;

    constructor(seed: number) {
        this.state = seed % 2147483647;
        if (this.state <= 0) this.state += 2147483646;
    }

    next(): number {
        this.state = (this.state * 16807) % 2147483647;
        return (this.state - 1) / 2147483646;
    }

    nextInt(minInclusive: number, maxExclusive: number): number {
        return Math.floor(this.next() * (maxExclusive - minInclusive)) + minInclusive;
    }
}
