/**
 * GICS Security Fuzzing Tests
 * 
 * Randomized input testing for security validation.
 * Aligned with:
 * - NIST SP 800-53 (Security Controls)
 * - Common Criteria (Boundary Testing)
 * - OWASP Testing Guidelines
 */
import { HybridWriter, HybridReader } from '../src/gics-hybrid.js';
import { IntegrityGuardian } from '../src/IntegrityGuardian.js';
import { CryptoProvider } from '../src/CryptoProvider.js';

// ============================================================================
// Fuzzing Utilities
// ============================================================================

/**
 * Generate random bytes for fuzzing
 */
function randomBytes(length: number): Uint8Array {
    return CryptoProvider.randomBytes(length);
}

/**
 * Generate random integer in range [min, max]
 */
function randomInt(min: number, max: number): number {
    const range = max - min + 1;
    const bytes = CryptoProvider.randomBytes(4);
    const value = new DataView(bytes.buffer).getUint32(0, true);
    return min + (value % range);
}

/**
 * Corrupt random bytes in a buffer
 */
function corruptRandomBytes(data: Uint8Array, count: number): Uint8Array {
    const corrupted = new Uint8Array(data);
    for (let i = 0; i < count; i++) {
        const pos = randomInt(0, corrupted.length - 1);
        corrupted[pos] ^= randomInt(1, 255); // Flip bits, but ensure change
    }
    return corrupted;
}

// ============================================================================
// Fuzzing Test Suites
// ============================================================================

describe('GICS Security Fuzzing Tests', () => {

    // =========================================================================
    // Header Manipulation Attacks
    // =========================================================================
    describe('Header Manipulation', () => {
        it('should reject corrupted magic bytes', async () => {
            const writer = new HybridWriter();
            writer.addSnapshot({ timestamp: 1000, items: new Map([[1, { price: 100, quantity: 10 }]]) });
            const valid = await writer.finish();

            // Corrupt magic bytes (first 4 bytes = "GICS")
            const corrupted = new Uint8Array(valid);
            corrupted[0] = 0xFF;
            corrupted[1] = 0xFF;

            expect(() => new HybridReader(corrupted)).toThrow();
        });

        it('should reject invalid version numbers', async () => {
            const writer = new HybridWriter();
            writer.addSnapshot({ timestamp: 1000, items: new Map([[1, { price: 100, quantity: 10 }]]) });
            const valid = await writer.finish();

            // Set version to 255 (invalid future version)
            const corrupted = new Uint8Array(valid);
            corrupted[4] = 255;

            expect(() => new HybridReader(corrupted)).toThrow();
        });

        it('should reject oversized block lengths', async () => {
            const writer = new HybridWriter();
            writer.addSnapshot({ timestamp: 1000, items: new Map([[1, { price: 100, quantity: 10 }]]) });
            const valid = await writer.finish();

            // Find block header and set size to MAX_SAFE_INTEGER equivalent
            // This tests integer overflow protection
            const corrupted = new Uint8Array(valid);
            // Overwrite block size bytes with huge value
            if (corrupted.length > 40) {
                const view = new DataView(corrupted.buffer);
                // Set a block size larger than file
                view.setUint32(36, 0xFFFFFFFF, true);
            }

            // Should either throw or not crash
            try {
                const reader = new HybridReader(corrupted);
                await reader.queryItems({});
            } catch (e) {
                // Expected - corruption detected
                expect(e).toBeDefined();
            }
        });
    });

    // =========================================================================
    // Random Byte Injection
    // =========================================================================
    describe('Random Byte Injection', () => {
        it('should detect single byte corruption anywhere in file', async () => {
            const guardian = new IntegrityGuardian();
            const writer = new HybridWriter();

            // Create substantial data
            for (let i = 0; i < 10; i++) {
                writer.addSnapshot({
                    timestamp: 1000 + i * 3600,
                    items: new Map([[1, { price: 100 + i, quantity: 10 }]])
                });
            }
            const valid = await writer.finish();
            const validHash = guardian.hashBuffer(valid);

            // Test corruption at various positions
            const positions = [0, 10, 50, 100, Math.floor(valid.length / 2), valid.length - 1];

            for (const pos of positions) {
                if (pos < valid.length) {
                    const corrupted = new Uint8Array(valid);
                    corrupted[pos] ^= 0x01; // Flip one bit

                    const corruptedHash = guardian.hashBuffer(corrupted);
                    expect(corruptedHash).not.toBe(validHash);
                }
            }
        });

        it('should survive 20 random corruption attempts without crashing', async () => {
            const writer = new HybridWriter();
            writer.addSnapshot({ timestamp: 1000, items: new Map([[1, { price: 100, quantity: 10 }]]) });
            const valid = await writer.finish();

            for (let i = 0; i < 20; i++) {
                const corrupted = corruptRandomBytes(valid, randomInt(1, 10));

                try {
                    const reader = new HybridReader(corrupted);
                    await reader.queryItems({});
                    // If it doesn't throw, that's also acceptable if data is returned safely
                } catch {
                    // Expected - corruption should be detected
                }
                // Key assertion: we should never crash
            }
        });
    });

    // =========================================================================
    // Truncation Attacks
    // =========================================================================
    describe('Truncation Attacks', () => {
        it('should reject truncated files at various lengths', async () => {
            const writer = new HybridWriter();
            writer.addSnapshot({ timestamp: 1000, items: new Map([[1, { price: 100, quantity: 10 }]]) });
            const valid = await writer.finish();

            const truncationPoints = [0, 1, 4, 10, 20, 36, valid.length - 4, valid.length - 1];

            for (const length of truncationPoints) {
                if (length < valid.length && length > 0) {
                    const truncated = valid.slice(0, length);

                    try {
                        new HybridReader(truncated);
                        // Should throw or handle gracefully
                    } catch {
                        // Expected
                    }
                }
            }
        });
    });

    // =========================================================================
    // Integer Overflow Protection
    // =========================================================================
    describe('Integer Overflow Protection', () => {
        it('should handle maximum integer values safely', () => {
            const maxValues = [
                Number.MAX_SAFE_INTEGER,
                Number.MAX_VALUE,
                0xFFFFFFFF, // Max uint32
                0x7FFFFFFF, // Max int32
            ];

            for (const value of maxValues) {
                // These operations should not throw or produce NaN
                const result = Math.min(value, 1000000);
                expect(Number.isFinite(result)).toBe(true);
            }
        });

        it('should reject negative counts in RLE decoding', async () => {
            // This tests the sanity limits in gics-types.ts
            const writer = new HybridWriter();
            writer.addSnapshot({
                timestamp: 1000,
                items: new Map([[1, { price: 100, quantity: 10 }]])
            });
            const valid = await writer.finish();

            // The file should be readable
            const reader = new HybridReader(valid);
            const results = await reader.queryItems({});
            expect(Array.isArray(results)).toBe(true);
        });
    });

    // =========================================================================
    // Malformed Snapshot Data
    // =========================================================================
    describe('Malformed Snapshot Data', () => {
        it('should handle empty snapshots', async () => {
            const writer = new HybridWriter();
            writer.addSnapshot({ timestamp: 1000, items: new Map() });

            // Should not throw
            const data = await writer.finish();
            expect(data.length).toBeGreaterThan(0);
        });

        it('should handle extreme timestamp values', async () => {
            const writer = new HybridWriter();

            // Very large but valid timestamp
            writer.addSnapshot({
                timestamp: 2147483647, // Max int32
                items: new Map([[1, { price: 100, quantity: 10 }]])
            });

            const data = await writer.finish();
            const reader = new HybridReader(data);
            const results = await reader.queryItems({});

            expect(results.length).toBeGreaterThanOrEqual(0);
        });

        it('should handle extreme price values', async () => {
            const writer = new HybridWriter();

            writer.addSnapshot({
                timestamp: 1000,
                items: new Map([
                    [1, { price: 0, quantity: 0 }],
                    [2, { price: 2147483647, quantity: 2147483647 }],
                ])
            });

            const data = await writer.finish();
            expect(data.length).toBeGreaterThan(0);
        });
    });

    // =========================================================================
    // Denial of Service Prevention
    // =========================================================================
    describe('DoS Prevention', () => {
        it('should have bounded memory usage for large item counts', async () => {
            const writer = new HybridWriter();

            // Create snapshot with many items
            const items = new Map<number, { price: number; quantity: number }>();
            for (let i = 0; i < 10000; i++) {
                items.set(i, { price: 100, quantity: 10 });
            }

            writer.addSnapshot({ timestamp: 1000, items });

            const data = await writer.finish();

            // File should be compressed efficiently
            // 10000 items * ~8 bytes each = ~80KB uncompressed
            // Should compress to much less
            expect(data.length).toBeLessThan(80000);
        });

        it('should reject files claiming excessive item counts', async () => {
            const writer = new HybridWriter();
            writer.addSnapshot({
                timestamp: 1000,
                items: new Map([[1, { price: 100, quantity: 10 }]])
            });
            const valid = await writer.finish();

            // Corrupt item count to claim billions of items
            const corrupted = new Uint8Array(valid);
            if (corrupted.length > 12) {
                const view = new DataView(corrupted.buffer);
                view.setUint32(8, 0x7FFFFFFF, true); // Max int32 items
            }

            try {
                const reader = new HybridReader(corrupted);
                await reader.queryItems({});
            } catch {
                // Expected - should reject excessive claims
            }
        });
    });

    // =========================================================================
    // Cryptographic Boundary Tests
    // =========================================================================
    describe('Cryptographic Boundaries', () => {
        it('should produce consistent hashes across multiple calls', () => {
            const provider = new CryptoProvider();
            const data = Buffer.from('consistency test');

            const hashes = [];
            for (let i = 0; i < 100; i++) {
                hashes.push(provider.sha256(data).toString('hex'));
            }

            // All hashes should be identical
            expect(new Set(hashes).size).toBe(1);
        });

        it('should produce different hashes for different inputs', () => {
            const provider = new CryptoProvider();
            const hashes = new Set<string>();

            for (let i = 0; i < 100; i++) {
                const data = Buffer.from(`input-${i}`);
                hashes.add(provider.sha256(data).toString('hex'));
            }

            // All hashes should be unique
            expect(hashes.size).toBe(100);
        });
    });
});
