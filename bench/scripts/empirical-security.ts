import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { GICS } from '../../src/index.js';
import {
    deriveKey,
    generateEncryptionSecrets,
    generateAuthVerify,
    verifyAuth,
    encryptSection,
    decryptSection,
} from '../../src/gics/encryption.js';

type Snapshot = {
    timestamp: number;
    items: Map<number, { price: number; quantity: number }>;
};

type SecuritySummary = {
    kdf_p50_ms: number;
    kdf_p95_ms: number;
    timing_equal_avg_ms: number;
    timing_mismatch_avg_ms: number;
    timing_delta_ratio: number;
    timing_resistance_ok: boolean;
    auth_verify_ok: boolean;
    deterministic_same_stream_ok: boolean;
    iv_domain_separation_ok: boolean;
    tamper_cipher_rejected: boolean;
    tamper_tag_rejected: boolean;
    gics_encrypted_roundtrip_ok: boolean;
    gics_wrong_password_rejected: boolean;
    pass: boolean;
    fail_reasons: string[];
};

type SecurityReport = {
    run_id: string;
    timestamp_utc: string;
    env: {
        node: string;
        os: string;
        cpu: string;
        git_commit: string;
    };
    config: {
        kdf_iterations: number;
        kdf_samples: number;
        timing_samples: number;
        timing_max_delta_ratio: number;
    };
    metrics: SecuritySummary;
};

function getGitCommit(): string {
    try {
        return execSync('git rev-parse HEAD').toString().trim();
    } catch {
        return 'unknown';
    }
}

function percentile(values: number[], p: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
    return sorted[idx];
}

function createFixtures() {
    const password = 'security-bench-password';
    const { salt, fileNonce } = generateEncryptionSecrets();
    const key = deriveKey(password, salt, 100_000);
    const aad = new Uint8Array([0x47, 0x49, 0x43, 0x53, 0x03]);
    const plaintext = randomBytes(2048);
    return { password, salt, fileNonce, key, aad, plaintext };
}

function buildSecuritySnapshots(): Snapshot[] {
    const snapshots: Snapshot[] = [];
    const baseTs = 1_701_000_000_000;
    for (let i = 0; i < 1200; i++) {
        const items = new Map<number, { price: number; quantity: number }>();
        for (let id = 1; id <= 8; id++) {
            items.set(id, {
                price: 10_000 + id * 5 + (i % 7),
                quantity: 1 + (id % 3),
            });
        }
        snapshots.push({ timestamp: baseTs + i, items });
    }
    return snapshots;
}

async function main(): Promise<void> {
    const runId = `empirical-security-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const iterations = Number(process.env.GICS_SECURITY_KDF_ITERATIONS ?? '100000');
    const kdfSamples = Number(process.env.GICS_SECURITY_KDF_SAMPLES ?? '8');
    const timingSamples = Number(process.env.GICS_SECURITY_TIMING_SAMPLES ?? '4000');
    const timingMaxDeltaRatio = Number(process.env.GICS_SECURITY_TIMING_MAX_DELTA_RATIO ?? '0.25');

    const env = {
        node: process.version,
        os: `${os.type()} ${os.release()}`,
        cpu: os.cpus()[0]?.model ?? 'unknown',
        git_commit: getGitCommit(),
    };

    const fixture = createFixtures();

    const kdfTimes: number[] = [];
    for (let i = 0; i < kdfSamples; i++) {
        const salt = randomBytes(16);
        const t0 = performance.now();
        deriveKey(fixture.password, salt, iterations);
        kdfTimes.push(performance.now() - t0);
    }

    const auth = generateAuthVerify(fixture.key);
    const auth_verify_ok = verifyAuth(fixture.key, auth);

    // Timing-resistance approximation: compare average runtime for valid/invalid auth checks.
    // This is not a formal side-channel proof, but provides a regression signal.
    const wrongAuth = new Uint8Array(auth);
    wrongAuth[0] ^= 0x01;
    let timingEqualTotal = 0;
    let timingMismatchTotal = 0;
    for (let i = 0; i < timingSamples; i++) {
        const tEq0 = performance.now();
        verifyAuth(fixture.key, auth);
        timingEqualTotal += performance.now() - tEq0;

        const tNe0 = performance.now();
        verifyAuth(fixture.key, wrongAuth);
        timingMismatchTotal += performance.now() - tNe0;
    }
    const timing_equal_avg_ms = timingEqualTotal / Math.max(1, timingSamples);
    const timing_mismatch_avg_ms = timingMismatchTotal / Math.max(1, timingSamples);
    const timing_delta_ratio =
        Math.abs(timing_equal_avg_ms - timing_mismatch_avg_ms) / Math.max(1e-9, timing_equal_avg_ms);
    const timing_resistance_ok = timing_delta_ratio <= timingMaxDeltaRatio;

    const encA1 = encryptSection(fixture.plaintext, fixture.key, fixture.fileNonce, 10, fixture.aad);
    const encA2 = encryptSection(fixture.plaintext, fixture.key, fixture.fileNonce, 10, fixture.aad);
    const deterministic_same_stream_ok =
        Buffer.compare(Buffer.from(encA1.ciphertext), Buffer.from(encA2.ciphertext)) === 0 &&
        Buffer.compare(Buffer.from(encA1.tag), Buffer.from(encA2.tag)) === 0;

    const encB = encryptSection(fixture.plaintext, fixture.key, fixture.fileNonce, 20, fixture.aad);
    const iv_domain_separation_ok =
        Buffer.compare(Buffer.from(encA1.ciphertext), Buffer.from(encB.ciphertext)) !== 0 ||
        Buffer.compare(Buffer.from(encA1.tag), Buffer.from(encB.tag)) !== 0;

    let tamper_cipher_rejected = false;
    {
        const badCipher = new Uint8Array(encA1.ciphertext);
        badCipher[0] ^= 0x01;
        try {
            decryptSection(badCipher, encA1.tag, fixture.key, fixture.fileNonce, 10, fixture.aad);
        } catch {
            tamper_cipher_rejected = true;
        }
    }

    let tamper_tag_rejected = false;
    {
        const badTag = new Uint8Array(encA1.tag);
        badTag[0] ^= 0x01;
        try {
            decryptSection(encA1.ciphertext, badTag, fixture.key, fixture.fileNonce, 10, fixture.aad);
        } catch {
            tamper_tag_rejected = true;
        }
    }

    const snapshots = buildSecuritySnapshots();
    const packed = await GICS.pack(snapshots, { password: fixture.password });

    let gics_encrypted_roundtrip_ok = false;
    {
        const unpacked = await GICS.unpack(packed, { password: fixture.password });
        gics_encrypted_roundtrip_ok = unpacked.length === snapshots.length;
    }

    let gics_wrong_password_rejected = false;
    {
        try {
            await GICS.unpack(packed, { password: 'wrong-security-password' });
        } catch {
            gics_wrong_password_rejected = true;
        }
    }

    const fail_reasons: string[] = [];
    if (!auth_verify_ok) fail_reasons.push('auth_verify_ok=false');
    if (!timing_resistance_ok) {
        fail_reasons.push(
            `timing_resistance_ok=false(delta_ratio=${timing_delta_ratio.toFixed(4)}, max=${timingMaxDeltaRatio.toFixed(4)})`,
        );
    }
    if (!deterministic_same_stream_ok) fail_reasons.push('deterministic_same_stream_ok=false');
    if (!iv_domain_separation_ok) fail_reasons.push('iv_domain_separation_ok=false');
    if (!tamper_cipher_rejected) fail_reasons.push('tamper_cipher_rejected=false');
    if (!tamper_tag_rejected) fail_reasons.push('tamper_tag_rejected=false');
    if (!gics_encrypted_roundtrip_ok) fail_reasons.push('gics_encrypted_roundtrip_ok=false');
    if (!gics_wrong_password_rejected) fail_reasons.push('gics_wrong_password_rejected=false');

    const metrics: SecuritySummary = {
        kdf_p50_ms: percentile(kdfTimes, 0.5),
        kdf_p95_ms: percentile(kdfTimes, 0.95),
        timing_equal_avg_ms,
        timing_mismatch_avg_ms,
        timing_delta_ratio,
        timing_resistance_ok,
        auth_verify_ok,
        deterministic_same_stream_ok,
        iv_domain_separation_ok,
        tamper_cipher_rejected,
        tamper_tag_rejected,
        gics_encrypted_roundtrip_ok,
        gics_wrong_password_rejected,
        pass: fail_reasons.length === 0,
        fail_reasons,
    };

    const report: SecurityReport = {
        run_id: runId,
        timestamp_utc: new Date().toISOString(),
        env,
        config: {
            kdf_iterations: iterations,
            kdf_samples: kdfSamples,
            timing_samples: timingSamples,
            timing_max_delta_ratio: timingMaxDeltaRatio,
        },
        metrics,
    };

    const latestDir = path.join(process.cwd(), 'bench', 'results', 'latest');
    const archiveDir = path.join(process.cwd(), 'bench', 'results');
    fs.mkdirSync(latestDir, { recursive: true });
    fs.mkdirSync(archiveDir, { recursive: true });

    const reportJsonPath = path.join(latestDir, 'empirical-security-report.json');
    const reportMdPath = path.join(latestDir, 'empirical-security-report.md');
    fs.writeFileSync(reportJsonPath, JSON.stringify(report, null, 2));
    fs.writeFileSync(
        reportMdPath,
        [
            '# GICS Empirical Security Report',
            `- Run: ${report.run_id}`,
            `- Pass: ${report.metrics.pass ? 'YES' : 'NO'}`,
            `- kdf_p50_ms: ${report.metrics.kdf_p50_ms.toFixed(3)}`,
            `- kdf_p95_ms: ${report.metrics.kdf_p95_ms.toFixed(3)}`,
            `- timing_equal_avg_ms: ${report.metrics.timing_equal_avg_ms.toFixed(6)}`,
            `- timing_mismatch_avg_ms: ${report.metrics.timing_mismatch_avg_ms.toFixed(6)}`,
            `- timing_delta_ratio: ${report.metrics.timing_delta_ratio.toFixed(6)}`,
            `- timing_resistance_ok: ${report.metrics.timing_resistance_ok}`,
            '',
            '## Checks',
            `- auth_verify_ok: ${report.metrics.auth_verify_ok}`,
            `- deterministic_same_stream_ok: ${report.metrics.deterministic_same_stream_ok}`,
            `- iv_domain_separation_ok: ${report.metrics.iv_domain_separation_ok}`,
            `- tamper_cipher_rejected: ${report.metrics.tamper_cipher_rejected}`,
            `- tamper_tag_rejected: ${report.metrics.tamper_tag_rejected}`,
            `- gics_encrypted_roundtrip_ok: ${report.metrics.gics_encrypted_roundtrip_ok}`,
            `- gics_wrong_password_rejected: ${report.metrics.gics_wrong_password_rejected}`,
            report.metrics.fail_reasons.length > 0 ? `- fail_reasons: ${report.metrics.fail_reasons.join(', ')}` : '- fail_reasons: none',
            '',
        ].join('\n'),
    );

    fs.writeFileSync(path.join(archiveDir, `${runId}.json`), JSON.stringify(report, null, 2));

    console.log(`Security benchmark complete: ${reportJsonPath}`);
    console.log(`Security markdown report: ${reportMdPath}`);

    if (!report.metrics.pass) {
        console.error(`Security benchmark gate failed: ${report.metrics.fail_reasons.join(' | ')}`);
        process.exitCode = 1;
    } else {
        console.log('Security benchmark gate passed.');
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
