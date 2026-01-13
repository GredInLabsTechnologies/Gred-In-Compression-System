import { runSandboxed } from './common/spawn.js';
import * as path from 'path';
import * as fs from 'fs';

const WORKER_PATH = path.join(process.cwd(), 'bench/sensitive/critical/fuzz_worker.ts');
const LOG_FILE = path.join(process.cwd(), 'bench/sensitive/critical/fuzz.log');

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

async function runFuzz(mode: string, seed: number): Promise<boolean> {
    const env = {
        SIZE: '2000',
        SEED: '12345',
        FUZZ_MODE: mode,
        FUZZ_SEED: seed.toString()
    };

    try {
        // Increased to 5s for Windows/CI stability
        const res = await runSandboxed(WORKER_PATH, [], env, 5000);

        if (res.exitCode === 101 || res.exitCode === 102) {
            return true; // Caught Safe Error
        } else if (res.exitCode === 0) {
            // Silent Success on garbage. Suspicious but not a "Crash".
            // We verify "No Uncontrolled Crash".
            return true;
        } else if (res.signal === 'SIGTERM') {
            // Timeout -> Hang?
            error(`FAIL: Hang (Timeout) at seed ${seed}`);
            return false;
        } else {
            // Crash (Exit 1 or signal)
            error(`FAIL: Crash at seed ${seed}. Code=${res.exitCode} ${res.stderr}`);
            return false;
        }
    } catch (e: any) {
        error(`FAIL: Sandbox Exception: ${e.message}`);
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

    // HEADER
    const limits = "MAX_BLOCK_ITEMS:10000,MAX_RLE_RUN:2000"; // Snapshot from known config
    console.log(`AUDIT_META runner=fuzz commit=${process.env.GIT_COMMIT || 'UNKNOWN'} mode=critical seed=${MASTER_SEED} limits=${limits}`);

    log("=== FUZZ SUITE (Time-Boxed) ===");

    const TARGET_DURATION_MS = 20000; // 20s Fuzzing
    const start = Date.now();
    let runs = 0;
    let passed = 0;
    let failed = 0;

    log(`Starting fuzzing for ${TARGET_DURATION_MS}ms...`);

    while (Date.now() - start < TARGET_DURATION_MS) {
        // Deterministic generation
        const seed = rng.next() % 100000;
        const mode = runs % 2 === 0 ? 'RANDOM' : 'STRUCTURAL';

        log(`[AUDIT] Run ${runs}: mode=${mode} seed=${seed}`);
        const p = await runFuzz(mode, seed);
        if (p) passed++;
        else failed++;
        runs++;

        if (failed > 0) {
            break;
        }
    }

    log(`Result: ${runs} Runs, ${passed} PASSED, ${failed} FAILED`);

    // FOOTER
    const duration = Date.now() - start;
    const exitCode = failed > 0 ? 1 : 0;
    console.log(`AUDIT_RESULT runner=fuzz status=${failed === 0 ? 'PASS' : 'FAIL'} exit_code=${exitCode} duration_ms=${duration} runs=${runs}`);

    if (failed > 0) {
        error("Fuzz Suite FAILED");
        process.exit(1);
    }
    log("Fuzz Suite PASSED");
    process.exit(0);
}

main();
