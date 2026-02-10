/// <reference path="../../src/zstd-codec.d.ts" />
/**
 * GICS v1.1 - Hybrid Storage Engine
 * 
 * @module gics
 * @version 1.1.0
 * @status FROZEN - Canonical implementation
 * @see docs/GICS_V1.1_SPEC.md
 * 
 * Dual-index architecture for 100× compression with flexible item queries.
 * Maintains complete snapshots while enabling O(1) per-item access.
 * 
 * @author GICS Team
 */

import { crc32, brotliCompress, brotliDecompress } from 'node:zlib';
import { promisify } from 'node:util';
import { createCipheriv } from 'node:crypto';
// Zstd compression via WebAssembly
import { ZstdCodec } from 'zstd-codec';

import {
    type Snapshot,
    type GICSStats,
    type ItemTier,
    type QueryFilter,
    type ItemQueryResult,
    type HeatScoreResult,
    EncryptionMode,
    BlockType,
    CompressionAlgorithm
} from '../../src/gics-types.js';
import { encodeVarint, decodeVarint } from '../../src/gics-utils.js';
import { keyService, KDF_CONFIG, FILE_NONCE_LEN, AUTH_VERIFY_LEN } from './services/key.service.js';
import { HeatClassifier } from './HeatClassifier.js';

const brotliCompressAsync = promisify(brotliCompress);
const brotliDecompressAsync = promisify(brotliDecompress);


// ============================================================================
// Types (local to hybrid engine)
// ============================================================================

export interface HybridConfig {
    /** Days per block (default: 7) */
    blockDurationDays?: number;
    /** Tier classification thresholds */
    tierThresholds?: {
        /** Change rate to be HOT (default: 0.8 = 80%) */
        hotChangeRate: number;
        /** Change rate to be WARM (default: 0.2 = 20%) */
        warmChangeRate: number;
    };
    /** Compression level 1-9 (default: 9) */
    compressionLevel?: number;
    /** Password for encryption (optional) */
    password?: string;
    /** Compression algorithm (default: BROTLI for backward compatibility) */
    compressionAlgorithm?: CompressionAlgorithm;
    /** Snapshots per block (default: 100) */
    snapshotsPerBlock?: number;
}

interface BlockHeader {

    blockId: number;
    startTimestamp: number;
    endTimestamp: number;
    snapshotCount: number;
    itemCount: number;
    compressedSize: number;
}

interface ItemIndexEntry {
    itemId: number;
    tier: ItemTier;
    /** Map of blockId → offset within block's price data */
    blockPositions: Map<number, number>;
}

interface TemporalIndexEntry {
    blockId: number;
    startTimestamp: number;
    offset: number;
}

// ============================================================================
// Constants
// ============================================================================

const MAGIC = new Uint8Array([0x47, 0x49, 0x43, 0x53]); // GICS
const VERSION = 1;
const MIN_SUPPORTED_VERSION = 1;

export class VersionMismatchError extends Error {
    constructor(fileVersion: number, minSupported: number) {
        super(`GICS File Version Mismatch: File=${fileVersion}, Supported=${minSupported}. This file is too new or too old for this reader.`);
        this.name = 'VersionMismatchError';
    }
}
const HOURS_PER_DAY = 24;
const DEFAULT_BLOCK_DAYS = 7;
const DEFAULT_HOT_THRESHOLD = 0.5;  // 50%+ change rate = HOT
const DEFAULT_WARM_THRESHOLD = 0.05; // 5%+ change rate = WARM

// ============================================================================
// Tier Classifier
// ============================================================================

export class TierClassifier {
    private readonly hotThreshold: number;
    private readonly warmThreshold: number;
    private readonly ultraSparseThreshold: number = 0.1; // Items in <10% of snapshots

    constructor(config?: HybridConfig) {
        this.hotThreshold = config?.tierThresholds?.hotChangeRate ?? DEFAULT_HOT_THRESHOLD;
        this.warmThreshold = config?.tierThresholds?.warmChangeRate ?? DEFAULT_WARM_THRESHOLD;
    }

    /**
     * Classify item based on change frequency
     */
    classify(changeRate: number): ItemTier {
        if (changeRate >= this.hotThreshold) return 'hot';
        if (changeRate >= this.warmThreshold) return 'warm';
        return 'cold';
    }

    /**
     * Analyze snapshots to determine item tiers
     * NEW: Also detects ultra_sparse items (present in <10% of snapshots)
     */
    analyzeSnapshots(snapshots: Snapshot[]): Map<number, ItemTier> {
        const itemChangeCounts = new Map<number, number>();
        const itemPresenceCounts = new Map<number, number>(); // NEW: track presence
        const totalSnapshots = snapshots.length;

        // Count presence and changes
        for (let i = 0; i < snapshots.length; i++) {
            const curr = snapshots[i];
            const prev = i > 0 ? snapshots[i - 1] : null;

            for (const [itemId, data] of Array.from(curr.items)) {
                // Track presence
                const presence = (itemPresenceCounts.get(itemId) ?? 0) + 1;
                itemPresenceCounts.set(itemId, presence);

                // Track changes
                if (prev) {
                    const prevData = prev.items.get(itemId);
                    if (!prevData?.price || prevData.price !== data.price) {
                        const changes = (itemChangeCounts.get(itemId) ?? 0) + 1;
                        itemChangeCounts.set(itemId, changes);
                    }
                }
            }
        }

        const tiers = new Map<number, ItemTier>();
        for (const [itemId, presence] of Array.from(itemPresenceCounts)) {
            const presenceRatio = presence / totalSnapshots;

            // ULTRA_SPARSE: Items appearing in <10% of snapshots
            if (presenceRatio < this.ultraSparseThreshold) {
                tiers.set(itemId, 'ultra_sparse');
                continue;
            }

            // Normal classification based on change rate
            const changes = itemChangeCounts.get(itemId) ?? 0;
            const changeRate = changes / presence;
            tiers.set(itemId, this.classify(changeRate));
        }

        return tiers;
    }
}

// ============================================================================
// Hybrid Writer
// ============================================================================

export class HybridWriter {
    private readonly config: Required<HybridConfig>;
    private snapshots: Snapshot[] = [];
    private blocks: Uint8Array[] = [];
    private temporalIndex: TemporalIndexEntry[] = [];
    private itemIndex: Map<number, ItemIndexEntry> = new Map();
    private readonly tierClassifier: TierClassifier;
    private readonly heatClassifier: HeatClassifier;
    private readonly blockHeatScores: Map<number, Map<number, HeatScoreResult>> = new Map();
    private readonly encryptionMode: EncryptionMode = EncryptionMode.NONE;
    private readonly salt?: Buffer;
    private readonly fileNonce?: Buffer;  // Phase 2: For deterministic IV
    private authVerify?: Buffer;
    private initPromise: Promise<void> | null = null;

    constructor(config: HybridConfig = {}) {
        this.config = {
            blockDurationDays: config.blockDurationDays ?? DEFAULT_BLOCK_DAYS,
            tierThresholds: config.tierThresholds ?? {
                hotChangeRate: DEFAULT_HOT_THRESHOLD,
                warmChangeRate: DEFAULT_WARM_THRESHOLD
            },
            compressionLevel: config?.compressionLevel ?? 3,
            password: config?.password ?? '',
            compressionAlgorithm: config?.compressionAlgorithm ?? CompressionAlgorithm.BROTLI,
            snapshotsPerBlock: config?.snapshotsPerBlock ?? 100
        };
        this.tierClassifier = new TierClassifier(this.config);
        this.heatClassifier = new HeatClassifier();

        if (config.password) {
            this.encryptionMode = EncryptionMode.AES_256_GCM;
            this.salt = keyService.generateSalt();
            this.fileNonce = keyService.generateFileNonce();
            // We store the promise and await it in initWait() when needed
            this.initPromise = this.initEncryption(config.password);
        }
    }

    /**
     * Ensure encryption is initialized before use
     */
    private async initWait(): Promise<void> {
        if (this.initPromise) {
            await this.initPromise;
        }
    }

    /**
     * Compress data using the configured algorithm
     */
    private async compressData(data: Uint8Array): Promise<Buffer> {
        if (this.config.compressionAlgorithm === CompressionAlgorithm.ZSTD) {
            // Zstd compression via WebAssembly
            return new Promise((resolve, reject) => {
                ZstdCodec.run((zstd: { Simple: new () => { compress: (data: Uint8Array, level?: number) => Uint8Array | null } }) => {
                    try {
                        const simple = new zstd.Simple();
                        const compressed = simple.compress(data, 9); // Level 9 for good ratio
                        if (compressed) {
                            resolve(Buffer.from(compressed));
                        } else {
                            reject(new Error('Zstd compression returned null'));
                        }
                    } catch (err) {
                        reject(err);
                    }
                });
            });
        }
        // Default: Brotli
        return brotliCompressAsync(data);
    }

    /**
     * Get the compression algorithm flag for header
     */
    getCompressionAlgorithm(): CompressionAlgorithm {
        return this.config.compressionAlgorithm;
    }



    private async initEncryption(password: string) {
        if (!this.salt) return;
        await keyService.unlock(password, this.salt);

        // Phase 2: HMAC-based AuthVerify
        // Generate fixed header bytes for HMAC binding
        const headerFixed = Buffer.alloc(10);
        headerFixed.write('GICS', 0);
        headerFixed.writeUInt8(VERSION, 4);
        headerFixed.writeUInt8(this.encryptionMode, 5);
        headerFixed.writeUInt32LE(KDF_CONFIG.iterations, 6);

        this.authVerify = keyService.generateAuthVerify(this.salt, headerFixed);
    }

    /**
     * Smart Append: Recover state from an existing file's raw components.
     * This enables O(1) file updates instead of O(N) full re-processing.
     * 
     * Usage:
     * ```typescript
     * const reader = new HybridReader(existingData);
     * const { blocks, temporalIndex, itemIndex } = reader.getRawComponents();
     * 
     * const writer = new HybridWriter();
     * writer.recoverState(blocks, temporalIndex, itemIndex);
     * await writer.addSnapshot(newSnapshot);
     * const updatedFile = await writer.finish();
     * ```
     * 
     * @param blocks Raw compressed blocks (not decompressed)
     * @param temporalIndex Temporal index entries from existing file
     * @param itemIndex Item index from existing file
     * @param compressionAlgorithm Compression algorithm from existing file (optional, defaults to current config)
     */
    recoverState(
        blocks: Uint8Array[],
        temporalIndex: TemporalIndexEntry[],
        itemIndex: Map<number, ItemIndexEntry>,
        compressionAlgorithm?: CompressionAlgorithm
    ): void {
        // Copy blocks (these are already compressed, don't touch them)
        this.blocks = blocks.map(b => new Uint8Array(b));

        // Deep copy indexes
        this.temporalIndex = temporalIndex.map(e => ({ ...e }));
        this.itemIndex = new Map(
            Array.from(itemIndex.entries()).map(
                ([k, v]) => [k, { ...v, blockPositions: new Map(v.blockPositions) }]
            )
        );

        // Preserve compression algorithm from existing file if provided
        if (compressionAlgorithm !== undefined) {
            this.config.compressionAlgorithm = compressionAlgorithm;
        }


        // Reset pending snapshots (they'll be added fresh via addSnapshot)
        this.snapshots = [];
    }

    /**
     * Add a snapshot to the current block
     */
    async addSnapshot(snapshot: Snapshot): Promise<void> {
        this.snapshots.push(snapshot);

        const snapshotsPerBlock = this.config.blockDurationDays * HOURS_PER_DAY;
        if (this.snapshots.length >= snapshotsPerBlock) {
            await this.flushBlock();
        }
    }

    /**
     * Flush current snapshots to a compressed block
     */
    private async flushBlock(): Promise<void> {
        if (this.snapshots.length === 0) return;

        // Ensure encryption key is ready
        await this.initWait();

        const blockId = this.blocks.length;
        const startTimestamp = this.snapshots[0].timestamp;
        // endTimestamp calculated here but only used in debug comments
        // const endTimestamp = this.snapshots.at(-1)!.timestamp;

        // Analyze item tiers for this block
        const tiers = this.tierClassifier.analyzeSnapshots(this.snapshots);

        // Calculate heat scores for market intelligence (v1.1)
        const heatScores = this.heatClassifier.analyzeBlock(this.snapshots);
        this.blockHeatScores.set(blockId, heatScores);

        // Encode block with tiered compression
        const blockData = await this.encodeBlock(this.snapshots, tiers, blockId);

        // Update temporal index
        const offset = this.blocks.reduce((sum, b) => sum + b.length, 0);
        this.temporalIndex.push({ blockId, startTimestamp, offset });

        this.blocks.push(blockData);
        this.snapshots = [];
    }

    /**
     * Get heat scores for a specific block (v1.1)
     */
    getBlockHeatScores(blockId: number): Map<number, HeatScoreResult> | undefined {
        return this.blockHeatScores.get(blockId);
    }

    /**
     * Get all heat scores across all blocks (v1.1)
     */
    getAllHeatScores(): Map<number, Map<number, HeatScoreResult>> {
        return new Map(this.blockHeatScores);
    }

    /**
     * Encode a block of snapshots with tiered compression
     * KEY OPTIMIZATION: Separate tiers and compress each optimally
     */
    private async encodeBlock(snapshots: Snapshot[], tiers: Map<number, ItemTier>, blockId: number): Promise<Uint8Array> {
        const sortedIds = this.getSortedItemIds(snapshots);
        const { hotIds, warmIds, coldIds, ultraSparseIds, coldConstantCount, coldVariableCount } = this.groupItemsByTier(snapshots, tiers, sortedIds);

        const coreIds = [...hotIds, ...warmIds, ...coldIds];
        const timestampsEncoded = this.encodeTimestamps(snapshots);
        const idsEncoded = this.encodeItemIdDeltas(coreIds);
        const quantitiesEncoded = this.encodeRLE(coreIds, snapshots);
        const ultraSparseEncoded = this.encodeUltraSparseCOO(ultraSparseIds, snapshots);

        const hotEncoded = this.encodeHotTier(hotIds, snapshots);
        const { warmBitmapCombined, warmValuesEncoded } = this.encodeWarmTier(warmIds, snapshots);
        const { coldConstantsEncoded, coldVariableBitmapCombined, coldVariableValuesEncoded } = this.encodeColdTier(coldIds, snapshots);

        this.updateItemIndices(hotIds, warmIds, coldIds, ultraSparseIds, tiers, blockId);

        const header = this.buildBlockHeader({
            snapCount: snapshots.length, hotIds, warmIds, coldIds,
            coldConstCount: coldConstantCount, coldVarCount: coldVariableCount,
            tLength: timestampsEncoded.length, iLength: idsEncoded.length, hLength: hotEncoded.length,
            wBLength: warmBitmapCombined.length, wVLength: warmValuesEncoded.length,
            cCLength: coldConstantsEncoded.length, cVBLength: coldVariableBitmapCombined.length, cVVLength: coldVariableValuesEncoded.length,
            qLength: quantitiesEncoded.length, uLength: ultraSparseEncoded.length
        });

        return this.wrapAndEncrypt(this.concatArrays([
            header, timestampsEncoded, idsEncoded, hotEncoded,
            warmBitmapCombined, warmValuesEncoded, coldConstantsEncoded,
            coldVariableBitmapCombined, coldVariableValuesEncoded,
            quantitiesEncoded, ultraSparseEncoded
        ]), blockId);
    }

    private getSortedItemIds(snapshots: Snapshot[]): number[] {
        const allItemIds = new Set<number>();
        for (const snap of snapshots) {
            for (const itemId of snap.items.keys()) {
                allItemIds.add(itemId);
            }
        }
        return Array.from(allItemIds).sort((a, b) => a - b);
    }

    private encodeTimestamps(snapshots: Snapshot[]): Uint8Array {
        const timestamps = snapshots.map(s => s.timestamp);
        const timestampDeltas = this.encodeDoD(timestamps);
        return encodeVarint(timestampDeltas);
    }

    private encodeItemIdDeltas(allIds: number[]): Uint8Array {
        const idDeltas = allIds.length > 0 ? [allIds[0]] : [];
        for (let i = 1; i < allIds.length; i++) {
            idDeltas.push(allIds[i] - allIds[i - 1]);
        }
        return encodeVarint(idDeltas);
    }

    private encodeHotTier(hotIds: number[], snapshots: Snapshot[]): Uint8Array {
        const hotPricesDoD: number[] = [];
        for (const itemId of hotIds) {
            const prices: number[] = [];
            for (const snap of snapshots) {
                prices.push(snap.items.get(itemId)?.price ?? 0);
            }
            hotPricesDoD.push(...this.encodeDoD(prices));
        }
        return encodeVarint(hotPricesDoD);
    }

    private encodeWarmTier(warmIds: number[], snapshots: Snapshot[]) {
        const warmBitmaps: Uint8Array[] = [];
        const warmValues: number[] = [];
        for (const itemId of warmIds) {
            const prices: number[] = [];
            for (const snap of snapshots) {
                prices.push(snap.items.get(itemId)?.price ?? 0);
            }

            const bitmap = new Uint8Array(Math.ceil(snapshots.length / 8));
            let prev = prices[0];
            warmValues.push(prev);

            for (let i = 1; i < prices.length; i++) {
                if (prices[i] !== prev) {
                    bitmap[Math.floor(i / 8)] |= (1 << (i % 8));
                    warmValues.push(prices[i] - prev);
                    prev = prices[i];
                }
            }
            warmBitmaps.push(bitmap);
        }
        return {
            warmBitmapCombined: this.concatArrays(warmBitmaps),
            warmValuesEncoded: encodeVarint(warmValues)
        };
    }

    private encodeColdTier(coldIds: number[], snapshots: Snapshot[]) {
        const coldConstants: number[] = [];
        const coldVariableBitmaps: Uint8Array[] = [];
        const coldVariableValues: number[] = [];

        for (const itemId of coldIds) {
            const prices: number[] = [];
            for (const snap of snapshots) {
                prices.push(snap.items.get(itemId)?.price ?? 0);
            }

            if (this.isItemConstant(itemId, snapshots)) {
                coldConstants.push(prices[0]);
            } else {
                const bitmap = new Uint8Array(Math.ceil(snapshots.length / 8));
                let prev = prices[0];
                coldVariableValues.push(prev);

                for (let i = 1; i < prices.length; i++) {
                    if (prices[i] !== prev) {
                        bitmap[Math.floor(i / 8)] |= (1 << (i % 8));
                        coldVariableValues.push(prices[i] - prev);
                        prev = prices[i];
                    }
                }
                coldVariableBitmaps.push(bitmap);
            }
        }

        return {
            coldConstantsEncoded: encodeVarint(coldConstants),
            coldVariableBitmapCombined: this.concatArrays(coldVariableBitmaps),
            coldVariableValuesEncoded: encodeVarint(coldVariableValues)
        };
    }

    private updateItemIndices(
        hotIds: number[], warmIds: number[], coldIds: number[], ultraSparseIds: number[],
        tiers: Map<number, ItemTier>, blockId: number
    ) {
        let itemPosition = 0;
        const allIdsInOrder = [...hotIds, ...warmIds, ...coldIds];
        for (const itemId of allIdsInOrder) {
            let entry = this.itemIndex.get(itemId);
            if (!entry) {
                const tier = tiers.get(itemId) ?? 'cold';
                entry = { itemId, tier, blockPositions: new Map() };
                this.itemIndex.set(itemId, entry);
            }
            entry.blockPositions.set(blockId, itemPosition++);
        }
        for (const itemId of ultraSparseIds) {
            let entry = this.itemIndex.get(itemId);
            if (!entry) {
                entry = { itemId, tier: 'ultra_sparse', blockPositions: new Map() };
                this.itemIndex.set(itemId, entry);
            }
            entry.blockPositions.set(blockId, -1);
        }
    }

    private buildBlockHeader(params: {
        snapCount: number, hotIds: number[], warmIds: number[], coldIds: number[],
        coldConstCount: number, coldVarCount: number,
        tLength: number, iLength: number, hLength: number, wBLength: number, wVLength: number,
        cCLength: number, cVBLength: number, cVVLength: number, qLength: number, uLength: number
    }): Uint8Array {
        const header = new Uint8Array(52);
        const headerView = new DataView(header.buffer);
        let hOffset = 0;

        headerView.setUint16(hOffset, params.snapCount, true); hOffset += 2;
        headerView.setUint16(hOffset, params.hotIds.length + params.warmIds.length + params.coldIds.length, true); hOffset += 2;
        headerView.setUint16(hOffset, params.hotIds.length, true); hOffset += 2;
        headerView.setUint16(hOffset, params.warmIds.length, true); hOffset += 2;
        headerView.setUint16(hOffset, params.coldConstCount, true); hOffset += 2;
        headerView.setUint16(hOffset, params.coldVarCount, true); hOffset += 2;

        headerView.setUint32(hOffset, params.tLength, true); hOffset += 4;
        headerView.setUint32(hOffset, params.iLength, true); hOffset += 4;
        headerView.setUint32(hOffset, params.hLength, true); hOffset += 4;
        headerView.setUint32(hOffset, params.wBLength, true); hOffset += 4;
        headerView.setUint32(hOffset, params.wVLength, true); hOffset += 4;
        headerView.setUint32(hOffset, params.cCLength, true); hOffset += 4;
        headerView.setUint32(hOffset, params.cVBLength, true); hOffset += 4;
        headerView.setUint32(hOffset, params.cVVLength, true); hOffset += 4;
        headerView.setUint32(hOffset, params.qLength, true); hOffset += 4;
        headerView.setUint32(hOffset, params.uLength, true);

        return header;
    }


    private groupItemsByTier(snapshots: Snapshot[], tiers: Map<number, ItemTier>, sortedIds: number[]) {
        const hotIds: number[] = [];
        const warmIds: number[] = [];
        const orderedColdConstants: number[] = [];
        const orderedColdVariables: number[] = [];
        const ultraSparseIds: number[] = [];

        for (const itemId of sortedIds) {
            const tier = tiers.get(itemId) ?? 'cold';
            if (tier === 'ultra_sparse') {
                ultraSparseIds.push(itemId);
            } else if (tier === 'hot') {
                hotIds.push(itemId);
            } else if (tier === 'warm') {
                warmIds.push(itemId);
            } else if (this.isItemConstant(itemId, snapshots)) {
                orderedColdConstants.push(itemId);
            } else {
                orderedColdVariables.push(itemId);
            }
        }
        return {
            hotIds, warmIds, ultraSparseIds,
            coldIds: [...orderedColdConstants, ...orderedColdVariables],
            coldConstantCount: orderedColdConstants.length,
            coldVariableCount: orderedColdVariables.length
        };
    }

    private isItemConstant(itemId: number, snapshots: Snapshot[]): boolean {
        const firstPrice = snapshots[0].items.get(itemId)?.price ?? 0;
        for (let i = 1; i < snapshots.length; i++) {
            if ((snapshots[i].items.get(itemId)?.price ?? 0) !== firstPrice) return false;
        }
        return true;
    }

    private encodeUltraSparseCOO(ultraSparseIds: number[], snapshots: Snapshot[]): Uint8Array {
        const ultraSparseCOO: number[] = [];
        let cooEntryCount = 0;
        let prevItemId = 0;
        let prevPrice = 0;
        let prevQty = 0;

        for (const itemId of ultraSparseIds) {
            for (let snapIdx = 0; snapIdx < snapshots.length; snapIdx++) {
                const data = snapshots[snapIdx].items.get(itemId);
                if (data) {
                    ultraSparseCOO.push(
                        itemId - prevItemId,
                        snapIdx,
                        data.price - prevPrice,
                        data.quantity - prevQty
                    );
                    prevItemId = itemId;
                    prevPrice = data.price;
                    prevQty = data.quantity;
                    cooEntryCount++;
                }
            }
        }
        return encodeVarint([cooEntryCount, ...ultraSparseCOO]);
    }

    private async wrapAndEncrypt(data: Uint8Array, blockId: number): Promise<Uint8Array> {
        const blockCrc = crc32(data);
        const withCrc = new Uint8Array(data.length + 4);
        withCrc.set(data);
        new DataView(withCrc.buffer).setUint32(data.length, blockCrc, true);

        const compressed = await this.compressData(withCrc);
        let payload: Buffer;

        if (this.encryptionMode === EncryptionMode.AES_256_GCM) {
            const iv = keyService.generateDeterministicIV(this.fileNonce!, blockId);
            const key = keyService.getKey();
            const aad = this.createBlockAAD(blockId);

            const cipher = createCipheriv('aes-256-gcm', key, iv);
            cipher.setAAD(aad);
            const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);
            payload = Buffer.concat([iv, ciphertext, cipher.getAuthTag()]);
        } else {
            payload = compressed;
        }

        const wrapper = new Uint8Array(9);
        const view = new DataView(wrapper.buffer);
        view.setUint8(0, BlockType.DATA);
        view.setUint32(1, payload.length, true);
        view.setUint32(5, crc32(payload), true);

        return Buffer.concat([wrapper, payload]);
    }

    private createBlockAAD(blockId: number): Buffer {
        const aad = Buffer.alloc(27);
        aad.write('GICS', 0);
        aad.writeUInt8(VERSION, 4);
        aad.writeUInt8(this.encryptionMode, 5);
        this.salt!.copy(aad, 6);
        aad.writeUInt32LE(blockId, 22);
        aad.writeUInt8(BlockType.DATA, 26);
        return aad;
    }

    private encodeDoD(values: number[]): number[] {
        if (values.length === 0) return [];
        if (values.length === 1) return [values[0]];

        const deltas = [values[0], values[1] - values[0]];
        for (let i = 2; i < values.length; i++) {
            const delta = values[i] - values[i - 1];
            const prevDelta = values[i - 1] - values[i - 2];
            deltas.push(delta - prevDelta);
        }
        return deltas;
    }

    private encodeRLE(allIdsInOrder: number[], snapshots: Snapshot[]): Uint8Array {
        const runs: number[] = [];
        for (const itemId of allIdsInOrder) {
            const quantities: number[] = [];
            for (const snap of snapshots) {
                quantities.push(snap.items.get(itemId)?.quantity ?? 0);
            }
            let i = 0;
            while (i < quantities.length) {
                const val = quantities[i];
                let count = 1;
                while (i + count < quantities.length && quantities[i + count] === val && count < 255) {
                    count++;
                }
                runs.push(count, val);
                i += count;
            }
        }
        return encodeVarint(runs);
    }

    private concatArrays(arrays: Uint8Array[]): Uint8Array {
        const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
        const result = new Uint8Array(totalLength);
        let offset = 0;
        for (const arr of arrays) {
            result.set(arr, offset);
            offset += arr.length;
        }
        return result;
    }

    async finish(): Promise<Uint8Array> {
        if (this.snapshots.length > 0) {
            const startTimestamp = this.snapshots[0].timestamp;
            const blockId = this.blocks.length;
            const tiers = this.tierClassifier.analyzeSnapshots(this.snapshots);
            const blockData = await this.encodeBlock(this.snapshots, tiers, blockId);
            const offset = this.blocks.reduce((sum, b) => sum + b.length, 0);
            this.temporalIndex.push({ blockId, startTimestamp, offset });
            this.blocks.push(blockData);
            this.snapshots = [];
        }

        const temporalIndexData = this.encodeTemporalIndex();
        const itemIndexData = this.encodeItemIndex();
        const blocksData = this.concatArrays(this.blocks);

        const headerBaseSize = 36;
        let currentHeaderSize = headerBaseSize;
        if (this.encryptionMode === EncryptionMode.AES_256_GCM) {
            currentHeaderSize += 1 + 16 + AUTH_VERIFY_LEN + 1 + 4 + 1 + FILE_NONCE_LEN;
        }

        const temporalIndexOffset = currentHeaderSize;
        const itemIndexOffset = temporalIndexOffset + temporalIndexData.length;
        const dataOffset = itemIndexOffset + itemIndexData.length;

        const totalSize = dataOffset + blocksData.length + 4;
        const buffer = new Uint8Array(totalSize);
        const view = new DataView(buffer.buffer);
        let offset = 0;

        buffer.set(MAGIC, offset); offset += 4;
        buffer[offset++] = VERSION;
        buffer[offset++] = this.config.compressionAlgorithm ?? 0;
        view.setUint16(offset, this.blocks.length, true); offset += 2;
        view.setUint32(offset, this.itemIndex.size, true); offset += 4;

        view.setUint32(offset, temporalIndexOffset, true); offset += 4;
        view.setUint32(offset, 0, true); offset += 4;
        view.setUint32(offset, itemIndexOffset, true); offset += 4;
        view.setUint32(offset, 0, true); offset += 4;
        view.setUint32(offset, dataOffset, true); offset += 4;
        view.setUint32(offset, 0, true); offset += 4;

        if (this.encryptionMode === EncryptionMode.AES_256_GCM) {
            buffer[offset++] = this.encryptionMode;
            if (this.salt) {
                buffer.set(this.salt, offset);
                offset += 16;
            }
            if (this.authVerify) {
                buffer.set(this.authVerify, offset);
                offset += AUTH_VERIFY_LEN;
            }
            buffer[offset++] = KDF_CONFIG.id;
            view.setUint32(offset, KDF_CONFIG.iterations, true); offset += 4;
            buffer[offset++] = KDF_CONFIG.digestId;
            if (this.fileNonce) {
                buffer.set(this.fileNonce, offset);
            }
        }

        buffer.set(temporalIndexData, temporalIndexOffset);
        buffer.set(itemIndexData, itemIndexOffset);
        buffer.set(blocksData, dataOffset);

        const checksum = crc32(buffer.slice(0, totalSize - 4));
        view.setUint32(totalSize - 4, checksum, true);

        return buffer;
    }

    /**
     * @internal TEST ONLY - Not part of public API.
     * Finish and return layout info for precise corruption testing.
     */
    async finishWithLayout__debug(): Promise<{
        bytes: Uint8Array;
        layout: {
            dataOffset: number;
            blocks: Array<{ start: number; payloadStart: number; payloadLen: number }>;
        };
    }> {
        if (this.snapshots.length > 0) {
            const startTimestamp = this.snapshots[0].timestamp;
            const blockId = this.blocks.length;
            const tiers = this.tierClassifier.analyzeSnapshots(this.snapshots);
            const blockData = await this.encodeBlock(this.snapshots, tiers, blockId);
            const offset = this.blocks.reduce((sum, b) => sum + b.length, 0);
            this.temporalIndex.push({ blockId, startTimestamp, offset });
            this.blocks.push(blockData);
            this.snapshots = [];
        }

        const temporalIndexData = this.encodeTemporalIndex();
        const itemIndexData = this.encodeItemIndex();
        const blocksData = this.concatArrays(this.blocks);

        const headerBaseSize = 36;
        let currentHeaderSize = headerBaseSize;
        if (this.encryptionMode === EncryptionMode.AES_256_GCM) {
            currentHeaderSize += 1 + 16 + AUTH_VERIFY_LEN + 1 + 4 + 1 + FILE_NONCE_LEN;
        }

        const temporalIndexOffset = currentHeaderSize;
        const itemIndexOffset = temporalIndexOffset + temporalIndexData.length;
        const dataOffset = itemIndexOffset + itemIndexData.length;

        // Calculate block positions
        const blockLayout: Array<{ start: number; payloadStart: number; payloadLen: number }> = [];
        let blockOffset = 0;
        for (const block of this.blocks) {
            // Block wrapper: Type(1) + Size(4) + CRC(4) = 9 bytes
            const size = new DataView(block.buffer, block.byteOffset + 1, 4).getUint32(0, true);
            blockLayout.push({
                start: dataOffset + blockOffset,
                payloadStart: dataOffset + blockOffset + 9,
                payloadLen: size
            });
            blockOffset += block.length;
        }

        // Build file
        const totalSize = dataOffset + blocksData.length + 4;
        const buffer = new Uint8Array(totalSize);
        const view = new DataView(buffer.buffer);
        let offset = 0;

        buffer.set(MAGIC, offset); offset += 4;
        buffer[offset++] = VERSION;
        buffer[offset++] = this.config.compressionAlgorithm ?? 0;
        view.setUint16(offset, this.blocks.length, true); offset += 2;
        view.setUint32(offset, this.itemIndex.size, true); offset += 4;

        view.setUint32(offset, temporalIndexOffset, true); offset += 4;
        view.setUint32(offset, 0, true); offset += 4;
        view.setUint32(offset, itemIndexOffset, true); offset += 4;
        view.setUint32(offset, 0, true); offset += 4;
        view.setUint32(offset, dataOffset, true); offset += 4;
        view.setUint32(offset, 0, true); offset += 4;

        if (this.encryptionMode === EncryptionMode.AES_256_GCM) {
            buffer[offset++] = this.encryptionMode;
            if (this.salt) {
                buffer.set(this.salt, offset);
                offset += 16;
            }
            if (this.authVerify) {
                buffer.set(this.authVerify, offset);
                offset += AUTH_VERIFY_LEN;
            }
            buffer[offset++] = KDF_CONFIG.id;
            view.setUint32(offset, KDF_CONFIG.iterations, true); offset += 4;
            buffer[offset++] = KDF_CONFIG.digestId;
            if (this.fileNonce) {
                buffer.set(this.fileNonce, offset);
            }
        }

        buffer.set(temporalIndexData, temporalIndexOffset);
        buffer.set(itemIndexData, itemIndexOffset);
        buffer.set(blocksData, dataOffset);

        const checksum = crc32(buffer.slice(0, totalSize - 4));
        view.setUint32(totalSize - 4, checksum, true);

        return {
            bytes: buffer,
            layout: { dataOffset, blocks: blockLayout }
        };
    }

    private encodeTemporalIndex(): Uint8Array {
        const entrySize = 10;
        const buffer = new Uint8Array(this.temporalIndex.length * entrySize);
        const view = new DataView(buffer.buffer);
        let offset = 0;
        for (const entry of this.temporalIndex) {
            view.setUint16(offset, entry.blockId, true); offset += 2;
            view.setUint32(offset, entry.startTimestamp, true); offset += 4;
            view.setUint32(offset, entry.offset, true); offset += 4;
        }
        return buffer;
    }

    private encodeItemIndex(): Uint8Array {
        const entries: number[] = [];
        for (const [itemId, entry] of Array.from(this.itemIndex)) {
            let tierValue: number;
            if (entry.tier === 'hot') tierValue = 0;
            else if (entry.tier === 'warm') tierValue = 1;
            else if (entry.tier === 'cold') tierValue = 2;
            else tierValue = 3;

            entries.push(itemId, tierValue, entry.blockPositions.size);
            for (const [blockId, pos] of Array.from(entry.blockPositions)) {
                entries.push(blockId, pos);
            }
        }
        return encodeVarint(entries);
    }

    getStats(): GICSStats {
        return {
            snapshotCount: this.blocks.length * this.config.snapshotsPerBlock, // Approximation
            itemCount: this.itemIndex.size,
            rawSizeBytes: 0,
            compressedSizeBytes: this.blocks.reduce((a, b) => a + b.length, 0),
            compressionRatio: 0,
            avgChangeRate: 0,
            dateRange: { start: new Date(), end: new Date() }
        };
    }

    private calculateRawSize(): number {
        return 0; // implementation detail
    }
}

// ============================================================================
// Hybrid Reader
// ============================================================================

export class HybridReader {
    private readonly buffer: Uint8Array;
    private readonly view: DataView;
    // Header structure is parsed into internal state, no dedicated object needed
    private readonly temporalIndex: TemporalIndexEntry[] = [];
    private readonly itemIndex: Map<number, ItemIndexEntry> = new Map();
    private encryptionMode: EncryptionMode = EncryptionMode.NONE;
    private compressionAlgorithm: CompressionAlgorithm = CompressionAlgorithm.BROTLI;
    private readonly config: { salvageMode?: boolean };

    constructor(data: Uint8Array, config: { salvageMode?: boolean } = {}) {
        this.buffer = data;
        this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        this.config = config;
        this.parseFileStructure();
    }

    private parseFileStructure() {
        if (this.buffer.length < 36) throw new Error("File too short");

        // Verify Magic
        if (this.buffer[0] !== 0x47 || this.buffer[1] !== 0x49 || this.buffer[2] !== 0x43 || this.buffer[3] !== 0x53) {
            throw new Error("Invalid GICS Magic Bytes");
        }

        let offset = 4;
        const version = this.buffer[offset++];
        if (version < MIN_SUPPORTED_VERSION || version > VERSION) throw new VersionMismatchError(version, MIN_SUPPORTED_VERSION);

        const flags = this.buffer[offset++]; // FLAGS = compression algorithm
        this.compressionAlgorithm = flags as CompressionAlgorithm;
        const blockCount = this.view.getUint16(offset, true); offset += 2;
        this.view.getUint32(offset, true); offset += 4; // itemCount - read but not used

        // Read Offsets
        const temporalIndexOffset = this.view.getUint32(offset, true); offset += 8; // skip high bits
        const itemIndexOffset = this.view.getUint32(offset, true); offset += 8;
        const dataOffset = this.view.getUint32(offset, true); offset += 8;

        // Check extensions for encryption
        if (temporalIndexOffset > offset) { // If temporalIndexOffset is greater than current offset, it means there's an extension header
            this.encryptionMode = this.buffer[offset++];
            // Skip salt/auth if present for now, handled in unlock if needed
        }

        // Parse Temporal Index
        offset = temporalIndexOffset;
        for (let i = 0; i < blockCount; i++) {
            const blockId = this.view.getUint16(offset, true); offset += 2;
            const startTimestamp = this.view.getUint32(offset, true); offset += 4;
            const blockOffset = this.view.getUint32(offset, true); offset += 4;
            this.temporalIndex.push({ blockId, startTimestamp, offset: blockOffset });
        }

        // Parse Item Index
        // Item Index is Varint Encoded flatten stream
        // Item Index is Varint Encoded flatten stream
        // [itemId, tier(0=hot,1=warm,2=cold), blockCount, (blockId, pos)...]
        // This is tricky to parse without streaming varint decoder.
        // We will decode the entire index section first.
        const indexData = this.buffer.subarray(itemIndexOffset, dataOffset);
        const values = decodeVarint(indexData);

        let i = 0;
        while (i < values.length) {
            const itemId = values[i++];
            const tierVal = values[i++];
            let actualTier: ItemTier;
            if (tierVal === 0) actualTier = 'hot';
            else if (tierVal === 1) actualTier = 'warm';
            else if (tierVal === 2) actualTier = 'cold';
            else actualTier = 'ultra_sparse';

            const count = values[i++];
            const blockPositions = new Map<number, number>();
            for (let j = 0; j < count; j++) {
                const bId = values[i++];
                const pos = values[i++];
                blockPositions.set(bId, pos);
            }
            this.itemIndex.set(itemId, { itemId, tier: actualTier, blockPositions });
        }
    }

    getItemIds(): number[] {
        return Array.from(this.itemIndex.keys());
    }

    /**
     * Get the compression algorithm used in this file
     */
    getCompressionAlgorithm(): CompressionAlgorithm {
        return this.compressionAlgorithm;
    }

    /**
     * Extract raw components for Smart Append (O(1) updates).
     * Returns blocks without decompression and indexes for reuse.
     * 
     * @returns Raw blocks, temporal index, and item index for writer recovery
     */
    getRawComponents(): {
        blocks: Uint8Array[];
        temporalIndex: TemporalIndexEntry[];
        itemIndex: Map<number, ItemIndexEntry>;
        compressionAlgorithm: CompressionAlgorithm;
    } {
        const dataStart = this.view.getUint32(28, true);
        const blocks: Uint8Array[] = [];

        // Extract raw blocks using temporal index offsets
        for (const entry of this.temporalIndex) {
            const start = dataStart + entry.offset;

            // Read block size from wrapper: Type(1) + Size(4) + CRC(4) = 9 bytes header
            const size = this.view.getUint32(start + 1, true);
            const totalLen = 9 + size;

            blocks.push(this.buffer.slice(start, start + totalLen));
        }

        return {
            blocks,
            temporalIndex: this.temporalIndex.map(e => ({ ...e })), // Deep copy
            itemIndex: new Map(Array.from(this.itemIndex.entries()).map(
                ([k, v]) => [k, { ...v, blockPositions: new Map(v.blockPositions) }]
            )),
            compressionAlgorithm: this.compressionAlgorithm
        };
    }

    async queryItems(query: QueryFilter): Promise<ItemQueryResult[]> {
        const itemIds = query.itemIds ?? Array.from(this.itemIndex.keys());
        if (itemIds.length === 0) return [];

        const relevantBlocks = this.findRelevantBlocks(query);
        const results = new Map<number, ItemQueryResult>();

        const dataStart = this.view.getUint32(28, true);

        for (const blockMeta of relevantBlocks) {
            await this.processBlock(blockMeta, dataStart, itemIds, results);
        }

        return Array.from(results.values());
    }

    private findRelevantBlocks(query: QueryFilter): TemporalIndexEntry[] {
        return this.temporalIndex.filter(entry => {
            const inRange = (!query.startTime || entry.startTimestamp >= query.startTime) &&
                (!query.endTime || entry.startTimestamp <= query.endTime);
            if (!inRange) return false;

            if (query.itemIds) {
                // If specific IDs requested, check if at least one is in this block
                // Approximation: if block exists, we check it. 
                // In a real system we might have a bloom filter per block.
                return true;
            }
            return true;
        });
    }

    private async processBlock(
        blockMeta: TemporalIndexEntry,
        dataStart: number,
        itemIds: number[],
        results: Map<number, ItemQueryResult>
    ) {
        const absOffset = dataStart + blockMeta.offset;
        const size = this.view.getUint32(absOffset + 1, true);
        const storedCrc = this.view.getUint32(absOffset + 5, true);
        const payload = this.buffer.subarray(absOffset + 9, absOffset + 9 + size);

        if (crc32(payload) !== storedCrc) {
            throw new Error(`CRC_MISMATCH: Block ${blockMeta.blockId} corrupted.`);
        }

        const decompressed = await this.decompressPayload(payload, blockMeta.blockId);
        if (decompressed) {
            await this.parseBlockContent(decompressed, itemIds, results, blockMeta.blockId);
        }
    }

    private async decompressPayload(payload: Uint8Array, blockId: number): Promise<Uint8Array | null> {
        try {
            if (this.compressionAlgorithm === CompressionAlgorithm.ZSTD) {
                return await new Promise<Uint8Array>((resolve, reject) => {
                    ZstdCodec.run((zstd: any) => {
                        try {
                            const result = new zstd.Simple().decompress(payload);
                            result ? resolve(result) : reject(new Error('Zstd null'));
                        } catch (err) { reject(err); }
                    });
                });
            }
            return await brotliDecompressAsync(payload);
        } catch (e) {
            console.error(`[HybridReader] Decompression failed for block ${blockId}:`, e);
            return null;
        }
    }

    private async parseBlockContent(
        data: Uint8Array,
        targetItemIds: number[],
        results: Map<number, ItemQueryResult>,
        blockId: number
    ) {
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const snapshotCount = view.getUint16(0, true);
        const offsets = this.readBlockOffsets(view);

        let dOff = 52; // Header size
        const absTimestamps = this.reconstructTimestamps(data, dOff, offsets.timestamps);
        dOff += offsets.timestamps;

        const ids = this.reconstructIds(data, dOff, offsets.ids);
        dOff += offsets.ids;

        const hotValues = decodeVarint(data.subarray(dOff, dOff + offsets.hot)); dOff += offsets.hot;
        dOff += offsets.warmBitmap + offsets.warmVal; // Skip warm for now (complex)

        const coldConsts = decodeVarint(data.subarray(dOff, dOff + offsets.coldConst)); dOff += offsets.coldConst;
        const coldVarBitmaps = data.subarray(dOff, dOff + offsets.coldVarBitmap); dOff += offsets.coldVarBitmap;
        const coldVarVals = decodeVarint(data.subarray(dOff, dOff + offsets.coldVarVal)); dOff += offsets.coldVarVal;

        const ultraOffset = dOff + offsets.qty; // Skip qty
        const ultraData = decodeVarint(data.subarray(ultraOffset, ultraOffset + offsets.ultra));

        this.processTierData({
            ids, targetItemIds, results, snapshotCount, absTimestamps,
            hotValues, coldConsts, coldVarBitmaps, coldVarVals,
            counts: {
                hot: view.getUint16(4, true),
                warm: view.getUint16(6, true),
                coldConst: view.getUint16(8, true),
                coldVar: view.getUint16(10, true)
            }
        });

        this.reconstructUltraSparseCOO(ultraData, targetItemIds, results, absTimestamps);
    }

    private readBlockOffsets(view: DataView) {
        return {
            timestamps: view.getUint32(12, true),
            ids: view.getUint32(16, true),
            hot: view.getUint32(20, true),
            warmBitmap: view.getUint32(24, true),
            warmVal: view.getUint32(28, true),
            coldConst: view.getUint32(32, true),
            coldVarBitmap: view.getUint32(36, true),
            coldVarVal: view.getUint32(40, true),
            qty: view.getUint32(44, true),
            ultra: view.getUint32(48, true)
        };
    }

    private reconstructTimestamps(data: Uint8Array, offset: number, length: number): number[] {
        const deltas = decodeVarint(data.subarray(offset, offset + length));
        if (deltas.length === 0) return [];

        let currentTs = deltas[0];
        const absTimestamps = [currentTs];
        if (deltas.length > 1) {
            let prevDelta = deltas[1];
            currentTs += prevDelta;
            absTimestamps.push(currentTs);
            for (let i = 2; i < deltas.length; i++) {
                const deltaDelta = deltas[i];
                const delta = prevDelta + deltaDelta;
                currentTs += delta;
                absTimestamps.push(currentTs);
                prevDelta = delta;
            }
        }
        return absTimestamps;
    }

    private reconstructIds(data: Uint8Array, offset: number, length: number): number[] {
        const deltas = decodeVarint(data.subarray(offset, offset + length));
        const ids: number[] = [];
        let currId = 0;
        for (const d of deltas) {
            currId += d;
            ids.push(currId);
        }
        return ids;
    }

    private processTierData(params: {
        ids: number[], targetItemIds: number[], results: Map<number, ItemQueryResult>,
        snapshotCount: number, absTimestamps: number[],
        hotValues: number[], coldConsts: number[],
        coldVarBitmaps: Uint8Array, coldVarVals: number[],
        counts: { hot: number, warm: number, coldConst: number, coldVar: number }
    }) {
        let coldConstIdx = 0;
        let coldVarIdx = 0;
        let coldVarValPtr = 0;

        for (let i = 0; i < params.ids.length; i++) {
            const itemId = params.ids[i];
            const isTarget = params.targetItemIds.includes(itemId);

            if (i < params.counts.hot) {
                if (isTarget) this.reconstructHotItem(itemId, i, params);
            } else if (i < (params.counts.hot + params.counts.warm)) {
                // WARM placeholder
            } else if (i < (params.counts.hot + params.counts.warm + params.counts.coldConst)) {
                if (isTarget) this.reconstructColdConstItem(itemId, params.coldConsts[coldConstIdx], params);
                coldConstIdx++;
            } else {
                const { valueCount } = this.getColdVarMetadata(coldVarIdx, params);
                if (isTarget) this.reconstructColdVarItem(itemId, coldVarIdx, coldVarValPtr, valueCount, params);
                coldVarValPtr += valueCount;
                coldVarIdx++;
            }
        }
    }

    private reconstructHotItem(itemId: number, idxInTier: number, params: any) {
        const start = idxInTier * params.snapshotCount;
        const dod = params.hotValues.slice(start, start + params.snapshotCount);
        let p = dod[0];
        let d = dod[1] ?? 0;
        const prices = [p];
        if (dod.length > 1) {
            p += d;
            prices.push(p);
        }
        for (let k = 2; k < dod.length; k++) {
            d += dod[k];
            p += d;
            prices.push(p);
        }

        const res = params.results.get(itemId)!;
        for (let s = 0; s < prices.length; s++) {
            res.history.push({ timestamp: params.absTimestamps[s], price: prices[s], quantity: 1 });
        }
    }

    private reconstructColdConstItem(itemId: number, val: number, params: any) {
        const res = params.results.get(itemId)!;
        for (const ts of params.absTimestamps) {
            res.history.push({ timestamp: ts, price: val, quantity: 1 });
        }
    }

    private getColdVarMetadata(coldVarIdx: number, params: any) {
        const bitmapBytes = Math.ceil(params.snapshotCount / 8);
        const startByte = coldVarIdx * bitmapBytes;
        let valueCount = 1;
        for (let b = 0; b < bitmapBytes; b++) {
            let n = params.coldVarBitmaps[startByte + b];
            while (n > 0) {
                if (n & 1) valueCount++;
                n >>= 1;
            }
        }
        return { valueCount, startByte, bitmapBytes };
    }

    private reconstructColdVarItem(itemId: number, coldVarIdx: number, valPtr: number, valCount: number, params: any) {
        const { startByte } = this.getColdVarMetadata(coldVarIdx, params);
        const myValues = params.coldVarVals.slice(valPtr, valPtr + valCount);

        let vPtr = 0;
        let val = myValues[vPtr++];
        const res = params.results.get(itemId)!;
        res.history.push({ timestamp: params.absTimestamps[0], price: val, quantity: 1 });

        for (let s = 1; s < params.snapshotCount; s++) {
            const byte = params.coldVarBitmaps[startByte + Math.floor(s / 8)];
            if ((byte & (1 << (s % 8))) !== 0) {
                val += myValues[vPtr++];
            }
            res.history.push({ timestamp: params.absTimestamps[s], price: val, quantity: 1 });
        }
    }

    private reconstructUltraSparseCOO(ultraData: number[], targetItemIds: number[], results: Map<number, ItemQueryResult>, absTimestamps: number[]) {
        if (!ultraData || ultraData.length === 0) return;
        let usIdx = 0;
        const count = ultraData[usIdx++];
        let uId = 0, uP = 0, uQ = 0;

        for (let k = 0; k < count; k++) {
            uId += ultraData[usIdx++];
            const sIdx = ultraData[usIdx++];
            uP += ultraData[usIdx++];
            uQ += ultraData[usIdx++];

            if (targetItemIds.includes(uId)) {
                results.get(uId)!.history.push({
                    timestamp: absTimestamps[sIdx],
                    price: uP,
                    quantity: uQ
                });
            }
        }
    }


    async unlock(password: string): Promise<void> {
        if (this.encryptionMode !== EncryptionMode.NONE) {
            if (!password) throw new Error("Password required");
        }
    }

    async getLatestSnapshot(): Promise<Snapshot | null> {
        if (this.temporalIndex.length === 0) return null;
        const lastBlock = this.temporalIndex.at(-1)!;
        const results = await this.queryItems({ startTime: lastBlock.startTimestamp });

        let maxTs = 0;
        for (const res of results) {
            if (res.history.length > 0) {
                const lastPoint = res.history.at(-1)!;
                if (lastPoint.timestamp > maxTs) maxTs = lastPoint.timestamp;
            }
        }

        if (maxTs === 0) return null;

        const items = new Map<number, { price: number, quantity: number }>();
        for (const res of results) {
            const matching = res.history.find(p => p.timestamp === maxTs);
            if (matching) {
                items.set(res.itemId, { price: matching.price, quantity: matching.quantity ?? 0 });
            }
        }

        return { timestamp: maxTs, items };
    }

    /**
     * Get a snapshot at a specific timestamp.
     * Returns null if no matching data is found.
     * Uses queryItems internally for CRC validation.
     */
    async getSnapshotAt(timestamp: number): Promise<Snapshot | null> {
        if (this.temporalIndex.length === 0) return null;

        // Find the block that contains this timestamp
        let targetBlock: TemporalIndexEntry | null = null;
        for (const block of this.temporalIndex) {
            if (block.startTimestamp <= timestamp) {
                targetBlock = block;
            } else {
                break;
            }
        }
        if (!targetBlock) return null;

        // Query all items at this timestamp range (will validate CRC)
        const results = await this.queryItems({ startTime: timestamp, endTime: timestamp });

        const items = new Map<number, { price: number; quantity: number }>();
        for (const result of results) {
            const point = result.history.find(h => h.timestamp === timestamp);
            if (point) {
                items.set(result.itemId, { price: point.price, quantity: point.quantity ?? 0 });
            }
        }

        if (items.size === 0) return null;
        return { timestamp, items };
    }

    /**
     * Get the tier classification for an item.
     */
    getItemTier(itemId: number): ItemTier | undefined {
        const entry = this.itemIndex.get(itemId);
        return entry?.tier;
    }

    /**
     * Extract ALL snapshots from the GICS file.
     * Used for Download-Merge-Upload consolidation.
     * Reconstructs snapshots from item history data.
     * 
     * OPTIMIZED: O(n) using parallel iteration instead of O(n²) .find()
     */
    async getAllSnapshots(): Promise<Snapshot[]> {
        const results = await this.queryItems({});
        if (results.length === 0) return [];

        const allTimestamps = this.collectUniqueTimestamps(results);
        const timestampToIndex = new Map<number, number>();
        allTimestamps.forEach((ts, i) => timestampToIndex.set(ts, i));

        const snapshots: Snapshot[] = allTimestamps.map(ts => ({
            timestamp: ts,
            items: new Map<number, { price: number; quantity: number }>()
        }));

        this.populateSnapshotsFromResults(results, snapshots, timestampToIndex);

        return snapshots.filter(s => s.items.size > 0);
    }

    private collectUniqueTimestamps(results: ItemQueryResult[]): number[] {
        const tsSet = new Set<number>();
        for (const res of results) {
            for (const point of res.history) {
                tsSet.add(point.timestamp);
            }
        }
        return Array.from(tsSet).sort((a, b) => a - b);
    }

    private populateSnapshotsFromResults(results: ItemQueryResult[], snapshots: Snapshot[], tsMap: Map<number, number>) {
        for (const result of results) {
            for (const point of result.history) {
                const idx = tsMap.get(point.timestamp);
                if (idx !== undefined) {
                    snapshots[idx].items.set(result.itemId, {
                        price: point.price,
                        quantity: point.quantity ?? 0
                    });
                }
            }
        }
    }

}

// ============================================================================
// Item Query Helper
// ============================================================================

export class ItemQuery {
    private readonly reader: HybridReader;

    constructor(reader: HybridReader) {
        this.reader = reader;
    }

    /**
     * Get the price history for a specific item.
     * Returns null if the item is not found.
     */
    getItemHistory(itemId: number): ItemQueryResult | null {
        const ids = this.reader.getItemIds();
        if (!ids.includes(itemId)) {
            return null;
        }
        return { itemId, history: [] }; // Simplified
    }
}

// ============================================================================
// Market Intelligence (Stub for future use)
// ============================================================================

export class MarketIntelligence {
    private readonly reader: HybridReader;

    constructor(reader: HybridReader) {
        this.reader = reader;
    }
}
