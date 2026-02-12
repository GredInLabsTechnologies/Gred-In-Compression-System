import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { GICS } from '../../src/index.js';

type Snapshot = {
    timestamp: number;
    items: Map<number, { price: number; quantity: number }>;
};

type CaseResult = {
    caseId: string;
    description: string;
    verifyOk: boolean;
    roundtripOk: boolean;
    ratio: number;
    pass: boolean;
    error?: string;
};

function getGitCommit(): string {
    try {
        return execSync('git rev-parse HEAD').toString().trim();
    } catch {
        return 'unknown';
    }
}

function estimateRawBytes(snapshots: Snapshot[]): number {
    const plain = snapshots.map((s) => ({
        timestamp: s.timestamp,
        items: Array.from(s.items.entries()).map(([id, v]) => ({ id, price: v.price, quantity: v.quantity })),
    }));
    return Buffer.byteLength(JSON.stringify(plain));
}

function makeEdgeCases(): Array<{ caseId: string; description: string; snapshots: Snapshot[] }> {
    const baseTs = 1_703_000_000_000;
    return [
        {
            caseId: 'float_special_ieee',
            description: 'NaN, ±Infinity, -0 y estabilidad IEEE-754',
            snapshots: [
                { timestamp: baseTs + 1, items: new Map([[1, { price: Number.NaN, quantity: Number.POSITIVE_INFINITY }], [2, { price: Number.NEGATIVE_INFINITY, quantity: -0 }]]) },
                { timestamp: baseTs + 2, items: new Map([[1, { price: Number.NaN, quantity: Number.NEGATIVE_INFINITY }], [2, { price: Number.POSITIVE_INFINITY, quantity: 0 }]]) },
            ],
        },
        {
            caseId: 'float_extremes',
            description: 'MAX_VALUE, MIN_VALUE y subnormales',
            snapshots: [
                { timestamp: baseTs + 10, items: new Map([[10, { price: Number.MAX_VALUE, quantity: Number.MIN_VALUE }], [20, { price: -Number.MAX_VALUE, quantity: -Number.MIN_VALUE }]]) },
                { timestamp: baseTs + 11, items: new Map([[10, { price: 1e-308, quantity: -1e-308 }], [20, { price: Number.MIN_VALUE, quantity: 0 }]]) },
            ],
        },
        {
            caseId: 'mixed_entropy',
            description: 'Bloques mixtos con tramos estables y ruido',
            snapshots: Array.from({ length: 2000 }, (_, i) => {
                const items = new Map<number, { price: number; quantity: number }>();
                for (let id = 1; id <= 20; id++) {
                    const noisy = i % 50 === 0;
                    items.set(id, {
                        price: noisy ? (1000 + id * 7 + ((i * id) % 97)) : (1000 + id * 7 + (i % 3)),
                        quantity: noisy ? ((i + id) % 11) : (1 + (id % 3)),
                    });
                }
                return { timestamp: baseTs + 100 + i, items };
            }),
        },
    ];
}

function sameNumberSemantics(a: number, b: number): boolean {
    if (Number.isNaN(a) && Number.isNaN(b)) return true;
    return Object.is(a, b);
}

function roundtripMatches(before: Snapshot[], after: Snapshot[]): boolean {
    if (before.length !== after.length) return false;
    for (let i = 0; i < before.length; i++) {
        if (before[i].timestamp !== after[i].timestamp) return false;
        if (before[i].items.size !== after[i].items.size) return false;
        for (const [id, orig] of before[i].items) {
            const dec = after[i].items.get(id);
            if (!dec) return false;
            if (!sameNumberSemantics(orig.price, dec.price)) return false;
            if (!sameNumberSemantics(orig.quantity, dec.quantity)) return false;
        }
    }
    return true;
}

async function runCase(input: { caseId: string; description: string; snapshots: Snapshot[] }): Promise<CaseResult> {
    try {
        const raw = estimateRawBytes(input.snapshots);
        const packed = await GICS.pack(input.snapshots);
        const unpacked = await GICS.unpack(packed);
        const verifyOk = await GICS.verify(packed);
        const roundtripOk = roundtripMatches(input.snapshots, unpacked);
        const ratio = raw / Math.max(1, packed.length);
        const pass = verifyOk && roundtripOk;
        return {
            caseId: input.caseId,
            description: input.description,
            verifyOk,
            roundtripOk,
            ratio,
            pass,
        };
    } catch (error) {
        return {
            caseId: input.caseId,
            description: input.description,
            verifyOk: false,
            roundtripOk: false,
            ratio: 0,
            pass: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

async function main(): Promise<void> {
    const runId = `empirical-edge-cases-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const cases = makeEdgeCases();
    const results: CaseResult[] = [];
    for (const c of cases) results.push(await runCase(c));

    const pass = results.every((r) => r.pass);
    const failReasons = results.filter((r) => !r.pass).map((r) => `${r.caseId}${r.error ? ` (${r.error})` : ''}`);

    const report = {
        run_id: runId,
        timestamp_utc: new Date().toISOString(),
        env: {
            node: process.version,
            os: `${os.type()} ${os.release()}`,
            cpu: os.cpus()[0]?.model ?? 'unknown',
            git_commit: getGitCommit(),
        },
        results,
        summary: {
            pass,
            fail_reasons: failReasons,
        },
    };

    const latestDir = path.join(process.cwd(), 'bench', 'results', 'latest');
    fs.mkdirSync(latestDir, { recursive: true });
    fs.writeFileSync(path.join(latestDir, 'empirical-edge-cases-report.json'), JSON.stringify(report, null, 2));
    fs.writeFileSync(
        path.join(latestDir, 'empirical-edge-cases-report.md'),
        [
            '# GICS Empirical Edge-Cases Report',
            `- Run: ${runId}`,
            `- Pass: ${pass ? 'YES' : 'NO'}`,
            '',
            '| Case | Verify | Roundtrip | Ratio | Pass |',
            '|---|---|---|---:|---|',
            ...results.map((r) => `| ${r.caseId} | ${r.verifyOk} | ${r.roundtripOk} | ${r.ratio.toFixed(2)}x | ${r.pass ? 'YES' : 'NO'} |`),
            '',
            failReasons.length > 0 ? `- Fail reasons: ${failReasons.join(' | ')}` : '- Fail reasons: none',
            '',
        ].join('\n'),
    );

    fs.writeFileSync(path.join(process.cwd(), 'bench', 'results', `${runId}.json`), JSON.stringify(report, null, 2));

    console.log(`Edge-cases benchmark complete: ${path.join(latestDir, 'empirical-edge-cases-report.json')}`);
    if (!pass) {
        console.error(`Edge-cases benchmark gate failed: ${failReasons.join(' | ')}`);
        process.exitCode = 1;
    }
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
