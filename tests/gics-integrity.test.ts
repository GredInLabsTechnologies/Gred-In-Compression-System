/**
 * IntegrityGuardian Unit Tests
 * 
 * Tests for infrastructure-grade file integrity (GICS v1.1)
 */
import { IntegrityGuardian } from '../src/IntegrityGuardian.js';
import { HybridWriter } from '../src/gics-hybrid.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

describe('IntegrityGuardian', () => {
    let tempDir: string;

    beforeAll(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gics-integrity-'));
    });

    afterAll(async () => {
        await fs.rm(tempDir, { recursive: true, force: true });
    });

    // =========================================================================
    // Buffer Hashing
    // =========================================================================
    describe('Buffer Hashing', () => {
        it('should return consistent hash for same data', () => {
            const guardian = new IntegrityGuardian();
            const data = Buffer.from('Hello GICS!');

            const hash1 = guardian.hashBuffer(data);
            const hash2 = guardian.hashBuffer(data);

            expect(hash1).toBe(hash2);
            expect(hash1).toHaveLength(64); // SHA-256 = 64 hex chars
        });

        it('should return different hash for different data', () => {
            const guardian = new IntegrityGuardian();

            const hash1 = guardian.hashBuffer(Buffer.from('Data A'));
            const hash2 = guardian.hashBuffer(Buffer.from('Data B'));

            expect(hash1).not.toBe(hash2);
        });

        it('should support SHA-512', () => {
            const guardian = new IntegrityGuardian({ algorithm: 'sha512' });
            const hash = guardian.hashBuffer(Buffer.from('Test'));

            expect(hash).toHaveLength(128); // SHA-512 = 128 hex chars
        });
    });

    // =========================================================================
    // Buffer Verification
    // =========================================================================
    describe('Buffer Verification', () => {
        it('should verify correct hash', () => {
            const guardian = new IntegrityGuardian();
            const data = Buffer.from('Verify me');
            const hash = guardian.hashBuffer(data);

            expect(guardian.verifyBuffer(data, hash)).toBe(true);
        });

        it('should reject incorrect hash', () => {
            const guardian = new IntegrityGuardian();
            const data = Buffer.from('Verify me');
            const wrongHash = 'a'.repeat(64);

            expect(guardian.verifyBuffer(data, wrongHash)).toBe(false);
        });

        it('should detect single byte corruption', () => {
            const guardian = new IntegrityGuardian();
            const data = Buffer.from('Original data');
            const hash = guardian.hashBuffer(data);

            // Corrupt one byte
            const corrupted = Buffer.from(data);
            corrupted[0] = corrupted[0] ^ 0xFF;

            expect(guardian.verifyBuffer(corrupted, hash)).toBe(false);
        });
    });

    // =========================================================================
    // File Hashing
    // =========================================================================
    describe('File Hashing', () => {
        it('should hash GICS file correctly', async () => {
            const guardian = new IntegrityGuardian();

            // Create a test GICS file
            const writer = new HybridWriter();
            writer.addSnapshot({
                timestamp: 1000,
                items: new Map([[1, { price: 100, quantity: 10 }]])
            });
            const data = await writer.finish();

            const filePath = path.join(tempDir, 'test.gics');
            await fs.writeFile(filePath, data);

            const record = await guardian.hashFile(filePath);

            expect(record.path).toBe(filePath);
            expect(record.size).toBe(data.length);
            expect(record.hash).toHaveLength(64);
            expect(record.algorithm).toBe('sha256');
        });
    });

    // =========================================================================
    // Manifest Creation & Verification
    // =========================================================================
    describe('Manifest Operations', () => {
        it('should create and verify manifest', async () => {
            const guardian = new IntegrityGuardian({ saveManifest: false });

            // Create test files
            const writer1 = new HybridWriter();
            writer1.addSnapshot({ timestamp: 1000, items: new Map([[1, { price: 100, quantity: 10 }]]) });
            await fs.writeFile(path.join(tempDir, 'file1.gics'), await writer1.finish());

            const writer2 = new HybridWriter();
            writer2.addSnapshot({ timestamp: 2000, items: new Map([[2, { price: 200, quantity: 20 }]]) });
            await fs.writeFile(path.join(tempDir, 'file2.gics'), await writer2.finish());

            // Create manifest
            const manifest = await guardian.createManifest(tempDir);

            expect(Object.keys(manifest.files)).toContain('file1.gics');
            expect(Object.keys(manifest.files)).toContain('file2.gics');

            // Verify
            const result = await guardian.verifyManifest(manifest, tempDir);

            expect(result.valid).toBe(true);
            expect(result.passed).toContain('file1.gics');
            expect(result.passed).toContain('file2.gics');
            expect(result.failed).toHaveLength(0);
        });

        it('should detect corrupted file', async () => {
            const guardian = new IntegrityGuardian({ saveManifest: false });

            // Create file
            const writer = new HybridWriter();
            writer.addSnapshot({ timestamp: 1000, items: new Map([[1, { price: 100, quantity: 10 }]]) });
            const filePath = path.join(tempDir, 'corrupt_test.gics');
            await fs.writeFile(filePath, await writer.finish());

            // Create manifest
            const manifest = await guardian.createManifest(tempDir);

            // Corrupt the file
            const corrupted = Buffer.alloc(100);
            corrupted.fill(0xFF);
            await fs.writeFile(filePath, corrupted);

            // Verify should fail
            const result = await guardian.verifyManifest(manifest, tempDir);

            expect(result.failed.some(f => f.path === 'corrupt_test.gics')).toBe(true);
        });

        it('should detect missing file', async () => {
            const guardian = new IntegrityGuardian({ saveManifest: false });

            // Create file
            const writer = new HybridWriter();
            writer.addSnapshot({ timestamp: 1000, items: new Map([[1, { price: 100, quantity: 10 }]]) });
            const filePath = path.join(tempDir, 'missing_test.gics');
            await fs.writeFile(filePath, await writer.finish());

            // Create manifest
            const manifest = await guardian.createManifest(tempDir);

            // Delete the file
            await fs.unlink(filePath);

            // Verify should fail
            const result = await guardian.verifyManifest(manifest, tempDir);

            expect(result.failed.some(f => f.path === 'missing_test.gics')).toBe(true);
            expect(result.failed.find(f => f.path === 'missing_test.gics')?.reason).toContain('File read error');
        });
    });

    // =========================================================================
    // Integration with HybridWriter
    // =========================================================================
    describe('Integration', () => {
        it('should verify GICS file integrity end-to-end', async () => {
            const guardian = new IntegrityGuardian();
            const writer = new HybridWriter();

            // Create multi-snapshot data
            for (let i = 0; i < 10; i++) {
                writer.addSnapshot({
                    timestamp: 1000 + i * 3600,
                    items: new Map([
                        [1, { price: 100 + i, quantity: 10 }],
                        [2, { price: 200 - i, quantity: 20 }],
                    ])
                });
            }

            const data = await writer.finish();
            const hash = guardian.hashBuffer(data);

            // Simulate save/load cycle
            const filePath = path.join(tempDir, 'integration.gics');
            await fs.writeFile(filePath, data);

            // Verify file
            expect(await guardian.verifyFile(filePath, hash)).toBe(true);

            // Verify loaded data matches
            const loaded = await fs.readFile(filePath);
            expect(guardian.verifyBuffer(loaded, hash)).toBe(true);
        });
    });
});
