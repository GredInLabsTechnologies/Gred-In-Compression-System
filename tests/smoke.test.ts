console.log('[smoke] module loaded');

describe('smoke', () => {
    it('vitest runs', () => {
        console.log('[smoke] test executed');
        expect(1 + 1).toBe(2);
    });
});
