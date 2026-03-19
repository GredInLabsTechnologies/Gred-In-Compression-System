import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { FileLock, FileLockTimeoutError } from '../src/daemon/file-lock.js';

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gics-file-lock-test-'));
    try {
        await run(dir);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
}

describe('FileLock (Roadmap v1.3.2 - Fase 1.5)', () => {
    it('permite múltiples locks compartidos simultáneos', async () => {
        await withTempDir(async (dir) => {
            const target = path.join(dir, 'segments');
            const lockA = new FileLock(target);
            const lockB = new FileLock(target);

            await lockA.acquire('shared', 500, 10);
            await lockB.acquire('shared', 500, 10);

            await lockB.release();
            await lockA.release();
        });
    });

    it('bloquea lock exclusivo cuando existe lock compartido y respeta timeout', async () => {
        await withTempDir(async (dir) => {
            const target = path.join(dir, 'segments');
            const shared = new FileLock(target);
            const exclusive = new FileLock(target);

            await shared.acquire('shared', 500, 10);

            await expect(exclusive.acquire('exclusive', 80, 10)).rejects.toBeInstanceOf(FileLockTimeoutError);

            await shared.release();
        });
    });

    it('bloquea lock compartido cuando existe lock exclusivo y respeta timeout', async () => {
        await withTempDir(async (dir) => {
            const target = path.join(dir, 'segments');
            const exclusive = new FileLock(target);
            const shared = new FileLock(target);

            await exclusive.acquire('exclusive', 500, 10);

            await expect(shared.acquire('shared', 80, 10)).rejects.toBeInstanceOf(FileLockTimeoutError);

            await exclusive.release();
        });
    });

    it('permite lock exclusivo una vez liberados locks compartidos', async () => {
        await withTempDir(async (dir) => {
            const target = path.join(dir, 'segments');
            const shared = new FileLock(target);
            const exclusive = new FileLock(target);

            await shared.acquire('shared', 500, 10);

            let enteredExclusive = false;
            const pending = (async () => {
                await exclusive.acquire('exclusive', 1000, 10);
                enteredExclusive = true;
                await exclusive.release();
            })();

            await new Promise((resolve) => setTimeout(resolve, 60));
            expect(enteredExclusive).toBe(false);

            await shared.release();
            await pending;
            expect(enteredExclusive).toBe(true);
        });
    });

    it('helpers withSharedLock/withExclusiveLock aplican semántica correcta', async () => {
        await withTempDir(async (dir) => {
            const target = path.join(dir, 'segments');

            await FileLock.withSharedLock(target, async () => {
                await FileLock.withSharedLock(target, async () => {
                    // Dos lectores simultáneos deben convivir
                }, 500);

                await expect(FileLock.withExclusiveLock(target, async () => undefined, 80)).rejects.toBeInstanceOf(FileLockTimeoutError);
            }, 500);
        });
    });

    it('reap stale exclusive lock files left by dead processes', async () => {
        await withTempDir(async (dir) => {
            const target = path.join(dir, 'segments');
            const lockDir = `${target}.locks`;
            await fs.mkdir(lockDir, { recursive: true });
            const exclusiveLockPath = path.join(lockDir, 'exclusive.lock');
            await fs.writeFile(exclusiveLockPath, JSON.stringify({
                mode: 'exclusive',
                pid: 999999,
                acquiredAt: Date.now() - 60_000,
            }), 'utf8');
            const staleDate = new Date(Date.now() - 60_000);
            await fs.utimes(exclusiveLockPath, staleDate, staleDate);

            const lock = new FileLock(target);
            await lock.acquire('exclusive', 500, 10);
            await lock.release();
        });
    });

    it('reap stale shared lock files before granting a new exclusive lock', async () => {
        await withTempDir(async (dir) => {
            const target = path.join(dir, 'segments');
            const lockDir = `${target}.locks`;
            await fs.mkdir(lockDir, { recursive: true });
            const sharedLockPath = path.join(lockDir, 'shared-stale.lock');
            await fs.writeFile(sharedLockPath, JSON.stringify({
                mode: 'shared',
                pid: 999999,
                acquiredAt: Date.now() - 60_000,
            }), 'utf8');
            const staleDate = new Date(Date.now() - 60_000);
            await fs.utimes(sharedLockPath, staleDate, staleDate);

            const lock = new FileLock(target);
            await lock.acquire('exclusive', 500, 10);
            await lock.release();
        });
    });

    it('does not reap malformed fresh lock files that may still be in-flight', async () => {
        await withTempDir(async (dir) => {
            const target = path.join(dir, 'segments');
            const lockDir = `${target}.locks`;
            await fs.mkdir(lockDir, { recursive: true });
            await fs.writeFile(path.join(lockDir, 'exclusive.lock'), '{', 'utf8');

            const lock = new FileLock(target);
            await expect(lock.acquire('exclusive', 80, 10)).rejects.toBeInstanceOf(FileLockTimeoutError);
        });
    });

    it('reaps malformed lock files once they are outside the freshness grace window', async () => {
        await withTempDir(async (dir) => {
            const target = path.join(dir, 'segments');
            const lockDir = `${target}.locks`;
            const exclusiveLockPath = path.join(lockDir, 'exclusive.lock');
            await fs.mkdir(lockDir, { recursive: true });
            await fs.writeFile(exclusiveLockPath, '{', 'utf8');
            const staleDate = new Date(Date.now() - 60_000);
            await fs.utimes(exclusiveLockPath, staleDate, staleDate);

            const lock = new FileLock(target);
            await lock.acquire('exclusive', 500, 10);
            await lock.release();
        });
    });
});
