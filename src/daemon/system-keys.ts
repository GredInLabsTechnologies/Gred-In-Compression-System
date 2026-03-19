export const SYSTEM_NAMESPACE_PREFIXES = [
    '_sys|',
    '_insight|',
    '_insight/',
    '_infer|',
    '_infer/',
] as const;
export const TOMBSTONE_PREFIX = '_sys|tombstone|';

export function isSystemKey(key: string): boolean {
    return SYSTEM_NAMESPACE_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export function isHiddenSystemKey(key: string): boolean {
    return isSystemKey(key);
}

export function makeTombstoneKey(targetKey: string): string {
    return `${TOMBSTONE_PREFIX}${encodeURIComponent(targetKey)}`;
}

export function isTombstoneKey(key: string): boolean {
    return key.startsWith(TOMBSTONE_PREFIX);
}

export function parseTombstoneTarget(key: string): string | null {
    if (!isTombstoneKey(key)) return null;
    const encoded = key.slice(TOMBSTONE_PREFIX.length);
    try {
        return decodeURIComponent(encoded);
    } catch {
        return null;
    }
}
