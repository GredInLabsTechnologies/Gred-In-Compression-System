import { GICS } from '../src/index.js';
import { GICSv2Decoder } from '../src/gics/decode.js';
import { GICSv2Encoder } from '../src/gics/encode.js';
import { GICS_HEADER_SIZE_V3 } from '../src/gics/format.js';

const TEST_PASSWORD = 'verify-hardening-password';
const TEST_SCHEMA = {
    id: 'verify_hardening_schema',
    version: 1,
    itemIdType: 'string' as const,
    fields: [{ name: 'value', type: 'numeric' as const, codecStrategy: 'value' as const }],
};

async function encodeLegacyFile(options: { password?: string } = {}): Promise<Uint8Array> {
    const encoder = new GICSv2Encoder(options);
    await encoder.addSnapshot({
        timestamp: 1,
        items: new Map([[1, { price: 42, quantity: 2 }]]),
    });
    return await encoder.finish();
}

async function encodeSchemaFile(options: { password?: string } = {}): Promise<Uint8Array> {
    const encoder = new GICSv2Encoder({ schema: TEST_SCHEMA, ...options });
    await encoder.addSnapshot({
        timestamp: 1,
        items: new Map([['item:1', { value: 42 }]]),
    } as any);
    return await encoder.finish();
}

function flipByte(data: Uint8Array, offset: number): Uint8Array {
    const tampered = new Uint8Array(data);
    tampered[offset] ^= 0x01;
    return tampered;
}

describe('GICS verification hardening', () => {
    it('rejects encrypted files when verify runs without the password', async () => {
        const data = await encodeLegacyFile({ password: TEST_PASSWORD });

        await expect(new GICSv2Decoder(data).verifyIntegrityOnly()).resolves.toBe(false);
    });

    it('rejects tampered authVerify bytes during verification and header parsing', async () => {
        const data = await encodeLegacyFile({ password: TEST_PASSWORD });
        const authVerifyOffset = GICS_HEADER_SIZE_V3 + 1 + 16;
        const tampered = flipByte(data, authVerifyOffset);

        await expect(new GICSv2Decoder(tampered, { password: TEST_PASSWORD }).verifyIntegrityOnly()).resolves.toBe(false);
        await expect(new GICSv2Decoder(tampered, { password: TEST_PASSWORD }).parseHeader()).rejects.toThrow(/Invalid password/);
    });

    it('rejects unsupported encrypted header metadata during verification and header parsing', async () => {
        const data = await encodeLegacyFile({ password: TEST_PASSWORD });
        const tampered = new Uint8Array(data);
        const kdfIdOffset = GICS_HEADER_SIZE_V3 + 1 + 16 + 32;
        tampered[kdfIdOffset] = 0xff;

        await expect(new GICSv2Decoder(tampered, { password: TEST_PASSWORD }).verifyIntegrityOnly()).resolves.toBe(false);
        await expect(new GICSv2Decoder(tampered, { password: TEST_PASSWORD }).parseHeader()).rejects.toThrow(/KDF/);
    });

    it('rejects tampered schema sections during verification and header parsing', async () => {
        const data = await encodeSchemaFile();
        const tampered = new Uint8Array(data);
        const view = new DataView(tampered.buffer, tampered.byteOffset, tampered.byteLength);
        const schemaLen = view.getUint32(GICS_HEADER_SIZE_V3, true);
        view.setUint32(GICS_HEADER_SIZE_V3, schemaLen + 1024, true);

        await expect(new GICSv2Decoder(tampered).verifyIntegrityOnly()).resolves.toBe(false);
        await expect(new GICSv2Decoder(tampered).parseHeader()).rejects.toThrow();
    });

    it('rejects tampered File EOS CRCs during verification', async () => {
        const data = await encodeLegacyFile();
        const tampered = flipByte(data, data.length - 1);

        await expect(new GICSv2Decoder(tampered).verifyIntegrityOnly()).resolves.toBe(false);
    });

    it('public GICS.verify forwards decoder options for encrypted files', async () => {
        const data = await encodeLegacyFile({ password: TEST_PASSWORD });

        await expect(GICS.verify(data)).resolves.toBe(false);
        await expect(GICS.verify(data, { password: TEST_PASSWORD })).resolves.toBe(true);
    });
});
