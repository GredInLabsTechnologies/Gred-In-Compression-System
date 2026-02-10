# Bench Forensics (GICS)

This folder contains **forensic / evidence-grade** benchmark harnesses.

Goals:
- Produce **stable artifacts** (raw input, encoded bytes, traces, KPI JSON, decoded output) that can be inspected and verified.
- Validate **product KPIs** (CORE-only) separately from global/storage ratios.
- Stay **isolated** from the fast `bench/scripts/*` harness (no mixed concerns).

## Postfreeze harness

Location:
- `bench/forensics/postfreeze/*`

Run:
```bash
npm run bench:forensics
npm run bench:forensics:verify
npm run bench:forensics:summary
```

Artifacts are written to:
- `bench/forensics/artifacts/postfreeze/`

Notes:
- The harness is deterministic (seeded RNG) and runs **A/B** to verify determinism.
- No `process.env` is used (future-proof / reproducible).
