
import fs from 'fs';
import path from 'path';

const resultsDir = path.join(process.cwd(), 'bench/results');
const reportFile = path.join(process.cwd(), 'bench/report.md');

function main() {
    // 1. Read all JSONs - ONLY process run-*.json files
    if (!fs.existsSync(resultsDir)) return;

    // Filter to only run-*.json files (ignore adversarial-*, sensitive-*, pre-split5-*, etc.)
    const files = fs.readdirSync(resultsDir)
        .filter(f => f.startsWith('run-') && f.endsWith('.json'));

    if (files.length === 0) {
        console.log('No run-*.json results found.');
        return;
    }

    // Sort by filename (ISO timestamp in filename) and take the latest
    const latestFile = files.sort().pop();
    const data = JSON.parse(fs.readFileSync(path.join(resultsDir, latestFile!), 'utf-8'));

    // Validate data structure
    if (!Array.isArray(data) || data.length === 0) {
        console.error('Invalid data format in', latestFile);
        return;
    }

    const lines: string[] = [];
    lines.push('# GICS Benchmark Report');
    lines.push(`**Run ID**: ${latestFile}`);
    lines.push(`**Time**: ${data[0].timestamp_utc}`);
    lines.push(`**Environment**: ${data[0].cpu_model} / ${data[0].os_info}`);
    lines.push('');

    // Table
    lines.push('## Results');
    lines.push('| Dataset | System | Workload | Size (In) | Size (Out) | Ratio | Total (ms) | Setup (ms) | Encode (ms) | RAM (MB) |');
    lines.push('|---|---|---|---|---|---|---|---|---|---|');

    for (const r of data) {
        // Skip entries without proper structure
        if (!r.dataset || !r.metrics || !r.dataset.size) {
            console.warn('Skipping malformed entry:', r);
            continue;
        }

        const mb = (r.metrics.output_bytes / 1024 / 1024).toFixed(2);
        const inMb = (r.dataset.size / 1024 / 1024).toFixed(2);
        const setup = r.metrics.time_setup_ms !== undefined ? r.metrics.time_setup_ms.toFixed(1) : '-';
        const encode = r.metrics.time_encode_ms !== undefined ? r.metrics.time_encode_ms.toFixed(1) : '-';

        lines.push(`| ${r.dataset.name} | **${r.system}** | ${r.workload} | ${inMb} MB | ${mb} MB | **${r.metrics.ratio_x.toFixed(2)}x** | ${r.metrics.time_ms.toFixed(0)} | ${setup} | ${encode} | ${r.metrics.ram_peak_mb.toFixed(1)} |`);
    }

    fs.writeFileSync(reportFile, lines.join('\n'));
    console.log(`Generatred ${reportFile}`);
}

main();
