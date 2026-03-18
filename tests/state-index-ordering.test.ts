import { StateIndex } from '../src/daemon/state-index.js';

describe('StateIndex ordering regressions', () => {
    it('preserves the newest put when an older record is replayed later', () => {
        const index = new StateIndex('unused');

        index.recordPut('orders:42', { value: 200, tag: 'new' }, {
            timestamp: 200,
            tier: 'warm',
            segmentRef: 'warm-new.gics',
        });
        index.recordPut('orders:42', { value: 100, tag: 'old' }, {
            timestamp: 100,
            tier: 'warm',
            segmentRef: 'warm-old.gics',
        });

        const entry = index.getVisible('orders:42', true);
        expect(entry?.timestamp).toBe(200);
        expect(entry?.fields).toEqual({ value: 200, tag: 'new' });
        expect(entry?.segmentRef).toBe('warm-new.gics');
    });

    it('does not let an older tombstone override a newer live value', () => {
        const index = new StateIndex('unused');

        index.recordPut('orders:42', { value: 300 }, {
            timestamp: 300,
            tier: 'warm',
            segmentRef: 'warm-live.gics',
        });
        index.recordDelete('orders:42', {
            timestamp: 250,
            tier: 'warm',
            segmentRef: 'warm-old-delete.gics',
        });

        const entry = index.getVisible('orders:42', true);
        expect(entry?.timestamp).toBe(300);
        expect(entry?.fields).toEqual({ value: 300 });
    });

    it('keeps the newest tombstone timestamp when an older tombstone arrives later', () => {
        const index = new StateIndex('unused');

        index.recordDelete('orders:42', {
            timestamp: 400,
            tier: 'cold',
            segmentRef: 'cold-delete-new.gics',
        });
        index.recordDelete('orders:42', {
            timestamp: 150,
            tier: 'warm',
            segmentRef: 'warm-delete-old.gics',
        });

        const entry = index.getEntry('orders:42');
        expect(entry?.deleted).toBe(true);
        expect(entry?.timestamp).toBe(400);
        expect(index.getVisible('orders:42', true)).toBeNull();
    });
});
