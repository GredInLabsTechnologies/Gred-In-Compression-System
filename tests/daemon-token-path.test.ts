/**
 * Regression tests for GICS 1.3.5 — `daemon start --token-path` handling.
 *
 * Covers the bug where `daemonStart()` hardcoded DEFAULT_TOKEN_PATH and silently
 * ignored the CLI flag, causing every non-`ping` RPC to fail with -32000
 * Unauthorized while health probes lied with alive=True.
 *
 * Spawns the CLI as a subprocess (daemon start runs indefinitely) with an
 * overridden HOME/USERPROFILE so PID/default paths land inside the test temp
 * dir — no pollution of the developer's ~/.gics/.
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const SEEDED_TOKEN_A = 'A'.repeat(32);
const SEEDED_TOKEN_B = 'B'.repeat(32);

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gics-token-path-test-'));
    try {
        await run(dir);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
}

function makeSocketPath(name: string): string {
    return process.platform === 'win32'
        ? `\\\\.\\pipe\\${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`
        : path.join(os.tmpdir(), `${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
}

function spawnDaemon(cliPath: string, cliArgs: string[], homeDir: string): ChildProcess {
    return spawn('node', [cliPath, 'daemon', 'start', ...cliArgs], {
        env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
}

function waitForDaemonReady(child: ChildProcess, timeoutMs = 15_000): Promise<void> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            child.stdout?.off('data', onData);
            child.stderr?.off('data', onErr);
            reject(new Error('daemon did not become ready within timeout'));
        }, timeoutMs);

        const onData = (chunk: Buffer) => {
            if (chunk.toString('utf8').includes('Daemon started on')) {
                clearTimeout(timer);
                child.stdout?.off('data', onData);
                child.stderr?.off('data', onErr);
                resolve();
            }
        };
        const onErr = () => { /* swallow stderr noise */ };
        child.stdout?.on('data', onData);
        child.stderr?.on('data', onErr);
        child.once('exit', (code) => {
            clearTimeout(timer);
            reject(new Error(`daemon exited before ready (code=${code})`));
        });
    });
}

async function stopDaemon(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill();
    await Promise.race([
        exited,
        new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
    ]);
    if (child.exitCode === null && process.platform === 'win32' && typeof child.pid === 'number') {
        try {
            const { execSync } = await import('node:child_process');
            execSync(`taskkill /PID ${child.pid} /F /T`, { stdio: 'ignore' });
        } catch { /* ignore */ }
    }
}

describe('daemon start --token-path (GICS 1.3.5 regression)', () => {
    const cliPath = path.resolve('dist/src/cli/index.js');

    it('honours --token-path: pre-seeded token file is not clobbered and daemon accepts it', async () => {
        await withTempDir(async (dir) => {
            const homeDir = path.join(dir, 'home');
            await fs.mkdir(homeDir, { recursive: true });
            const dataPath = path.join(dir, 'data');
            const tokenPath = path.join(dir, 'gics.token');
            const socketPath = makeSocketPath('gics-tp-honour');

            await fs.writeFile(tokenPath, SEEDED_TOKEN_A);

            const daemon = spawnDaemon(cliPath, [
                '--data-path', dataPath,
                '--socket-path', socketPath,
                '--token-path', tokenPath,
            ], homeDir);

            try {
                await waitForDaemonReady(daemon);

                // Seeded token must be intact.
                const afterStart = (await fs.readFile(tokenPath, 'utf8')).trim();
                expect(afterStart).toBe(SEEDED_TOKEN_A);

                // Default path (<home>/.gics/gics.token) must NOT have been created.
                const defaultTokenPath = path.join(homeDir, '.gics', 'gics.token');
                await expect(fs.stat(defaultTokenPath)).rejects.toMatchObject({ code: 'ENOENT' });

                // Authenticated RPC with the seeded token must succeed (not -32000).
                const put = await execFileAsync('node', [
                    cliPath, 'rpc', 'put',
                    '--socket-path', socketPath,
                    '--token-path', tokenPath,
                    '--params-json', JSON.stringify({ key: 'probe:honour:1', fields: { value: 1 } }),
                ]);
                expect(JSON.parse(put.stdout).ok).toBe(true);
            } finally {
                await stopDaemon(daemon);
            }
        });
    }, 30_000);

    it('end-to-end put/scan with explicit --token-path returns the record (no -32000)', async () => {
        await withTempDir(async (dir) => {
            const homeDir = path.join(dir, 'home');
            await fs.mkdir(homeDir, { recursive: true });
            const dataPath = path.join(dir, 'data');
            const tokenPath = path.join(dir, 'gics.token');
            const socketPath = makeSocketPath('gics-tp-e2e');

            await fs.writeFile(tokenPath, SEEDED_TOKEN_A);

            const daemon = spawnDaemon(cliPath, [
                '--data-path', dataPath,
                '--socket-path', socketPath,
                '--token-path', tokenPath,
            ], homeDir);

            try {
                await waitForDaemonReady(daemon);

                const put = await execFileAsync('node', [
                    cliPath, 'rpc', 'put',
                    '--socket-path', socketPath,
                    '--token-path', tokenPath,
                    '--params-json', JSON.stringify({ key: 'probe:e2e:1', fields: { value: 42, tag: 'ok' } }),
                ]);
                expect(JSON.parse(put.stdout).ok).toBe(true);

                const scan = await execFileAsync('node', [
                    cliPath, 'rpc', 'scan',
                    '--socket-path', socketPath,
                    '--token-path', tokenPath,
                    '--params-json', JSON.stringify({ prefix: 'probe:e2e:' }),
                ]);
                const parsed = JSON.parse(scan.stdout);
                expect(parsed.items).toHaveLength(1);
                expect(parsed.items[0].key).toBe('probe:e2e:1');
                expect(parsed.items[0].fields).toEqual({ value: 42, tag: 'ok' });
            } finally {
                await stopDaemon(daemon);
            }
        });
    }, 30_000);

    it('CLI --token-path wins over config file paths.tokenPath (precedence CLI > config > default)', async () => {
        await withTempDir(async (dir) => {
            const homeDir = path.join(dir, 'home');
            await fs.mkdir(homeDir, { recursive: true });
            const dataPath = path.join(dir, 'data');
            const cliToken = path.join(dir, 'cli-token');
            const configToken = path.join(dir, 'config-token');
            const configFile = path.join(dir, 'gics.config.json');
            const socketPath = makeSocketPath('gics-tp-precedence');

            // Seed BOTH token files with distinct values.
            await fs.writeFile(cliToken, SEEDED_TOKEN_A);
            await fs.writeFile(configToken, SEEDED_TOKEN_B);

            await fs.writeFile(configFile, JSON.stringify({
                paths: { tokenPath: configToken },
            }));

            const daemon = spawnDaemon(cliPath, [
                '--data-path', dataPath,
                '--socket-path', socketPath,
                '--config', configFile,
                '--token-path', cliToken,
            ], homeDir);

            try {
                await waitForDaemonReady(daemon);

                // CLI token wins → put with cliToken must succeed.
                const put = await execFileAsync('node', [
                    cliPath, 'rpc', 'put',
                    '--socket-path', socketPath,
                    '--token-path', cliToken,
                    '--params-json', JSON.stringify({ key: 'probe:prec:1', fields: { v: 1 } }),
                ]);
                expect(JSON.parse(put.stdout).ok).toBe(true);

                // Using the config-file token must be rejected as Unauthorized.
                await expect(execFileAsync('node', [
                    cliPath, 'rpc', 'put',
                    '--socket-path', socketPath,
                    '--token-path', configToken,
                    '--params-json', JSON.stringify({ key: 'probe:prec:2', fields: { v: 2 } }),
                ])).rejects.toMatchObject({ code: 1 });
            } finally {
                await stopDaemon(daemon);
            }
        });
    }, 30_000);
});
