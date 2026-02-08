import { GICS } from '../../src/index.js';
import { SeededRNG } from '../../bench/scripts/rng.js';

function generateData(rng: SeededRNG, size: number) {
    const data: { t: number, v: number }[] = [];
    let t = 1000;
    let v = 1000;
    for (let i = 0; i < size; i++) {
        t += rng.nextInt(1, 100);
        v += rng.nextInt(-10, 10);
        data.push({ t, v });
    }
    return data;
}

describe('Regression: Integrity Mismatch', () => {
    it('should roundtrip bit-exact with seed 12345', async () => {
        const seed = 12345;
        const size = 100;
        const rng = new SeededRNG(seed);
        const dataset = generateData(rng, size);

        // Encode
        const encoder = new GICS.Encoder();
        for (const row of dataset) {
            await encoder.addSnapshot({ timestamp: row.t, items: new Map([[1, { price: row.v, quantity: 1 }]]) });
        }
        const data = await encoder.finish();

        // Decode
        const decoder = new GICS.Decoder(data);
        const result = await decoder.getAllSnapshots();

        expect(result.length).toBe(dataset.length);
        for (let i = 0; i < dataset.length; i++) {
            if (result[i].timestamp !== dataset[i].t) {
                console.log(`Mismatch at ${i}: Expected T=${dataset[i].t}, Got T=${result[i].timestamp}`);
            }
            if (result[i].items.get(1)?.price !== dataset[i].v) {
                console.log(`Mismatch at ${i}: Expected V=${dataset[i].v}, Got V=${result[i].items.get(1)?.price}`);
            }
            expect(result[i].timestamp).toBe(dataset[i].t);
            expect(result[i].items.get(1)?.price).toBe(dataset[i].v);
        }
    });
});
