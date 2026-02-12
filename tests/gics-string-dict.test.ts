/**
 * String Dictionary Tests
 *
 * Tests:
 * 1. Round-trip: string keys → encode → decode → same keys
 * 2. Compression: keys with common prefixes
 * 3. Empty dictionary
 * 4. Large dictionary
 * 5. SegmentIndex with string dict round-trip
 * 6. containsString() lookup
 */
// NOTE: Vitest globals are enabled (see vitest.config.ts). Avoid importing from
// 'vitest' in test files to prevent "No test suite found" issues.
import { StringDictionary } from '../src/gics/string-dict.js';
import { SegmentIndex, BloomFilter } from '../src/gics/segment.js';

describe('StringDictionary', () => {

    describe('build()', () => {
        it('builds from unique keys, sorted', () => {
            const dict = StringDictionary.build(['banana', 'apple', 'cherry']);
            expect(dict.entries).toEqual(['apple', 'banana', 'cherry']);
            expect(dict.map.get('apple')).toBe(0);
            expect(dict.map.get('banana')).toBe(1);
            expect(dict.map.get('cherry')).toBe(2);
        });

        it('deduplicates keys', () => {
            const dict = StringDictionary.build(['a', 'b', 'a', 'c', 'b']);
            expect(dict.entries).toEqual(['a', 'b', 'c']);
            expect(dict.map.size).toBe(3);
        });

        it('handles empty input', () => {
            const dict = StringDictionary.build([]);
            expect(dict.entries).toEqual([]);
            expect(dict.map.size).toBe(0);
        });
    });

    describe('encode/decode round-trip', () => {
        it('round-trips simple keys', () => {
            const dict = StringDictionary.build(['hello', 'world', 'test']);
            const encoded = StringDictionary.encode(dict);
            const decoded = StringDictionary.decode(encoded);

            expect(decoded.size).toBe(3);
            expect(decoded.get(0)).toBe('hello');
            expect(decoded.get(1)).toBe('test');
            expect(decoded.get(2)).toBe('world');
        });

        it('round-trips keys with common prefixes', () => {
            const keys = [
                'file_write|src/auth.py',
                'file_write|src/main.py',
                'file_write|src/utils.py',
                'file_read|src/auth.py',
                'file_read|src/main.py',
                'shell_exec|rm -rf /',
                'llm_call|claude-sonnet',
            ];
            const dict = StringDictionary.build(keys);
            const encoded = StringDictionary.encode(dict);
            const decoded = StringDictionary.decode(encoded);

            expect(decoded.size).toBe(keys.length);
            // Verify all keys are recoverable
            for (const key of keys) {
                const idx = dict.map.get(key)!;
                expect(decoded.get(idx)).toBe(key);
            }
        });

        it('round-trips with decodeForward', () => {
            const dict = StringDictionary.build(['x', 'y', 'z']);
            const encoded = StringDictionary.encode(dict);
            const forward = StringDictionary.decodeForward(encoded);

            expect(forward.get('x')).toBe(0);
            expect(forward.get('y')).toBe(1);
            expect(forward.get('z')).toBe(2);
        });

        it('round-trips empty dictionary', () => {
            const dict = StringDictionary.build([]);
            const encoded = StringDictionary.encode(dict);
            const decoded = StringDictionary.decode(encoded);
            expect(decoded.size).toBe(0);
        });

        it('round-trips single entry', () => {
            const dict = StringDictionary.build(['only_one']);
            const encoded = StringDictionary.encode(dict);
            const decoded = StringDictionary.decode(encoded);
            expect(decoded.size).toBe(1);
            expect(decoded.get(0)).toBe('only_one');
        });

        it('round-trips unicode strings', () => {
            const dict = StringDictionary.build(['café', 'naïve', '日本語']);
            const encoded = StringDictionary.encode(dict);
            const decoded = StringDictionary.decode(encoded);

            expect(decoded.size).toBe(3);
            const values = Array.from(decoded.values());
            expect(values).toContain('café');
            expect(values).toContain('naïve');
            expect(values).toContain('日本語');
        });

        it('should throw when decoding truncated data', () => {
            const dict = StringDictionary.build(['test']);
            const encoded = StringDictionary.encode(dict);
            const truncated = encoded.subarray(0, -1);
            expect(() => StringDictionary.decode(truncated)).toThrow();
        });
    });

    describe('compression efficiency', () => {
        it('common prefix keys compress smaller than naive', () => {
            const keys: string[] = [];
            for (let i = 0; i < 100; i++) {
                keys.push(`tool_call|file_write|src/module_${i.toString().padStart(3, '0')}.ts`);
            }
            const dict = StringDictionary.build(keys);
            const encoded = StringDictionary.encode(dict);
            const naiveSize = keys.join('').length + keys.length * 4; // rough naive estimate

            // Encoded should be reasonably compact
            expect(encoded.length).toBeLessThan(naiveSize);
        });
    });

    describe('large dictionary', () => {
        it('handles 1000 entries', () => {
            const keys: string[] = [];
            for (let i = 0; i < 1000; i++) {
                keys.push(`dimension_${i}_tool|context|model|task`);
            }
            const dict = StringDictionary.build(keys);
            const encoded = StringDictionary.encode(dict);
            const decoded = StringDictionary.decode(encoded);
            expect(decoded.size).toBe(1000);

            // Spot check
            const idx0 = dict.map.get(dict.entries[0])!;
            expect(decoded.get(idx0)).toBe(dict.entries[0]);
            const idx999 = dict.map.get(dict.entries[999])!;
            expect(decoded.get(idx999)).toBe(dict.entries[999]);
        });
    });
});

describe('SegmentIndex with StringDictionary', () => {

    it('round-trips SegmentIndex WITHOUT string dict (backward compat)', () => {
        const bf = new BloomFilter();
        bf.add(1); bf.add(2); bf.add(3);
        const original = new SegmentIndex(bf, [1, 2, 3]);

        const serialized = original.serialize();
        const restored = SegmentIndex.deserialize(serialized);

        expect(restored.sortedItemIds).toEqual([1, 2, 3]);
        expect(restored.contains(1)).toBe(true);
        expect(restored.contains(2)).toBe(true);
        expect(restored.contains(999)).toBe(false);
        expect(restored.stringDict).toBeUndefined();
    });

    it('round-trips SegmentIndex WITH string dict', () => {
        const bf = new BloomFilter();
        const keys = ['file_write|auth.py', 'shell_exec|rm', 'llm_call|sonnet'];
        const dict = StringDictionary.build(keys);

        // Map string keys to numeric IDs
        for (const [, idx] of dict.map) bf.add(idx);
        const sortedIds = Array.from(dict.map.values()).sort((a, b) => a - b);

        const original = new SegmentIndex(bf, sortedIds, dict);
        const serialized = original.serialize();
        const restored = SegmentIndex.deserialize(serialized);

        expect(restored.sortedItemIds).toEqual(sortedIds);
        expect(restored.stringDict).toBeDefined();
        expect(restored.stringDict!.entries).toEqual(dict.entries);
        expect(restored.stringDict!.map.size).toBe(3);
    });

    it('containsString() works via string dict lookup', () => {
        const bf = new BloomFilter();
        const keys = ['dim_a', 'dim_b', 'dim_c'];
        const dict = StringDictionary.build(keys);
        for (const [, idx] of dict.map) bf.add(idx);
        const sortedIds = Array.from(dict.map.values()).sort((a, b) => a - b);

        const index = new SegmentIndex(bf, sortedIds, dict);

        expect(index.containsString('dim_a')).toBe(true);
        expect(index.containsString('dim_b')).toBe(true);
        expect(index.containsString('dim_c')).toBe(true);
        expect(index.containsString('dim_z')).toBe(false);
    });

    it('containsString() returns false when no string dict', () => {
        const bf = new BloomFilter();
        bf.add(1);
        const index = new SegmentIndex(bf, [1]);
        expect(index.containsString('anything')).toBe(false);
    });
});
