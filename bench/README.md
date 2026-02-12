# GICS Benchmark Suite

This directory contains complementary benchmark paths:

1. **Exploratory harness** (`bench/scripts/harness.ts`) for iterative performance analysis.
2. **Empirical fail-state gate** (`bench/scripts/empirical.ts`) for objective acceptance checks.
3. **Strict multi-codec audit** (`bench/scripts/empirical-strict.ts`) for A/B/C-style scenarios.
4. **50x dedicated validator** (`bench/scripts/validate-50x-guarantee.ts`) for dataset-specific guarantees.
5. **Security benchmark** (`bench/scripts/empirical-security.ts`) for crypto integrity controls.
6. **Edge-case benchmark** (`bench/scripts/empirical-edge-cases.ts`) for IEEE-754 and mixed-entropy cases.
7. **Codec-stats benchmark** (`bench/scripts/empirical-codec-stats.ts`) for codec selection and quarantine telemetry distribution.

---

## Fail-State Contract (Hard Gate)

The empirical benchmark is considered **PASS** only if all the following are true:

1. **Critical weighted compression ratio (GICS) >= 50x**
2. **Integrity validation is 100%** on all critical datasets
3. No benchmark runtime error occurred

If any condition fails, the process exits non-zero and CI must fail.

> Threshold can be overridden with `GICS_MIN_RATIO_X` (default `50`).

---

## Usage

### 1) Hard gate (recommended for release/CI)

```bash
npm run bench:gate
```

Outputs:
- `bench/results/latest/empirical-report.json`
- `bench/results/latest/empirical-report.md`
- `bench/results/empirical-<timestamp>.json`

### 2) Empirical run (same engine, local analysis)

```bash
npm run bench:empirical
```

### 2.b) Strict empirical audit (A/B/C, protobuf+msgpack+arrow+structured-binary)

```bash
npm run bench:strict
```

Outputs:
- `bench/results/latest/empirical-strict-report.json`
- `bench/results/latest/empirical-strict-report.txt`
- `bench/results/empirical-strict-<timestamp>.json`

### 2.c) Validate 50x guarantee (dedicated datasets)

```bash
npm run bench:validate-50x
```

Outputs:
- `bench/results/latest/validate-50x-report.json`
- `bench/results/latest/validate-50x-report.md`
- `bench/results/validate-50x-<timestamp>.json`

### 2.d) Security benchmark

```bash
npm run bench:security
```

Outputs:
- `bench/results/latest/empirical-security-report.json`
- `bench/results/latest/empirical-security-report.md`

### 2.e) Edge-case benchmark

```bash
npm run bench:edge-cases
```

Outputs:
- `bench/results/latest/empirical-edge-cases-report.json`
- `bench/results/latest/empirical-edge-cases-report.md`

### 2.f) Codec-stats benchmark

```bash
npm run bench:codec-stats
```

Outputs:
- `bench/results/latest/empirical-codec-stats-report.json`
- `bench/results/latest/empirical-codec-stats-report.md`

### 3) Legacy exploratory benchmark + report

```bash
npm run bench
```

Or:

```powershell
./bench/scripts/run-all.ps1
```

---

## Reproducibility Contract

1. **Deterministic inputs** where seeded generation is used.
2. **Environment recorded** (OS/CPU/Node/git commit in empirical report).
3. **Structured output** (JSON + Markdown) for auditability.
4. **Integrity checked** for GICS and baseline decode flow.

---

## Structure

- `scripts/`: benchmark engines, datasets, comparators, reporting.
- `results/`: machine-generated outputs and latest artifacts.
- `spec.md`: benchmark scenario notes.

---

## Benchmark matrix

| Benchmark | Purpose | Gate/Threshold | Primary output |
|---|---|---|---|
| `bench:gate` | CI hard-gate for weighted critical ratio | Weighted critical ratio >= 50x + integrity | `empirical-report.json` |
| `bench:strict` | Multi-codec and scenario strictness | Realistic B1 consistency and >50x criteria | `empirical-strict-report.json` |
| `bench:validate-50x` | Dedicated 50x guarantees per dataset | Each dataset >= expectedMinRatio | `validate-50x-report.json` |
| `bench:security` | Cryptographic and tamper controls | All checks must pass | `empirical-security-report.json` |
| `bench:edge-cases` | Float/IEEE-754 and entropy edge behavior | Verify + roundtrip semantics | `empirical-edge-cases-report.json` |
| `bench:codec-stats` | Codec/stream distribution + quarantine observability | Report generated + integrity pass | `empirical-codec-stats-report.json` |
| `bench:forensics:verify` | Postfreeze deterministic verification | Determinism and KPI consistency | forensics verifier artifacts |
