/**
 * GICS Types - Core type definitions
 * 
 * @module gics
 * @version 1.3.0
 * @status PRODUCTION
 * 
 * These types are designed to be generic for any price time-series,
 * supporting financial, sensor, and IoT data streams.
 */

/**
 * GICS Format Version Constants
 */
export const GICS_VERSION = '1.3.0';
export const GICS_VERSION_1_1 = 0x11; // Binary version byte

/**
 * Snapshot type classification (v0.2+ experimental)
 */
export enum SnapshotType {
    /** Keyframe (I-frame): Absolute values, no dependencies */
    KEYFRAME = 0,
    /** Delta (P-frame): Relative to previous snapshot */
    DELTA = 1
}

/**
 * File rotation policy (v0.2+ experimental)
 */
export type FileRotationPolicy = 'monthly' | 'weekly' | 'daily' | 'size-based' | 'off';

/**
 * Default rotation policy
 */
export const DEFAULT_ROTATION_POLICY: FileRotationPolicy = 'monthly';

/**
 * Trend direction for price analysis
 */
export type TrendDirection = 'up' | 'down' | 'stable';

/**
 * Market sentiment indicator
 */
export type MarketSentiment = 'bullish' | 'bearish' | 'neutral' | 'volatile';

/**
 * A single price point in time
 */
export interface PricePoint {
    /** Unix timestamp in seconds */
    timestamp: number;
    /** Price in smallest unit (e.g., cents, satoshis, or domain-specific units) */
    price: number;
    /** Quantity available at this price (optional) */
    quantity?: number;
}

/**
 * A snapshot of all items at a point in time
 */
export interface Snapshot {
    /** Unix timestamp in seconds */
    timestamp: number;
    /** Map of itemId -> price data */
    items: Map<number, { price: number; quantity: number }>;
}

/**
 * Delta between two snapshots (internal use)
 */
export interface SnapshotDelta {
    /** Reference to previous snapshot timestamp */
    baseTimestamp: number;
    /** This snapshot's timestamp */
    timestamp: number;
    /** Items that changed: [itemId, newPrice, newQuantity] */
    changes: [number, number, number][];
    /** Items that were removed (no longer listed) */
    removed: number[];
}

/**
 * Configuration for GICS encoder/decoder
 */
export interface GICSConfig {
    /** 
     * Dictionary of known item IDs for compact encoding
     * If provided, item IDs are encoded as indices (smaller)
     * If not provided, full item IDs are stored
     */
    dictionary?: Map<number, number>;

    /**
     * Compression level for zstd (1-22, default 3)
     * Higher = better compression but slower
     */
    compressionLevel?: number;

    /**
     * Chunk size for streaming (default: 1 hour of snapshots)
     */
    chunkSize?: number;

    /**
     * Enable integrity checksums (default: true)
     */
    enableChecksums?: boolean;

    /**
     * File rotation policy (v0.2+ experimental)
     * Controls how files are segmented over time
     * Default: 'monthly' for production, 'off' maintains legacy behavior
     */
    rotationPolicy?: FileRotationPolicy;

    /**
     * Password for encryption (optional)
     */
    password?: string;

    /**
     * Salt for key derivation (optional, for reader)
     */
    salt?: Buffer;

    /**
     * Encryption mode (optional, for reader)
     */
    encryptionMode?: EncryptionMode;
}

/**
 * Statistics about compression performance
 */
export interface GICSStats {
    /** Total snapshots stored */
    snapshotCount: number;
    /** Total unique items tracked */
    itemCount: number;
    /** Raw size if stored as JSON (estimated) */
    rawSizeBytes: number;
    /** Compressed size in bytes */
    compressedSizeBytes: number;
    /** Compression ratio (raw / compressed) */
    compressionRatio: number;
    /** Average % of items that change per snapshot */
    avgChangeRate: number;
    /** Date range covered */
    dateRange: { start: Date; end: Date };
}

/**
 * History for a single item (query result)
 */
export interface ItemHistory {
    /** Item ID */
    itemId: number;
    /** Name if known */
    name?: string;
    /** All price points */
    history: PricePoint[];
    /** Computed statistics */
    stats?: {
        min: number;
        max: number;
        avg: number;
        volatility: number;
        trend: TrendDirection;
        trendPercent: number;
    };
}

/**
 * GICS file header (binary format)
 */
export interface GICSHeader {
    /** Magic bytes: "GICS" */
    magic: string;
    /** Format version */
    version: number;
    /** Year-Month (e.g., 202412 for Dec 2024) */
    yearMonth: number;
    /** Number of snapshots in this file */
    snapshotCount: number;
    /** Number of unique items */
    itemCount: number;
    /** Offset to dictionary section */
    dictionaryOffset: number;
    /** Offset to data section */
    dataOffset: number;
    /** CRC32 of header */
    headerChecksum: number;
    /** Snapshot type of first block (v0.2+ experimental): KEYFRAME or DELTA */
    snapshotType?: SnapshotType;
    /** Encryption Mode (0x00=None, 0x01=AES-256-GCM) */
    encryptionMode?: EncryptionMode;
    /** Salt for Key Derivation (16 bytes, if encrypted) */
    salt?: Buffer;
    /** Verification Token (16 bytes auth tag, to verify password) */
    authVerify?: Buffer;
}

/**
 * Encryption Modes
 */
export enum EncryptionMode {
    NONE = 0x00,
    AES_256_GCM = 0x01
}

/**
 * Compression Algorithm (stored in FLAGS byte of header)
 * @since v1.1
 */
export enum CompressionAlgorithm {
    /** Brotli compression (default, backward compatible) */
    BROTLI = 0x00,
    /** Zstd compression (better ratio, faster) */
    ZSTD = 0x01
}

/**
 * Encoding strategy (auto-detected or manual)
 */
export type EncodingStrategy =
    | 'delta'           // Store differences from previous
    | 'delta-of-delta'  // Store differences of differences
    | 'rle'             // Run-length for repeated values
    | 'varint'          // Variable-length integer encoding
    | 'raw';            // No encoding (fallback)

/**
 * Bit-pack type for adaptive encoding
 */
export enum BitPackType {
    UNCHANGED = 0,      // Price unchanged (0 bits for value)
    DELTA_SMALL = 1,    // Small delta (-127 to +127, 8 bits)
    DELTA_MEDIUM = 2,   // Medium delta (-32767 to +32767, 16 bits)
    ABSOLUTE = 3        // Full 32-bit value
}

/**
 * Sanity limits for decoder protection
 */
export const GICS_MAX_CHANGES_PER_SNAPSHOT = 1_000_000; // 1M items max
export const GICS_MAX_REMOVED_PER_SNAPSHOT = 500_000;    // 500K removals max

/**
 * Block Types for GICS v1.0 Structure
 */
export enum BlockType {
    DATA = 0x01,       // Standard compressed data
    INDEX = 0x02,      // Table of Contents (TOC)
    CHECKPOINT = 0x03  // Full state snapshot
}

/**
 * GICS Block Header (9 bytes)
 */
export interface GICSBlockHeader {
    /** Block type identifier (1 byte) */
    type: BlockType;
    /** Size of payload in bytes (4 bytes) */
    payloadSize: number;
    /** CRC32 checksum of payload (4 bytes) */
    crc32: number;
    /** Continuous heat metric 0-1 (v1.1+) */
    heatScore?: number;
}

/**
 * Complete Block Structure (In-memory representation)
 */
export interface GICSBlock {
    header: GICSBlockHeader;
    payload: Uint8Array;
}

/**
 * Heat score result for market intelligence (v1.1+)
 */
export interface HeatScoreResult {
    /** Item ID */
    itemId: number;
    /** Continuous heat score 0-1 */
    heatScore: number;
    /** Component breakdown for debugging/display */
    components: {
        /** Price volatility (coefficient of variation) */
        volatility: number;
        /** Demand trend indicator */
        demand: number;
        /** Percentage of snapshots with price changes */
        changeFrequency: number;
    };
}

// ============================================================================
// GICS v1.0 Hybrid Storage Types
// ============================================================================

/**
 * Item tier classification based on change frequency
 */
export type ItemTier = 'hot' | 'warm' | 'cold' | 'ultra_sparse';

/**
 * Time range for sparse queries
 */
export interface TimeRange {
    start: number;
    end: number;
}

/**
 * Configuration for GICS v1.0 Hybrid Storage
 */
export interface GICSHybridConfig extends GICSConfig {
    /** Days per block (default: 7) */
    blockDurationDays?: number;
    /** Tier classification thresholds */
    tierThresholds?: {
        /** Change rate to be HOT (default: 0.8 = 80%) */
        hotChangeRate: number;
        /** Change rate to be WARM (default: 0.2 = 20%) */
        warmChangeRate: number;
    };
}

/**
 * Filter for querying item history
 */
export interface QueryFilter {
    /** Specific item IDs to query */
    itemIds?: number[];
    /** Start timestamp (Unix seconds) */
    startTime?: number;
    /** End timestamp (Unix seconds) */
    endTime?: number;
    /** Max results per item */
    limit?: number;
    /** Sparse time ranges to query (inclusive) */
    timeRanges?: TimeRange[];
}

/**
 * Result of an item query with history and statistics
 */
export interface ItemQueryResult {
    itemId: number;
    history: PricePoint[];
    stats?: {
        min: number;
        max: number;
        avg: number;
        volatility: number;
        trend: TrendDirection;
        trendPercent: number;
    };
}

// =======================================================================
// Service-Level Types (Moved from gics-service.ts)
// =======================================================================

export interface ItemHistoryResult {
    itemId: number;
    found: boolean;
    dataPoints: number;
    history: PricePoint[];
    stats?: {
        minPrice: number;
        maxPrice: number;
        avgPrice: number;
        volatility: number;
        trend: TrendDirection;
        trendPercent: number;
    };
}

export interface SnapshotResult {
    timestamp: number;
    found: boolean;
    itemCount: number;
    items: Array<{
        itemId: number;
        price: number;
        quantity: number;
    }>;
}

export interface MarketIntelResult {
    timestamp: number;
    totalItems: number;
    hotItems: Array<{
        itemId: number;
        volatility: number;
        trend: TrendDirection;
        trendPercent: number;
    }>;
    warmItems: number;
    coldItems: number;
    topGainers: Array<{
        itemId: number;
        changePercent: number;
        currentPrice: number;
        previousPrice: number;
    }>;
    topLosers: Array<{
        itemId: number;
        changePercent: number;
        currentPrice: number;
        previousPrice: number;
    }>;
    marketSentiment: MarketSentiment;
    avgVolatility: number;
}

export interface SparseQueryItem {
    /** Asset identifier (can be item ID, ticker symbol hash, etc.) */
    assetId: number;
    /** Start of time range (Unix timestamp in seconds) */
    startTime?: number;
    /** End of time range (Unix timestamp in seconds) */
    endTime?: number;
}

export interface SparseQueryResult {
    assetId: number;
    found: boolean;
    dataPoints: number;
    history: PricePoint[];
    /** Which block(s) were read to satisfy this query */
    blocksRead: number;
}