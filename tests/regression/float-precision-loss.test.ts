import { GICS } from '../../src/index.js';

function sameNumberSemantics(actual: number, expected: number): boolean {
    if (Number.isNaN(expected)) return Number.isNaN(actual);
    return Object.is(actual, expected);
}

describe('Regression: float precision stability', () => {
    it('keeps IEEE-754 semantics for challenging floating values', async () => {
        const snapshots = [
            {
                timestamp: 1000,
                items: new Map([
                    [1, { price: 0.1 + 0.2, quantity: 1 / 3 }],
                    [2, { price: Number.MAX_VALUE, quantity: Number.MIN_VALUE }],
                ]),
            },
            {
                timestamp: 1001,
                items: new Map([
                    [1, { price: -0, quantity: Number.POSITIVE_INFINITY }],
                    [2, { price: Number.NEGATIVE_INFINITY, quantity: Number.NaN }],
                ]),
            },
        ];

        const packed = await GICS.pack(snapshots);
        const decoded = await GICS.unpack(packed);

        expect(decoded.length).toBe(snapshots.length);
        for (let i = 0; i < snapshots.length; i++) {
            for (const [id, expected] of snapshots[i].items) {
                const actual = decoded[i].items.get(id);
                expect(actual).toBeDefined();
                expect(sameNumberSemantics(actual!.price, expected.price)).toBe(true);
                expect(sameNumberSemantics(actual!.quantity, expected.quantity)).toBe(true);
            }
        }
    });
});
