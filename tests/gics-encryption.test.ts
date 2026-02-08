import { Snapshot } from '../src/gics-types.js';
import { GICSv2Encoder } from '../src/gics/encode.js';
import { GICSv2Decoder } from '../src/gics/decode.js';
import { IntegrityError } from '../src/gics/errors.js';
import { describe, it, expect } from 'vitest';

describe('GICS v1.3 Encryption', () => {
    const snapshots: Snapshot[] = [
        {
            timestamp: 1625097600000,
            items: new Map([[1, { price: 100, quantity: 10 }]])
        },
        {
            timestamp: 1625097660000,
            items: new Map([[1, { price: 105, quantity: 12 }]])
        }
    ];

    it('should encode and decode with password', async () => {
        const password = 'extremely-strong-and-secure-password';
        const encoder = new GICSv2Encoder({ password });
        for (const s of snapshots) await encoder.addSnapshot(s);
        const encoded = await encoder.finish();

        const decoder = new GICSv2Decoder(encoded, { password });
        const decoded = await decoder.getAllSnapshots();

        expect(decoded.length).toBe(snapshots.length);
        expect(decoded[0].timestamp).toBe(snapshots[0].timestamp);
        expect(decoded[0].items.get(1)?.price).toBe(100);
        expect(decoded[1].timestamp).toBe(snapshots[1].timestamp);
        expect(decoded[1].items.get(1)?.price).toBe(105);
    });

    it('should fail with incorrect password', async () => {
        const password = 'right-password';
        const encoder = new GICSv2Encoder({ password });
        for (const s of snapshots) await encoder.addSnapshot(s);
        const encoded = await encoder.finish();

        const decoder = new GICSv2Decoder(encoded, { password: 'wrong-password' });
        await expect(decoder.getAllSnapshots()).rejects.toThrow('Invalid password');
    });

    it('should fail with no password for encrypted file', async () => {
        const password = 'password';
        const encoder = new GICSv2Encoder({ password });
        for (const s of snapshots) await encoder.addSnapshot(s);
        const encoded = await encoder.finish();

        const decoder = new GICSv2Decoder(encoded);
        await expect(decoder.getAllSnapshots()).rejects.toThrow('Password required');
    });

    it('should detect tampered ciphertext', async () => {
        const password = 'password';
        const encoder = new GICSv2Encoder({ password });
        for (const s of snapshots) await encoder.addSnapshot(s);
        const encoded = await encoder.finish();

        const tampered = new Uint8Array(encoded);
        // Tamper with data after header
        for (let i = 100; i < tampered.length - 40; i++) {
            tampered[i] ^= 0xFF;
        }

        const decoder = new GICSv2Decoder(tampered, { password });
        await expect(decoder.getAllSnapshots()).rejects.toThrow();
    });
});
