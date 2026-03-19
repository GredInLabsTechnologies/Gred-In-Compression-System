import * as fs from 'fs/promises';
import * as path from 'path';
import { existsSync } from 'fs';
import { isHiddenSystemKey, isSystemKey, isTombstoneKey, makeTombstoneKey, parseTombstoneTarget } from './system-keys.js';

export type StateIndexTier = 'hot' | 'warm' | 'cold';
export type StateIndexScanMode = 'current';

export interface StateIndexEntryFields {
    [key: string]: number | string;
}

export interface StateIndexEntry {
    key: string;
    timestamp: number;
    deleted: boolean;
    tier: StateIndexTier;
    segmentRef: string | null;
    fields?: StateIndexEntryFields;
    system: boolean;
    updatedAt: number;
}

export interface StateIndexScanOptions {
    tiers?: 'all' | StateIndexTier[];
    includeSystem?: boolean;
    limit?: number;
    cursor?: string | null;
    mode?: StateIndexScanMode;
}

export interface StateIndexScanItem {
    key: string;
    fields: StateIndexEntryFields;
    tier: StateIndexTier;
    timestamp: number;
}

export interface StateIndexScanResult {
    items: StateIndexScanItem[];
    nextCursor: string | null;
}

interface StateIndexFileData {
    version: 1;
    entries: StateIndexEntry[];
}

interface RecordMutationMeta {
    timestamp?: number;
    tier?: StateIndexTier;
    segmentRef?: string | null;
}

const STATE_INDEX_VERSION = 1 as const;

export class StateIndex {
    private readonly filePath: string;
    private readonly entries = new Map<string, StateIndexEntry>();
    private sortedKeys: string[] = [];

    constructor(filePath: string) {
        this.filePath = filePath;
    }

    async load(): Promise<void> {
        if (!existsSync(this.filePath)) {
            this.entries.clear();
            this.rebuildSortedKeys();
            return;
        }

        const raw = await fs.readFile(this.filePath, 'utf8');
        let parsed: StateIndexFileData;
        try {
            parsed = JSON.parse(raw) as StateIndexFileData;
        } catch (err: any) {
            throw new Error(`StateIndex parse error: ${err.message}`);
        }

        if (parsed.version !== STATE_INDEX_VERSION || !Array.isArray(parsed.entries)) {
            throw new Error('StateIndex version mismatch or malformed payload');
        }

        this.entries.clear();
        for (const entry of parsed.entries) {
            if (!entry || typeof entry.key !== 'string') continue;
            this.entries.set(entry.key, {
                key: entry.key,
                timestamp: Number(entry.timestamp || 0),
                deleted: Boolean(entry.deleted),
                tier: entry.tier === 'warm' || entry.tier === 'cold' ? entry.tier : 'hot',
                segmentRef: entry.segmentRef ?? null,
                fields: entry.fields ? { ...entry.fields } : undefined,
                system: Boolean(entry.system || isSystemKey(entry.key)),
                updatedAt: Number(entry.updatedAt || Date.now()),
            });
        }
        this.rebuildSortedKeys();
    }

    async save(): Promise<void> {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        const tmpPath = `${this.filePath}.tmp`;
        const payload: StateIndexFileData = {
            version: STATE_INDEX_VERSION,
            entries: Array.from(this.entries.values()).sort((a, b) => a.key.localeCompare(b.key)),
        };
        await fs.writeFile(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
        await fs.rename(tmpPath, this.filePath);
    }

    clear(): void {
        this.entries.clear();
        this.rebuildSortedKeys();
    }

    getEntry(key: string): StateIndexEntry | null {
        const entry = this.entries.get(key);
        return entry ? this.cloneEntry(entry) : null;
    }

    has(key: string): boolean {
        return this.entries.has(key);
    }

    getVisible(key: string, includeSystem: boolean = false): StateIndexEntry | null {
        const entry = this.entries.get(key);
        if (!entry) return null;
        if (entry.deleted) return null;
        if (!includeSystem && isHiddenSystemKey(entry.key)) return null;
        if (!entry.fields) return null;
        return this.cloneEntry(entry);
    }

    recordPut(key: string, fields: StateIndexEntryFields, meta: RecordMutationMeta = {}): void {
        const timestamp = meta.timestamp ?? Date.now();
        const tier = meta.tier ?? 'hot';
        const segmentRef = meta.segmentRef ?? null;
        const now = Date.now();
        const prev = this.entries.get(key);
        if (prev && timestamp < prev.timestamp) {
            return;
        }

        const next: StateIndexEntry = {
            key,
            timestamp,
            deleted: false,
            tier,
            segmentRef,
            fields: { ...fields },
            system: isSystemKey(key),
            updatedAt: now,
        };
        this.entries.set(key, next);

        if (isTombstoneKey(key)) {
            const target = parseTombstoneTarget(key);
            if (target) {
                this.recordDeletedTarget(target, timestamp, tier, segmentRef);
            }
        }

        this.rebuildSortedKeys();
    }

    recordDelete(targetKey: string, meta: RecordMutationMeta = {}): { tombstoneKey: string; tombstoneFields: StateIndexEntryFields } {
        const timestamp = meta.timestamp ?? Date.now();
        const tier = meta.tier ?? 'hot';
        const segmentRef = meta.segmentRef ?? null;
        const tombstoneKey = makeTombstoneKey(targetKey);
        const tombstoneFields: StateIndexEntryFields = {
            target_key: targetKey,
            deleted_at_ms: timestamp,
        };

        this.recordPut(tombstoneKey, tombstoneFields, { timestamp, tier, segmentRef });
        this.recordDeletedTarget(targetKey, timestamp, tier, segmentRef);
        this.rebuildSortedKeys();

        return { tombstoneKey, tombstoneFields };
    }

    applyWALDelete(targetKey: string, timestamp: number = Date.now()): void {
        this.recordDeletedTarget(targetKey, timestamp, 'hot', null);
        this.rebuildSortedKeys();
    }

    reclassifyTier(keys: Iterable<string>, tier: StateIndexTier, segmentRef: string | null): void {
        const now = Date.now();
        for (const key of keys) {
            const entry = this.entries.get(key);
            if (!entry) continue;
            entry.tier = tier;
            entry.segmentRef = segmentRef;
            entry.updatedAt = now;
        }
        this.rebuildSortedKeys();
    }

    remapSegments(segmentMap: Map<string, { tier: StateIndexTier; segmentRef: string | null }>): void {
        const now = Date.now();
        for (const entry of this.entries.values()) {
            if (!entry.segmentRef) continue;
            const replacement = segmentMap.get(entry.segmentRef);
            if (!replacement) continue;
            entry.tier = replacement.tier;
            entry.segmentRef = replacement.segmentRef;
            entry.updatedAt = now;
        }
        this.rebuildSortedKeys();
    }

    scan(prefix: string = '', options: StateIndexScanOptions = {}): StateIndexScanResult {
        const includeSystem = options.includeSystem ?? false;
        const mode = options.mode ?? 'current';
        const limit = Math.max(0, Number(options.limit ?? 0));
        const cursor = options.cursor ?? null;
        const tiers = options.tiers === 'all' || !options.tiers
            ? null
            : new Set(options.tiers);

        if (mode !== 'current') {
            throw new Error(`Unsupported scan mode: ${mode}`);
        }

        const keys = includeSystem ? this.sortedKeys : this.sortedKeys.filter((key) => !isHiddenSystemKey(key));
        const startIdx = cursor ? Math.max(0, keys.findIndex((key) => key > cursor)) : 0;
        const out: StateIndexScanItem[] = [];
        let nextCursor: string | null = null;

        for (let i = startIdx; i < keys.length; i++) {
            const key = keys[i]!;
            if (prefix && !key.startsWith(prefix)) {
                if (out.length > 0 && key.localeCompare(prefix) > 0) break;
                continue;
            }

            const entry = this.entries.get(key);
            if (!entry || entry.deleted || !entry.fields) continue;
            if (tiers && !tiers.has(entry.tier)) continue;
            if (!includeSystem && isHiddenSystemKey(key)) continue;

            out.push({
                key: entry.key,
                fields: { ...entry.fields },
                tier: entry.tier,
                timestamp: entry.timestamp,
            });

            if (limit > 0 && out.length >= limit) {
                nextCursor = entry.key;
                break;
            }
        }

        return { items: out, nextCursor };
    }

    entriesForSegment(segmentRef: string): string[] {
        return Array.from(this.entries.values())
            .filter((entry) => entry.segmentRef === segmentRef)
            .map((entry) => entry.key);
    }

    removeEntriesForSegment(segmentRef: string): void {
        let changed = false;
        for (const [key, entry] of this.entries.entries()) {
            if (entry.segmentRef !== segmentRef) continue;
            this.entries.delete(key);
            changed = true;
        }
        if (changed) this.rebuildSortedKeys();
    }

    snapshotEntries(): StateIndexEntry[] {
        return Array.from(this.entries.values()).map((entry) => this.cloneEntry(entry));
    }

    private recordDeletedTarget(targetKey: string, timestamp: number, tier: StateIndexTier, segmentRef: string | null): void {
        const now = Date.now();
        const prev = this.entries.get(targetKey);
        if (prev && timestamp < prev.timestamp) return;
        this.entries.set(targetKey, {
            key: targetKey,
            timestamp,
            deleted: true,
            tier,
            segmentRef,
            fields: undefined,
            system: isSystemKey(targetKey),
            updatedAt: now,
        });
    }

    private rebuildSortedKeys(): void {
        this.sortedKeys = Array.from(this.entries.keys()).sort((a, b) => a.localeCompare(b));
    }

    private cloneEntry(entry: StateIndexEntry): StateIndexEntry {
        return {
            ...entry,
            fields: entry.fields ? { ...entry.fields } : undefined,
        };
    }
}
