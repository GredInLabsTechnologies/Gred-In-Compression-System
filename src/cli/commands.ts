/**
 * GICS CLI Commands (Phase 10 → v1.3.3 UX)
 *
 * Implements: encode, decode, verify, info, bench, profile, daemon
 * Zero external dependencies, ANSI UX via ui.ts
 */

import * as fs from 'fs/promises';
import * as net from 'net';
import * as path from 'path';
import * as os from 'os';
import { existsSync, writeFileSync, readFileSync, unlinkSync } from 'fs';
import { GICSv2Encoder } from '../gics/encode.js';
import { GICSv2Decoder } from '../gics/decode.js';
import type { GenericSnapshot } from '../gics-types.js';
import type { CompressionPreset } from '../gics/types.js';
import { CompressionProfiler } from '../gics/profiler.js';
import { Spinner, c, table, formatBytes, colorRatio, daemonBanner, mapReplacer } from './ui.js';

export interface CLIContext {
    args: string[];
    cwd: string;
}

function parseFlag(args: string[], flag: string): string | null {
    const idx = args.indexOf(flag);
    if (idx === -1) return null;
    const value = args[idx + 1];
    if (!value || value.startsWith('-')) return null;
    return value;
}

function hasFlag(args: string[], flag: string): boolean {
    return args.includes(flag);
}

const GICS_HOME = path.join(os.homedir(), '.gics');
const PID_FILE = path.join(GICS_HOME, 'gics.pid');
const DEFAULT_DATA_PATH = path.join(GICS_HOME, 'data');
const DEFAULT_SOCKET = process.platform === 'win32'
    ? '\\\\.\\pipe\\gics-daemon'
    : path.join(GICS_HOME, 'gics.sock');

/**
 * gics encode <input.json> [-o output.gics] [--preset ...] [--password <pw>]
 */
export async function encodeCommand(ctx: CLIContext): Promise<number> {
    if (hasFlag(ctx.args, '--help')) {
        console.log(`${c.bold('gics encode')} — Compress JSON data to GICS format

${c.bold('Usage:')} gics encode <input.json> [options]

${c.bold('Options:')}
  -o <path>           Output file path (default: <input>.gics)
  --preset <name>     Compression preset: balanced, max_ratio, low_latency
  --password <pw>     Encrypt with password
  --verbose           Show detailed compression info`);
        return 0;
    }

    const inputPath = ctx.args[0];
    if (!inputPath) {
        console.error('Usage: gics encode <input.json> [-o output.gics] [--preset balanced|max_ratio|low_latency] [--password <pw>]');
        return 2;
    }

    if (!existsSync(inputPath)) {
        console.error(`${c.red('Error:')} input file not found: ${inputPath}`);
        return 1;
    }

    const outputPath = parseFlag(ctx.args, '-o') ?? inputPath.replace(/\.json$/, '.gics');
    const presetStr = parseFlag(ctx.args, '--preset') ?? 'balanced';
    const password = parseFlag(ctx.args, '--password') ?? undefined;
    const verbose = hasFlag(ctx.args, '--verbose');

    const preset: CompressionPreset = ['balanced', 'max_ratio', 'low_latency'].includes(presetStr)
        ? (presetStr as CompressionPreset)
        : 'balanced';

    const spinner = new Spinner();
    spinner.start(`Compressing ${path.basename(inputPath)}...`);

    try {
        const startMs = Date.now();
        const raw = await fs.readFile(inputPath, 'utf8');
        const data = JSON.parse(raw) as {
            schema: any;
            snapshots: Array<{ timestamp: number; items: Record<string, Record<string, number | string>> | Map<string, Record<string, number | string>> }>;
        };

        const encoder = new GICSv2Encoder({ schema: data.schema, preset, password });
        let snapshotCount = 0;
        for (const snapshot of data.snapshots) {
            const itemsMap = snapshot.items instanceof Map
                ? snapshot.items
                : new Map(Object.entries(snapshot.items));
            await encoder.addSnapshot({ timestamp: snapshot.timestamp, items: itemsMap });
            snapshotCount++;
        }
        const compressed = await encoder.finish();
        await fs.writeFile(outputPath, compressed);
        const elapsedMs = Date.now() - startMs;

        const ratio = raw.length / compressed.length;
        spinner.succeed(`Encoded: ${path.basename(inputPath)} → ${path.basename(outputPath)}`);
        console.log(`  ${formatBytes(raw.length)} → ${formatBytes(compressed.length)}  (${colorRatio(ratio)} compression)`);

        if (verbose) {
            console.log(c.dim(`  Preset: ${preset} | Snapshots: ${snapshotCount} | Time: ${elapsedMs}ms`));
        }
        return 0;
    } catch (err: any) {
        spinner.fail(`Encoding failed: ${err.message}`);
        return 1;
    }
}

/**
 * gics decode <input.gics> [-o output.json] [--password <pw>]
 */
export async function decodeCommand(ctx: CLIContext): Promise<number> {
    if (hasFlag(ctx.args, '--help')) {
        console.log(`${c.bold('gics decode')} — Decompress GICS archive to JSON

${c.bold('Usage:')} gics decode <input.gics> [options]

${c.bold('Options:')}
  -o <path>           Output file path (default: <input>.decoded.json)
  --password <pw>     Decrypt with password
  --verbose           Show detailed decompression info`);
        return 0;
    }

    const inputPath = ctx.args[0];
    if (!inputPath) {
        console.error('Usage: gics decode <input.gics> [-o output.json] [--password <pw>]');
        return 2;
    }

    if (!existsSync(inputPath)) {
        console.error(`${c.red('Error:')} input file not found: ${inputPath}`);
        return 1;
    }

    const outputPath = parseFlag(ctx.args, '-o') ?? inputPath.replace(/\.gics$/, '.decoded.json');
    const password = parseFlag(ctx.args, '--password') ?? undefined;
    const verbose = hasFlag(ctx.args, '--verbose');

    const spinner = new Spinner();
    spinner.start(`Decompressing ${path.basename(inputPath)}...`);

    try {
        const startMs = Date.now();
        const raw = await fs.readFile(inputPath);
        const decoder = new GICSv2Decoder(raw, { password });
        await decoder.parseHeader();
        const schema = decoder.getSchema();
        const snapshots = await decoder.getAllGenericSnapshots();
        const totalItems = snapshots.reduce((sum, s) => sum + s.items.size, 0);

        const output = { schema, snapshots };
        await fs.writeFile(outputPath, JSON.stringify(output, mapReplacer, 2));
        const elapsedMs = Date.now() - startMs;

        spinner.succeed(`Decoded: ${path.basename(inputPath)} → ${path.basename(outputPath)} (${snapshots.length} snapshots, ${totalItems.toLocaleString()} items)`);

        if (verbose) {
            console.log(c.dim(`  Schema: ${schema.id} v${schema.version} | Fields: ${schema.fields.length} | Time: ${elapsedMs}ms`));
        }
        return 0;
    } catch (err: any) {
        spinner.fail(`Decoding failed: ${err.message}`);
        return 1;
    }
}

/**
 * gics verify <input.gics> [--password <pw>]
 */
export async function verifyCommand(ctx: CLIContext): Promise<number> {
    if (hasFlag(ctx.args, '--help')) {
        console.log(`${c.bold('gics verify')} — Verify integrity of a GICS archive

${c.bold('Usage:')} gics verify <input.gics> [options]

${c.bold('Options:')}
  --password <pw>     Decrypt with password`);
        return 0;
    }

    const inputPath = ctx.args[0];
    if (!inputPath) {
        console.error('Usage: gics verify <input.gics> [--password <pw>]');
        return 2;
    }

    if (!existsSync(inputPath)) {
        console.error(`${c.red('Error:')} input file not found: ${inputPath}`);
        return 1;
    }

    const password = parseFlag(ctx.args, '--password') ?? undefined;

    const spinner = new Spinner();
    spinner.start(`Verifying integrity of ${path.basename(inputPath)}...`);

    try {
        const raw = await fs.readFile(inputPath);
        const decoder = new GICSv2Decoder(raw, { password });
        const valid = await decoder.verifyIntegrityOnly();

        if (valid) {
            spinner.succeed(c.bold(`Integrity valid: ${inputPath}`));
            return 0;
        } else {
            spinner.fail(c.bold(`INTEGRITY FAILED: ${inputPath}`));
            return 1;
        }
    } catch (err: any) {
        spinner.fail(`Verification error: ${err.message}`);
        return 1;
    }
}

/**
 * gics info <input.gics> [--password <pw>]
 */
export async function infoCommand(ctx: CLIContext): Promise<number> {
    if (hasFlag(ctx.args, '--help')) {
        console.log(`${c.bold('gics info')} — Display archive metadata

${c.bold('Usage:')} gics info <input.gics> [options]

${c.bold('Options:')}
  --password <pw>     Decrypt with password`);
        return 0;
    }

    const inputPath = ctx.args[0];
    if (!inputPath) {
        console.error('Usage: gics info <input.gics> [--password <pw>]');
        return 2;
    }

    if (!existsSync(inputPath)) {
        console.error(`${c.red('Error:')} input file not found: ${inputPath}`);
        return 1;
    }

    const password = parseFlag(ctx.args, '--password') ?? undefined;

    try {
        const raw = await fs.readFile(inputPath);
        const decoder = new GICSv2Decoder(raw, { password });
        await decoder.parseHeader();
        const schema = decoder.getSchema();
        const snapshots = await decoder.getAllGenericSnapshots();
        const totalItems = snapshots.reduce((sum, s) => sum + s.items.size, 0);

        console.log(table(
            ['Property', 'Value'],
            [
                ['File', path.basename(inputPath)],
                ['Size', formatBytes(raw.length)],
                ['Schema', `${schema.id} (v${schema.version})`],
                ['Fields', String(schema.fields.length)],
                ['Snapshots', String(snapshots.length)],
                ['Total Items', totalItems.toLocaleString()],
            ]
        ));

        return 0;
    } catch (err: any) {
        console.error(`${c.red('Error:')} ${err.message}`);
        return 1;
    }
}

/**
 * gics bench <input.json> [--runs N]
 */
export async function benchCommand(ctx: CLIContext): Promise<number> {
    if (hasFlag(ctx.args, '--help')) {
        console.log(`${c.bold('gics bench')} — Benchmark encode/decode performance

${c.bold('Usage:')} gics bench <input.json> [options]

${c.bold('Options:')}
  --runs <N>          Number of benchmark runs (default: 3)`);
        return 0;
    }

    const inputPath = ctx.args[0];
    if (!inputPath) {
        console.error('Usage: gics bench <input.json> [--runs N]');
        return 2;
    }

    if (!existsSync(inputPath)) {
        console.error(`${c.red('Error:')} input file not found: ${inputPath}`);
        return 1;
    }

    const runs = parseInt(parseFlag(ctx.args, '--runs') ?? '3', 10);

    try {
        const raw = await fs.readFile(inputPath, 'utf8');
        const data = JSON.parse(raw) as {
            schema: any;
            snapshots: Array<{ timestamp: number; items: Record<string, Record<string, number | string>> | Map<string, Record<string, number | string>> }>;
        };

        const results: Array<{ ratio: number; encodeMs: number; decodeMs: number }> = [];

        for (let i = 0; i < runs; i++) {
            process.stdout.write(`\r  ${c.dim(`Run ${i + 1}/${runs}...`)}`);

            const encStart = Date.now();
            const encoder = new GICSv2Encoder({ schema: data.schema });
            for (const snapshot of data.snapshots) {
                // Fix 6: Convert plain object to Map if needed (same as encodeCommand)
                const itemsMap = snapshot.items instanceof Map
                    ? snapshot.items
                    : new Map(Object.entries(snapshot.items));
                await encoder.addSnapshot({ timestamp: snapshot.timestamp, items: itemsMap });
            }
            const compressed = await encoder.finish();
            const encMs = Date.now() - encStart;

            const decStart = Date.now();
            const decoder = new GICSv2Decoder(compressed);
            await decoder.getAllGenericSnapshots();
            const decMs = Date.now() - decStart;

            const ratio = raw.length / compressed.length;
            results.push({ ratio, encodeMs: encMs, decodeMs: decMs });
        }

        process.stdout.write('\r\x1b[K');

        const avgRatio = results.reduce((sum, r) => sum + r.ratio, 0) / results.length;
        const avgEncMs = results.reduce((sum, r) => sum + r.encodeMs, 0) / results.length;
        const avgDecMs = results.reduce((sum, r) => sum + r.decodeMs, 0) / results.length;

        const rows = results.map((r, i) => [
            String(i + 1),
            colorRatio(r.ratio),
            `${r.encodeMs.toFixed(1)} ms`,
            `${r.decodeMs.toFixed(1)} ms`,
        ]);
        rows.push([
            c.bold('AVG'),
            c.bold(colorRatio(avgRatio)),
            c.bold(`${avgEncMs.toFixed(1)} ms`),
            c.bold(`${avgDecMs.toFixed(1)} ms`),
        ]);

        console.log(table(['Run', 'Ratio', 'Encode', 'Decode'], rows));

        return 0;
    } catch (err: any) {
        console.error(`${c.red('Error:')} ${err.message}`);
        return 1;
    }
}

/**
 * gics profile <input.json>
 */
export async function profileCommand(ctx: CLIContext): Promise<number> {
    if (hasFlag(ctx.args, '--help')) {
        console.log(`${c.bold('gics profile')} — Find optimal compression settings

${c.bold('Usage:')} gics profile <input.json>`);
        return 0;
    }

    const inputPath = ctx.args[0];
    if (!inputPath) {
        console.error('Usage: gics profile <input.json>');
        return 2;
    }

    if (!existsSync(inputPath)) {
        console.error(`${c.red('Error:')} input file not found: ${inputPath}`);
        return 1;
    }

    const spinner = new Spinner();
    spinner.start(`Profiling ${path.basename(inputPath)}...`);

    try {
        const raw = await fs.readFile(inputPath, 'utf8');
        const data = JSON.parse(raw) as {
            schema: any;
            snapshots: Array<{ timestamp: number; items: Record<string, Record<string, number | string>> | Map<string, Record<string, number | string>> }>;
        };

        // Convert items to Map if needed
        const snapshots = data.snapshots.map(s => ({
            timestamp: s.timestamp,
            items: s.items instanceof Map ? s.items : new Map(Object.entries(s.items)),
        }));

        const result = await CompressionProfiler.profile(snapshots, 'quick', { schema: data.schema });

        spinner.succeed(`Profile complete: ${path.basename(inputPath)}`);

        const rows = result.trials.map((t: any) => {
            const isBest = t.ratio === result.bestRatio && t.encodeMs === result.bestEncodeMs;
            const mark = isBest ? ` ${c.green('★')}` : '';
            const ratioStr = isBest ? c.bold(c.green(`${t.ratio.toFixed(2)}x`)) : `${t.ratio.toFixed(2)}x`;
            return [
                `${t.compressionLevel}`,
                `${t.blockSize}`,
                ratioStr + mark,
                `${t.encodeMs.toFixed(1)} ms`,
            ];
        });

        console.log(table(['Level', 'Block', 'Ratio', 'Encode'], rows));
        console.log(c.dim(`  Best: zstd level ${result.compressionLevel}, block size ${result.blockSize}`));

        return 0;
    } catch (err: any) {
        spinner.fail(`Profiling failed: ${err.message}`);
        return 1;
    }
}

/**
 * gics daemon start|stop|status
 */
export async function daemonCommand(ctx: CLIContext): Promise<number> {
    const subcommand = ctx.args[0];
    const subArgs = ctx.args.slice(1);

    if (hasFlag(ctx.args, '--help') || !subcommand || !['start', 'stop', 'status'].includes(subcommand)) {
        console.log(`${c.bold('gics daemon')} — Manage the GICS background daemon

${c.bold('Usage:')} gics daemon <start|stop|status> [options]

${c.bold('Subcommands:')}
  start    Start the daemon (foreground)
  stop     Stop a running daemon
  status   Check daemon status

${c.bold('Options (start):')}
  --data-path <dir>     Data directory (default: ~/.gics/data)
  --socket-path <path>  Socket path (default: platform-specific)
  --wal-type <type>     WAL type: binary or jsonl (default: binary)`);
        return subcommand ? 0 : 2;
    }

    switch (subcommand) {
        case 'start':
            return daemonStart(subArgs);
        case 'stop':
            return daemonStop();
        case 'status':
            return daemonStatus(subArgs);
        default:
            return 2;
    }
}

async function daemonStart(args: string[]): Promise<number> {
    const dataPath = parseFlag(args, '--data-path') ?? DEFAULT_DATA_PATH;
    const socketPath = parseFlag(args, '--socket-path') ?? DEFAULT_SOCKET;
    const walType = (parseFlag(args, '--wal-type') ?? 'binary') as 'binary' | 'jsonl';

    // Lazy import to avoid loading daemon code for non-daemon commands
    const { GICSDaemon } = await import('../daemon/server.js');

    console.log(daemonBanner());

    // Ensure home dir exists
    const { mkdirSync } = await import('fs');
    mkdirSync(GICS_HOME, { recursive: true });

    const tokenPath = path.join(GICS_HOME, 'gics.token');

    const daemon = new GICSDaemon({
        socketPath,
        dataPath,
        tokenPath,
        walType,
    });

    // Write PID file
    writeFileSync(PID_FILE, String(process.pid));

    // Trap signals for graceful shutdown
    const shutdown = async () => {
        console.log(c.yellow('\n[GICS] Shutting down...'));
        await daemon.stop();
        try { unlinkSync(PID_FILE); } catch { /* ignore */ }
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    try {
        await daemon.start();
        console.log(c.green(`[GICS] Daemon started on ${socketPath}`));
        console.log(c.dim(`[GICS] PID: ${process.pid} | Data: ${dataPath} | WAL: ${walType}`));
        // Keep process alive
        await new Promise(() => {});
        return 0;
    } catch (err: any) {
        console.error(c.red(`[GICS] Failed to start: ${err.message}`));
        try { unlinkSync(PID_FILE); } catch { /* ignore */ }
        return 1;
    }
}

async function daemonStop(): Promise<number> {
    if (!existsSync(PID_FILE)) {
        console.log(c.yellow('No daemon running (no PID file found)'));
        return 1;
    }

    const pid = parseInt(readFileSync(PID_FILE, 'utf8').trim(), 10);
    if (isNaN(pid)) {
        console.error(c.red('Invalid PID file'));
        try { unlinkSync(PID_FILE); } catch { /* ignore */ }
        return 1;
    }

    try {
        if (process.platform === 'win32') {
            const { execSync } = await import('child_process');
            execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' });
        } else {
            process.kill(pid, 'SIGTERM');
        }
        console.log(c.green(`Daemon stopped (PID ${pid})`));
    } catch {
        console.log(c.yellow(`Process ${pid} not found — cleaning up PID file`));
    }

    try { unlinkSync(PID_FILE); } catch { /* ignore */ }
    return 0;
}

async function daemonStatus(args: string[]): Promise<number> {
    const socketPath = parseFlag(args, '--socket-path') ?? DEFAULT_SOCKET;
    const tokenPath = path.join(GICS_HOME, 'gics.token');

    let token = '';
    try {
        token = readFileSync(tokenPath, 'utf8').trim();
    } catch {
        console.log(c.red('Daemon not configured (no token file)'));
        return 1;
    }

    return new Promise<number>((resolve) => {
        const socket = net.createConnection(socketPath, () => {
            const request = JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'ping',
                token,
            });
            socket.write(request + '\n');
        });

        let buffer = '';
        socket.on('data', (data) => {
            buffer += data.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const response = JSON.parse(line);
                    if (response.result) {
                        const r = response.result;
                        console.log(table(
                            ['Property', 'Value'],
                            [
                                ['Status', c.green(r.status ?? 'ok')],
                                ['Uptime', `${r.uptime?.toFixed(0) ?? '?'}s`],
                                ['Records', String(r.count ?? 0)],
                                ['WAL Type', r.walType ?? '?'],
                                ['Warm Segments', String(r.segments ?? 0)],
                                ['Cold Segments', String(r.coldSegments ?? 0)],
                                ['Insights', String(r.insightsTracked ?? 0)],
                                ['Supervisor', r.supervisorState ?? '?'],
                            ]
                        ));
                    } else if (response.error) {
                        console.error(c.red(`Error: ${response.error.message}`));
                    }
                } catch { /* ignore parse errors */ }
                socket.end();
                resolve(0);
            }
        });

        socket.on('error', () => {
            console.log(c.red('Daemon not running'));
            resolve(1);
        });

        setTimeout(() => {
            socket.destroy();
            console.log(c.red('Daemon not responding (timeout)'));
            resolve(1);
        }, 3000);
    });
}
