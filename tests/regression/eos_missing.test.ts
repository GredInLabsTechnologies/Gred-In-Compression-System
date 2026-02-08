import { GICSv2Encoder, GICSv2Decoder } from '../../src/index.js';
import { IncompleteDataError } from '../../src/gics/errors.js';

describe('Regression: EOS Missing', () => {
    it('should throw IncompleteDataError if EOS marker is missing', async () => {
        const encoder = new GICSv2Encoder();
        await encoder.addSnapshot({ timestamp: 1000, items: new Map([[1, { price: 100, quantity: 1 }]]) });
        const data_with_eos = await encoder.finish();
        // Strip EOS block (11 bytes)
        const data = data_with_eos.slice(0, -11);

        const decoder = new GICSv2Decoder(data);

        // Expect decoding to throw IncompleteDataError because EOS is missing
        await expect(decoder.getAllSnapshots()).rejects.toThrow(IncompleteDataError);
    });
});
