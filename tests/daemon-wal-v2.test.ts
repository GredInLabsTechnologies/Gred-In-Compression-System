import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createWALProvider, Operation } from '../src/daemon/wal.js';

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gics-wal-v2-test-'));
    try {
        await run(dir);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
}

const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    CRC_TABLE[i] = c;
}

function crc32(buffer: Buffer): number {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buffer.length; i++) {
        crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xFF];
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

function encodeBinaryV1Entry(op: Operation, key: string, payload: Record<string, number | string>): Buffer {
    const keyBuf = Buffer.from(key, 'utf8');
    const valBuf = Buffer.from(JSON.stringify(payload), 'utf8');
    const body = Buffer.alloc(1 + 2 + keyBuf.length + 4 + valBuf.length);

    let offset = 0;
    body.writeUInt8(op, offset++);
    body.writeUInt16LE(keyBuf.length, offset);
    offset += 2;
    keyBuf.copy(body, offset);
    offset += keyBuf.length;
    body.writeUInt32LE(valBuf.length, offset);
    offset += 4;
    valBuf.copy(body, offset);

    const out = Buffer.alloc(body.length + 4);
    body.copy(out);
    out.writeUInt32LE(crc32(body), body.length);
    return out;
}

async function corruptFirstBinaryV2Entry(filePath: string): Promise<void> {
    const raw = await fs.readFile(filePath);
    let offset = 0;
    if (raw.length >= 5 && raw.subarray(0, 4).toString('ascii') === 'GWV2') {
        offset = 5;
    }
    offset += 8; // lsn
    offset += 8; // ts
    offset += 1; // op
    const keyLen = raw.readUInt16LE(offset);
    offset += 2 + keyLen;
    const valLen = raw.readUInt32LE(offset);
    offset += 4;
    const corruptAt = offset + Math.floor(valLen / 2);
    raw[corruptAt] = raw[corruptAt] ^ 0xff;
    await fs.writeFile(filePath, raw);
}

describe('WAL v2 (fase 4)', () => {
    it('100 ciclos write+recovery mantienen consistencia post-fsync', async () => {
        await withTempDir(async (dir) => {
            const walPath = path.join(dir, 'cycles.wal');

            for (let i = 0; i < 100; i++) {
                const wal = createWALProvider('binary', walPath, {
                    fsyncOnCommit: true,
                    checkpointEveryOps: 5,
                    checkpointEveryMs: 60_000
                });
                await wal.append(Operation.PUT, `k:${i}`, { v: i });
                await wal.close();

                const reader = createWALProvider('binary', walPath);
                const found = new Map<string, number>();
                await reader.replay((op, key, payload) => {
                    if (op === Operation.PUT && typeof payload.v === 'number') {
                        found.set(key, payload.v);
                    }
                });
                await reader.close();

                expect(found.size).toBe(i + 1);
                expect(found.get(`k:${i}`)).toBe(i);
            }
        });
    });

    it('lector v2 migra y replays WAL v1 binario', async () => {
        await withTempDir(async (dir) => {
            const walPath = path.join(dir, 'legacy-v1.wal');
            const v1 = Buffer.concat([
                encodeBinaryV1Entry(Operation.PUT, 'legacy:a', { score: 10 }),
                encodeBinaryV1Entry(Operation.PUT, 'legacy:b', { score: 20 })
            ]);
            await fs.writeFile(walPath, v1);

            const wal = createWALProvider('binary', walPath);
            const replayed: Array<{ key: string; payload: Record<string, number | string> }> = [];
            await wal.replay((op, key, payload) => {
                if (op === Operation.PUT) replayed.push({ key, payload });
            });
            await wal.close();

            expect(replayed).toHaveLength(2);
            expect(replayed[0]).toEqual({ key: 'legacy:a', payload: { score: 10 } });
            expect(replayed[1]).toEqual({ key: 'legacy:b', payload: { score: 20 } });

            const migrated = await fs.readFile(walPath);
            expect(migrated.subarray(0, 4).toString('ascii')).toBe('GWV2');
        });
    });

    it('corrupción CRC en recovery: salta entry corrupta y continúa', async () => {
        await withTempDir(async (dir) => {
            const walPath = path.join(dir, 'crc-skip.wal');
            const wal = createWALProvider('binary', walPath, { checkpointEveryOps: 1000 });
            await wal.append(Operation.PUT, 'k1', { v: 1 });
            await wal.append(Operation.PUT, 'k2', { v: 2 });
            await wal.close();

            await corruptFirstBinaryV2Entry(walPath);

            const reader = createWALProvider('binary', walPath);
            const keys: string[] = [];
            await reader.replay((op, key) => {
                if (op === Operation.PUT) keys.push(key);
            });
            await reader.close();

            expect(keys).toEqual(['k2']);
        });
    });

    it('checkpoint corrupto: fallback a checkpoint anterior válido', async () => {
        await withTempDir(async (dir) => {
            const walPath = path.join(dir, 'checkpoint-fallback.wal');
            const wal = createWALProvider('binary', walPath, {
                checkpointEveryOps: 1,
                checkpointEveryMs: 60_000
            });

            await wal.append(Operation.PUT, 'a', { v: 1 });
            await wal.append(Operation.PUT, 'b', { v: 2 });
            await wal.append(Operation.PUT, 'c', { v: 3 });
            await wal.close();

            const ckptPath = `${walPath}.ckpt`;
            const ckptRaw = await fs.readFile(ckptPath, 'utf8');
            const lines = ckptRaw.split('\n').filter(Boolean);
            const latest = JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
            latest.sha256 = 'deadbeef';
            lines[lines.length - 1] = JSON.stringify(latest);
            await fs.writeFile(ckptPath, `${lines.join('\n')}\n`, 'utf8');

            const reader = createWALProvider('binary', walPath);
            const out = new Map<string, number>();
            await reader.replay((op, key, payload) => {
                if (op === Operation.PUT && typeof payload.v === 'number') {
                    out.set(key, payload.v);
                }
            });
            await reader.close();

            expect(out.get('a')).toBe(1);
            expect(out.get('b')).toBe(2);
            expect(out.get('c')).toBe(3);
        });
    });

    it('auto-compact mantiene WAL acotado al superar maxWalSizeMB', async () => {
        await withTempDir(async (dir) => {
            const walPath = path.join(dir, 'compact.wal');
            const wal = createWALProvider('binary', walPath, {
                checkpointEveryOps: 1,
                checkpointEveryMs: 60_000,
                maxWalSizeMB: 0.002
            });

            for (let i = 0; i < 60; i++) {
                await wal.append(Operation.PUT, 'same-key', { payload: 'x'.repeat(3000), rev: i });
            }
            await wal.close();

            const st = await fs.stat(walPath);
            // Sin compactación, sería muy superior a 100KB.
            expect(st.size).toBeLessThan(40 * 1024);

            const reader = createWALProvider('binary', walPath);
            let latestRev = -1;
            await reader.replay((op, key, payload) => {
                if (op === Operation.PUT && key === 'same-key' && typeof payload.rev === 'number') {
                    latestRev = payload.rev;
                }
            });
            await reader.close();
            expect(latestRev).toBe(59);
        });
    });
});
