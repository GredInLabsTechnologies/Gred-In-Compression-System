import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createWALProvider, Operation, type WALType } from '../src/daemon/wal.js';

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gics-wal-test-'));
    try {
        await run(dir);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
}

async function corruptFirstBinaryEntryPayload(filePath: string): Promise<void> {
    const buf = await fs.readFile(filePath);

    // v2 binary may include header [magic:4][version:1]
    let offset = 0;
    if (buf.length >= 5 && buf.subarray(0, 4).toString('ascii') === 'GWV2') {
        offset = 5;
    }

    // v1: [op:1][keyLen:2][key][valLen:4][val][crc:4]
    // v2: [lsn:8][ts:8][op:1][keyLen:2][key][valLen:4][val][crc:4]
    const isV2 = offset === 5;
    if (isV2) {
        offset += 8; // lsn
        offset += 8; // timestamp
    }

    offset += 1;
    const keyLen = buf.readUInt16LE(offset);
    offset += 2 + keyLen;
    const valLen = buf.readUInt32LE(offset);
    offset += 4;

    if (valLen === 0) {
        throw new Error('Unexpected empty payload while corrupting binary WAL test fixture.');
    }

    // Flip one payload byte so CRC mismatch is guaranteed.
    const corruptAt = offset + Math.floor(valLen / 2);
    buf[corruptAt] = buf[corruptAt] ^ 0xff;

    await fs.writeFile(filePath, buf);
}

async function corruptFirstJsonlEntryCrc(filePath: string): Promise<void> {
    const text = await fs.readFile(filePath, 'utf8');
    const lines = text.split('\n');
    const first = lines.findIndex((line) => {
        if (!line.trim()) return false;
        try {
            const parsed = JSON.parse(line) as Record<string, unknown>;
            return typeof parsed.crc32 === 'number' && parsed.op !== undefined;
        } catch {
            return false;
        }
    });

    if (first < 0) {
        throw new Error('No JSONL entries found to corrupt.');
    }

    const entry = JSON.parse(lines[first]) as Record<string, unknown>;
    const crc = Number(entry.crc32 ?? 0);
    entry.crc32 = crc + 1;
    lines[first] = JSON.stringify(entry);

    await fs.writeFile(filePath, lines.join('\n'), 'utf8');
}

describe('WAL providers (binary/jsonl)', () => {
    const walTypes: WALType[] = ['binary', 'jsonl'];

    it.each(walTypes)('append + replay roundtrip (%s)', async (walType) => {
        await withTempDir(async (dir) => {
            const walPath = path.join(dir, `test-${walType}.wal`);
            const wal = createWALProvider(walType, walPath);

            await wal.append(Operation.PUT, 'k1', { price: 100, label: 'a' });
            await wal.append(Operation.PUT, 'k2', { qty: 7, status: 'ok' });
            await wal.append(Operation.DELETE, 'k1', {});
            await wal.close();

            const replayed: Array<{ op: Operation; key: string; payload: Record<string, number | string>; }> = [];
            const walReader = createWALProvider(walType, walPath);
            await walReader.replay((op, key, payload) => {
                replayed.push({ op, key, payload });
            });
            await walReader.close();

            expect(replayed).toHaveLength(3);
            expect(replayed[0]).toEqual({ op: Operation.PUT, key: 'k1', payload: { price: 100, label: 'a' } });
            expect(replayed[1]).toEqual({ op: Operation.PUT, key: 'k2', payload: { qty: 7, status: 'ok' } });
            expect(replayed[2]).toEqual({ op: Operation.DELETE, key: 'k1', payload: {} });
        });
    });

    it.each(walTypes)('truncate limpia el archivo WAL (%s)', async (walType) => {
        await withTempDir(async (dir) => {
            const walPath = path.join(dir, `truncate-${walType}.wal`);
            const wal = createWALProvider(walType, walPath);

            await wal.append(Operation.PUT, 'k1', { v: 1 });
            await wal.truncate();

            const replayed: Array<{ op: Operation; key: string; payload: Record<string, number | string>; }> = [];
            await wal.replay((op, key, payload) => {
                replayed.push({ op, key, payload });
            });
            await wal.close();

            expect(replayed).toHaveLength(0);
        });
    });

    it.each(walTypes)('replay ignora entry corrupta y continúa con las siguientes (%s)', async (walType) => {
        await withTempDir(async (dir) => {
            const walPath = path.join(dir, `corrupt-${walType}.wal`);
            const wal = createWALProvider(walType, walPath);

            await wal.append(Operation.PUT, 'k1', { v: 1, label: 'first' });
            await wal.append(Operation.PUT, 'k2', { v: 2, label: 'second' });
            await wal.close();

            if (walType === 'binary') {
                await corruptFirstBinaryEntryPayload(walPath);
            } else {
                await corruptFirstJsonlEntryCrc(walPath);
            }

            const replayed: Array<{ op: Operation; key: string; payload: Record<string, number | string>; }> = [];
            const walReader = createWALProvider(walType, walPath);
            await walReader.replay((op, key, payload) => {
                replayed.push({ op, key, payload });
            });
            await walReader.close();

            expect(replayed).toHaveLength(1);
            expect(replayed[0]).toEqual({ op: Operation.PUT, key: 'k2', payload: { v: 2, label: 'second' } });
        });
    });

    it.each(walTypes)('fsync strict se comporta como fail-closed en errores de sync (%s)', async (walType) => {
        await withTempDir(async (dir) => {
            const walPath = path.join(dir, `strict-${walType}.wal`);
            const wal = createWALProvider(walType, walPath, { fsyncMode: 'strict' });

            let strictAppendFailed = false;
            try {
                await wal.append(Operation.PUT, 'k1', { v: 1 });
            } catch (error) {
                strictAppendFailed = true;
                const maybeErr = error as NodeJS.ErrnoException;
                if (maybeErr?.code) {
                    expect(['EPERM', 'EINVAL', 'ENOTSUP']).toContain(maybeErr.code);
                }
            }

            // If filesystem supports fsync, append may succeed in strict mode.
            if (!strictAppendFailed) {
                const replayed: Array<{ op: Operation; key: string; payload: Record<string, number | string>; }> = [];
                await wal.replay((op, key, payload) => {
                    replayed.push({ op, key, payload });
                });
                expect(replayed.length).toBeGreaterThanOrEqual(1);
            }

            await wal.close();
        });
    });
});
