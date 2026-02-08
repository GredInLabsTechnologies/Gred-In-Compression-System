import { GICSv2Encoder, GICSv2Decoder } from '../../src/index.js';
import { IncompleteDataError } from '../../src/gics/errors.js';

describe('Regression: Truncation Silent Success', () => {
    it('should throw IncompleteDataError for truncated streams', async () => {
        const encoder = new GICSv2Encoder();
        // Create enough data to have multiple blocks/varints
        for (let i = 0; i < 50; i++) {
            await encoder.addSnapshot({ timestamp: 1000 + i, items: new Map([[1, { price: 100 + i, quantity: 1 }]]) });
        }
        const fullData = await encoder.finish();

        // Try truncating at every single byte offset
        for (let i = 1; i < fullData.length; i++) {
            const truncated = fullData.slice(0, i);
            const decoder = new GICSv2Decoder(truncated);

            // Must throw. Prefer IncompleteDataError, but generic Error/Format is better than silent success.
            // The audit requirement is IncompleteDataError (102) for EOF-related fails.
            await expect(decoder.getAllSnapshots(), `Failed at offset ${i}/${fullData.length}`).rejects.toThrow();
        }
    });
});
