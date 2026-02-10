# GICS — Deterministic Time-Series Compression

![Version](https://img.shields.io/badge/version-1.3.0-blue)
![Status](https://img.shields.io/badge/status-production-green)
![License](https://img.shields.io/badge/license-proprietary-red)

## 🎯 What Is GICS?

**GICS** is a **deterministic, fail-closed, agnostic time-series compression engine** designed for critical infrastructure where **data integrity and auditability are paramount**.

**Key Characteristics:**
- ✅ **Bit-exact lossless compression** for time-series data
- ✅ **Deterministic encoding** (same input → same output bytes)
- ✅ **Fail-closed safety** (rejects corrupted/incomplete data)
- ✅ **Domain-agnostic** (works with any monotonic time-series)
- ✅ **Dual-stream architecture** (CORE + QUARANTINE)
- ✅ **Enterprise-grade auditing** (full telemetry and traceability)

**What GICS is NOT:**
- ❌ NOT AI-driven (no hallucinations or approximations)
- ❌ NOT general-purpose (specialized for time-series)
- ❌ NOT lossy (strictly bit-exact roundtrips)

---

## 🚀 Quick Start

### Installation

#### From source
```bash
git clone <repository-url>
cd gics-core
npm install
npm run build
```

### Basic Usage

```typescript
import { GICS } from 'gics-core';

// 1. Simple API (Pack/Unpack)
const snapshots = [
  {
    timestamp: Date.now(),
    items: new Map([
      [1, { price: 100, quantity: 10 }]
    ])
  }
];

// Pack to Uint8Array
const bytes = await GICS.pack(snapshots);

// Unpack
const decoded = await GICS.unpack(bytes);

// Verify integrity (hash chain + CRC) without decompression
const isValid = await GICS.verify(bytes);

// 2. Advanced / Streaming API
const encoder = new GICS.Encoder();

await encoder.addSnapshot({
  timestamp: Date.now(),
  items: new Map([
    [1001, { price: 125.50, quantity: 42 }]
  ])
});

const compressed = await encoder.finish();
console.log(`Compressed size: ${compressed.length} bytes`);

const decoder = new GICS.Decoder(compressed);
const result = await decoder.getAllSnapshots();
```



---

## 📦 Project Structure

```
gics-core/
├── src/
│   ├── index.ts                  # Main entry point & public API
│   ├── gics-types.ts             # Core type definitions
│   ├── gics-utils.ts             # Varint, RLE, and encoding utilities
│   └── gics/                     # v1.3 codec implementation
│       ├── encode.ts             # Section/Segment level encoding
│       ├── decode.ts             # Section/Segment level decoding
│       ├── format.ts             # Binary format specification
│       ├── codecs.ts             # Internal bit-level codecs
│       ├── string-dict.ts        # String dictionary support
│       ├── segment.ts            # Segment-level operations
│       └── errors.ts             # Typed error definitions
├── tests/                        # Vitest test suites (v1.3 only)
├── bench/                        # Benchmark harness & results
├── tools/                        # Verification scripts and legacy code
│   └── legacy/                   # Frozen v1.1/v1.2 code (archived)
└── docs/                         # Architecture documentation
```

---

## 🏗️ Architecture

### Dual-Stream Design

```
[ DATA SOURCE ]
      ↓
[ Entropy Gate ]
    /       \
 CORE    QUARANTINE
  ↓           ↓
 High      Fallback
Compression   (1:1)
  ↓           ↓
[ Combined Output ]
```

- **CORE Stream**: Predictable data with high compression (50x+ typical)
- **QUARANTINE Stream**: Volatile/high-entropy data preserved as-is
- **Why?**: Guarantees integrity while optimizing for common patterns

### Key Components

| Component | Purpose |
|-----------|---------|
| `GICSv2Encoder` | State machine for ingesting frames and emitting compressed blocks |
| `GICSv2Decoder` | The enforcer — validates structure, enforces EOS, checks integrity |
| `CHM` | Compression Health Monitor — tracks ratios and routes to CORE/QUARANTINE |
| `Context` | Isolated compression state (no global mutable state) |

---

## 🔒 Safety Guarantees

### What GICS Guarantees

✅ **Bit-Exactness**: `input === output` (byte-for-byte)  
✅ **Determinism**: Same input + config → same output bytes  
✅ **Fail-Closed**: Never silently accepts malformed/truncated data  
✅ **EOS Enforcement**: Decoder strictly requires End-of-Stream marker  
✅ **Type Safety**: No `any` types — full TypeScript contracts

### Common Failure Modes

| Failure | Behavior | Why |
|---------|----------|-----|
| Missing EOS | `IncompleteDataError` | Prevents ambiguity between "end" and "network cut" |
| Truncation | Immediate rejection | Partial data is dangerous data |
| Corruption | `IntegrityError` | Checksum/structural validation |
| High Entropy | Routes to QUARANTINE | Refuses to fit noise into models |

---

## 📊 Performance

### Compression Ratios (Typical)

| Data Type | CORE Ratio | Overall Ratio |
|-----------|------------|---------------|
| Trending prices | 50x - 100x | 40x - 80x |
| Constant values | 100x+ | 90x+ |
| High volatility | N/A (QUARANTINE) | 1.0x - 2x |
| Mixed regime | 20x - 50x | 15x - 40x |

**Note**: Compression ratio is **NOT guaranteed** — it depends entirely on data structure. White noise = 1.0x ratio.

### Throughput

- **Encoding**: ~10-50 MB/s (single-threaded)
- **Decoding**: ~20-60 MB/s (single-threaded)
- **Latency**: Block-based (slight buffering for codec selection)

---

## 🧪 Testing & Verification

### Run Tests
```bash
npm test
```

### Run Benchmarks
```bash
npm run bench
```

### Verify Integrity
```bash
npm run verify
```

---

## SonarCloud (automatic analysis)

This repository contains a GitHub Actions workflow at:

- `.github/workflows/sonar.yml`

To enable automatic scans on push / PR:

1) In GitHub, go to **Settings → Secrets and variables → Actions**
2) Add a repository secret:
   - `SONAR_TOKEN` (from SonarCloud: **My Account → Security → Generate Tokens**)
3) Ensure your SonarCloud project key matches `sonar-project.properties`:
   - `sonar.projectKey=Shiloren_Gred-In-Compression-System`
   - and set the correct `sonar.organization` value for your SonarCloud org.

After that, you should see the workflow running in **GitHub → Actions**.

---

## 📚 Documentation

- **[Implementation Report](./docs/reports/GICS_v1.3_IMPLEMENTATION_REPORT.md)**: Current architecture and implementation details
- **[Security Model](./docs/SECURITY_MODEL.md)**: Safety guarantees and threat model
- **[Format Specification](./docs/FORMAT.md)**: Binary format and encoding details
- **[Repository Layout](./docs/REPO_LAYOUT.md)**: Project structure overview
- **[Versioning](./docs/VERSIONING.md)**: Version history and archive references

---

## 🎯 Use Cases

### ✅ When to Use GICS

- Financial audit logs (trade/transaction records)
- Event sequence verification (anti-tamper systems)
- Sensor data for safety-critical systems
- Any domain requiring **provable correctness**

### ❌ When NOT to Use GICS

- Streaming video/audio (use H.264/AAC)
- Lossy metrics where 99% accuracy suffices
- High-frequency trading where microseconds matter more than correctness

---

## 🔧 Advanced Configuration

### Custom Encoder Options

```typescript
const encoder = new GICSv2Encoder({
  streamId: 1,              // Stream identifier (default: auto-assigned)
  enableTelemetry: true     // Enable detailed compression telemetry
});
```

### Accessing Telemetry

```typescript
const telemetry = encoder.getTelemetry();
console.log(`
  Core Ratio: ${telemetry.core_ratio.toFixed(2)}x
  Quarantine Rate: ${(telemetry.quarantine_rate * 100).toFixed(1)}%
  Total Output: ${telemetry.total_output_bytes} bytes
`);
```

---

## 🛡️ Security & Compliance

- **No external network calls**: Fully offline/airgapped compatible
- **No AI/ML**: Deterministic algorithms only
- **No telemetry leaks**: All metrics stay local
- **Cryptographic validation**: Optional integrity checks via `IntegrityGuardian`

---

## 📄 License

**Proprietary** — All rights reserved.  
Unauthorized distribution or modification is prohibited.

---

## 🙋 Support

For technical support, integration questions, or bug reports:

1. Check [Security Model](./docs/SECURITY_MODEL.md)
2. Review [test cases](./tests/) for usage examples
3. Contact: [Your Contact Info]

---

## 🔖 Version History

### v1.3.0 (Current) — Production Release
- ✅ **Clean Namespace**: `GICS.pack`, `GICS.unpack`, `GICS.verify`.
- ✅ **StreamSections**: Optimized grouped streams with outer Zstd compression.
- ✅ **Integrity Chain**: SHA-256 hash chain linking all sections and segments.
- ✅ **Encryption**: AES-256-GCM per section with deterministic IVs.
- ✅ **Trial-Based Codecs**: Automatic selection of best internal codec per stream.


### v1.2.0 — Canonical Release
- Dual-stream architecture (CORE/QUARANTINE)
- Compression Health Monitor (CHM)
- Full EOS enforcement
- Type-safe error handling

### v1.1.x — Legacy (Archived)
- See [GICS-ARCHIVE](../GICS-ARCHIVE/) for historical versions

---

## 🚦 Status

**Production-Ready** ✅

All critical assurance gates have been passed:
- ✅ Determinism verified
- ✅ Integrity roundtrip validated
- ✅ EOS enforcement hardened
- ✅ Quarantine semantics proven
- ✅ Performance benchmarks met

**Safe for critical civil infrastructure deployment.**
