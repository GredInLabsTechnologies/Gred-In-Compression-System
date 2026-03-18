/**
 * GICS MemTable
 * In-memory mutable storage for HOT data.
 */

export type MemFieldValue = number | string;
export type MemRecordFields = Record<string, MemFieldValue>;

export interface MemTableConfig {
    maxMemTableBytes?: number;
    maxDirtyRecords?: number;
}

export interface FlushDecision {
    shouldFlush: boolean;
    reason: 'size' | 'dirty' | null;
}

export interface MemRecord {
    key: string;
    fields: MemRecordFields;
    created: number;
    updated: number;
    accessCount: number;
    dirty: boolean;
}

export class MemTable {
    public static readonly DEFAULT_MAX_MEMTABLE_BYTES = 4 * 1024 * 1024; // 4MB
    public static readonly DEFAULT_MAX_DIRTY_RECORDS = 1000;

    private records: Map<string, MemRecord> = new Map();
    private _sizeBytes: number = 0;
    private _dirtyCount: number = 0;
    private readonly maxMemTableBytes: number;
    private readonly maxDirtyRecords: number;

    constructor(config: MemTableConfig = {}) {
        this.maxMemTableBytes = config.maxMemTableBytes ?? MemTable.DEFAULT_MAX_MEMTABLE_BYTES;
        this.maxDirtyRecords = config.maxDirtyRecords ?? MemTable.DEFAULT_MAX_DIRTY_RECORDS;
    }

    /**
     * Insert or update a record
     */
    put(key: string, fields: MemRecordFields): void {
        const now = Date.now();
        const existing = this.records.get(key);

        if (existing) {
            // Estimate size delta (very rough for now)
            const oldSize = this.estimateRecordSize(existing);

            // Replace full payload to avoid stale-field leakage across updates.
            existing.fields = { ...fields };
            existing.updated = now;
            if (!existing.dirty) {
                existing.dirty = true;
                this._dirtyCount++;
            }

            const newSize = this.estimateRecordSize(existing);
            this._sizeBytes += (newSize - oldSize);
        } else {
            const record: MemRecord = {
                key,
                fields,
                created: now,
                updated: now,
                accessCount: 0,
                dirty: true
            };
            this.records.set(key, record);
            this._sizeBytes += this.estimateRecordSize(record);
            this._dirtyCount++;
        }
    }

    /**
     * Retrieve a record
     */
    get(key: string): MemRecord | undefined {
        const record = this.records.get(key);
        if (record) {
            record.accessCount++;
        }
        return record;
    }

    /**
     * Delete a record (marks for deletion/tombstone)
     */
    delete(key: string): boolean {
        if (this.records.has(key)) {
            const record = this.records.get(key)!;
            this._sizeBytes -= this.estimateRecordSize(record);
            if (record.dirty) {
                this._dirtyCount--;
            }
            this.records.delete(key);
            return true;
        }
        return false;
    }

    /**
     * Scan keys with optional prefix
     */
    scan(prefix?: string): MemRecord[] {
        const results: MemRecord[] = [];
        for (const [key, record] of this.records) {
            if (!prefix || key.startsWith(prefix)) {
                results.push(record);
            }
        }
        return results;
    }

    get sizeBytes(): number {
        return this._sizeBytes;
    }

    get dirtyCount(): number {
        return this._dirtyCount;
    }

    get count(): number {
        return this.records.size;
    }

    get thresholds(): Readonly<{ maxMemTableBytes: number; maxDirtyRecords: number; }> {
        return {
            maxMemTableBytes: this.maxMemTableBytes,
            maxDirtyRecords: this.maxDirtyRecords
        };
    }

    shouldFlush(): FlushDecision {
        if (this._sizeBytes > this.maxMemTableBytes) {
            return { shouldFlush: true, reason: 'size' };
        }
        if (this._dirtyCount > this.maxDirtyRecords) {
            return { shouldFlush: true, reason: 'dirty' };
        }
        return { shouldFlush: false, reason: null };
    }

    /**
     * Resets dirty status (usually after a successful flush + WAL truncate)
     */
    resetDirty(): void {
        for (const record of this.records.values()) {
            record.dirty = false;
        }
        this._dirtyCount = 0;
    }

    /**
     * Fully evict all HOT records, usually after a durable flush.
     */
    clear(): void {
        this.records.clear();
        this._sizeBytes = 0;
        this._dirtyCount = 0;
    }

    /**
     * Rough estimation of record size in bytes
     */
    private estimateRecordSize(record: MemRecord): number {
        let size = Buffer.byteLength(record.key, 'utf8');
        size += Buffer.byteLength(JSON.stringify(record.fields), 'utf8');
        size += 32; // Overheads (timestamps, counters, booleans)
        return size;
    }
}
