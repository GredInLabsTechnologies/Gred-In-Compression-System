# GICS v1.2 TECHNICAL DOSSIER

**Version:** 1.2 (Critical)
**Status:** Frozen
**Target Audience:** Release Engineers, System Architects, Auditors

---

## 1. What GICS Is (and Is Not)

**What It Is:**
GICS (Gred-In Compression System) is a **deterministic, fail-closed, agnostic time-series compression engine**. It is designed for critical infrastructure where data integrity and auditability are paramount. It sacrifices raw compression ratio for absolute correctness and safety.

**What It Is Not:**
- **NOT AI-driven:** GICS uses static, deterministic algorithms. It does not "hallucinate" or approximate data.
- **NOT General Purpose:** It is specialized for monotonic time-series data. It is not for text, images, or arbitrary binary blobs.
- **NOT Lossy:** GICS v1.2 is strictly lossless for the `CORE` stream.

**Why Not AI?**
AI models introduce probabilistic behavior. In critical civil infrastructure, "mostly correct" is unacceptable. GICS guarantees bit-exact roundtrips every time.

---

## 2. Correct Usage Guide (Quick Start)

**Minimal Example (TypeScript):**
```typescript
import { GICS } from 'gics';

// 1. Initialize Encoder
const encoder = new GICS.Encoder({ streamId: 1 });

// 2. Push Agnostic Frames (Time, Value)
encoder.push({ time: 1000, value: 1.5 });
encoder.push({ time: 1001, value: 1.6 });

// 3. Mandatory EOS
encoder.push({ time: 1002, value: 1.7, eos: true });
// OR explicitly: encoder.end();

// 4. Get Blob
const compressed = encoder.flush();
```

**Common Mistakes:**
- **Forgetting EOS:** The decoder will strictly reject files without the `0xFF` EOS marker.
- **Ignoring Errors:** GICS throws on truncation. Do not wrap in silent `try/catch` without handling the `IncompleteDataError`.
- **Mixing Regimes:** Sending highly volatile data to a `LINEAR` codec will trigger Quarantine. This is expected behavior, not a bug.

---

## 3. High-Level Architecture

**Diagram:**
```ascii
[ DATA SOURCE ] --> [ ADAPTER LAYER ] --> [ GICS CORE ]
                                             |
                                     (Entropy Gate)
                                     /             \
                             [ CORE STREAM ]   [ QUARANTINE ]
                                   |                |
                              (Lossless)       (Fallback)
```

- **Core vs Adapters:** The Core is domain-agnostic. Adapters (e.g., WoW, Financial) reside outside and normalize data into `GicsFrame`.
- **Encoder/Decoder:** Implementing complementary logic. The Decoder is the "Enforcer" of the protocol.
- **Dual-Stream:**
    - **CORE:** High compression, strictly modeled data.
    - **QUARANTINE:** Volatile/Entropy-high data. Bypass compression to preserve integrity.
- **Context:** Shared-nothing. Each stream is isolated. No global static state.

---

## 4. Data Model

**The Atomic Unit: `GicsFrame`**
- **Time:** Monotonic integer (u64).
- **Value:** Double precision float (f64).
- **Aux:** Optional metadata map.

**Streams:**
- **TIME Stream:** Delta-encoded timestamps.
- **VALUE Stream:** XOR-compressed floating point values.

**Assumptions:**
- Time is generally monotonic (GICS handles disorders but penalizes them).
- Values often follow a trend (Linear, Constant, etc.).

---

## 5. Compression Pipeline

1.  **Ingestion & Structuring:**
    - Raw data is validated and structued into `GicsFrame`.
2.  **Feature Extraction:**
    - Calculate deltas (`d1`, `d2`) and entropy.
3.  **Routing (Entropy Gate):**
    - **Low Entropy:** Route to `CORE`.
    - **High Entropy:** Route to `QUARANTINE`.
4.  **Codec Selection (CORE):**
    - Determine best fit: `CONST`, `LINEAR`, `DELTADELTA`, or `XOR`.
5.  **Encoding:**
    - Write header (if new block).
    - Bit-pack data.
6.  **EOS Finalize:**
    - Append `0xFF` marker.
7.  **Decode Flow:**
    - Validate Header -> Read Chunks -> Check EOS -> Reconstruct.

---

## 6. Code Map (Critical Section)

| File/Module | Responsibility |
|---|---|
| `encode.ts` | State machine for ingesting frames and emitting bits. Handles the Entropy Gate. |
| `decode.ts` | **The Enforcer.** Parses bits, validates structure, enforces EOS, checks offsets. |
| `chm.ts` | **Compression Health Monitor.** Tracks ratios and decides routing (Core vs Quarantine). |
| `integrity_worker.ts` | Redundant off-thread verification of inputs vs outputs. |
| `tests/regression/*.ts` | **The Permanent Seal.** Tests for known bugs (EOS, Truncation, Integrity). |

---

## 7. Failure Modes

**A. Missing EOS**
- **Symptom:** Decoder throws `IncompleteDataError` or similar.
- **Behavior:** Packet is rejected.
- **Why:** Prevents distinguishing between "end of stream" and "network cut".

**B. Truncation**
- **Symptom:** `BufferUnderflowError` or `IncompleteDataError`.
- **Behavior:** Fail-closed. No partial data returned.
- **Why:** Partial data is dangerous data.

**C. Corruption (Bit Flip)**
- **Symptom:** `IntegrityError` (checksum mismatch if enabled, or structural violation).
- **Behavior:** Reject entire block.

**D. High Entropy Data**
- **Symptom:** Compression ratio drops (e.g., 1.0x).
- **Behavior:** System routes to `QUARANTINE`.
- **Why:** GICS refuses to fit noise into a model. It preserves the noise exactly.

---

## 8. Limitations & Boundaries

- **Compression Ratio:** NOT guaranteed. Ratio depends entirely on data structure. White noise = 1.0x ratio.
- **Quarantine Trigger:** Frequent regime changes (Valid -> Volatile) will trigger Quarantine to protect the Core model.
- **Latency:** GICS is block-based. Slight buffering delay exists for codec selection.

---

## 9. Safety & Critical Use Guidance

**Guarantees:**
- **Bit-Exactness:** Input == Output.
- **Determinism:** Same Input + Same Config = Same Bytes.
- **Vigilance:** Decoder will never silently accept malformed data.

**When to Use GICS:**
- Financial audit logs.
- Gameplay replication verification.
- Sensor data for safety systems.

**When NOT to Use GICS:**
- Streaming video/audio (use H.264/AAC).
- Lossy metrics where 99% accuracy is enough (use standard metrics stores).
- High-frequency trading where microseconds matter more than correctness (GICS overhead is non-zero).
