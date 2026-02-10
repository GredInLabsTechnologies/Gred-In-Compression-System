# GICS Binary Format Specification (v1.3)

> Wire format and encoding details for GICS v1.3 compressed streams.

---

## 📦 High-Level Structure

A GICS v1.3 file consists of a global header, an optional schema section, one or more data segments, and a file-level End-of-Stream (EOS) marker.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                GICS FILE                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│ [FileHeaderV3] [EncryptionHeader?] [SchemaSection?] [Segment 0..N] [FileEOS] │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 🏷️ File Header (V3)

The file begins with a 14-byte mandatory header.

| Field | Size | Description |
|-------|------|-------------|
| Magic | 4 bytes | `0x47494353` ("GICS") |
| Version | 1 byte | `0x03` |
| Flags | 4 bytes | bitmask (see below) |
| StreamCount | 1 byte | Number of active streams |
| Reserved | 4 bytes | Zero-padded |

**Flags bitmask (Little-Endian)**:
- `0x04`: **HAS_SCHEMA** — A schema section follows the header.
- `0x80`: **ENCRYPTED** — The file is encrypted (Encryption Header follows).

---

## 🔐 Encryption Header

Required if the `ENCRYPTED` flag is set. Size: **67 bytes**.

| Field | Size | Description |
|-------|------|-------------|
| EncMode | 1 byte | `1`: AES-256-GCM |
| Salt | 16 bytes | KDF Salt |
| AuthVerify | 32 bytes | Password verification hash |
| KDFId | 1 byte | `1`: PBKDF2 |
| Iterations | 4 bytes | KDF iterations (default: 100,000) |
| DigestId | 1 byte | `1`: SHA-256 |
| FileNonce | 12 bytes | Base nonce for encryption |

---

## 📑 Schema Section

Required if the `HAS_SCHEMA` flag is set.

| Field | Size | Description |
|-------|------|-------------|
| SchemaLength | 4 bytes | Length of compressed payload (Little-Endian) |
| SchemaPayload | Var | Zstd-compressed JSON profile |

The JSON profile defines field names, types, and codec recommendations.

---

## 🧩 Segment Architecture

Segments are independent blocks containing zero or more StreamSections.

### Segment Header (14 bytes)
| Field | Size | Description |
|-------|------|-------------|
| Magic | 2 bytes | `0x5347` ("SG") |
| IndexOffset | 4 bytes | Absolute offset to the Segment Index |
| TotalLength | 4 bytes | Total segment size (header to footer) |
| Reserved | 4 bytes | Zero-padded |

### StreamSection
Each stream (Time, Value, or custom field) is isolated in a section.

| Field | Size | Description |
|-------|------|-------------|
| StreamId | 1 byte | `10`: Time, `20`: Value, `100+`: Schema Fields |
| OuterCodec | 1 byte | `1`: Zstd |
| BlockCount | 2 bytes | Number of blocks in this section |
| RawSize | 4 bytes | Decompressed size |
| CompSize | 4 bytes | Compressed size |
| SectionHash | 32 bytes | Running integrity hash |
| AuthTag | 16 bytes | GCM tag (only if ENCRYPTED) |
| **Manifest** | Var | `BlockCount * 10` bytes (see below) |
| **Payload** | Var | Compressed (and optionally encrypted) data |

**Block Manifest Entry (10 bytes)**:
- `InnerCodec` (1 byte): `1` VarintDelta, `2` BitPackDelta, `3` RLEZigZag, etc.
- `ItemCount` (4 bytes): Snapshots in this block.
- `PayloadLen` (4 bytes): Bytes in the encoded block.
- `Flags` (1 byte): Health tags and regime hints.

### Segment Index
Enables rapid O(log N) lookup and item filtering.

| Field | Size | Description |
|-------|------|-------------|
| BloomSize | 2 bytes | Size of Bloom Filter mapping |
| BloomBits | Var | Membership bitmask (default 256 bytes) |
| IDCount | 4 bytes | Total unique ItemIDs in segment |
| IDDeltas | Var | Varint-encoded sorted ItemID deltas |
| **StringDict**| Opt | (Schema-only) String-to-Numeric mapping |

### Segment Footer (36 bytes)
| Field | Size | Description |
|-------|------|-------------|
| RootHash | 32 bytes | Integrity root for the whole segment |
| CRC32 | 4 bytes | Transmission checksum |

---

## 🏁 File End-of-Stream (EOS)

Mandatory 37-byte marker at file end.

| Field | Size | Description |
|-------|------|-------------|
| Marker | 1 byte | `0xFF` |
| FinalHash | 32 bytes | The final cumulative hash of the file |
| CRC32 | 4 bytes | Integrity checksum of the hash |

---

## 🔢 Inner Codecs

| ID | Name | Description |
|----|------|-------------|
| `0` | NONE | Raw pass-through |
| `1` | VARINT_DELTA | Base delta + Protocol Buffer varints |
| `2` | BITPACK_DELTA| Delta + dynamic bit packing |
| `3` | RLE_ZIGZAG | Run-Length Encoding + ZigZag |
| `6` | DICT_VARINT | Context-aware dictionary + Varint |
| `7` | FIXED64_LE | Fixed-width 8 bytes per item (Little Endian). Used as QUARANTINE anti-expansion cap |

---

*Document version: 1.3 | Updated: 2026-02-10*
