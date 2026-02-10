import fs from 'node:fs';
import path from 'node:path';

const ARTIFACTS_ROOT = path.join(process.cwd(), 'bench', 'forensics', 'artifacts', 'postfreeze');

function readJson(p: string) {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function verifyRun(runDir: string, dataset: string) {
    const tracePath = path.join(runDir, `${dataset}_trace.json`);
    const kpiPath = path.join(runDir, `${dataset}_kpi.json`);

    if (!fs.existsSync(tracePath) || !fs.existsSync(kpiPath)) {
        throw new Error(`Missing artifacts for ${dataset} in ${runDir}`);
    }

    const trace = readJson(tracePath);
    const kpi = readJson(kpiPath);

    let calcTotalOut = 0;
    trace.forEach((b: any) => {
        calcTotalOut += b.total_bytes;
        if ((b.header_bytes + b.payload_bytes) !== b.total_bytes) {
            throw new Error(`[${dataset}] Block ${b.block_id} accounting fail`);
        }
    });

    if (calcTotalOut !== kpi.total_output_bytes) {
        throw new Error(`[${dataset}] total_output_bytes mismatch (trace vs kpi)`);
    }
}

function compareRuns(dataset: string) {
    const dirA = path.join(ARTIFACTS_ROOT, 'runA');
    const dirB = path.join(ARTIFACTS_ROOT, 'runB');

    const shaA = fs.readFileSync(path.join(dirA, `${dataset}_encoded.sha256`), 'utf-8').trim();
    const shaB = fs.readFileSync(path.join(dirB, `${dataset}_encoded.sha256`), 'utf-8').trim();
    if (shaA !== shaB) {
        throw new Error(`[${dataset}] DETERMINISM FAIL: encoded SHA mismatch A vs B`);
    }
    console.log(`[PASS] ${dataset} determinism (encoded SHA256 match)`);

    const traceA = fs.readFileSync(path.join(dirA, `${dataset}_trace.json`), 'utf-8');
    const traceB = fs.readFileSync(path.join(dirB, `${dataset}_trace.json`), 'utf-8');
    if (traceA !== traceB) {
        throw new Error(`[${dataset}] TRACE MISMATCH A vs B`);
    }
}

function main() {
    const datasets = ['Structured_TrendNoise', 'Mixed_RegimeSwitch', 'HighEntropy_Random'];

    // Contract thresholds (CORE-only, min=50 for Structured_TrendNoise)
    const THRESHOLDS: Record<string, { metric: string; min: number }> = {
        Structured_TrendNoise: { metric: 'core_ratio', min: 50.0 },
    };

    for (const ds of datasets) {
        console.log(`Verifying ${ds}...`);
        verifyRun(path.join(ARTIFACTS_ROOT, 'runA'), ds);
        verifyRun(path.join(ARTIFACTS_ROOT, 'runB'), ds);
        compareRuns(ds);

        const kpi = readJson(path.join(ARTIFACTS_ROOT, 'runA', `${ds}_kpi.json`));
        const rule = THRESHOLDS[ds];
        if (rule) {
            const val = kpi[rule.metric];
            console.log(`[CHECK] ${ds} ${rule.metric}: ${val.toFixed(2)} (min=${rule.min})`);
            if (val < rule.min) {
                throw new Error(`[CONTRACT FAIL] ${ds} ${rule.metric} ${val.toFixed(2)} < ${rule.min}`);
            }
        }
    }

    console.log('\nPOSTFREEZE VERIFICATION SUCCESSFUL');
}

try {
    main();
} catch (e) {
    console.error('POSTFREEZE VERIFICATION FAILED', e);
    process.exit(1);
}
