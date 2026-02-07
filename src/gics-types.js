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
export const GICS_VERSION = '1.1.0';
export const GICS_VERSION_1_1 = 0x11; // Binary version byte
/**
 * Snapshot type classification (v0.2+ experimental)
 */
export var SnapshotType;
(function (SnapshotType) {
    /** Keyframe (I-frame): Absolute values, no dependencies */
    SnapshotType[SnapshotType["KEYFRAME"] = 0] = "KEYFRAME";
    /** Delta (P-frame): Relative to previous snapshot */
    SnapshotType[SnapshotType["DELTA"] = 1] = "DELTA";
})(SnapshotType || (SnapshotType = {}));
/**
 * Default rotation policy
 */
export const DEFAULT_ROTATION_POLICY = 'monthly';
/**
 * Encryption Modes
 */
export var EncryptionMode;
(function (EncryptionMode) {
    EncryptionMode[EncryptionMode["NONE"] = 0] = "NONE";
    EncryptionMode[EncryptionMode["AES_256_GCM"] = 1] = "AES_256_GCM";
})(EncryptionMode || (EncryptionMode = {}));
/**
 * Compression Algorithm (stored in FLAGS byte of header)
 * @since v1.1
 */
export var CompressionAlgorithm;
(function (CompressionAlgorithm) {
    /** Brotli compression (default, backward compatible) */
    CompressionAlgorithm[CompressionAlgorithm["BROTLI"] = 0] = "BROTLI";
    /** Zstd compression (better ratio, faster) */
    CompressionAlgorithm[CompressionAlgorithm["ZSTD"] = 1] = "ZSTD";
})(CompressionAlgorithm || (CompressionAlgorithm = {}));
/**
 * Bit-pack type for adaptive encoding
 */
export var BitPackType;
(function (BitPackType) {
    BitPackType[BitPackType["UNCHANGED"] = 0] = "UNCHANGED";
    BitPackType[BitPackType["DELTA_SMALL"] = 1] = "DELTA_SMALL";
    BitPackType[BitPackType["DELTA_MEDIUM"] = 2] = "DELTA_MEDIUM";
    BitPackType[BitPackType["ABSOLUTE"] = 3] = "ABSOLUTE"; // Full 32-bit value
})(BitPackType || (BitPackType = {}));
/**
 * Sanity limits for decoder protection
 */
export const GICS_MAX_CHANGES_PER_SNAPSHOT = 1_000_000; // 1M items max
export const GICS_MAX_REMOVED_PER_SNAPSHOT = 500_000; // 500K removals max
/**
 * Block Types for GICS v1.0 Structure
 */
export var BlockType;
(function (BlockType) {
    BlockType[BlockType["DATA"] = 1] = "DATA";
    BlockType[BlockType["INDEX"] = 2] = "INDEX";
    BlockType[BlockType["CHECKPOINT"] = 3] = "CHECKPOINT"; // Full state snapshot
})(BlockType || (BlockType = {}));
//# sourceMappingURL=gics-types.js.map