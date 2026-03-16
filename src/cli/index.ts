#!/usr/bin/env node
/**
 * GICS CLI Entrypoint (Phase 10)
 *
 * Zero-dependency CLI tool for GICS operations
 * Usage: gics <command> [args...]
 */

import {
    encodeCommand,
    decodeCommand,
    verifyCommand,
    infoCommand,
    benchCommand,
    profileCommand,
    daemonCommand,
    type CLIContext
} from './commands.js';

const COMMANDS = {
    encode: encodeCommand,
    decode: decodeCommand,
    verify: verifyCommand,
    info: infoCommand,
    bench: benchCommand,
    profile: profileCommand,
    daemon: daemonCommand,
};

function printUsage(): void {
    console.log(`GICS CLI v1.3.3

Usage: gics <command> [args...]

Commands:
  encode <input.json> [-o output.gics] [--preset balanced|max_ratio|low_latency] [--password <pw>]
  decode <input.gics> [-o output.json] [--password <pw>]
  verify <input.gics> [--password <pw>]
  info <input.gics> [--password <pw>]
  bench <input.json> [--runs N]
  profile <input.json>
  daemon start|stop|status

Exit codes:
  0 = success
  1 = error
  2 = usage error
`);
}

async function main(): Promise<number> {
    const [, , command, ...args] = process.argv;

    if (!command || command === '--help' || command === '-h') {
        printUsage();
        return 0;
    }

    const handler = COMMANDS[command as keyof typeof COMMANDS];
    if (!handler) {
        console.error(`Unknown command: ${command}`);
        printUsage();
        return 2;
    }

    const ctx: CLIContext = {
        args,
        cwd: process.cwd()
    };

    try {
        return await handler(ctx);
    } catch (err: any) {
        console.error(`Fatal error: ${err.message}`);
        return 1;
    }
}

main().then((code) => {
    process.exit(code);
}).catch((err) => {
    console.error(`Unhandled error: ${err.message}`);
    process.exit(1);
});
