# GICS v1.3.3 — Streaming Encoder + Audit Gap Closure Plan

## Problem Statement

The 20-year forensics benchmark revealed a **1.42 GB peak heap** during encoding of
175,200 snapshots × 1,024 items. This is the #1 blocker for production adoption.

Root cause analysis of `encode.ts` reveals **3 memory accumulation points**:

1. **`snapshots[]` array** — Grows unbounded between `flush()` calls
2. **`accumulatedBytes[]`** — In-memory mode accumulates ALL segment bytes
3. **Per-segment allocations** — Feature arrays + block payloads + zstd buffers

Points 1–2 are already solvable by users calling `flush()` periodically and using file
mode. **Point 3 is the real blocker** — even a single segment with 1,024 snapshots × 1,024
items allocates ~12 MB of feature arrays, then duplicates them in transposition, then
duplicates again in block payloads, then again in zstd concatenation.

At 175,200 snapshots divided into ~170 segments of ~1,024 snapshots each, the per-segment
overhead is manageable (~50 MB). The real killer is that `flush()` serializes ALL groups
in a single loop, holding references to ALL segment bytes until the final `concatArrays`.

## SOTA Analysis

| System | Approach | Memory Bound |
|--------|----------|-------------|
| **Gorilla (Facebook)** | 2-hour fixed blocks, flush each independently | O(block_size) |
| **Parquet (Estuary 2-pass)** | Write small row groups to scratch file, re-read column-by-column | O(row_group) |
| **QuestDB** | In-memory WAL → columnar partition flush, background compaction | O(WAL_buffer) |
| **InfluxDB IOx** | Arrow record batches → Parquet compaction | O(batch) |
| **GICS current** | Accumulate snapshots → build segment → serialize → concat ALL | O(all_segments) |

The SOTA pattern is: **encode one segment at a time, write it to the sink immediately,
then release its memory before starting the next segment.**

GICS already supports this via `FileAccess.appendData()` in the `flush()` loop — but
the current code still holds ALL serialized segment bytes in `allBytes[]` and then
concatenates them at the end of `flush()`. The fix is surgical.

## Design: Zero-Copy Streaming Flush

### Core Principle
**Process one segment → write → release → next segment.** No multi-segment accumulation.

### Change 1: Streaming `flush()` (O(1-segment) memory)

Current `flush()` at line 218:
```
groups = buildSegmentGroups(snapshots)
snapshots = []
allBytes = []
for group in groups:
    segment = encodeSegment(group)
    bytes = segment.serialize()
    allBytes.push(bytes)           // ← HOLDS ALL
    if fileHandle: appendData(bytes)
finalBytes = concatArrays(allBytes) // ← PEAK ALLOCATION
if !fileHandle: accumulatedBytes.push(finalBytes)
return finalBytes
```

New `flush()`:
```
groups = buildSegmentGroups(snapshots)
snapshots = []
totalWritten = 0

// Emit header once (same as before)
if !hasEmittedHeader: writeHeader()

for group in groups:
    segment = encodeSegment(group)
    bytes = segment.serialize()
    totalWritten += bytes.length

    if fileHandle:
        appendData(bytes)
    else:
        accumulatedBytes.push(bytes)  // ← Per-segment, not concat

    // bytes falls out of scope here → GC can collect
    blockStats.push(stats)

computeTelemetry(blockStats)
return totalWritten  // ← Return byte count, not buffer
```

**Problem**: `flush()` currently returns `Uint8Array`. Changing return type is a breaking
API change. We need backward compatibility.

**Solution**: Keep `flush()` returning `Uint8Array` in in-memory mode (concatenating as
before — users without file mode need the bytes). In file mode, return the LAST segment's
bytes (consistent with `seal()` behavior). The key optimization is that in file mode we
**don't hold allBytes[]** — we write each segment and release it.

For in-memory mode, the user can already control memory by calling `flush()` more
frequently. The real fix is file mode.

### Change 2: File-mode flush releases per-segment

In file mode, `flush()` will:
1. Iterate groups
2. For each group: encode → serialize → `appendData()` → **discard** the serialized bytes
3. Return an empty `Uint8Array` (or the last segment's bytes for backward compat)
4. `seal()` already returns `eosBytes` in file mode — no change needed

This means in file mode, peak memory = **O(1 segment)** instead of O(all segments).

### Change 3: Streaming-aware auto-flush (new feature)

Add `autoFlushThreshold` option to `GICSv2EncoderOptions`:
```typescript
/** Auto-flush after this many snapshots accumulate (0 = disabled). Default: 0. */
autoFlushThreshold?: number;
```

When set, `addSnapshot()` checks `this.snapshots.length >= threshold` and calls
`this.flush()` internally. This prevents users from accidentally accumulating
unbounded snapshots.

### Change 4: `FileAccess.appendData` optimization

Current implementation calls `stat()` on every write to find file size:
```typescript
static async appendData(handle: FileHandle, data: Uint8Array): Promise<void> {
    const stats = await handle.stat();
    await handle.write(data, 0, data.length, stats.size);
}
```

This is an extra syscall per write. Replace with a tracked offset:
```typescript
static async appendData(handle: FileHandle, data: Uint8Array, offset: number): Promise<number> {
    await handle.write(data, 0, data.length, offset);
    return offset + data.length;
}
```

The encoder tracks `private fileOffset: number = 0` and passes it through.

### Change 5: Per-segment memory ceiling with snapshot-count cap

The `maxSnapshotsPerSegment` (default 1024) already caps segment depth for stable
multi-item mode. For the SegmentBuilder fallback path, we add:
```typescript
maxItemsPerSegment?: number; // default: 1_000_000
```

When estimated total items (snapshots × items_per_snapshot) exceed this, force a segment
boundary. This prevents a single segment from consuming >~100MB in feature arrays.

## Implementation Steps

### Step 1: Refactor `flush()` for file-mode streaming
- File: `src/gics/encode.ts`, method `flush()` (line 218)
- Remove `allBytes[]` accumulation in file mode
- Write each segment to file immediately, release reference
- Keep in-memory mode unchanged (backward compat)

### Step 2: Optimize `FileAccess.appendData()`
- File: `src/gics/file-access.ts`
- Add tracked offset to avoid per-write `stat()` syscall
- Add `fileOffset` field to `GICSv2Encoder`

### Step 3: Add `autoFlushThreshold` option
- File: `src/gics/types.ts` — add field to `GICSv2EncoderOptions`
- File: `src/gics/encode.ts` — check in `addSnapshot()`, auto-flush when exceeded

### Step 4: Add `maxItemsPerSegment` ceiling
- File: `src/gics/types.ts` — add field
- File: `src/gics/encode.ts` — check in `buildSegmentGroups()` SegmentBuilder path

### Step 5: Tests
- New test: streaming file mode with 10K+ snapshots verifies peak heap < 100MB
- New test: autoFlushThreshold triggers correctly
- New test: backward compat — in-memory `flush()` still returns full `Uint8Array`
- Existing tests: MUST all pass unchanged (no format changes)

### Step 6: Long-horizon bench update
- Update `bench/scripts/long-horizon-forensics.ts` to use file mode + autoFlush
- Verify peak heap drops from 1.42 GB to < 200 MB

## What This Plan Does NOT Change

- **Binary format**: Zero changes. Same segment layout, same codecs, same integrity chain.
- **Decoder**: Zero changes. It already reads segment-by-segment.
- **In-memory mode API**: `flush()` still returns `Uint8Array` with all bytes.
- **Compression ratios**: Identical — same codecs, same block sizes.
- **Test suite**: All 118 security probes + existing tests pass unchanged.

## Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|-----------|
| `flush()` return type change breaks consumers | HIGH | Keep Uint8Array return for in-memory; only file mode changes behavior |
| `autoFlush` within `addSnapshot()` creates unexpected async | MEDIUM | Document clearly; only active when explicitly enabled |
| `FileAccess` offset tracking diverges from actual file size | LOW | Track offset precisely; fallback to stat() on error |
| Existing tests depend on `flush()` buffer content | LOW | In-memory mode unchanged; file mode tests verify file content |

## Estimated Memory Profile After Fix

| Scenario | Before | After |
|----------|--------|-------|
| 175K snaps × 1K items (file mode) | 1.42 GB peak | ~50 MB peak (1 segment) |
| 175K snaps × 1K items (memory mode) | 1.42 GB peak | ~1.42 GB (unchanged, user controls flush) |
| 500 snaps × 1K items (either) | ~50 MB | ~50 MB (single flush) |
| autoFlush=1024 + file mode | N/A | ~50 MB constant |
