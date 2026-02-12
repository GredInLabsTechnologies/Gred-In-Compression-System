import { GICS, Snapshot } from '../src/index.js';

function expectSameNumberSemantics(actual: number, expected: number): void {
    if (Number.isNaN(expected)) {
        expect(Number.isNaN(actual)).toBe(true);
        return;
    }
    expect(Object.is(actual, expected)).toBe(true);
}

describe('GICS float edge-cases', () => {
    it('roundtrips special IEEE-754 values (NaN, ±Infinity, -0)', async () => {
        const snapshots: Snapshot[] = [
            {
                timestamp: 1,
                items: new Map([
                    [1, { price: Number.NaN, quantity: Number.POSITIVE_INFINITY }],
                    [2, { price: Number.NEGATIVE_INFINITY, quantity: -0 }],
                ]),
            },
            {
                timestamp: 2,
                items: new Map([
                    [1, { price: Number.NaN, quantity: Number.NEGATIVE_INFINITY }],
                    [2, { price: Number.POSITIVE_INFINITY, quantity: 0 }],
                ]),
            },
        ];

        const packed = await GICS.pack(snapshots);
        expect(await GICS.verify(packed)).toBe(true);

        const decoded = await GICS.unpack(packed);
        expect(decoded.length).toBe(snapshots.length);

        for (let i = 0; i < snapshots.length; i++) {
            for (const [id, expected] of snapshots[i].items) {
                const actual = decoded[i].items.get(id);
                expect(actual).toBeDefined();
                expectSameNumberSemantics(actual!.price, expected.price);
                expectSameNumberSemantics(actual!.quantity, expected.quantity);
            }
        }
    });

    it('roundtrips extreme finite floats (MAX_VALUE, MIN_VALUE/subnormal)', async () => {
        const tinySubnormal = Number.MIN_VALUE; // 5e-324
        const tinyNormal = 1e-308;

        const snapshots: Snapshot[] = [
            {
                timestamp: 10,
                items: new Map([
                    [10, { price: Number.MAX_VALUE, quantity: tinySubnormal }],
                    [20, { price: -Number.MAX_VALUE, quantity: -tinySubnormal }],
                ]),
            },
            {
                timestamp: 11,
                items: new Map([
                    [10, { price: tinyNormal, quantity: -tinyNormal }],
                    [20, { price: Number.MIN_VALUE, quantity: 0 }],
                ]),
            },
        ];

        const packed = await GICS.pack(snapshots);
        const decoded = await GICS.unpack(packed);

        expect(decoded.length).toBe(2);
        for (let i = 0; i < snapshots.length; i++) {
            for (const [id, expected] of snapshots[i].items) {
                const actual = decoded[i].items.get(id);
                expect(actual).toBeDefined();
                expectSameNumberSemantics(actual!.price, expected.price);
                expectSameNumberSemantics(actual!.quantity, expected.quantity);
            }
        }
    });
});
