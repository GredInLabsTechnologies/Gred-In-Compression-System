import { GICS } from '../../src/index.js';

describe('Regression: EOS Trailing Bytes', () => {
    it('should throw if bytes exist after EOS', async () => {
        const encoder = new GICS.Encoder();
        await encoder.addSnapshot({ timestamp: 1000, items: new Map([[1, { price: 100, quantity: 1 }]]) });
        const validWithEOS = await encoder.finish();

        // Append explicit garbage
        const currLen = validWithEOS.length;
        const corrupted = new Uint8Array(currLen + 1);
        corrupted.set(validWithEOS);
        corrupted[currLen] = 0xAA;

        const decoder = new GICS.Decoder(corrupted);
        await expect(decoder.getAllSnapshots()).rejects.toThrow();
    });
});
