/**
 * GICS CLI Commands (Phase 10 → v1.3.3 UX)
 *
 * Implements: encode, decode, verify, info, bench, profile, inference, daemon
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
const DEFAULT_TOKEN_PATH = path.join(GICS_HOME, 'gics.token');
const DEFAULT_SOCKET = process.platform === 'win32'
    ? '\\\\.\\pipe\\gics-daemon'
    : path.join(GICS_HOME, 'gics.sock');
const BUILTIN_MODULES = ['audit-chain', 'native-insight', 'prompt-distiller', 'inference-engine'] as const;

function parseModuleList(value: string | null): string[] {
    if (!value) return [];
    return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function wantsJson(args: string[]): boolean {
    return hasFlag(args, '--json');
}

function wantsPrettyJson(args: string[]): boolean {
    return hasFlag(args, '--pretty');
}

function writeJson(value: unknown, pretty: boolean = false): void {
    process.stdout.write(JSON.stringify(value, mapReplacer, pretty ? 2 : undefined) + '\n');
}

async function resolveDaemonTarget(args: string[]): Promise<{ socketPath: string; tokenPath: string; token: string; }> {
    const explicitSocketPath = parseFlag(args, '--socket-path');
    const explicitTokenPath = parseFlag(args, '--token-path');
    const configPath = parseFlag(args, '--config');
    const { resolveDaemonConfig, DEFAULT_CONFIG_PATH } = await import('../daemon/config.js');
    const resolved = await resolveDaemonConfig(configPath ?? DEFAULT_CONFIG_PATH, {
        socketPath: explicitSocketPath ?? DEFAULT_SOCKET,
        dataPath: DEFAULT_DATA_PATH,
        tokenPath: explicitTokenPath ?? DEFAULT_TOKEN_PATH,
        walType: 'binary',
    });

    const socketPath = explicitSocketPath ?? resolved.daemon.socketPath;
    const tokenPath = explicitTokenPath ?? resolved.daemon.tokenPath;
    const token = readFileSync(tokenPath, 'utf8').trim();
    return { socketPath, tokenPath, token };
}

async function daemonRpcCall(
    socketPath: string,
    token: string,
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs: number = 5000
): Promise<any> {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection(socketPath, () => {
            socket.write(JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method,
                params,
                token,
            }) + '\n');
        });

        let settled = false;
        let buffer = '';
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            socket.destroy();
            reject(new Error(`RPC timeout after ${timeoutMs}ms`));
        }, timeoutMs);

        const finish = (fn: () => void) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            fn();
        };

        socket.on('data', (data) => {
            buffer += data.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            const line = lines.find((entry) => entry.trim());
            if (!line) return;
            finish(() => {
                socket.end();
                try {
                    resolve(JSON.parse(line));
                } catch (err: any) {
                    reject(new Error(`Invalid JSON-RPC response: ${err.message}`));
                }
            });
        });

        socket.on('error', (err) => {
            finish(() => reject(err));
        });
    });
}

function parseJsonInput(args: string[], inlineFlag: string, fileFlag: string): Record<string, unknown> {
    const value = parseJsonValue(args, inlineFlag, fileFlag);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return {};
    }
    return value as Record<string, unknown>;
}

function parseJsonValue(args: string[], inlineFlag: string, fileFlag: string): unknown {
    const inline = parseFlag(args, inlineFlag);
    if (inline) {
        return JSON.parse(inline);
    }

    const filePath = parseFlag(args, fileFlag);
    if (filePath) {
        return JSON.parse(readFileSync(filePath, 'utf8'));
    }

    return null;
}

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
  --password <pw>     Decrypt with password
  --json              Emit machine-readable JSON`);
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
    const asJson = wantsJson(ctx.args);
    const spinner = asJson ? null : new Spinner();

    spinner?.start(`Verifying integrity of ${path.basename(inputPath)}...`);

    try {
        const raw = await fs.readFile(inputPath);
        const decoder = new GICSv2Decoder(raw, { password });
        const valid = await decoder.verifyIntegrityOnly();

        if (asJson) {
            writeJson({ file: inputPath, valid }, wantsPrettyJson(ctx.args));
            return valid ? 0 : 1;
        }

        if (valid) {
            spinner?.succeed(c.bold(`Integrity valid: ${inputPath}`));
            return 0;
        } else {
            spinner?.fail(c.bold(`INTEGRITY FAILED: ${inputPath}`));
            return 1;
        }
    } catch (err: any) {
        if (asJson) {
            writeJson({ file: inputPath, valid: false, error: err.message }, wantsPrettyJson(ctx.args));
        } else {
            spinner?.fail(`Verification error: ${err.message}`);
        }
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
  --password <pw>     Decrypt with password
  --json              Emit machine-readable JSON`);
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
    const asJson = wantsJson(ctx.args);

    try {
        const raw = await fs.readFile(inputPath);
        const decoder = new GICSv2Decoder(raw, { password });
        await decoder.parseHeader();
        const schema = decoder.getSchema();
        const snapshots = await decoder.getAllGenericSnapshots();
        const totalItems = snapshots.reduce((sum, s) => sum + s.items.size, 0);

        if (asJson) {
            writeJson({
                file: inputPath,
                sizeBytes: raw.length,
                schema: {
                    id: schema.id,
                    version: schema.version,
                    fields: schema.fields.length,
                },
                snapshots: snapshots.length,
                totalItems,
            }, wantsPrettyJson(ctx.args));
            return 0;
        }

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

${c.bold('Usage:')} gics profile <input.json>

${c.bold('Options:')}
  --json              Emit machine-readable JSON`);
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

    const asJson = wantsJson(ctx.args);
    const spinner = new Spinner();
    if (!asJson) {
        spinner.start(`Profiling ${path.basename(inputPath)}...`);
    }

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
        if (asJson) {
            writeJson({
                file: inputPath,
                ...result,
            }, wantsPrettyJson(ctx.args));
            return 0;
        }

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
        if (asJson) {
            writeJson({ file: inputPath, error: err.message }, wantsPrettyJson(ctx.args));
        } else {
            spinner.fail(`Profiling failed: ${err.message}`);
        }
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
  --wal-type <type>     WAL type: binary or jsonl (default: binary)
  --config <path>       Persistent daemon config file
  --modules <list>      Comma-separated enabled modules

${c.bold('Options (status):')}
  --json                Emit machine-readable JSON
  --pretty              Pretty-print JSON
  --token-path <path>   Explicit daemon token path`);
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

/**
 * gics module list|status|enable|disable
 */
export async function moduleCommand(ctx: CLIContext): Promise<number> {
    const subcommand = ctx.args[0];
    const target = ctx.args[1];
    const configPath = parseFlag(ctx.args, '--config');

    if (hasFlag(ctx.args, '--help') || !subcommand || !['list', 'status', 'enable', 'disable'].includes(subcommand)) {
        console.log(`${c.bold('gics module')} â€” Manage daemon modules

${c.bold('Usage:')} gics module <list|status|enable|disable> [moduleId] [options]

${c.bold('Options:')}
  --config <path>       Config file path (default: ~/.gics/gics.config.json)
  --json                Emit machine-readable JSON`);
        return subcommand ? 0 : 2;
    }

    const { loadDaemonFileConfig, writeDaemonFileConfig, DEFAULT_CONFIG_PATH } = await import('../daemon/config.js');
    const resolvedConfigPath = configPath ?? DEFAULT_CONFIG_PATH;
    const fileConfig = await loadDaemonFileConfig(resolvedConfigPath);
    const moduleConfig = { ...(fileConfig.modules ?? {}) };

    const asJson = wantsJson(ctx.args);
    const statusItems = BUILTIN_MODULES.map((moduleId) => ({
        moduleId,
        enabled: moduleConfig[moduleId]?.enabled !== false,
    }));

    const renderStatus = () => {
        if (asJson) {
            writeJson({
                configPath: resolvedConfigPath,
                modules: statusItems,
            }, wantsPrettyJson(ctx.args));
            return;
        }
        const rows = statusItems.map((item) => {
            const label = item.enabled ? c.green('enabled') : c.red('disabled');
            return [item.moduleId, label];
        });
        console.log(table(['Module', 'Status'], rows));
    };

    switch (subcommand) {
        case 'list':
        case 'status':
            renderStatus();
            return 0;
        case 'enable':
        case 'disable': {
            if (!target || !BUILTIN_MODULES.includes(target as typeof BUILTIN_MODULES[number])) {
                console.error(c.red(`Unknown module: ${target ?? '(missing)'}`));
                return 2;
            }
            moduleConfig[target] = {
                ...(moduleConfig[target] ?? {}),
                enabled: subcommand === 'enable',
            };
            await writeDaemonFileConfig(resolvedConfigPath, {
                ...fileConfig,
                modules: moduleConfig,
            });
            if (asJson) {
                writeJson({
                    moduleId: target,
                    enabled: subcommand === 'enable',
                    configPath: resolvedConfigPath,
                }, wantsPrettyJson(ctx.args));
            } else {
                console.log(`${target}: ${subcommand === 'enable' ? 'enabled' : 'disabled'} (${resolvedConfigPath})`);
            }
            return 0;
        }
        default:
            return 2;
    }
}

/**
 * gics inference <infer|profile|recommendations|health|flush>
 */
export async function inferenceCommand(ctx: CLIContext): Promise<number> {
    const subcommand = ctx.args[0];
    const subArgs = ctx.args.slice(1);

    if (hasFlag(ctx.args, '--help') || !subcommand || !['infer', 'profile', 'recommendations', 'health', 'flush'].includes(subcommand)) {
        console.log(`${c.bold('gics inference')} — Operate the GICS inference engine

${c.bold('Usage:')} gics inference <infer|profile|recommendations|health|flush> [options]

${c.bold('Subcommands:')}
  infer             Ask the inference engine to rank candidates
  profile           Fetch a persisted inference profile
  recommendations   Fetch recent decisions and policies
  health            Show inference runtime health
  flush             Force a durable inference flush

${c.bold('Options:')}
  --json                Emit machine-readable JSON
  --pretty              Pretty-print JSON
  --socket-path <path>  Explicit daemon socket path
  --token-path <path>   Explicit daemon token path
  --config <path>       Resolve daemon paths from config`);
        return subcommand ? 0 : 2;
    }

    switch (subcommand) {
        case 'infer':
            return inferenceInfer(subArgs);
        case 'profile':
            return inferenceProfile(subArgs);
        case 'recommendations':
            return inferenceRecommendations(subArgs);
        case 'health':
            return inferenceHealth(subArgs);
        case 'flush':
            return inferenceFlush(subArgs);
        default:
            return 2;
    }
}

/**
 * gics rpc <method> [--params-json <json>]
 */
export async function rpcCommand(ctx: CLIContext): Promise<number> {
    const method = ctx.args[0];
    if (hasFlag(ctx.args, '--help') || !method) {
        console.log(`${c.bold('gics rpc')} â€” Call daemon RPC methods from scripts

${c.bold('Usage:')} gics rpc <method> [options]

${c.bold('Options:')}
  --params-json <json>  Inline JSON params
  --params-file <path>  JSON file with params
  --socket-path <path>  Explicit daemon socket path
  --token-path <path>   Explicit daemon token path
  --config <path>       Resolve daemon paths from config
  --pretty              Pretty-print JSON
  --envelope            Emit full JSON-RPC envelope

${c.bold('Examples:')}
  gics rpc get --params-json "{\\"key\\":\\"orders:42\\"}"
  gics rpc scan --params-json "{\\"prefix\\":\\"orders:\\"}" --pretty`);
        return method ? 0 : 2;
    }

    let params: Record<string, unknown>;
    try {
        params = parseJsonInput(ctx.args, '--params-json', '--params-file');
    } catch (err: any) {
        console.error(c.red(`Invalid RPC params: ${err.message}`));
        return 2;
    }

    try {
        const { socketPath, token } = await resolveDaemonTarget(ctx.args);
        const response = await daemonRpcCall(socketPath, token, method, params);
        const payload = hasFlag(ctx.args, '--envelope')
            ? response
            : (response.error ? { error: response.error } : (response.result ?? null));
        writeJson(payload, wantsPrettyJson(ctx.args));
        return response.error ? 1 : 0;
    } catch (err: any) {
        writeJson({
            error: {
                message: err.message,
            },
        }, wantsPrettyJson(ctx.args));
        return 1;
    }
}

async function inferenceInfer(args: string[]): Promise<number> {
    const domain = parseFlag(args, '--domain');
    if (!domain) {
        console.error(c.red('Missing required flag: --domain'));
        return 2;
    }

    let context: Record<string, unknown> = {};
    let candidates: Array<Record<string, unknown>> = [];
    try {
        context = parseJsonInput(args, '--context-json', '--context-file');
        const rawCandidates = parseJsonValue(args, '--candidates-json', '--candidates-file');
        if (Array.isArray(rawCandidates)) {
            candidates = rawCandidates as Array<Record<string, unknown>>;
        }
    } catch (err: any) {
        console.error(c.red(`Invalid inference JSON payload: ${err.message}`));
        return 2;
    }

    try {
        const { socketPath, token } = await resolveDaemonTarget(args);
        const response = await daemonRpcCall(socketPath, token, 'infer', {
            domain,
            objective: parseFlag(args, '--objective') ?? undefined,
            subject: parseFlag(args, '--subject') ?? undefined,
            context,
            candidates,
        }, 10_000);
        if (wantsJson(args)) {
            writeJson(response.error ? response : response.result, wantsPrettyJson(args));
            return response.error ? 1 : 0;
        }
        if (response.error) {
            console.error(c.red(response.error.message));
            return 1;
        }
        const result = response.result;
        console.log(table(
            ['Property', 'Value'],
            [
                ['Domain', result.domain],
                ['Decision ID', result.decisionId],
                ['Recommended', result.recommended?.id ?? '(none)'],
                ['Policy Version', result.policyVersion],
                ['Profile Version', result.profileVersion],
            ]
        ));
        const rankingRows = (result.ranking ?? []).map((item: any) => [
            item.id,
            Number(item.score ?? 0).toFixed(3),
            Number(item.confidence ?? 0).toFixed(3),
            Array.isArray(item.basis) ? item.basis.join('; ') : '',
        ]);
        console.log(table(['Candidate', 'Score', 'Confidence', 'Basis'], rankingRows));
        return 0;
    } catch (err: any) {
        if (wantsJson(args)) {
            writeJson({ error: err.message }, wantsPrettyJson(args));
        } else {
            console.error(c.red(err.message));
        }
        return 1;
    }
}

async function inferenceProfile(args: string[]): Promise<number> {
    const scope = parseFlag(args, '--scope') ?? 'host:default';
    try {
        const { socketPath, token } = await resolveDaemonTarget(args);
        const response = await daemonRpcCall(socketPath, token, 'getProfile', { scope });
        if (wantsJson(args)) {
            writeJson(response.error ? response : response.result, wantsPrettyJson(args));
            return response.error ? 1 : 0;
        }
        if (response.error) {
            console.error(c.red(response.error.message));
            return 1;
        }
        console.log(JSON.stringify(response.result, mapReplacer, 2));
        return 0;
    } catch (err: any) {
        if (wantsJson(args)) {
            writeJson({ error: err.message }, wantsPrettyJson(args));
        } else {
            console.error(c.red(err.message));
        }
        return 1;
    }
}

async function inferenceRecommendations(args: string[]): Promise<number> {
    const params: Record<string, unknown> = {};
    const domain = parseFlag(args, '--domain');
    const subject = parseFlag(args, '--subject');
    const limit = parseFlag(args, '--limit');
    if (domain) params.domain = domain;
    if (subject) params.subject = subject;
    if (limit) params.limit = Number(limit);

    try {
        const { socketPath, token } = await resolveDaemonTarget(args);
        const response = await daemonRpcCall(socketPath, token, 'getRecommendations', params);
        if (wantsJson(args)) {
            writeJson(response.error ? response : response.result, wantsPrettyJson(args));
            return response.error ? 1 : 0;
        }
        if (response.error) {
            console.error(c.red(response.error.message));
            return 1;
        }
        console.log(JSON.stringify(response.result, mapReplacer, 2));
        return 0;
    } catch (err: any) {
        if (wantsJson(args)) {
            writeJson({ error: err.message }, wantsPrettyJson(args));
        } else {
            console.error(c.red(err.message));
        }
        return 1;
    }
}

async function inferenceHealth(args: string[]): Promise<number> {
    try {
        const { socketPath, token } = await resolveDaemonTarget(args);
        const response = await daemonRpcCall(socketPath, token, 'getInferenceRuntime');
        if (wantsJson(args)) {
            writeJson(response.error ? response : response.result, wantsPrettyJson(args));
            return response.error ? 1 : 0;
        }
        if (response.error) {
            console.error(c.red(response.error.message));
            return 1;
        }
        console.log(JSON.stringify(response.result, mapReplacer, 2));
        return 0;
    } catch (err: any) {
        if (wantsJson(args)) {
            writeJson({ error: err.message }, wantsPrettyJson(args));
        } else {
            console.error(c.red(err.message));
        }
        return 1;
    }
}

async function inferenceFlush(args: string[]): Promise<number> {
    try {
        const { socketPath, token } = await resolveDaemonTarget(args);
        const response = await daemonRpcCall(socketPath, token, 'flushInference');
        if (wantsJson(args)) {
            writeJson(response.error ? response : response.result, wantsPrettyJson(args));
            return response.error ? 1 : 0;
        }
        if (response.error) {
            console.error(c.red(response.error.message));
            return 1;
        }
        console.log(c.green('Inference engine flushed.'));
        return 0;
    } catch (err: any) {
        if (wantsJson(args)) {
            writeJson({ error: err.message }, wantsPrettyJson(args));
        } else {
            console.error(c.red(err.message));
        }
        return 1;
    }
}

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

    const tokenPath = DEFAULT_TOKEN_PATH;
    const defaults = {
        socketPath,
        dataPath,
        tokenPath,
        walType,
    };
    const resolved = await resolveDaemonConfig(configPath ?? DEFAULT_CONFIG_PATH, defaults, modulesOverride);

    const daemon = new GICSDaemon({
        ...resolved.daemon,
        modules: resolved.modules,
        defaultProfileScope: resolved.profiles.defaultScope,
        configPath: resolved.filePath,
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
        console.log(c.green(`[GICS] Daemon started on ${resolved.daemon.socketPath}`));
        console.log(c.dim(`[GICS] PID: ${process.pid} | Data: ${resolved.daemon.dataPath} | WAL: ${resolved.daemon.walType ?? walType}`));
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
    try {
        const { socketPath, token } = await resolveDaemonTarget(args);
        const response = await daemonRpcCall(socketPath, token, 'ping', {}, 3000);
        if (response.error) {
            if (wantsJson(args)) {
                writeJson(response, wantsPrettyJson(args));
            } else {
                console.error(c.red(`Error: ${response.error.message}`));
            }
            return 1;
        }

        const result = response.result ?? {};
        if (wantsJson(args)) {
            writeJson(result, wantsPrettyJson(args));
            return 0;
        }

        console.log(table(
            ['Property', 'Value'],
            [
                ['Status', c.green(result.status ?? 'ok')],
                ['Uptime', `${result.uptime?.toFixed(0) ?? '?'}s`],
                ['Records', String(result.count ?? 0)],
                ['WAL Type', result.walType ?? '?'],
                ['Warm Segments', String(result.segments ?? 0)],
                ['Cold Segments', String(result.coldSegments ?? 0)],
                ['Insights', String(result.insightsTracked ?? 0)],
                ['Supervisor', result.supervisorState ?? '?'],
            ]
        ));
        return 0;
    } catch (err: any) {
        if (wantsJson(args)) {
            writeJson({ error: err.message }, wantsPrettyJson(args));
        } else if (err.code === 'ENOENT') {
            console.log(c.red('Daemon not configured (no token file)'));
        } else {
            console.log(c.red(`Daemon not running: ${err.message}`));
        }
        return 1;
    }
}
