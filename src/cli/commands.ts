/**
 * GICS CLI Commands (Phase 10)
 *
 * Implements: encode, decode, verify, info, bench, profile, daemon
 * Zero external dependencies, manual argument parsing
 */

import * as fs from 'fs/promises';
import { existsSync } from 'fs';
import { GICSv2Encoder } from '../gics/encode.js';
import { GICSv2Decoder } from '../gics/decode.js';
import type { GenericSnapshot } from '../gics-types.js';
import type { CompressionPreset } from '../gics/types.js';
import { CompressionProfiler } from '../gics/profiler.js';

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

/**
 * gics encode <input.json> [-o output.gics] [--preset ...] [--password <pw>]
 */
export async function encodeCommand(ctx: CLIContext): Promise<number> {
    const inputPath = ctx.args[0];
    if (!inputPath) {
        console.error('Usage: gics encode <input.json> [-o output.gics] [--preset balanced|max_ratio|low_latency] [--password <pw>]');
        return 2;
    }

    if (!existsSync(inputPath)) {
        console.error(`Error: input file not found: ${inputPath}`);
        return 1;
    }

    const outputPath = parseFlag(ctx.args, '-o') ?? inputPath.replace(/\.json$/, '.gics');
    const presetStr = parseFlag(ctx.args, '--preset') ?? 'balanced';
    const password = parseFlag(ctx.args, '--password') ?? undefined;

    const preset: CompressionPreset = ['balanced', 'max_ratio', 'low_latency'].includes(presetStr)
        ? (presetStr as CompressionPreset)
        : 'balanced';

    try {
        const raw = await fs.readFile(inputPath, 'utf8');
        const data = JSON.parse(raw) as {
            schema: any;
            snapshots: Array<{ timestamp: number; items: Record<string, Record<string, number | string>> | Map<string, Record<string, number | string>> }>;
        };

        const encoder = new GICSv2Encoder({ schema: data.schema, preset, password });
        for (const snapshot of data.snapshots) {
            // Convert plain object to Map if needed
            const itemsMap = snapshot.items instanceof Map
                ? snapshot.items
                : new Map(Object.entries(snapshot.items));
            await encoder.addSnapshot({ timestamp: snapshot.timestamp, items: itemsMap });
        }
        const compressed = await encoder.finish();
        await fs.writeFile(outputPath, compressed);

        const ratio = raw.length / compressed.length;
        console.log(`✓ Encoded: ${inputPath} → ${outputPath} (${ratio.toFixed(2)}x compression)`);
        return 0;
    } catch (err: any) {
        console.error(`Error encoding: ${err.message}`);
        return 1;
    }
}

/**
 * gics decode <input.gics> [-o output.json] [--password <pw>]
 */
export async function decodeCommand(ctx: CLIContext): Promise<number> {
    const inputPath = ctx.args[0];
    if (!inputPath) {
        console.error('Usage: gics decode <input.gics> [-o output.json] [--password <pw>]');
        return 2;
    }

    if (!existsSync(inputPath)) {
        console.error(`Error: input file not found: ${inputPath}`);
        return 1;
    }

    const outputPath = parseFlag(ctx.args, '-o') ?? inputPath.replace(/\.gics$/, '.decoded.json');
    const password = parseFlag(ctx.args, '--password') ?? undefined;

    try {
        const raw = await fs.readFile(inputPath);
        const decoder = new GICSv2Decoder(raw, { password });
        await decoder.parseHeader();
        const schema = decoder.getSchema();
        const snapshots = await decoder.getAllGenericSnapshots();

        const output = { schema, snapshots };
        await fs.writeFile(outputPath, JSON.stringify(output, null, 2));

        console.log(`✓ Decoded: ${inputPath} → ${outputPath} (${snapshots.length} snapshots)`);
        return 0;
    } catch (err: any) {
        console.error(`Error decoding: ${err.message}`);
        return 1;
    }
}

/**
 * gics verify <input.gics> [--password <pw>]
 */
export async function verifyCommand(ctx: CLIContext): Promise<number> {
    const inputPath = ctx.args[0];
    if (!inputPath) {
        console.error('Usage: gics verify <input.gics> [--password <pw>]');
        return 2;
    }

    if (!existsSync(inputPath)) {
        console.error(`Error: input file not found: ${inputPath}`);
        return 1;
    }

    const password = parseFlag(ctx.args, '--password') ?? undefined;

    try {
        const raw = await fs.readFile(inputPath);
        const decoder = new GICSv2Decoder(raw, { password });
        const valid = await decoder.verifyIntegrityOnly();

        if (valid) {
            console.log(`✓ Integrity valid: ${inputPath}`);
            return 0;
        } else {
            console.error(`✗ Integrity check failed: ${inputPath}`);
            return 1;
        }
    } catch (err: any) {
        console.error(`Error verifying: ${err.message}`);
        return 1;
    }
}

/**
 * gics info <input.gics> [--password <pw>]
 */
export async function infoCommand(ctx: CLIContext): Promise<number> {
    const inputPath = ctx.args[0];
    if (!inputPath) {
        console.error('Usage: gics info <input.gics> [--password <pw>]');
        return 2;
    }

    if (!existsSync(inputPath)) {
        console.error(`Error: input file not found: ${inputPath}`);
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

        console.log(`File: ${inputPath}`);
        console.log(`Size: ${raw.length} bytes`);
        console.log(`Schema: ${schema.id} (v${schema.version})`);
        console.log(`Fields: ${schema.fields.length}`);
        console.log(`Snapshots: ${snapshots.length}`);
        console.log(`Total items: ${totalItems}`);

        return 0;
    } catch (err: any) {
        console.error(`Error reading info: ${err.message}`);
        return 1;
    }
}

/**
 * gics bench <input.json> [--runs N]
 */
export async function benchCommand(ctx: CLIContext): Promise<number> {
    const inputPath = ctx.args[0];
    if (!inputPath) {
        console.error('Usage: gics bench <input.json> [--runs N]');
        return 2;
    }

    if (!existsSync(inputPath)) {
        console.error(`Error: input file not found: ${inputPath}`);
        return 1;
    }

    const runs = parseInt(parseFlag(ctx.args, '--runs') ?? '3', 10);

    try {
        const raw = await fs.readFile(inputPath, 'utf8');
        const data = JSON.parse(raw) as { schema: any; snapshots: GenericSnapshot<Record<string, number | string>>[] };

        const results: Array<{ ratio: number; encodeMs: number; decodeMs: number }> = [];

        for (let i = 0; i < runs; i++) {
            const encStart = Date.now();
            const encoder = new GICSv2Encoder({ schema: data.schema });
            for (const snapshot of data.snapshots) {
                await encoder.addSnapshot(snapshot);
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

        const avgRatio = results.reduce((sum, r) => sum + r.ratio, 0) / results.length;
        const avgEncMs = results.reduce((sum, r) => sum + r.encodeMs, 0) / results.length;
        const avgDecMs = results.reduce((sum, r) => sum + r.decodeMs, 0) / results.length;

        console.log(`Benchmark (${runs} runs):`);
        console.log(`  Compression ratio: ${avgRatio.toFixed(2)}x`);
        console.log(`  Encode time: ${avgEncMs.toFixed(2)}ms`);
        console.log(`  Decode time: ${avgDecMs.toFixed(2)}ms`);

        return 0;
    } catch (err: any) {
        console.error(`Error benchmarking: ${err.message}`);
        return 1;
    }
}

/**
 * gics profile <input.json>
 */
export async function profileCommand(ctx: CLIContext): Promise<number> {
    const inputPath = ctx.args[0];
    if (!inputPath) {
        console.error('Usage: gics profile <input.json>');
        return 2;
    }

    if (!existsSync(inputPath)) {
        console.error(`Error: input file not found: ${inputPath}`);
        return 1;
    }

    try {
        const raw = await fs.readFile(inputPath, 'utf8');
        const data = JSON.parse(raw) as { schema: any; snapshots: GenericSnapshot<Record<string, number | string>>[] };

        const result = await CompressionProfiler.profile(data.snapshots, 'quick', { schema: data.schema });

        console.log(`Profile: ${inputPath}`);
        console.log(`Best configuration: zstd level ${result.compressionLevel}, block size ${result.blockSize}`);
        console.log(`  Compression ratio: ${result.bestRatio.toFixed(2)}x`);
        console.log(`  Encode time: ${result.bestEncodeMs.toFixed(2)}ms`);
        console.log(`  Trials: ${result.trials.length}`);

        return 0;
    } catch (err: any) {
        console.error(`Error profiling: ${err.message}`);
        return 1;
    }
}

/**
 * gics daemon start|stop|status
 */
export async function daemonCommand(ctx: CLIContext): Promise<number> {
    const subcommand = ctx.args[0];
    if (!subcommand || !['start', 'stop', 'status'].includes(subcommand)) {
        console.error('Usage: gics daemon start|stop|status');
        return 2;
    }

    console.error(`Error: daemon subcommand not yet implemented (placeholder for Phase 10)`);
    return 1;
}
