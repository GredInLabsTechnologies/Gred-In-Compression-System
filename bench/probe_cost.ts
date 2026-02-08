import { GICSv2Encoder } from '../src/gics/encode.js';

// Benchmark Probe Overhead
// Compare:
// Case A: Stable Stream (No Probes)
// Case B: Stream forcing Probes (Quarantine)
// 
// To allow measuring JUST the probe cost, we need to artificially trigger probes often.
// We can use the deterministic "Chaos" pattern from edge test but keep it in quarantine.

async function runBench() {
    console.log("Measuring Probe Overhead...");

    const N_ITEMS = 50000;
    const items = [];
    for (let i = 0; i < N_ITEMS; i++) {
        // Stable items to establish baseline
        items.push({ timestamp: 1000 + i * 10, value: 100 });
    }

    // Warmup
    {
        const enc = new GICSv2Encoder();
        for (const item of items.slice(0, 1000)) await enc.addSnapshot({ timestamp: item.timestamp, items: new Map([[1, { price: item.value, quantity: 1 }]]) });
        await enc.flush();
    }

    // Run A: Stable (Baseline) -> Should use Standard Codec, No Probes, occasional CHM update.
    const startA = performance.now();
    const encA = new GICSv2Encoder();
    for (const item of items) {
        await encA.addSnapshot({ timestamp: item.timestamp, items: new Map([[1, { price: item.value, quantity: 1 }]]) });
    }
    await encA.flush();
    await encA.finalize();
    const endA = performance.now();
    const timeA = endA - startA;
    console.log(`Stable Time: ${timeA.toFixed(2)}ms`);

    // Run B: Constant Probing (Worst Case)
    // We simulate this by creating a scenario where we are in Quarantine but data is "Just Good Enough" to trigger probe but "Not Good Enough" to recover?
    // Or just "Bad" data that stays in Quarantine -> Probes every 4 blocks.
    // If we are in Quarantine, every 4th block triggers a Probe.
    // Let's force Quarantine by injecting anomaly at start, then data that fails recovery.
    // Data: Random noise.

    const badItems = [];
    for (let i = 0; i < N_ITEMS; i++) {
        badItems.push({ timestamp: 1000 + i * 10, value: Math.random() * 100000 });
    }

    const startB = performance.now();
    const encB = new GICSv2Encoder();
    // Inject initial anomaly to force Quarantine?
    // Actually, random noise will likely trigger anomaly quickly and stay there.
    for (const item of badItems) {
        await encB.addSnapshot({ timestamp: item.timestamp, items: new Map([[1, { price: item.value, quantity: 1 }]]) });
    }
    await encB.flush();
    await encB.finalize();
    const endB = performance.now();
    const timeB = endB - startB;

    // Note: Bad data might be SLOWER to encode due to varint size?
    // But GICS v1.2 uses SAFE codec in Quarantine which is basically raw varints.
    // Standard codec (Dict) might be slower or faster depending on match rate.
    // Stable data (Run A) uses Dict (Fast for stable).
    // So comparison is tricky.
    // But we want to know if PROBING adds massive overhead.
    // Probe runs Standard Encode in background.
    // So if in Quarantine, we do SAFE encode (Main) + STANDARD encode (Probe) every 4 blocks.
    // So cost should be roughly 1.25x Cost of Encoding?

    console.log(`Quarantine (Probing) Time: ${timeB.toFixed(2)}ms`);
    console.log(`Ratio B/A: ${(timeB / timeA).toFixed(2)}x`);

    // Assert logic (soft)
    const telB = encB.getTelemetry();
    const probes = telB.blocks.filter((b: any) => b.stream_id === 20 && (b.flags & 16)).length; // HEALTH_QUAR
    // Approx check if we actually probed.
    console.log(`Quarantine Blocks: ${probes}`);
}

runBench();
