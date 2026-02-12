import * as fs from 'fs/promises';
import { wait } from '../gics-utils.js';

/**
 * Lock mode supported by the daemon.
 */
export type FileLockMode = 'shared' | 'exclusive';

export class FileLockTimeoutError extends Error {
    constructor(filePath: string, mode: FileLockMode, timeoutMs: number) {
        super(`Failed to acquire ${mode} lock for ${filePath} within ${timeoutMs}ms.`);
        this.name = 'FileLockTimeoutError';
    }
}

/**
 * In-process async read-write lock. FIFO queue, write-preferring.
 *
 * Write-preferring: when an exclusive waiter is queued, no new shared
 * grants are issued until the exclusive completes. This prevents writer
 * starvation under continuous reader load.
 *
 * Single-threaded event loop guarantees: no TOCTOU races, no atomicity
 * concerns. The queue drains synchronously after each release().
 */
export class AsyncRWLock {
    private readers = 0;
    private writer = false;
    private readonly queue: { mode: FileLockMode; resolve: () => void }[] = [];

    async acquire(mode: FileLockMode, timeoutMs: number = 5000): Promise<void> {
        // Fast path: immediate grant if no contention and no exclusive waiter.
        if (mode === 'shared' && !this.writer && !this.hasExclusiveWaiter()) {
            this.readers++;
            return;
        }
        if (mode === 'exclusive' && !this.writer && this.readers === 0) {
            this.writer = true;
            return;
        }

        // Slow path: enqueue and wait.
        return new Promise<void>((resolve, reject) => {
            const entry = { mode, resolve: () => { /* replaced below */ } };
            this.queue.push(entry);

            const timer = setTimeout(() => {
                const idx = this.queue.indexOf(entry);
                if (idx !== -1) {
                    this.queue.splice(idx, 1);
                    reject(new FileLockTimeoutError('(in-process)', mode, timeoutMs));
                }
            }, timeoutMs);

            entry.resolve = () => {
                clearTimeout(timer);
                resolve();
            };
        });
    }

    release(): void {
        if (this.writer) {
            this.writer = false;
        } else if (this.readers > 0) {
            this.readers--;
        }
        this.drain();
    }

    private hasExclusiveWaiter(): boolean {
        for (const w of this.queue) {
            if (w.mode === 'exclusive') return true;
        }
        return false;
    }

    private drain(): void {
        while (this.queue.length > 0) {
            const next = this.queue[0];
            if (next.mode === 'exclusive') {
                if (this.readers === 0 && !this.writer) {
                    this.queue.shift()!;
                    this.writer = true;
                    next.resolve();
                }
                return; // Exclusive waiter blocks all subsequent grants.
            } else {
                if (!this.writer) {
                    this.queue.shift()!;
                    this.readers++;
                    next.resolve();
                    // Continue — grant consecutive shared waiters.
                } else {
                    return;
                }
            }
        }
    }
}

/**
 * File-based locking for cross-platform environments (Node stdlib only).
 *
 * Instance API (acquire/release): marker-file based, for cross-process safety.
 * Static API (withExclusiveLock/withSharedLock): in-process AsyncRWLock per path,
 * race-free and zero-cost. Used by the daemon for all operations.
 */
export class FileLock {
    private readonly targetFilePath: string;
    private readonly lockDirPath: string;
    private readonly exclusiveLockPath: string;
    private heldMode: FileLockMode | null = null;
    private sharedLockPath: string | null = null;

    /** Per-path in-process locks for the static helpers. */
    private static readonly processLocks = new Map<string, AsyncRWLock>();

    private static getProcessLock(path: string): AsyncRWLock {
        let lock = FileLock.processLocks.get(path);
        if (!lock) {
            lock = new AsyncRWLock();
            FileLock.processLocks.set(path, lock);
        }
        return lock;
    }

    constructor(targetFilePath: string) {
        this.targetFilePath = targetFilePath;
        this.lockDirPath = `${targetFilePath}.locks`;
        this.exclusiveLockPath = `${this.lockDirPath}/exclusive.lock`;
    }

    private async ensureLockDir(): Promise<void> {
        await fs.mkdir(this.lockDirPath, { recursive: true });
    }

    private async writeLockFile(filePath: string, metadata: Record<string, string | number>): Promise<void> {
        const lockPayload = JSON.stringify(metadata);
        const handle = await fs.open(filePath, 'wx');
        try {
            await handle.writeFile(lockPayload, 'utf8');
        } finally {
            await handle.close();
        }
    }

    private async getSharedLockFiles(): Promise<string[]> {
        try {
            const files = await fs.readdir(this.lockDirPath);
            return files.filter((name) => name.startsWith('shared-') && name.endsWith('.lock'));
        } catch (err: any) {
            if (err.code === 'ENOENT') return [];
            throw err;
        }
    }

    private async existsExclusiveLock(): Promise<boolean> {
        try {
            await fs.access(this.exclusiveLockPath);
            return true;
        } catch (err: any) {
            if (err.code === 'ENOENT') return false;
            throw err;
        }
    }

    private async tryAcquireShared(): Promise<boolean> {
        if (await this.existsExclusiveLock()) {
            return false;
        }

        await this.ensureLockDir();
        const candidatePath = `${this.lockDirPath}/shared-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.lock`;

        try {
            await this.writeLockFile(candidatePath, {
                mode: 'shared',
                pid: process.pid,
                acquiredAt: Date.now()
            });
        } catch (err: any) {
            if (err.code === 'EEXIST') {
                return false;
            }
            throw err;
        }

        // Re-check after creation to close race with exclusive acquirer.
        if (await this.existsExclusiveLock()) {
            await fs.unlink(candidatePath).catch(() => undefined);
            return false;
        }

        this.heldMode = 'shared';
        this.sharedLockPath = candidatePath;
        return true;
    }

    private async tryAcquireExclusive(): Promise<boolean> {
        await this.ensureLockDir();

        try {
            await this.writeLockFile(this.exclusiveLockPath, {
                mode: 'exclusive',
                pid: process.pid,
                acquiredAt: Date.now()
            });
        } catch (err: any) {
            if (err.code === 'EEXIST') {
                return false;
            }
            throw err;
        }

        // Re-check shared readers to close race windows.
        const sharedFiles = await this.getSharedLockFiles();
        if (sharedFiles.length > 0) {
            await fs.unlink(this.exclusiveLockPath).catch(() => undefined);
            return false;
        }

        this.heldMode = 'exclusive';
        this.sharedLockPath = null;
        return true;
    }

    /**
     * Acquire a lock with timeout/retry policy. (Instance API — file-based)
     */
    async acquire(mode: FileLockMode, timeoutMs: number = 5000, retryIntervalMs: number = 100): Promise<void> {
        if (this.heldMode) {
            throw new Error(`Lock for ${this.targetFilePath} is already held in mode=${this.heldMode}.`);
        }

        const startTime = Date.now();

        while (Date.now() - startTime < timeoutMs) {
            const acquired = mode === 'shared'
                ? await this.tryAcquireShared()
                : await this.tryAcquireExclusive();

            if (acquired) {
                return;
            }

            await wait(retryIntervalMs);
        }

        throw new FileLockTimeoutError(this.targetFilePath, mode, timeoutMs);
    }

    /**
     * Release the lock. (Instance API — file-based)
     */
    async release(): Promise<void> {
        if (this.heldMode === 'exclusive') {
            try {
                await fs.unlink(this.exclusiveLockPath);
            } catch (err: any) {
                if (err.code !== 'ENOENT') throw err;
            }
        } else if (this.heldMode === 'shared' && this.sharedLockPath) {
            try {
                await fs.unlink(this.sharedLockPath);
            } catch (err: any) {
                if (err.code !== 'ENOENT') throw err;
            }
        }

        this.heldMode = null;
        this.sharedLockPath = null;
    }

    /**
     * Execute a function with an exclusive lock. (In-process AsyncRWLock — race-free)
     */
    static async withExclusiveLock<T>(filePath: string, fn: () => Promise<T>, timeoutMs: number = 5000): Promise<T> {
        const lock = FileLock.getProcessLock(filePath);
        await lock.acquire('exclusive', timeoutMs);
        try {
            return await fn();
        } finally {
            lock.release();
        }
    }

    /**
     * Execute a function with a shared lock. (In-process AsyncRWLock — race-free)
     */
    static async withSharedLock<T>(filePath: string, fn: () => Promise<T>, timeoutMs: number = 5000): Promise<T> {
        const lock = FileLock.getProcessLock(filePath);
        await lock.acquire('shared', timeoutMs);
        try {
            return await fn();
        } finally {
            lock.release();
        }
    }

    /**
     * Backward-compatible alias for existing call sites.
     */
    static async withLock<T>(filePath: string, fn: () => Promise<T>, timeoutMs: number = 5000): Promise<T> {
        return FileLock.withExclusiveLock(filePath, fn, timeoutMs);
    }
}
