# GICS 1.3.5 — Bug Report: `daemon start` silently ignores `--token-path`, forcing a token split with any consumer that set one

- **Reporter**: GIMO team (Gred In Multiagent Orchestrator), downstream consumer of `@gredinlabstechnologies/gics-core`
- **Date filed**: 2026-04-24
- **Affects version**: 1.3.4 (current `package.json` version of this repo; shipped in the `dist/` compiled on 2026-04-10)
- **Target fix version**: 1.3.5
- **Severity**: **CRITICAL** for any consumer that passes `--token-path` to `gics daemon start`. The daemon silently boots against the *default* token file while the consumer's client library reads from the *passed* path — every subsequent RPC returns `-32000 Unauthorized` for the entire lifetime of the daemon. The daemon still reports `alive=True` on its health endpoint because `ping` is exempt from auth (see `src/daemon/server.ts:1548`), so the breakage is invisible to any health probe that only calls `ping`.
- **Component**: `src/cli/commands.ts` — `daemonStart()` (compiled into `dist/src/cli/commands.js`)
- **Regression window**: introduced no later than the build shipped in `dist/` dated 2026-04-10. Consumers that started the daemon through `daemonStart` with `--token-path` before that build had working auth; after that build, all writes and scans are rejected. GIMO's `.orch_data/ops/gics_data/gics.wal` stopped receiving new records on **2026-04-10 04:57**, which matches the transition window.
- **Sister-repo cross-reference**: `gred_in_multiagent_orchestrator` is running without a workaround; its F7 proof-of-execution chain has been silently empty for the last 14 days. A local patch on the vendored `dist/` is planned if 1.3.5 does not land in-window — see "Workaround for 1.3.4 consumers" below.

---

## Summary

`gics daemon start` exposes a `--token-path <path>` CLI flag. The flag is documented in three separate help banners of the very same file (`src/cli/commands.ts` lines 620, 748, 783, each advertising `--token-path <path>   Explicit daemon token path`). Sibling functions in the same file correctly read the flag (e.g. `resolveDaemonTarget()` at line 65). **But the one function that most needs the flag — the function that starts the daemon — never parses it.** It hardcodes `tokenPath = DEFAULT_TOKEN_PATH` (`~/.gics/gics.token`), completely disregarding whatever the caller passed.

The consequence is a silent cryptographic split between the daemon and its clients:

- The daemon boots. It reads the token from `~/.gics/gics.token` (or generates one if the file is missing, via `ensureToken()` in `src/daemon/server.ts`). It caches that token in RAM for its lifetime.
- The consumer (e.g. GIMO) reads the token from the path it actually passed — e.g. `.orch_data/ops/gics.token` — and caches *that* string in the Python `GICSClient`.
- Every RPC carries the client's token in the JSON-RPC body (`gics_client.py::_call`, line 139).
- The daemon compares `request.token !== this.token` at `src/daemon/server.ts:1548`. The two tokens are different files, written by different processes at different times — they do not match.
- The daemon returns `{ jsonrpc: '2.0', id, error: { code: -32000, message: 'Unauthorized' } }` for every method that is not `ping`. For `ping`, it returns OK, so `GICSClient.is_alive()` and any health probe that polls `ping` keep reporting `alive=True`.

Net effect on consumers: every `put`, `get`, `scan`, `delete`, `put_many`, `count_prefix`, `scan_summary`, `seed_profile`, `seed_policy` returns `-32000 Unauthorized`. Proof-of-execution chains never persist. Task telemetry never persists. Reliability tracking never updates. The daemon accepts connections and looks healthy.

The daemon also produces no warning at boot that `--token-path` was passed-and-ignored, because the flag never reaches any code that could warn about it. This is a **silent** bug.

---

## Root cause

`src/cli/commands.ts`, function `daemonStart()`. Lines 995–1017 (current `main`, commit corresponding to the 2026-04-10 dist):

```typescript
async function daemonStart(args: string[]): Promise<number> {
    const dataPath = parseFlag(args, '--data-path') ?? DEFAULT_DATA_PATH;
    const socketPath = parseFlag(args, '--socket-path') ?? DEFAULT_SOCKET;
    const walType = (parseFlag(args, '--wal-type') ?? 'binary') as 'binary' | 'jsonl';
    const configPath = parseFlag(args, '--config');
    const modulesOverride = parseModuleList(parseFlag(args, '--modules'));

    // Lazy import to avoid loading daemon code for non-daemon commands
    const { GICSDaemon } = await import('../daemon/server.js');
    const { resolveDaemonConfig, DEFAULT_CONFIG_PATH } = await import('../daemon/config.js');

    console.log(daemonBanner());

    // Ensure home dir exists
    const { mkdirSync } = await import('fs');
    mkdirSync(GICS_HOME, { recursive: true });

    const tokenPath = DEFAULT_TOKEN_PATH;   // ← THE BUG. Never reads --token-path.
    const defaults = {
        socketPath,
        dataPath,
        tokenPath,
        walType,
    };
    const resolved = await resolveDaemonConfig(configPath ?? DEFAULT_CONFIG_PATH, defaults, modulesOverride);
    // ... resolved.daemon.tokenPath is the one handed to the daemon.
    const daemon = new GICSDaemon({
        ...resolved.daemon,
        // ...
    });
```

The same file parses *every other* relevant daemon flag via `parseFlag(args, '...')` — `--data-path` (line 995), `--socket-path` (line 996), `--wal-type` (line 997), `--config` (line 998), `--modules` (line 999). **Only `--token-path` is missing.** It is not a semantic decision ("we do not allow overriding the token path"): the flag is still documented in three help banners of this file (lines 620, 748, 783), and its sibling function `resolveDaemonTarget()` at line 65 *does* read it:

```typescript
async function resolveDaemonTarget(args: string[]) {
    const explicitSocketPath = parseFlag(args, '--socket-path');
    const explicitTokenPath = parseFlag(args, '--token-path');   // ← read here
    // ...
    const tokenPath = explicitTokenPath ?? resolved.daemon.tokenPath;
    const token = readFileSync(tokenPath, 'utf8').trim();
    return { socketPath, tokenPath, token };
}
```

So the intent of the CLI — "pass me a token path, I will use it" — is correctly implemented for the client side (the side that calls the daemon) but not for the daemon side (the side that *is* the daemon). Because a consumer typically spawns the daemon **and** talks to it, both sides of the split-brain exist in the same consumer, and the result is that the consumer's `--token-path` is respected by its own client but not by the daemon it just spawned.

The bug is a single missing line. It is almost certainly a regression: `resolveDaemonTarget` shows what the "correct" pattern looks like and `daemonStart` should mirror it.

---

## How clients hit this in practice

The canonical spawn path used by the Python SDK:

1. `GICSDaemonSupervisor.start()` (in `clients/python/gics_client.py`) spawns the Node daemon via `subprocess.Popen([node, cli_index_js, 'daemon', 'start', '--data-path', ..., '--socket-path', ..., '--token-path', ..., ...])`. It passes every path flag, because the whole point of the supervisor is "deploy GICS inside *this* consumer's data directory, not in `~/.gics/`".
2. The daemon boots. `daemonStart` reads `--data-path` (good) and `--socket-path` (good), so data and the IPC endpoint land where the consumer wants. But `daemonStart` ignores `--token-path` and silently falls back to `~/.gics/gics.token`. So the daemon's token file is in one place, and all other GICS state is in another.
3. `ensureToken()` at `src/daemon/server.ts:166` now runs against `~/.gics/gics.token`:
   - If the consumer has *never* used the home-dir path, `ensureToken` generates a new random token and writes it to `~/.gics/gics.token`. The consumer's passed path is never touched, so it either does not exist or keeps its old token.
   - If `~/.gics/gics.token` already exists from a prior unrelated run (another project, an earlier GICS install, a developer who once ran `gics daemon start` without arguments), the daemon reuses *that* token. Again, unrelated to whatever the consumer passed.
4. The consumer's client library, via `GICSClient._get_token()` at `clients/python/gics_client.py:66`, reads the token file the consumer specified (`--token-path`, which the client library honours correctly). Call this `token_A`.
5. The daemon's in-memory token is whatever was in `~/.gics/gics.token`. Call this `token_B`.
6. First RPC: the Python client sends `{ ..., token: token_A }`. The daemon compares `token_A !== token_B` at `src/daemon/server.ts:1548` and returns `-32000 Unauthorized`.
7. `is_alive()` in the client library calls `ping`. `ping` is exempt from auth (`if (token !== this.token && method !== 'ping')`), so it returns OK. The supervisor and the health loop mark the daemon `alive`. The consumer's application layer sees `alive=True` and moves on.
8. Every real operation fails silently (the SDK's `put/scan/get/...` methods log the error and return `None`/`[]`/`False` — see `clients/python/gics_client.py`'s `except` branches, and GIMO's own `gics_service.py` wrapper which also swallows-and-returns).

---

## Timeline of the bug in the GIMO codebase (evidence)

GIMO's data directory is the forensic artefact. GIMO runs GICS via `GICSDaemonSupervisor` with `token_path=<project>/.orch_data/ops/gics.token` and `data_path=<project>/.orch_data/ops/gics_data`.

- `vendor/gics/dist/` mtime on the GIMO side: **2026-04-10 02:00** → the build of GICS shipped to GIMO was produced on that date.
- `.orch_data/ops/gics_data/gics.wal` last modified: **2026-04-10 04:57** → last time the daemon persisted any record. All 46 historical proof records in the WAL predate this timestamp.
- `.orch_data/ops/gics.token` last modified: **2026-03-19** (still holds the token from the last working auth — GIMO never rotates it, because nothing in GIMO's code touches this file after creation).
- `~/.gics/gics.token` last modified: **2026-04-06** → written (or rewritten) by some earlier `gics daemon start` invocation that also fell into this bug. Contents are a different hex string from the project-scoped one.
- First observation in GIMO server.log (`~/.gimo/server.log` after a fresh `gimo up` on 2026-04-24):
  ```
  ERROR: GICS scan(prefix='ops:proof:thread_a3073d21:') failed: GICS error -32000: Unauthorized
  ERROR: GICS put(ops:proof:thread_a3073d21:proof_71ffab1f19934b7d) failed: GICS error -32000: Unauthorized
  ERROR: GICS get(ops:task:agentic_chat:gpt-5-codex) failed: GICS error -32000: Unauthorized
  [... identical pattern for every proof, every task stats record, every model score, every task pattern, every telemetry event]
  ```

Reading the two timestamps together: the dist build that GIMO uses was produced at 02:00 on 2026-04-10; last successful persistence happened at 04:57 on the same day, almost 3 hours later. The most plausible reconstruction: an earlier daemon process (pre-rebuild) kept running with the old, correct in-memory token until 04:57; after that process finally exited, every subsequent daemon was the new build, which ignores `--token-path`, and every RPC from the new builds has been rejected.

---

## Reproduction (clean-room)

Minimal reproduction that does not depend on GIMO at all:

```bash
# 1. Create a scratch token directory.
mkdir -p /tmp/gics-scratch
echo "AAAA1111BBBB2222CCCC3333DDDD4444" > /tmp/gics-scratch/gics.token

# 2. Start the daemon, passing --token-path explicitly.
node dist/src/cli/index.js daemon start \
  --data-path /tmp/gics-scratch/data \
  --socket-path /tmp/gics-scratch/sock \
  --token-path /tmp/gics-scratch/gics.token &
DAEMON_PID=$!
sleep 1

# 3. Inspect what the daemon actually wrote.
#    On a machine that does NOT have ~/.gics/, observe that the daemon
#    silently created ~/.gics/gics.token with a random token, ignoring
#    /tmp/gics-scratch/gics.token entirely.
cat ~/.gics/gics.token                 # ← random 32-hex generated by daemon
cat /tmp/gics-scratch/gics.token       # ← still "AAAA...4444", untouched
diff <(cat ~/.gics/gics.token) <(cat /tmp/gics-scratch/gics.token)
# → tokens differ.

# 4. Any client that was told to use /tmp/gics-scratch/gics.token will
#    now be rejected as Unauthorized:
node dist/src/cli/index.js put foo '{"bar":1}' \
  --socket-path /tmp/gics-scratch/sock \
  --token-path /tmp/gics-scratch/gics.token
# → Error: -32000 Unauthorized

# 5. But ping succeeds (ping is exempt), so liveness checks lie:
node dist/src/cli/index.js ping \
  --socket-path /tmp/gics-scratch/sock \
  --token-path /tmp/gics-scratch/gics.token
# → ok

kill $DAEMON_PID
```

The same reproduction via the Python SDK:

```python
import tempfile, os, time
from pathlib import Path
from gics_client import GICSDaemonSupervisor, GICSClient

tmp = Path(tempfile.mkdtemp())
(tmp / "gics.token").write_text("AAAA1111BBBB2222CCCC3333DDDD4444")

sup = GICSDaemonSupervisor(
    cli_path="./dist/src/cli/index.js",
    address=str(tmp / "sock"),
    token_path=str(tmp / "gics.token"),
    data_path=str(tmp / "data"),
    node_executable="node",
)
sup.start(wait=True, timeout=15.0)

client = GICSClient(
    address=str(tmp / "sock"),
    token_path=str(tmp / "gics.token"),
)

print("ping:", client.ping())          # → {"status":"ok",...}   (misleading)
print("scan:", client.scan(prefix=""))  # → []  (SDK swallows the -32000 and returns [])
# Real error is logged:
#   ERROR: GICS scan(prefix='') failed: GICS error -32000: Unauthorized
```

---

## Expected behaviour

`daemonStart` should mirror the pattern already established by `resolveDaemonTarget` at line 65. Concretely:

```typescript
async function daemonStart(args: string[]): Promise<number> {
    const dataPath = parseFlag(args, '--data-path') ?? DEFAULT_DATA_PATH;
    const socketPath = parseFlag(args, '--socket-path') ?? DEFAULT_SOCKET;
    const walType = (parseFlag(args, '--wal-type') ?? 'binary') as 'binary' | 'jsonl';
    const configPath = parseFlag(args, '--config');
    const modulesOverride = parseModuleList(parseFlag(args, '--modules'));
    const explicitTokenPath = parseFlag(args, '--token-path');   // ← NEW

    // ... (imports, banner, mkdirSync)

    const tokenPath = explicitTokenPath ?? DEFAULT_TOKEN_PATH;   // ← was: DEFAULT_TOKEN_PATH
    // rest unchanged
}
```

That is a one-line change. It keeps the default (`~/.gics/gics.token`) when no flag is passed, preserving the ergonomics of a developer running `gics daemon start` in a terminal, and honours the flag when present — which matches the documented behaviour and matches what every other flag in `daemonStart` already does.

Additionally, to prevent this class of regression from happening again:

1. **Warn on flag drop**. `parseFlag` could maintain a set of consumed flags; `daemonStart` could assert that there are no unconsumed flags among a known set (`--data-path`, `--socket-path`, `--token-path`, `--wal-type`, `--config`, `--modules`). Unknown flags become a hard error; documented-but-unconsumed flags become a warning. Either catches this failure mode at boot.
2. **Boot log line**. Add a single line at daemon start: `[GICS] Token path: <resolved path>`. This makes divergence visible with a 1-line diff in `server.log` — a consumer who sees the daemon log `~/.gics/gics.token` when they expected `.orch_data/ops/gics.token` will immediately know something is wrong. This costs nothing and would have cut this bug's detection time from 14 days to the first `gimo up` after the rebuild.
3. **Unify socket-path / token-path / data-path parsing into one helper.** Right now the three paths are parsed independently in `daemonStart`, which makes it easy to forget one (as happened). A small helper `parseDaemonPaths(args)` that returns all three would make the asymmetry impossible — either all paths are read or the helper fails to compile.

---

## Regression tests to add in 1.3.5

Three tests, all cheap:

1. **CLI flag is honoured**: spawn `gics daemon start --token-path /some/path/gics.token`, observe that `/some/path/gics.token` is the file the daemon reads (and, if absent, creates). The current default (`~/.gics/gics.token`) must not be touched when the flag is given.
2. **End-to-end put/scan with an explicit token path**: write a known token to a scratch path, start the daemon with `--token-path <scratch>`, do a `put` via the SDK with `token_path=<scratch>`, do a `scan`, verify the record comes back. This is the exact path that a consumer like GIMO takes; if this test had existed in 1.3.4, the bug would never have shipped.
3. **Liveness must not lie**: a daemon that cannot authenticate any real operation should not advertise itself as healthy. Either `ping` should require auth too, or the daemon's own health endpoint should include a cheap authenticated round-trip. The current setup (auth-less `ping` + authed everything-else) means "alive" is indistinguishable from "dead-to-this-consumer", and consumers built health checks on the wrong primitive for 14 days.

Test (3) is a scope decision — tests (1) and (2) are sufficient to close the specific bug.

---

## Workaround for 1.3.4 consumers (documented for sibling-repo use)

Two options that do not require patching GICS:

**Option A — Sync the tokens at consumer boot.**

Before calling `GICSDaemonSupervisor.start()`, copy the consumer's token file to `~/.gics/gics.token` (create the directory if needed). If the consumer's token file does not yet exist, create one there first and then mirror it to `~/.gics/gics.token`. Because the daemon's `ensureToken()` reads the file when it exists and only generates a new one when it does not, mirroring in advance guarantees both sides see the same bytes.

Pseudocode for the Python consumer:

```python
import shutil, os
from pathlib import Path

consumer_token = Path(".orch_data/ops/gics.token")
home_token = Path.home() / ".gics" / "gics.token"
home_token.parent.mkdir(parents=True, exist_ok=True)
if consumer_token.exists():
    shutil.copy2(consumer_token, home_token)
else:
    # first-time boot: generate on the consumer path, then mirror
    import secrets
    token = secrets.token_hex(16)
    consumer_token.parent.mkdir(parents=True, exist_ok=True)
    consumer_token.write_text(token)
    home_token.write_text(token)

# now safe to start the daemon — both files hold the same token
sup.start(...)
```

This is pure-consumer code, no changes to vendored GICS.

**Option B — Vendor-patch `dist/`.**

One-line patch to `vendor/gics/dist/src/cli/commands.js` at the call site (line 1011 in the 2026-04-10 build):

```diff
-    const tokenPath = DEFAULT_TOKEN_PATH;
+    const tokenPath = parseFlag(args, '--token-path') ?? DEFAULT_TOKEN_PATH;
```

Equivalent patch against `src/cli/commands.ts` if the consumer also has the TypeScript source. This is correct but must be reverted when 1.3.5 lands, so it should be a clearly-marked patch file (e.g. `patches/gics-1.3.4-token-path.diff`) applied at vendoring time, not a silent edit to `vendor/gics/dist/`.

GIMO will take **Option A** in the short term (pure-consumer code, no vendored binary edits).

---

## Severity justification

Quoting the `is_alive()` contract of the SDK: a daemon that answers `ping` is alive. That contract is load-bearing — consumers plug it into health checks, startup gates, circuit breakers, refusal-to-serve invariants (GIMO refuses to serve without GICS since R23; see `tools/gimo_server/main.py:429`). This bug makes `alive` **technically true and semantically false**: the daemon answers `ping`, so `alive=True`, but no other operation can succeed.

Downstream consequences observed in GIMO alone:

- F7 proof-of-execution chain (the cryptographic audit trail for every tool call) has been empty for 14 days.
- Task stats (`ops:task:*`), model reliability scores (`ops:model_score:*`), task-pattern telemetry (`ops:task_pattern:*`), and cost-engine records (`ce:*`) have all been un-persisted for 14 days. Any analysis that reads from GICS (e.g. Thompson sampling priors, cascade routing decisions, benchmark enrichment priors) is running against the frozen-on-2026-04-10 snapshot and will degrade silently as real workloads drift.
- Governance enforcement that reads from GICS (trust, security events, circuit breakers) is running against a read-only view of April-10 state.

Any GICS consumer that does not run in the developer's home directory is exposed to this. A production-grade deployment that sites GICS under `/var/lib/app/gics/` is the **exact** shape that trips the bug.

---

## Proposed fix footprint

- `src/cli/commands.ts` line 1011: one-line change (`DEFAULT_TOKEN_PATH` → `parseFlag(args, '--token-path') ?? DEFAULT_TOKEN_PATH`).
- `CHANGELOG.md`: `1.3.5 — Fixed: daemon start now honours --token-path (regression in 1.3.4).`
- Three tests added per the list above.
- Rebuild `dist/`. Ship.

Estimated reviewer time: 10 minutes reading the diff, 30 minutes writing the three tests, done.

---

Fin del reporte.
