# Historical Benchmark Results

This file tracks benchmark outcomes across key validation runs and documents gate expectations.

## v1.3.3-pre (2026-03-18)

Current pre-release benchmark references for the `dev/v1.3.3` branch:

- `bench:empirical`: **PASS**
  - Weighted critical ratio: **870.40x**
  - Critical integrity: **true**
  - Artifact: `bench/results/latest/empirical-report.md`

- `bench:validate-50x`: **PASS**
  - `market_data_trending`: **556.64x**
  - `market_data_stable`: **820.38x**
  - `iot_sensor_periodic`: **808.75x**
  - `event_log_structured`: **632.91x**
  - Artifact: `bench/results/latest/validate-50x-report.md`

- `bench:security`: **PASS**
  - tamper rejection: **true**
  - wrong password rejection: **true**
  - timing resistance check: **true**
  - Artifact: `bench/results/latest/empirical-security-report.md`

- `bench:long-horizon`: available, but intentionally limited in scope
  - horizon: **1 year**
  - snapshots: **730**
  - items per snapshot: **8**
  - ratio: **6.63x**
  - verify: **true**
  - roundtrip: **true**
  - Artifact: `bench/results/latest/long-horizon-report.md`

- test validation:
  - `reports/vitest-junit.xml`
  - **284 tests**
  - **0 failures**
  - **0 errors**

### Interpretation

- The critical benchmark artifacts support strong compression claims for the benchmarked workloads.
- The security artifact supports current encryption/tamper-detection claims.
- The long-horizon artifact proves there is a real long-horizon run in the branch, but it does not justify universal claims about arbitrary workloads running for years without failure.

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
