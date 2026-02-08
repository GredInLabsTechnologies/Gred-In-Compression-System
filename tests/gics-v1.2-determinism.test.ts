import { GICSv2Encoder } from '../src/gics/encode.js';
import * as fs from 'fs';
import * as path from 'path';

describe('GICS v1.2 Determinism', () => {
    const TEST_RUN_ID = 'test_run_fixed_123';

    const createSidecarWriter = () => {
        return async ({ filename, report }: { filename: string; report: unknown }) => {
            const sidecarPath = path.join(process.cwd(), filename);
            await fs.promises.writeFile(sidecarPath, JSON.stringify(report, null, 2), 'utf-8');
        };
    };

    afterEach(() => {
        GICSv2Encoder.reset();
        // Cleanup sidecars
        const cwd = process.cwd();
        const sidecarPath = path.join(cwd, `gics-anomalies.${TEST_RUN_ID}.json`);
        if (fs.existsSync(sidecarPath)) {
            fs.unlinkSync(sidecarPath);
        }
    });

    it('should produce identical output bytes and sidecar for identical input', async () => {
        // Generate Deterministic Data (Pattern that triggers simple compression)
        // A simple sine wave + some spikes to trigger CHM?
        // Let's keep it simple first: Normal data.
        const timestamps: number[] = [];
        const values: number[] = [];
        for (let i = 0; i < 5000; i++) {
            timestamps.push(1000 + i * 10);
            values.push(Math.floor(Math.sin(i * 0.1) * 100));
        }

        // Run 1
        GICSv2Encoder.reset();
        const encoder1 = new GICSv2Encoder({
            runId: TEST_RUN_ID,
            sidecarWriter: createSidecarWriter()
        });
        for (let i = 0; i < timestamps.length; i++) {
            await encoder1.addSnapshot({
                timestamp: timestamps[i],
                items: new Map([[1, { price: values[i], quantity: 1 }]])
            });
        }
        const output1 = await encoder1.flush();
        await encoder1.finalize();

        const sidecar1Path = path.join(process.cwd(), `gics-anomalies.${TEST_RUN_ID}.json`);
        const sidecar1Content = fs.readFileSync(sidecar1Path, 'utf-8');

        // Run 2
        GICSv2Encoder.reset(); // CRITICAL: Reset shared context
        const encoder2 = new GICSv2Encoder({
            runId: TEST_RUN_ID,
            sidecarWriter: createSidecarWriter()
        });
        for (let i = 0; i < timestamps.length; i++) {
            await encoder2.addSnapshot({
                timestamp: timestamps[i],
                items: new Map([[1, { price: values[i], quantity: 1 }]])
            });
        }
        const output2 = await encoder2.flush();
        await encoder2.finalize();

        const sidecar2Path = path.join(process.cwd(), `gics-anomalies.${TEST_RUN_ID}.json`);
        const sidecar2Content = fs.readFileSync(sidecar2Path, 'utf-8');

        // Assertions
        assert.deepEqual(output1, output2, 'Output bytes must be identical');
        assert.strictEqual(sidecar1Content, sidecar2Content, 'Sidecar content must be identical');

        // Check hash of bytes (optional but good practice)
        // const hash1 = crypto.createHash('sha256').update(output1).digest('hex');
        // console.log('Hash:', hash1);
    });

    it('should be deterministic even with anomalies (triggering probes)', async () => {
        // Generate Data triggering Anomaly
        // 1. Initial stable (Train Baseline)
        // 2. Sudden chaos (Trigger Anomaly -> Quarantine -> Probes)
        // 3. Recovery
        const timestamps: number[] = [];
        const values: number[] = [];

        // 1. Stable (Block 1-10)
        for (let i = 0; i < 10000; i++) {
            timestamps.push(i * 10);
            if (i < 5000) {
                values.push(100); // Constant
            } else if (i < 8000) {
                values.push(Math.random() * 10000); // Chaos
            } else {
                values.push(100); // Back to Constant
            }
        }
        // Note: Randomness here MUST be deterministic (pseudo-random) for the TEST ITSELF to be deterministic?
        // Wait, `Math.random()` is not seeded. 
        // -> I used `Math.random()`. I must use a deterministic generator for the test data!

        const seededRandom = (seed: number) => {
            let x = Math.sin(seed++) * 10000;
            return x - Math.floor(x);
        };

        const valuesDet: number[] = [];
        for (let i = 0; i < 10000; i++) {
            if (i < 5000) {
                valuesDet.push(100);
            } else if (i < 8000) {
                valuesDet.push(Math.floor(seededRandom(i) * 10000));
            } else {
                valuesDet.push(100);
            }
        }

        const runTest = async () => {
            GICSv2Encoder.reset();
            const enc = new GICSv2Encoder({
                runId: TEST_RUN_ID,
                sidecarWriter: createSidecarWriter()
            });
            for (let i = 0; i < valuesDet.length; i++) {
                await enc.addSnapshot({
                    timestamp: i * 10,
                    items: new Map([[1, { price: valuesDet[i], quantity: 1 }]])
                });
            }
            const out = await enc.flush();
            await enc.finalize();
            const sc = fs.readFileSync(path.join(process.cwd(), `gics-anomalies.${TEST_RUN_ID}.json`), 'utf-8');
            return { out, sc };
        };

        const res1 = await runTest();
        const res2 = await runTest();

        assert.deepEqual(res1.out, res2.out, 'Anomaly outputs must strictly match');
        assert.strictEqual(res1.sc, res2.sc, 'Anomaly sidecars must strictly match');
    });
});
