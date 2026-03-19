#!/usr/bin/env node
/**
 * GICS CLI Entrypoint (v1.3.3)
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
    inferenceCommand,
    moduleCommand,
    rpcCommand,
    daemonCommand,
    type CLIContext
} from './commands.js';
import { c } from './ui.js';

const COMMANDS = {
    encode: encodeCommand,
    decode: decodeCommand,
    verify: verifyCommand,
    info: infoCommand,
    bench: benchCommand,
    profile: profileCommand,
    inference: inferenceCommand,
    module: moduleCommand,
    rpc: rpcCommand,
    daemon: daemonCommand,
};

function printUsage(): void {
    console.log(`${c.bold('GICS CLI')} ${c.dim('v1.3.3')} — Deterministic Time-Series Compression

${c.bold('Usage:')} gics <command> [args...]

${c.bold('Commands:')}
  ${c.green('encode')}   Compress JSON data to GICS format
  ${c.green('decode')}   Decompress GICS archive to JSON
  ${c.green('verify')}   Verify integrity of a GICS archive
  ${c.green('info')}     Display archive metadata
  ${c.green('bench')}    Benchmark encode/decode performance
  ${c.green('profile')}  Find optimal compression settings
  ${c.green('inference')} Operate the inference engine
  ${c.green('module')}   Manage daemon modules
  ${c.green('rpc')}      Call daemon RPC methods with JSON output
  ${c.green('daemon')}   Manage the GICS background daemon

${c.bold('Examples:')}
  ${c.dim('gics encode data.json -o data.gics --preset max_ratio')}
  ${c.dim('gics decode data.gics -o restored.json')}
  ${c.dim('gics verify data.gics')}
  ${c.dim('gics info data.gics')}
  ${c.dim('gics bench data.json --runs 5')}
  ${c.dim(`gics rpc scan --params-json '{"prefix":"orders:"}' --pretty`)}
  ${c.dim('gics daemon start')}

Run ${c.cyan('gics <command> --help')} for detailed usage of each command.
`);
}

async function main(): Promise<number> {
    const [, , command, ...args] = process.argv;

    if (!command || command === '--help' || command === '-h') {
        printUsage();
        return 0;
    }

    if (command === '--version' || command === '-v') {
        console.log('1.3.3');
        return 0;
    }

    const handler = COMMANDS[command as keyof typeof COMMANDS];
    if (!handler) {
        console.error(`${c.red('Unknown command:')} ${command}\n`);
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
        console.error(`${c.red('Fatal error:')} ${err.message}`);
        return 1;
    }
}

try {
    const code = await main();
    process.exit(code);
} catch (err: any) {
    console.error(`Unhandled error: ${err.message}`);
    process.exit(1);
}
