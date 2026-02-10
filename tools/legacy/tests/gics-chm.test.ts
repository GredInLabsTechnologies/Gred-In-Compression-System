// ... (imports remain)
import assert from 'node:assert';

import { GICSv2Encoder } from '../src/gics/encode.js';
import { getBlocksWithFlags, BlockFlagInfo } from './helpers/test-utils.js';

// Helper to generate a stream that shifts regime
function generateRegimeShiftData(blocksStable: number, blocksChaos: number, blocksRecovery: number) {
    const data: number[] = [];
    let timestamp = 1000;

    // 1. Stable Regime (Linear)
    for (let i = 0; i < blocksStable * 1000; i++) {
        data.push(timestamp);
        timestamp += 100; // Delta = 100
    }

    // 2. Chaos Regime (Random jumps)
    for (let i = 0; i < blocksChaos * 1000; i++) {
        data.push(timestamp);
        timestamp += Math.floor(Math.random() * 4950) + 50;
    }

    // 3. Recovery Regime (Linear again)
    for (let i = 0; i < blocksRecovery * 1000; i++) {
        data.push(timestamp);
        timestamp += 100;
    }

    return data;
}

describe('GICS v1.2 CHM Regime Shift Verification', () => {

    it('Should detect ANOMALY_START and ANOMALY_END correcty (with Latency due to Probes)', async () => {
        GICSv2Encoder.reset();
        const enc = new GICSv2Encoder();

        const STABLE_BLOCKS = 50;
        const CHAOS_BLOCKS = 5;
        // Recovery needs more blocks now due to Probe Interval (4) * M (3) = 12 blocks min latency
        const RECOVERY_BLOCKS_DATA = 20;

        const rawTimes = generateRegimeShiftData(STABLE_BLOCKS, CHAOS_BLOCKS, RECOVERY_BLOCKS_DATA);
        const snapshots = rawTimes.map(t => ({ timestamp: t, items: new Map() }));

        for (const s of snapshots) {
            await enc.addSnapshot(s);
        }

        const data = await enc.finish();

        const blocksWithFlags = getBlocksWithFlags(data, 10); // Time Stream
        const foundStart = blocksWithFlags.find((b: BlockFlagInfo) => (b.flags & 1) !== 0)?.index ?? -1;
        const foundEnd = blocksWithFlags.find((b: BlockFlagInfo) => (b.flags & 4) !== 0)?.index ?? -1;


        // Assertions
        // Start: Chaos at 51. Should detect at 51 or 52.
        assert.ok(foundStart >= 50 && foundStart <= 52, `ANOMALY_START should be around block 51, found ${foundStart}`);

        // Recovery:
        // Chaos ends at 55.
        // Recovery data starts at 56.
        // Probes happen every 4 blocks.
        // We need 3 consecutive successful probes.
        // Probe indices: 56, 60, 64 (assuming 56 is first good one).
        // If 56 is good -> count=1.
        // If 60 is good -> count=2.
        // If 64 is good -> count=3 -> RECOVERY at 64.
        // So END should be around 64.
        assert.ok(foundEnd >= 60 && foundEnd <= 68, `ANOMALY_END should be around block 64 (Probe Latency), found ${foundEnd}`);
    });
});



