export const GICS_MAGIC_V2 = new Uint8Array([0x47, 0x49, 0x43, 0x53]); // "GICS"
export const GICS_VERSION_BYTE = 0x03;

export enum StreamId {
    TIME = 10,         // Timestamps (1:1 with snapshots)
    VALUE = 20,        // Prices (1:1 with items)
    META = 30,         // Reserved
    ITEM_ID = 40,      // Item IDs (1:1 with items)
    QUANTITY = 50,     // Quantities (1:1 with items)
    SNAPSHOT_LEN = 60, // Items per snapshot (1:1 with snapshots)
}

export enum InnerCodecId {
    NONE = 0,
    VARINT_DELTA = 1,
    BITPACK_DELTA = 2,
    RLE_ZIGZAG = 3,
    RLE_DOD = 4,   // For Time mainly
    DOD_VARINT = 5, // For Time mainly (Delta-of-Delta + Varint)
    DICT_VARINT = 6, // Dictionary + Varint
}

export enum OuterCodecId {
    NONE = 0,
    ZSTD = 1,
}

export enum HealthTag {
    OK = 0,
    WARN = 1,
    QUAR = 2,
}

export interface HeaderV3 {
    magic: Uint8Array; // "GICS"
    version: number;   // 3
    flags: number;
    streamCount: number;
}

export const GICS_HEADER_SIZE_V3 = 14; // magic(4) + version(1) + flags(4) + streamCount(1) + reserved(4)

export enum GICS_FLAGS_V3 {
    NONE = 0,
    ENCRYPTED = 0x80,
}

export interface EncryptionHeaderV3 {
    encMode: number;      // 1: AES-256-GCM
    salt: Uint8Array;    // 16 bytes
    authVerify: Uint8Array; // 32 bytes (HMAC of a known constant to verify password)
    kdfId: number;       // 1: PBKDF2
    iterations: number;  // e.g. 100000
    digestId: number;    // 1: SHA-256
    fileNonce: Uint8Array; // 8 bytes
}

export const GICS_ENC_HEADER_SIZE_V3 = 1 + 16 + 32 + 1 + 4 + 1 + 8; // 63 bytes

// Block Header layout:
// [stream_id (u8)] [codec_id (u8)] [n_items (u32)] [payload_len (u32)] [flags_low (u8)]
// V1.1 had 10 bytes. We added flags byte? 
// The initial V1.2 implementation reused the 10 byte header.
// To add Flags into Block Header without breaking too much:
// stream_id (u8) is fine.
// codec_id (u8) is fine.
// n_items (u32) is fine.
// payload_len (u32) is fine.
// We need a place for flags. 
// OPTION A: Add 1 byte. Header becomes 11 bytes.
// OPTION B: Steal from codec_id? No, 255 codecs needed eventually.
// OPTION C: Steal from stream_id? No.
// Let's make Block Header 11 bytes in V1.2.
export const BLOCK_HEADER_SIZE = 1 + 1 + 4 + 4 + 1;

export const V12_FLAGS = {
    FIELDWISE_TS: 1,
    CONTEXT_ENABLED: 2,
    REGIME_SWITCH: 4, // Legacy hint
};

export const BLOCK_FLAGS = {
    NONE: 0,
    ANOMALY_START: 1,
    ANOMALY_MID: 2,
    ANOMALY_END: 4,
    // Bits 3-4 for HealthTag
    HEALTH_WARN: 8,
    HEALTH_QUAR: 16,
};

export enum RecoveryAction {
    INSPECT = "INSPECT",
    RETRY = "RETRY",
    IGNORE = "IGNORE"
}

export const GICS_EOS_MARKER = 0xFF;

export const SEGMENT_MAGIC = new Uint8Array([0x53, 0x47]); // "SG"
export const SEGMENT_FOOTER_SIZE = 36; // 32 (hash) + 4 (crc32)
export const FILE_EOS_SIZE = 37; // 1 (marker) + 32 (hash) + 4 (crc32)
