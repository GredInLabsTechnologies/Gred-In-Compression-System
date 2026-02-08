
export interface ContextStore {
    version: number;
    id: string | null; // [NEW] Telemetry ID
    schemaHash: string;
    dictionaries?: Record<string, Uint8Array>;
    stats?: Record<string, number>;
    // Inter-chunk persistence for metrics
    lastTimestamp?: number;
    lastTimestampDelta?: number;
    lastValue?: number;
    lastValueDelta?: number;
}

export class ContextV0 implements ContextStore {
    private static idCounter = 0;

    version = 0;
    id: string | null;
    schemaHash: string;
    dictionaries: Record<string, Uint8Array> = {};
    stats: Record<string, number> = {};

    lastTimestamp?: number;
    lastTimestampDelta?: number;
    lastValue?: number;
    lastValueDelta?: number;

    // Dictionary (Context V1)
    dictionary: number[] = [];
    dictMap: Map<number, number> = new Map(); // Value -> Index
    maxDictSize: number = 256; // 8-bit index optimization

    // Telemetry / Usage Tracking
    metrics = {
        refCount: 0,
        hits: 0,
        misses: 0,
        predictedGainBytes: 0,
        netGainBytes: 0
    };

    /**
     * Reset per-block metrics. Call this before processing a new block if you want per-block stats.
     * Or keep accumulating for stream-lifetime stats.
     * Spec says "ctx_bytes_emitted_total" etc.
     */
    resetMetrics() {
        this.metrics = {
            refCount: 0,
            hits: 0,
            misses: 0,
            predictedGainBytes: 0,
            netGainBytes: 0
        };
    }

    constructor(schemaHash: string, id?: string | null) {
        this.schemaHash = schemaHash;
        // If id is explicitly null, keep it null (OFF mode). 
        if (id === null) {
            this.id = null;
        } else {
            this.id = id || `ctx_${++ContextV0.idCounter}`;
        }
    }

    serialize(): Uint8Array {
        // Skeleton serialization
        const json = JSON.stringify(this);
        return new TextEncoder().encode(json);
    }

    static deserialize(data: Uint8Array): ContextV0 {
        const json = new TextDecoder().decode(data);
        const obj = JSON.parse(json) as ContextStore;
        const ctx = new ContextV0(obj.schemaHash);
        ctx.id = obj.id;
        ctx.dictionaries = obj.dictionaries || {};
        ctx.stats = obj.stats || {};
        ctx.lastTimestamp = obj.lastTimestamp;
        ctx.lastTimestampDelta = obj.lastTimestampDelta;
        ctx.lastValue = obj.lastValue;
        ctx.lastValueDelta = obj.lastValueDelta;
        return ctx;
    }

    // Dictionary Management (FIFO / Ring Buffer)
    dictPos: number = 0;

    updateDictionary(val: number) {
        // If ID is null (OFF mode), do nothing
        if (this.id === null) return;

        if (this.dictionary.length < this.maxDictSize) {
            this.dictMap.set(val, this.dictionary.length);
            this.dictionary.push(val);
        } else {
            const oldVal = this.dictionary[this.dictPos];
            if (this.dictMap.get(oldVal) === this.dictPos) {
                this.dictMap.delete(oldVal);
            }
            this.dictionary[this.dictPos] = val;
            this.dictMap.set(val, this.dictPos);
            this.dictPos = (this.dictPos + 1) % this.maxDictSize;
        }
    }

    // Cloning for Probe Safety
    /**
     * Creates a lightweight clone of the active coding state.
     * Used for "Dry Run" probes to prevent mutation of the canonical context.
     * 
     * Copies:
     * - dictionary (Array & Map)
     * - dictPos, maxDictSize
     * - lastTimestamp, lastValues (History)
     * 
     * Does NOT Copy:
     * - metrics (resets to 0)
     * - dictionaries (shared ref acceptable or ignored for probe)
     * - stats (shared ref acceptable or ignored)
     */
    clone(): ContextV0 {
        const copy = new ContextV0(this.schemaHash, this.id ? `${this.id}_clone` : null);

        // Copy History
        copy.lastTimestamp = this.lastTimestamp;
        copy.lastTimestampDelta = this.lastTimestampDelta;
        copy.lastValue = this.lastValue;
        copy.lastValueDelta = this.lastValueDelta;

        // Copy Dictionary State (Deep Copy of Active State)
        // Since maxDictSize is small (256), this is cheap.
        copy.dictionary = [...this.dictionary];
        copy.dictMap = new Map(this.dictMap);
        copy.dictPos = this.dictPos;
        copy.maxDictSize = this.maxDictSize;

        // Shared Refs for invariant/heavy data (Probes don't mutate these)
        copy.dictionaries = this.dictionaries;
        copy.stats = this.stats;

        return copy;
    }

    lookup(val: number): number | undefined {
        if (this.id === null) return undefined;
        this.metrics.refCount++;
        const idx = this.dictMap.get(val);
        if (idx !== undefined) {
            this.metrics.hits++;
            return idx;
        }
        this.metrics.misses++;
        return undefined;
    }

    // --- Split-5: Context Isolation ---

    /**
     * "Previous Core" accessors to satisfy architectural constraints.
     * These map to the persistent `last*` fields which are now STRICTLY for Start-of-Block reference.
     * Core blocks update them. Quarantine blocks must revert changes to them.
     */
    get prevCoreTime(): number | undefined { return this.lastTimestamp; }
    set prevCoreTime(v: number | undefined) { this.lastTimestamp = v; }

    get prevCoreValue(): number | undefined { return this.lastValue; }
    set prevCoreValue(v: number | undefined) { this.lastValue = v; }

    /**
     * SNAPSHOT & RESTORE
     * Used to enforce "Quarantine must not update context".
     * Encoder calls snapshot() before processing a block.
     * If block is routed to QUARANTINE, encoder calls restore().
     */
    snapshot(): ContextSnapshot {
        return {
            lastTimestamp: this.lastTimestamp,
            lastTimestampDelta: this.lastTimestampDelta,
            lastValue: this.lastValue,
            lastValueDelta: this.lastValueDelta,
            // Dictionary State (Shallow copy of array & map is needed because they are mutable)
            dictionaryLen: this.dictionary.length,
            dictPos: this.dictPos,
            // We don't need full clone of arrays if we assume append-only or ring-buffer?
            // Ring buffer modifies in place. We must clone.
            // But for performance, copy only if modified? 
            // V1.2 dictionary is small (256). Copy is cheap.
            dictionary: [...this.dictionary],
            dictMap: new Map(this.dictMap)
        };
    }

    restore(s: ContextSnapshot) {
        this.lastTimestamp = s.lastTimestamp;
        this.lastTimestampDelta = s.lastTimestampDelta;
        this.lastValue = s.lastValue;
        this.lastValueDelta = s.lastValueDelta;

        // Restore Dictionary
        this.dictionary = s.dictionary;
        this.dictMap = s.dictMap;
        this.dictPos = s.dictPos;
    }
}

export interface ContextSnapshot {
    lastTimestamp?: number;
    lastTimestampDelta?: number;
    lastValue?: number;
    lastValueDelta?: number;
    dictionary: number[];
    dictMap: Map<number, number>;
    dictPos: number;
    dictionaryLen: number;
}
