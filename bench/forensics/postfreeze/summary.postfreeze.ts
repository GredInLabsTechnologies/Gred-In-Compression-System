import fs from 'node:fs';
import path from 'node:path';

const ARTIFACTS_ROOT = path.join(process.cwd(), 'bench', 'forensics', 'artifacts', 'postfreeze');
const RUN_A = path.join(ARTIFACTS_ROOT, 'runA');

const datasets = ['Structured_TrendNoise', 'Mixed_RegimeSwitch', 'HighEntropy_Random'];

const summary: any = {
    timestamp: new Date().toISOString(),
    datasets: {}
};

for (const ds of datasets) {
    const kpiPath = path.join(RUN_A, `${ds}_kpi.json`);
    const impactPath = path.join(RUN_A, `${ds}_impact.json`);
    const shaPath = path.join(RUN_A, `${ds}_encoded.sha256`);

    const kpi = JSON.parse(fs.readFileSync(kpiPath, 'utf-8'));
    const impact = JSON.parse(fs.readFileSync(impactPath, 'utf-8'));
    const sha = fs.readFileSync(shaPath, 'utf-8').trim();

    summary.datasets[ds] = {
        core_ratio: kpi.core_ratio,
        global_ratio: kpi.global_ratio,
        storage_ratio: kpi.storage_ratio,
        quarantine_byte_rate: impact.quarantine_byte_rate,
        quarantine_block_rate: impact.quarantine_block_rate,
        encoded_sha256: sha,
    };
}

const outPath = path.join(ARTIFACTS_ROOT, 'summary.postfreeze.json');
fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
console.log(`Summary written to ${outPath}`);
