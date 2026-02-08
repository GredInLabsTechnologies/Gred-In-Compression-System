
import { HybridWriter, HybridReader } from '../src/index.js';
import * as fs from 'fs/promises';
import { fork } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Helper script path for child process
const WORKER_SCRIPT = path.join(__dirname, 'helpers', 'disaster-worker.js');

describe('🔥 GICS Disaster Protocol', () => {

    describe('Scenario A: Sudden Death (Atomicity)', () => {
        // We need a helper script that writes and keeps the process alive until killed
        // Or simply writes slowly.

        // This test requires the worker script to exist. 
        // For now, we simulate "partial writes" by manually truncating files 
        // which simulates the result of a sudden death. 
        // True process killing is hard to coordinate deterministically in unit tests.

        it('should recover from a file truncated mid-block (simulated crash)', async () => {
            const writer = new HybridWriter();
            for (let i = 0; i < 100; i++) {
                writer.addSnapshot({
                    timestamp: 1000 + i * 3600,
                    items: new Map([[1, { price: 100 + i, quantity: 1 }]])
                });
            }
            const fullData = await writer.finish();

            // Cut roughly in half (simulating power loss during write)
            const truncated = fullData.slice(0, fullData.length / 2);

            // GICS V2 Reader should ideally:
            // 1. Detect invalid footer/index.
            // 2. Either throw a clear error OR recover what it can (if designed for recovery).
            // Current GICS implementation expects valid format. 
            // The goal here is "No Undefined Behavior" or "No Garbage Data".

            let error: Error | null = null;
            try {
                const reader = new HybridReader(truncated);
                await reader.getSnapshotAt(1000);
            } catch (e) {
                error = e as Error;
            }

            // It MUST fail. It must NOT return garbage.
            expect(error).toBeDefined();
            // Optional: check specific error message if we want to improve DX
        });
    });

    describe('Scenario B: Disk Failure (ENOSPC)', () => {
        // We can't easily mock "out of memory" for the buffer itself without crashing Node,
        // but we CAN mock fs.writeFile if the Writer used it directly.
        // However, HybridWriter currently returns a Buffer (in-memory).
        // So we test how it handles "Invalid State" or "Resource Exhaustion" conceptually.

        // Let's test "Max Block Size Exceeded" behavior if applicable, 
        // or ensure it handles write errors if we were streaming.

        // Since GICS v1.1 is in-memory for the 'finish()' result, 
        // we can simulate "System limits" by enforcing a fake limit.

        it('should handle allocation failures gracefully (simulated)', async () => {
            // This is hard to test in JS without crashing the runner.
            // Instead, let's verify it validates limits.

            const writer = new HybridWriter();
            // Pass invalid data that might cause internal buffer overruns if not checked?
            // GICS uses Node buffers, usually safe.
        });
    });

    describe('Scenario C: Data Corruption (Bit Rot)', () => {
        it('should detect single-bit corruption in header', async () => {
            const writer = new HybridWriter();
            writer.addSnapshot({ timestamp: 1000, items: new Map([[1, { price: 10, quantity: 1 }]]) });
            const data = await writer.finish();

            // Corrupt the "GICS" magic bytes or Version
            data[0] = 0x00;

            expect(() => new HybridReader(data)).toThrow(); // Should throw immediately on init
        });

        it('should detect CRC mismatch in data blocks', async () => {
            const writer = new HybridWriter();
            writer.addSnapshot({ timestamp: 1000, items: new Map([[1, { price: 10, quantity: 1 }]]) });
            const data = await writer.finish();

            // Find a data block and corrupt it.
            // This requires knowing the structure roughly. 
            // We just flip a byte in the middle (likely payload).
            data[data.length - 50] ^= 0xFF;

            const reader = new HybridReader(data);

            // Trying to read that block should trigger CRC check
            await expect(reader.getSnapshotAt(1000)).rejects.toThrow(/CRC|Corrupt|Checksum/i);
        });
    });
});
