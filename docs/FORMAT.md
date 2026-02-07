# GICS Binary Format Specification

> Wire format and encoding details for GICS compressed streams.

---

## 📦 Stream Structure

```
┌─────────────────────────────────────────────────────┐
│                    GICS STREAM                      │
├─────────────────────────────────────────────────────┤
│ [Header] [Block 0] [Block 1] ... [Block N] [EOS]   │
└─────────────────────────────────────────────────────┘
```

---

## 🏷️ Header Format

| Field | Size | Description |
|-------|------|-------------|
| Magic | 4 bytes | `0x47494353` ("GICS") |
| Version | 1 byte | Format version (current: `0x03`) |
| StreamId | 4 bytes | Unique stream identifier |
| Flags | 1 byte | Configuration flags |
| Reserved | 2 bytes | Future use |

**Total Header Size**: 12 bytes

---

## 📦 Block Format

Each block contains one or more compressed frames:

| Field | Size | Description |
|-------|------|-------------|
| BlockType | 1 byte | `0x01` CORE, `0x02` QUARANTINE |
| PayloadLen | 4 bytes | Compressed payload size (little-endian) |
| Payload | Variable | Compressed frame data |

### Block Types

| Type | Code | Description |
|------|------|-------------|
| CORE | `0x01` | High-compression predictable data |
| QUARANTINE | `0x02` | Pass-through for high-entropy data |

---

## 🖼️ Frame Format (within blocks)

| Field | Size | Description |
|-------|------|-------------|
| FrameFlags | 1 byte | Encoding metadata |
| ItemId | 4 bytes | Snapshot item identifier |
| Timestamp | 8 bytes | Unix epoch (ms) |
| FieldCount | 2 bytes | Number of encoded fields |
| Fields | Variable | Delta/varint encoded values |

---

## 🏁 End-of-Stream (EOS)

| Field | Size | Description |
|-------|------|-------------|
| Marker | 1 byte | `0xFF` |
| FrameCount | 4 bytes | Total frames in stream |
| Checksum | 4 bytes | Optional CRC32 (if enabled) |

**Critical**: Decoder **rejects** any stream missing EOS marker.

---

## 🔢 Encoding Techniques

### Delta Encoding (CORE blocks)

```
Value[0] = BaseValue
Value[n] = Value[n-1] + Delta[n]
```

### Varint Encoding

- Uses protobuf-style variable-length integers
- Small values = fewer bytes
- Negative values use ZigZag encoding

### Quarantine Passthrough

- High-entropy data stored as raw bytes
- No compression applied (ratio ≈ 1.0x)

---

## ⚠️ Validation Rules

1. **Magic must match** — Invalid magic = immediate reject
2. **Version must be supported** — Unknown version = reject
3. **EOS required** — Missing EOS = `IncompleteDataError`
4. **Block bounds enforced** — Payload cannot exceed declared length

---

*Document version: 1.0 | Updated: 2026-02-07*
