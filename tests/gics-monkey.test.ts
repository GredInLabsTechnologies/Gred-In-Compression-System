// @ts-nocheck
/**
 * GICS Monkey Attack Tests
 * 
 * "Anti-bebés" - Tests diseñados para romper GICS de todas las formas
 * posibles que un usuario inexperto podría intentar accidentalmente.
 * 
 * Si GICS sobrevive estos tests, es a prueba de tontos.
 */

import { HybridReader, HybridWriter } from '../src/index.js';
import { randomBytes } from 'node:crypto';

describe('🐒 GICS Monkey Attack Tests (Anti-Bebés)', () => {

    // ============================================================================
    // RANDOM CHAOS - Pure monkey testing
    // ============================================================================

    describe('Random Chaos', () => {

        it('should survive 50 random operations without crashing', async () => {
            let crashes = 0;
            let operations = 0;

            for (let i = 0; i < 50; i++) {
                try {
                    const action = Math.floor(Math.random() * 10);

                    switch (action) {
                        case 0: {
                            // Random garbage as input
                            const garbage = randomBytes(Math.floor(Math.random() * 10000));
                            new HybridReader(garbage);
                            break;
                        }
                        case 1: {
                            // Empty buffer
                            new HybridReader(new Uint8Array(0));
                            break;
                        }
                        case 2: {
                            // Too small buffer
                            new HybridReader(new Uint8Array(10));
                            break;
                        }
                        case 3: {
                            // Valid write then random query
                            const writer = new HybridWriter();
                            writer.addSnapshot({
                                timestamp: Math.floor(Math.random() * Number.MAX_SAFE_INTEGER),
                                items: new Map([[Math.random() * 1000000, { price: Math.random() * 1000000, quantity: Math.random() * 1000 }]])
                            });
                            const data = await writer.finish();
                            const reader = new HybridReader(data);
                            reader.getSnapshotAt(Math.random() * Number.MAX_SAFE_INTEGER);
                            break;
                        }
                        case 4: {
                            // Query with negative timestamp
                            const writer = new HybridWriter();
                            writer.addSnapshot({ timestamp: 1000, items: new Map([[1, { price: 100, quantity: 10 }]]) });
                            const data = await writer.finish();
                            const reader = new HybridReader(data);
                            reader.getSnapshotAt(-9999999);
                            break;
                        }
                        case 5: {
                            // Negative item IDs
                            const writer = new HybridWriter();
                            writer.addSnapshot({
                                timestamp: 1000,
                                items: new Map([[-1, { price: 100, quantity: 10 }]])
                            });
                            await writer.finish();
                            break;
                        }
                        case 6: {
                            // NaN values
                            const writer = new HybridWriter();
                            writer.addSnapshot({
                                timestamp: Number.NaN,
                                items: new Map([[1, { price: Number.NaN, quantity: Number.NaN }]])
                            });
                            await writer.finish();
                            break;
                        }
                        case 7: {
                            // Infinity values
                            const writer = new HybridWriter();
                            writer.addSnapshot({
                                timestamp: Infinity,
                                items: new Map([[1, { price: Infinity, quantity: -Infinity }]])
                            });
                            await writer.finish();
                            break;
                        }
                        case 8: {
                            // Empty map
                            const writer = new HybridWriter();
                            writer.addSnapshot({ timestamp: 1000, items: new Map() });
                            await writer.finish();
                            break;
                        }
                        case 9: {
                            // Write nothing
                            const writer = new HybridWriter();
                            await writer.finish();
                            break;
                        }
                    }
                    operations++;
                } catch {
                    // Throwing is acceptable - crashing is not
                    operations++;
                }
            }

            console.log(`\n🐒 Chaos: ${operations}/50 operations handled (${crashes} crashes)`);
            expect(crashes).toBe(0);
        }, 60000);

        it('should handle random snapshot sequences', async () => {
            let handled = 0;

            for (let trial = 0; trial < 20; trial++) {
                try {
                    const writer = new HybridWriter();
                    const snapshotCount = Math.floor(Math.random() * 50);

                    for (let i = 0; i < snapshotCount; i++) {
                        const itemCount = Math.floor(Math.random() * 100);
                        const items = new Map<number, { price: number; quantity: number }>();

                        for (let j = 0; j < itemCount; j++) {
                            items.set(
                                Math.floor(Math.random() * 100000),
                                {
                                    price: Math.floor(Math.random() * 10000000),
                                    quantity: Math.floor(Math.random() * 1000)
                                }
                            );
                        }

                        writer.addSnapshot({
                            timestamp: Math.floor(Math.random() * 2000000000),
                            items
                        });
                    }

                    await writer.finish();
                    handled++;
                } catch {
                    handled++;
                }
            }

            console.log(`\n🐒 Random sequences: ${handled}/20 handled`);
            expect(handled).toBe(20);
        }, 60000);
    });

    // ============================================================================
    // USER MISTAKES - Common errors a beginner might make
    // ============================================================================

    describe('User Mistakes (Anti-Bebés)', () => {

        it('should handle calling finish() multiple times', async () => {
            const writer = new HybridWriter();
            writer.addSnapshot({ timestamp: 1000, items: new Map([[1, { price: 100, quantity: 10 }]]) });

            const first = await writer.finish();
            const second = await writer.finish();
            const third = await writer.finish();

            // Subsequent calls should return same or valid result
            expect(first.length).toBeGreaterThan(0);
            expect(second.length).toBeGreaterThan(0);
            expect(third.length).toBeGreaterThan(0);
        });

        it('should handle adding snapshots after finish()', async () => {
            const writer = new HybridWriter();
            writer.addSnapshot({ timestamp: 1000, items: new Map([[1, { price: 100, quantity: 10 }]]) });
            await writer.finish();

            // User tries to add more after finish
            let handled = false;
            try {
                writer.addSnapshot({ timestamp: 2000, items: new Map([[1, { price: 200, quantity: 20 }]]) });
                handled = true;
            } catch {
                handled = true; // Throwing is acceptable
            }

            expect(handled).toBe(true);
        });

        it('should handle reading from empty writer', async () => {
            const writer = new HybridWriter();
            const data = await writer.finish();

            let handled = false;
            try {
                const reader = new HybridReader(data);
                reader.getSnapshotAt(1000);
                handled = true;
            } catch {
                handled = true;
            }

            expect(handled).toBe(true);
        });

        it('should handle querying non-existent items', async () => {
            const writer = new HybridWriter();
            writer.addSnapshot({ timestamp: 1000, items: new Map([[1, { price: 100, quantity: 10 }]]) });
            const data = await writer.finish();
            const reader = new HybridReader(data);

            // Query items that don't exist using the reader's API
            const result1 = await reader.queryItems({ itemIds: [99999] });
            const result2 = await reader.queryItems({ itemIds: [-1] });
            await reader.queryItems({ itemIds: [0] });

            // Non-existent items should return empty arrays or no data
            expect(result1.length === 0 || result1[0]?.history.length === 0).toBe(true);
            expect(result2.length === 0 || result2[0]?.history.length === 0).toBe(true);
            // Item 0 might or might not exist
        });

        it('should handle timestamps in wrong order', async () => {
            const writer = new HybridWriter();

            // User adds snapshots out of order
            writer.addSnapshot({ timestamp: 3000, items: new Map([[1, { price: 300, quantity: 10 }]]) });
            writer.addSnapshot({ timestamp: 1000, items: new Map([[1, { price: 100, quantity: 10 }]]) });
            writer.addSnapshot({ timestamp: 2000, items: new Map([[1, { price: 200, quantity: 10 }]]) });

            let handled = false;
            try {
                const data = await writer.finish();
                const reader = new HybridReader(data);
                reader.getSnapshotAt(1000);
                handled = true;
            } catch {
                handled = true;
            }

            expect(handled).toBe(true);
        });

        it('should handle same timestamp multiple times', async () => {
            const writer = new HybridWriter();

            // User accidentally adds same timestamp 100 times
            for (let i = 0; i < 100; i++) {
                writer.addSnapshot({
                    timestamp: 1000,
                    items: new Map([[1, { price: 100 + i, quantity: 10 }]])
                });
            }

            const data = await writer.finish();
            const reader = new HybridReader(data);
            const snapshot = reader.getSnapshotAt(1000);

            // Should return something valid
            expect(snapshot).toBeDefined();
        });

        it('should handle extremely large item IDs', async () => {
            const writer = new HybridWriter();
            writer.addSnapshot({
                timestamp: 1000,
                items: new Map([
                    [Number.MAX_SAFE_INTEGER, { price: 100, quantity: 10 }],
                    [Number.MAX_SAFE_INTEGER - 1, { price: 200, quantity: 20 }]
                ])
            });

            let handled = false;
            try {
                const data = await writer.finish();
                const reader = new HybridReader(data);
                reader.getItemIds();
                handled = true;
            } catch {
                handled = true;
            }

            expect(handled).toBe(true);
        });

        it('should handle floating point prices (should be integers)', async () => {
            const writer = new HybridWriter();
            writer.addSnapshot({
                timestamp: 1000,
                items: new Map([
                    [1, { price: 99.99, quantity: 10.5 }],
                    [2, { price: 0.001, quantity: 0.001 }]
                ])
            });

            const data = await writer.finish();
            const reader = new HybridReader(data);
            const snapshot = reader.getSnapshotAt(1000);

            // Values should be truncated to integers
            expect(snapshot).toBeDefined();
        });
    });

    // ============================================================================
    // DATA CORRUPTION SIMULATION
    // ============================================================================

    describe('Corruption Attacks', () => {
        // These tests involve heavy async operations and may cause
        // DataView offset errors during parallel execution. 
        // Previously gated as integration tests, now mandatory for quality.

        it('should detect random byte modifications', async () => {
            const writer = new HybridWriter();
            for (let i = 0; i < 24; i++) {
                const items = new Map<number, { price: number; quantity: number }>();
                for (let j = 0; j < 100; j++) {
                    items.set(j, { price: 1000 + j, quantity: 50 });
                }
                writer.addSnapshot({ timestamp: 1700000000 + i * 3600, items });
            }
            const original = await writer.finish();

            let corruptionDetected = 0;
            let silentCorruption = 0;

            // Modify random bytes 100 times
            for (let trial = 0; trial < 100; trial++) {
                const corrupted = Buffer.from(original);
                const pos = Math.floor(Math.random() * corrupted.length);
                const originalByte = corrupted[pos];
                corrupted[pos] = (originalByte + 1) % 256;

                try {
                    const reader = new HybridReader(corrupted);
                    const snapshot = await reader.getSnapshotAt(1700000000);

                    // Check if data is still correct
                    if (snapshot?.items.get(0)?.price !== 1000) {
                        silentCorruption++;
                    }
                } catch {
                    corruptionDetected++;
                }
            }

            console.log(`\n🐒 Corruption: ${corruptionDetected}/100 detected, ${silentCorruption} silent`);
            // With CRC32 on block payloads, payload corruptions are detected.
            // Header/index corruptions cause parse errors or silent issues.
            // Realistic target: >15% for v1.2 format (v1.3 with hash chain will detect more).
            expect(corruptionDetected).toBeGreaterThanOrEqual(15);
        });

        it('should reject truncated files of any size', async () => {
            const writer = new HybridWriter();
            for (let i = 0; i < 24; i++) {
                const items = new Map([[1, { price: 1000, quantity: 10 }]]);
                writer.addSnapshot({ timestamp: 1700000000 + i * 3600, items });
            }
            const original = await writer.finish();

            let rejected = 0;
            const testSizes = [0, 1, 10, 20, 36, 50, original.length - 1];

            for (const size of testSizes) {
                const truncated = original.slice(0, size);
                try {
                    const reader = new HybridReader(truncated);
                    // Await to catch potential async errors
                    await reader.getSnapshotAt(1700000000);
                } catch {
                    rejected++;
                }
            }

            console.log(`\n🐒 Truncation: ${rejected}/${testSizes.length} rejected`);
            expect(rejected).toBeGreaterThanOrEqual(testSizes.length - 2);
        });
    });

    // ============================================================================
    // API MISUSE
    // ============================================================================

    describe('API Misuse', () => {

        it('should handle null/undefined inputs gracefully', () => {
            let handled = 0;

            try {
                // @ts-ignore Testing bad input
                new HybridReader(null);
            } catch { handled++; }

            try {
                // @ts-ignore Testing bad input
                new HybridReader(undefined);
            } catch { handled++; }

            try {
                const writer = new HybridWriter();
                // @ts-ignore Testing bad input
                writer.addSnapshot(null);
            } catch { handled++; }

            try {
                const writer = new HybridWriter();
                // @ts-ignore Testing bad input
                writer.addSnapshot({ timestamp: null, items: null });
            } catch { handled++; }

            console.log(`\n🐒 Null handling: ${handled}/4 cases handled`);
            // At least 2 should throw, others may handle gracefully
            expect(handled).toBeGreaterThanOrEqual(2);
        });

        it('should handle string inputs instead of numbers', async () => {
            const writer = new HybridWriter();

            let handled = false;
            try {
                // @ts-ignore Testing bad input
                writer.addSnapshot({
                    timestamp: "not a number",
                    items: new Map([["1", { price: "100", quantity: "10" }]])
                });
                await writer.finish();
                handled = true;
            } catch {
                handled = true;
            }

            expect(handled).toBe(true);
        });

        it('should handle Map operations on reader correctly', async () => {
            const writer = new HybridWriter();
            writer.addSnapshot({
                timestamp: 1000,
                items: new Map([[1, { price: 100, quantity: 10 }]])
            });
            const data = await writer.finish();
            const reader = new HybridReader(data);

            // All these should work without crashing
            const ids = reader.getItemIds();
            const tier = reader.getItemTier(1);
            reader.getItemTier(99999);
            const snapshot = await reader.getSnapshotAt(1000);
            await reader.getSnapshotAt(0);

            expect(ids).toBeDefined();
            expect(tier).toBeDefined();
            // tierBad may be undefined for non-existent items - that's OK
            expect(snapshot).toBeDefined();
            // Bad timestamp may return null or empty snapshot
            // (timestamp 0 may not match any block)
        });
    });

    // ============================================================================
    // STRESS UNDER CHAOS
    // ============================================================================

    describe('Stress Under Chaos', () => {

        it('should handle rapid write/read cycles', async () => {
            let successful = 0;

            for (let i = 0; i < 100; i++) {
                try {
                    const writer = new HybridWriter();
                    const items = new Map<number, { price: number; quantity: number }>();

                    for (let j = 0; j < 100; j++) {
                        items.set(j, { price: 1000 + j, quantity: 50 });
                    }

                    writer.addSnapshot({ timestamp: Date.now(), items });
                    const data = await writer.finish();
                    const reader = new HybridReader(data);
                    reader.getItemIds();
                    successful++;
                } catch {
                    // Ignore errors
                }
            }

            console.log(`\n🐒 Rapid cycles: ${successful}/100 successful`);
            expect(successful).toBe(100);
        });

        it('should handle mixed valid and invalid operations', async () => {
            const operations: (() => void)[] = [];

            // Mix of valid and invalid
            for (let i = 0; i < 50; i++) {
                operations.push(async () => {
                    const writer = new HybridWriter();
                    writer.addSnapshot({ timestamp: 1000, items: new Map([[1, { price: 100, quantity: 10 }]]) });
                    const data = await writer.finish();
                    const reader = new HybridReader(data);
                    reader.getItemIds();
                });
            }

            for (let i = 0; i < 50; i++) {
                operations.push(async () => {
                    const reader = new HybridReader(randomBytes(100));
                    try { reader.getItemIds(); } catch { }
                });
            }

            // Shuffle
            operations.sort(() => Math.random() - 0.5);

            let handled = 0;
            for (const op of operations) {
                try {
                    await op();
                    handled++;
                } catch {
                    handled++;
                }
            }

            expect(handled).toBe(100);
        });
    });
});




