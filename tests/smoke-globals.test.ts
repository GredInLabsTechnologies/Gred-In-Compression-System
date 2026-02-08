// Intentionally do NOT import from 'vitest' to validate globals injection.

console.log('[smoke-globals] module loaded');

describe('smoke-globals', () => {
    it('vitest runs (globals)', () => {
        console.log('[smoke-globals] test executed');
        expect(2 + 3).toBe(5);
    });
});
