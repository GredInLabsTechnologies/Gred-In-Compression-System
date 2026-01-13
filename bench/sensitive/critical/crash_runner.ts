import { runSandboxed } from './common/spawn.js';
import * as path from 'path';
import * as fs from 'fs';

const WORKER_PATH = path.join(process.cwd(), 'bench/sensitive/critical/crash_worker.ts');
const LOG_FILE = path.join(process.cwd(), 'bench/sensitive/critical/crash.log');

// Clear log
fs.writeFileSync(LOG_FILE, '');

function log(msg: string) {
    fs.appendFileSync(LOG_FILE, msg + '\n');
    console.log(msg);
}

function error(msg: string) {
    fs.appendFileSync(LOG_FILE, 'ERROR: ' + msg + '\n');
    console.error(msg);
}

async function runTest(truncateAt: number, desc: string): Promise<boolean> {
    const env = {
        SIZE: '10000', // 10 blocks (approx 10kb output?)
        SEED: '12345',
        TRUNCATE_AT: truncateAt.toString()
    };

    // log(`Testing Truncation at ${truncateAt}: ${desc}`);

    // Silence detailed logs per byte, just summary

    try {
        const res = await runSandboxed(WORKER_PATH, [], env, 5000); // 5s timeout

        if (res.exitCode === 102) {
            // Good: Caught Incomplete
            return true;
        } else if (res.exitCode === 0) {
            // Bad: Silent Success (Partial load?)
            error(`FAIL: Silent Success at offset ${truncateAt}. Decoded partial file as valid!`);
            return false;
        } else {
            // Bad: Crash
            error(`FAIL: Crash at offset ${truncateAt}. Code=${res.exitCode} ${res.stderr}`);
            return false;
        }
    } catch (e: any) {
        error(`FAIL: Sandbox Exception at ${truncateAt}: ${e.message}`);
        return false;
    }
}

// Minimal LCG for determinism
class SeededRNG {
    private state: number;
    constructor(seed: number) { this.state = seed % 2147483647; if (this.state <= 0) this.state += 2147483646; }
    next(): number { return this.state = (this.state * 16807) % 2147483647; }
    nextFloat(): number { return (this.next() - 1) / 2147483646; }
}

async function main() {
    const MASTER_SEED = parseInt(process.env.MASTER_SEED || process.env.SEED || "12345");
    const rng = new SeededRNG(MASTER_SEED);
    const start = Date.now();

    // HEADER
    const limits = "MAX_BLOCK_ITEMS:10000,MAX_RLE_RUN:2000";
    console.log(`AUDIT_META runner=crash commit=${process.env.GIT_COMMIT || 'UNKNOWN'} mode=critical seed=${MASTER_SEED} limits=${limits}`);

    log("=== CRASH SUITE ===");

    // 1. Determine Full Size first
    log("Determining full size...");
    const res = await runSandboxed(WORKER_PATH, [], { SIZE: '10000', TRUNCATE_AT: '-1' });
    const fullOutputMatch = res.stdout.match(/Full length (\d+)/);
    if (!fullOutputMatch) {
        error("Failed to determine full size");
        process.exit(1);
    }
    const fullSize = parseInt(fullOutputMatch[1]);
    log(`Full Size: ${fullSize} bytes`);

    let passed = 0;
    let failed = 0;

    // 2. Scan Truncation Offsets
    // Critical Areas: 
    // - 0..HeaderSize (Mutation of header)
    // - HeaderSize..HeaderSize+BlockHeader
    // - Middle of Payload
    // - Boundary of Block 1 and 2

    const offsetsToCheck = [
        0, 1, 2, 4, 8, // Magic/Version
        9, 10, 15, // Flags/First Block Header
        100, 500, // Middle of Block 1
        fullSize - 1, fullSize - 5, fullSize - 10 // Tail
    ];

    // Also random sample
    for (let i = 0; i < 20; i++) {
        // Deterministic offset
        offsetsToCheck.push(rng.next() % (fullSize - 1));
    }

    for (const off of offsetsToCheck) {
        if (off < 0 || off >= fullSize) continue;
        const p = await runTest(off, `Offset ${off}`);
        if (p) passed++;
        else failed++;
    }

    log(`Result: ${passed} PASSED, ${failed} FAILED`);

    // FOOTER
    const duration = Date.now() - start;
    const exitCode = failed > 0 ? 1 : 0;
    console.log(`AUDIT_RESULT runner=crash status=${failed === 0 ? 'PASS' : 'FAIL'} exit_code=${exitCode} duration_ms=${duration} truncations=${offsetsToCheck.length}`);

    if (failed > 0) {
        error("Crash Suite FAILED (Silent Successes detected)");
        process.exit(1);
    }
    log("Crash Suite PASSED");
    process.exit(0);
}

main();
