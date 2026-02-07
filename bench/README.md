# GICS Benchmark Suite

This directory contains the empirical benchmark suite for the GICS compression system.

## Reproducibility Contract
1. **Deterministic Inputs**: All datasets are generated via seeded RNG.
2. **Environment Recording**: Every result records CPU, RAM, OS, and software versions.
3. **No Hidden State**: Each benchmark run isolates variables as much as possible.
4. **Data Integrity**: All outputs are verified for correctness before measuring performance.

## Usage

### Run All (Recommended)
```powershell
./bench/scripts/run-all.ps1
```
This script will:
1. Generate datasets (in memory).
2. Run the harness for all active workloads.
3. Save results to `bench/results/*.json`.
4. Generate `bench/report.md`.

### Run Manually
```bash
npx tsx bench/scripts/harness.ts
npx tsx bench/scripts/gen-report.ts
```

## Structure
- `scripts/`: Implementation of harness, generators, and reporting.
- `results/`: Machine-generated JSON result files.
- `spec.md`: Detailed specification of workloads and datasets.
