export function durationSeconds(startedAtMs: number, finishedAtMs: number = Date.now()): number {
    return Math.max(0, (finishedAtMs - startedAtMs) / 1000);
}

export function normalizeErrorType(error: unknown): string {
    if (error && typeof error === 'object') {
        const maybeError = error as Error & { code?: string; name?: string; };
        if (typeof maybeError.code === 'string' && maybeError.code.trim()) {
            return maybeError.code.trim().toLowerCase();
        }
        if (typeof maybeError.name === 'string' && maybeError.name.trim() && maybeError.name !== 'Error') {
            return maybeError.name.trim().toLowerCase();
        }
        if (typeof maybeError.message === 'string' && maybeError.message.trim()) {
            return maybeError.message.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64) || 'error';
        }
    }
    if (typeof error === 'string' && error.trim()) {
        return error.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64) || 'error';
    }
    return 'error';
}

export function normalizeBooleanLabel(value: boolean): 'true' | 'false' {
    return value ? 'true' : 'false';
}

export function normalizeSchemaKind(hasSchema: boolean): 'generic' | 'legacy' {
    return hasSchema ? 'generic' : 'legacy';
}

export function normalizeOutcomeResult(result: string | undefined): 'success' | 'partial' | 'error' | 'other' {
    switch (String(result ?? '').toLowerCase()) {
        case 'success':
        case 'ok':
        case 'true':
            return 'success';
        case 'partial':
        case 'retry':
            return 'partial';
        case 'timeout':
        case 'error':
        case 'fail':
        case 'failed':
        case 'false':
            return 'error';
        default:
            return 'other';
    }
}
