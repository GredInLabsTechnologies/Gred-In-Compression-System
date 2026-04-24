# GICS 1.3.5 — Bug Report: Python SDK pollutes parent stdout when daemon is spawned under a stdio JSON-RPC host

- **Reporter**: GIMO team (Gred In Multiagent Orchestrator), downstream consumer of `@gredinlabstechnologies/gics-core`
- **Date filed**: 2026-04-09
- **Affects version**: 1.3.4 (current `package.json` version of this repo)
- **Target fix version**: 1.3.5
- **Severity**: HIGH for any consumer that embeds GICS inside an MCP / LSP / JSON-RPC-over-stdio process. LOW for consumers that run GICS only from a TTY or from a long-lived HTTP backend.
- **Component**: `clients/python/gics_client.py` — `GICSDaemonSupervisor.start`
- **Sister-repo cross-reference**: `gred_in_multiagent_orchestrator` is shipping a local patch on its vendored copy of this file as a temporary workaround. The patch will be reverted when 1.3.5 lands. See "Workaround for 1.3.4 consumers" below.

---

## Summary

When a Python host process starts the GICS daemon via `GICSDaemonSupervisor.start()`, the spawned Node daemon **inherits the parent process's stdout and stderr file descriptors**. The daemon legitimately writes human-readable lifecycle messages to stdout (`[GICS] Daemon started on ...`, `[GICS] PID: ...`, `[GICS] Replaying WAL...`, `[Supervisor] ... -> ... : ...`, etc. — see `src/daemon/server.ts` and `src/daemon/supervisor.ts`). If the parent process happens to be using its own stdout as a structured protocol channel (e.g. an MCP server speaking JSON-RPC over stdio), those log lines are interleaved into the protocol stream and corrupt it.

The downstream symptom seen in MCP clients (e.g. Claude Code consuming GIMO's MCP bridge) is a stream of toast errors of the form:

```
MCP gimo: Unexpected token 'G', "[GICS] Repl"... is not valid JSON
MCP gimo: Unexpected token 'G', "[GICS] WAL "... is not valid JSON
MCP gimo: Unexpected token 'G', "[GICS] Daem"... is not valid JSON
MCP gimo: Unexpected token 'G', "[GICS] PID:"... is not valid JSON
MCP gimo: Unexpected token 'S', "[Supervisor"... is not valid JSON
```

These are not errors in the MCP host or in the daemon — they are the JSON-RPC client correctly rejecting non-JSON bytes that the GICS daemon emitted onto a channel that does not belong to it.

---

## Root cause (single line)

`clients/python/gics_client.py`, around **line 724**:

```python
self.process = subprocess.Popen(args, cwd=self.cwd)
```

`subprocess.Popen` with no `stdout`/`stderr` argument inherits the parent's file descriptors 1 and 2. The Node daemon then writes through them.

This is a quiet but load-bearing assumption baked into the SDK: *"whoever calls `start()` has a stdout that is safe to write human prose into."* That assumption holds for a developer running `python -m something` in a terminal, and for a long-lived HTTP backend, but it **does not hold** for any process whose stdout is a structured protocol stream.

---

## Reproduction

1. Build a tiny Python program that:
   - Acts as a JSON-RPC server over stdin/stdout (an MCP server, an LSP server, or just a `print(json.dumps(...))` loop).
   - On startup, calls `GICSDaemonSupervisor(...).start()`.
2. Have any JSON-RPC client connect to that program over stdio.
3. Observe: the very first lines the client receives are not JSON, they are `[GICS] Daemon started on ...` etc., and the client errors out.

In GIMO's case the host is the GIMO MCP bridge (`tools/gimo_server/mcp_bridge/server.py`), which since GIMO R20 calls a shared bootstrap helper that ends up invoking `GICSDaemonSupervisor.start`. Before R20 the bridge did not arrange for the daemon to be started from this code path, so the bug was latent. R20 did not introduce the bug — it merely exercised a code path that exposes a pre-existing assumption in the SDK.

---

## Why this is a GICS-side bug (and not just a downstream caller mistake)

A library that spawns a child process **must not** silently capture its caller's stdout/stderr without either (a) documenting it loudly or (b) providing an opt-out. The current SDK fails both:

- The docstring of `GICSDaemonSupervisor.start` does not warn that the daemon will inherit parent fds.
- There is no parameter to redirect the daemon's stdio.
- The only workaround for a downstream user is to monkey-patch `subprocess.Popen` or to fork the vendored file, neither of which is a sustainable contract.

A safer default for a library-spawned daemon is **either**:

1. Redirect to `subprocess.DEVNULL` by default (silent), **or**
2. Redirect to a log file under a well-known path (e.g. `<data_path>/logs/gics_daemon.log`), **or**
3. Pipe and consume in a background thread.

Option 2 is the friendliest for operators because it preserves diagnostics.

---

## Proposed fix for 1.3.5

Add an explicit `log_path` keyword parameter to `GICSDaemonSupervisor.__init__` with a sensible default, and use it in `start()`. Initialize a `_log_fh` slot in `__init__` and close it in `stop()`.

```python
class GICSDaemonSupervisor:
    def __init__(self, *, address, token_path, data_path, cwd=None,
                 node_executable="node", cli_path=None,
                 log_path=None):  # NEW kwarg
        ...
        self.token_path = token_path
        self.data_path = data_path
        self.process = None
        # NEW
        if log_path is None:
            base = data_path or os.path.join(self.cwd or os.getcwd(), ".gics")
            log_path = os.path.join(base, "logs", "gics_daemon.log")
        self.log_path = log_path
        self._log_fh = None

    def start(self, wait=True, timeout=10.0, extra_args=None):
        args = [self.node_executable, self.cli_path, 'daemon', 'start']
        if self.data_path:
            args.extend(['--data-path', self.data_path])
        if self.address:
            args.extend(['--socket-path', self.address])
        if self.token_path:
            args.extend(['--token-path', self.token_path])
        if extra_args:
            args.extend(extra_args)

        os.makedirs(os.path.dirname(self.log_path), exist_ok=True)
        self._log_fh = open(self.log_path, "ab", buffering=0)
        self.process = subprocess.Popen(
            args,
            cwd=self.cwd,
            stdout=self._log_fh,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
        )
        if wait:
            self.wait_until_ready(timeout=timeout)
        return self.process

    def stop(self):
        try:
            if self.process and self.process.poll() is None:
                self.process.terminate()
                try:
                    self.process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait(timeout=5)
                return 0
            return 0
        finally:
            if self._log_fh is not None:
                try:
                    self._log_fh.close()
                finally:
                    self._log_fh = None
```

Notes for the implementer:

- `stdin=subprocess.DEVNULL` is also recommended: it prevents any future change in the daemon (e.g. an interactive prompt on first run) from blocking on the parent's stdin, which has the symmetric problem on JSON-RPC hosts.
- Keep the parameter name explicit (`log_path`) so callers can pass `os.devnull` to opt into total silence, or any path of their choosing.
- The default location should live under `data_path` (not `cwd`) so multi-instance deployments do not collide.
- Consider rotating the log file (size cap or daily) — out of scope for this bug fix, worth a follow-up issue.
- Mirror the same change in any sibling SDKs (Node client, Go client, etc.) that spawn the daemon via inherited fds.

---

## Suggested CHANGELOG entry for 1.3.5

```markdown
### Fixed
- **Python SDK** (`clients/python/gics_client.py`): `GICSDaemonSupervisor.start`
  no longer inherits the parent process's stdout/stderr when spawning the
  Node daemon. The daemon's lifecycle output is now redirected to a log file
  under `<data_path>/logs/gics_daemon.log` by default. This unbreaks
  consumers that embed GICS inside MCP / LSP / JSON-RPC-over-stdio hosts,
  where any non-JSON byte on stdout corrupts the protocol stream.
  A new `log_path` keyword argument allows callers to override the
  destination (or pass `os.devnull` to silence the daemon entirely).
  The daemon's stdin is now also redirected to `DEVNULL` to prevent
  symmetric breakage if the daemon ever reads from stdin in the future.
  Reported by the GIMO team. See
  `docs/reports/2026-04-09_GICS_1_3_5_BUG_PYTHON_SDK_STDIO_POLLUTION.md`.
```

---

## Backwards compatibility

The change is **observable but non-breaking** for existing callers:

- Callers that previously relied on seeing `[GICS] ...` lines on their own stdout will stop seeing them there. They will instead find them in `<data_path>/logs/gics_daemon.log`. This is a quality-of-life improvement, not a regression — those lines were never part of any documented API contract.
- No method signature is removed. `log_path` is keyword-only with a default, so all existing call sites compile unchanged.
- The default log location is under `data_path`, which is already a per-instance directory, so multi-tenant deployments do not collide.

---

## Test plan for 1.3.5

1. **Unit**: spy on `subprocess.Popen` and assert that `start()` passes a writable file object as `stdout`, `subprocess.STDOUT` as `stderr`, and `subprocess.DEVNULL` as `stdin`.
2. **Unit**: assert that `stop()` closes the log file handle and resets `_log_fh` to `None`.
3. **Integration**: start the supervisor, wait until ready, write a known marker via the daemon (e.g. trigger a `[GICS] WAL replayed.` line), stop, then assert the marker is present in the configured `log_path` file.
4. **Regression** (the actual MCP scenario): build a minimal Python script that prints exactly one JSON line to stdout, then calls `GICSDaemonSupervisor.start()`, then prints a second JSON line, then exits. Capture the script's stdout from a parent process and assert that it contains exactly two lines and both parse as JSON. Without the fix this test fails; with the fix it passes.
5. **Cross-platform**: run #3 and #4 on Linux, macOS, and Windows. The original GIMO failure was observed on Windows 11 under Claude Code, where the `proactor` event loop also surfaces "I/O operation on closed pipe" noise when child fds are inherited and the parent shell detaches — the redirect fix sidesteps that class of failure as well.

---

## Workaround for 1.3.4 consumers (until 1.3.5 ships)

Downstream consumers stuck on 1.3.4 can patch their vendored copy of `clients/python/gics_client.py` line 724 to the same `Popen` call shown above. The GIMO team has applied this patch locally inside `gred_in_multiagent_orchestrator/vendor/gics/clients/python/gics_client.py`, marked with a `LOCAL PATCH (pending GICS 1.3.5)` comment block, and will revert the patch and reabsorb the upstream vendor when 1.3.5 ships.

GIMO's local log destination is `<.gimo>/logs/gics_daemon.log` rather than `<data_path>/logs/...`, because in GIMO the daemon is bootstrapped before `data_path` is fully resolved in some code paths. The upstream fix should prefer `data_path` when available and fall back to a reasonable per-cwd location only as a last resort.

---

## Contact

- Downstream repo: `gred_in_multiagent_orchestrator` (GIMO), part of the same Gred In Labs organization as this repo.
- Local fix tracked in GIMO under R20 follow-up (post-Phase-4).
- Both repos are maintained by the same team — the GIMO patch can be ported back as a PR against the GICS 1.3.x branch on request.
