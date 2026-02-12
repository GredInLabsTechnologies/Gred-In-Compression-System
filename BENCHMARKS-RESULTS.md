# Historical Benchmark Results

This file tracks benchmark outcomes across key validation runs and documents gate expectations.

## v1.3.2 (2026-02-12)

- `bench:empirical` (hard gate): **PASS**
  - Weighted critical ratio: **870.40x**
  - Critical integrity: **true**

- `bench:strict` (scenario/multi-codec audit): available for deep audit runs
- `bench:validate-50x`: dedicated per-dataset 50x guarantee validator (new)
- `bench:security`: cryptographic/tamper validation suite (active)
- `bench:edge-cases`: IEEE-754 + mixed-entropy behavior benchmark (new)

## Gate policy summary

- Release and CI minimum:
  1. `npm run bench:gate`
  2. `npm run bench:validate-50x`
  3. `npm run bench:security`

- Extended quality run:
  - `npm run quality:strict:full`
  - Includes strict + security + edge-cases in addition to gate checks.

## Notes

- Historical JSON/MD artifacts are produced under `bench/results/latest/` and archived in `bench/results/` with timestamped names.
- Forensics determinism remains available via:
  - `npm run bench:forensics`
  - `npm run bench:forensics:verify`
