import { GICSv2Encoder } from '../src/gics/encode.js';
import { BLOCK_FLAGS } from '../src/gics/format.js';


describe('GICS v1.2 CHM Edge Cases', () => {

    it('should handle single-block anomaly (noise) correctly', async () => {
        // Scenario: Stable -> 1 Crazy Block (Trigger) -> Stable (Recovery immediately?)
        // Normal: Trigger = Baseline - 3*Dev. Recovery = Baseline - 1*Dev.
        // If next block is stable, it should recover... after M blocks?
        // Wait, M=3. So we need 3 GOOD probes to recover.
        // If we have 1 bad block, we enter Quarantine.
        // We stay in Quarantine for at least 3*ProbeInterval? 
        // No. Probes happen every interval.
        // If we enter Quarantine at Block X. 
        // Next Probe is at Ceil(X/4)*4? No, condition is `index % 4 == 0`.
        // If we are lucky and X is just before probe, we probe soon.
        // But we need 3 consecutive successes.
        // So minimum quarantine is 3 * 4 = 12 blocks (roughly).
        // This test verifies that a SINGLE blip causes a quarantine that lasts for M*Interval blocks.

        const timestampStart = 1000;
        const snapshots = [];

        // 1. Stable (20 blocks - 20,000 items)
        for (let i = 0; i < 200000; i += 10) {
            snapshots.push({ timestamp: timestampStart + i, value: 100 });
        }

        // 2. NOISE (1 Block - 1000 items)
        // Insert massive entropy/randomness
        for (let i = 0; i < 1000; i++) {
            snapshots.push({ timestamp: timestampStart + 20000 + i * 10, value: Math.random() * 100000 });
        }

        // 3. Stable Again (100 blocks)
        for (let i = 0; i < 100000; i += 10) {
            snapshots.push({ timestamp: timestampStart + 30000 + i * 10, value: 100 });
        }

        GICSv2Encoder.reset();
        const encoder = new GICSv2Encoder();
        for (const s of snapshots) {
            await encoder.addSnapshot({
                timestamp: s.timestamp,
                items: new Map([[1, { price: Math.floor(s.value), quantity: 1 }]])
            });
        }

        const output = await encoder.flush();
        const telemetry = encoder.getTelemetry();

        // Analyze Blocks
        // Analyze Blocks
        const blocks = telemetry.blocks.filter((b: any) => b.stream_id === 20); // Value Stream



        // Find Anomaly Start
        const startIdx = blocks.findIndex((b: any) => (b.flags & BLOCK_FLAGS.ANOMALY_START));
        assert.notEqual(startIdx, -1, 'Should trigger ANOMALY_START');

        console.log(`Anomaly Start at Block ${blocks[startIdx].regime} (Index ${startIdx})`);

        // Verify Quarantine Length
        // We expect it to confirm recovery after 3 probes. 
        // Probe at index % 4 == 0.
        // Let's count how many blocks have HEALTH_QUAR.

        let quarCount = 0;
        for (let i = startIdx; i < blocks.length; i++) {
            if (blocks[i].flags & BLOCK_FLAGS.HEALTH_QUAR) {
                quarCount++;
            }
            if (blocks[i].flags & BLOCK_FLAGS.ANOMALY_END) {
                break;
            }
        }

        console.log(`Quarantine Length: ${quarCount} blocks`);

        // Min blocks for 3 probes (Interval 4) is roughly 8-12.
        assert.ok(quarCount >= 8, 'Quarantine should last at least until 3 probes pass (approx 8-12 blocks)');

        // Verify Baseline didn't explode
        // We can't easily check internal CHM state, but we know future blocks are Normal.
        // If baseline broke, we'd see more anomalies.
        const subsequentAnomalies = blocks.slice(startIdx + quarCount + 5).filter((b: any) => b.flags & BLOCK_FLAGS.ANOMALY_START);
        assert.strictEqual(subsequentAnomalies.length, 0, 'Should not re-trigger anomaly after recovery');
    });

});
