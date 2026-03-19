import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { readFileSync } from 'node:fs';
import { GICSv2Decoder } from '../gics/decode.js';
import type { SeedPolicyInput, SeedProfileInput } from '../inference/state-store.js';

export interface GICSNodeClientOptions {
    socketPath?: string;
    token?: string;
    tokenPath?: string;
    maxRetries?: number;
    retryDelayMs?: number;
    requestTimeoutMs?: number;
}

export interface GICSRecord {
    key: string;
    fields: Record<string, number | string>;
}

export interface GICSScanItem {
    key: string;
    fields: Record<string, number | string>;
    tier: 'hot' | 'warm' | 'cold';
    timestamp: number;
}

export interface GICSScanResult {
    items: GICSScanItem[];
    nextCursor: string | null;
}

export interface GICSScanOptions {
    prefix?: string;
    tiers?: 'all' | Array<'hot' | 'warm' | 'cold'>;
    includeSystem?: boolean;
    limit?: number;
    cursor?: string | null;
    mode?: 'current';
}

export interface GICSPutManyOptions {
    atomic?: boolean;
    idempotencyKey?: string;
    verify?: boolean;
}

export interface GICSScanSummary {
    prefix: string;
    count: number;
    oldestTimestamp: number | null;
    latestTimestamp: number | null;
    latestKey: string | null;
    tiers: Record<'hot' | 'warm' | 'cold', number>;
}

const DEFAULT_SOCKET = process.platform === 'win32'
    ? '\\\\.\\pipe\\gics-daemon'
    : path.join(os.homedir(), '.gics', 'gics.sock');
const DEFAULT_TOKEN_PATH = path.join(os.homedir(), '.gics', 'gics.token');

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldRetry(error: unknown): boolean {
    const err = error as NodeJS.ErrnoException | undefined;
    return Boolean(err?.code && ['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ENOENT'].includes(err.code));
}

export async function verifyGICSFile(filePath: string, options: { password?: string } = {}): Promise<boolean> {
    const raw = await fs.readFile(filePath);
    const decoder = new GICSv2Decoder(raw, { password: options.password });
    return await decoder.verifyIntegrityOnly();
}

export class GICSNodeClient {
    private requestId = 1;
    private readonly socketPath: string;
    private readonly tokenPath: string;
    private readonly maxRetries: number;
    private readonly retryDelayMs: number;
    private readonly requestTimeoutMs: number;
    private cachedToken: string | null;

    constructor(options: GICSNodeClientOptions = {}) {
        this.socketPath = options.socketPath ?? DEFAULT_SOCKET;
        this.tokenPath = options.tokenPath ?? DEFAULT_TOKEN_PATH;
        this.cachedToken = options.token ?? null;
        this.maxRetries = Math.max(0, options.maxRetries ?? 3);
        this.retryDelayMs = Math.max(10, options.retryDelayMs ?? 100);
        this.requestTimeoutMs = Math.max(100, options.requestTimeoutMs ?? 5000);
    }

    private nextRequestId(): number {
        return this.requestId++;
    }

    private async resolveToken(required: boolean): Promise<string | undefined> {
        if (this.cachedToken) {
            return this.cachedToken;
        }
        try {
            this.cachedToken = readFileSync(this.tokenPath, 'utf8').trim();
            return this.cachedToken;
        } catch (error) {
            if (!required) {
                return undefined;
            }
            throw error;
        }
    }

    private async rpc<T>(method: string, params: Record<string, unknown> = {}, authRequired: boolean = true): Promise<T> {
        const token = await this.resolveToken(authRequired);
        const request = {
            jsonrpc: '2.0',
            id: this.nextRequestId(),
            method,
            params,
            token,
        };
        const payload = JSON.stringify(request) + '\n';

        let lastError: unknown;
        for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
            try {
                const response = await new Promise<any>((resolve, reject) => {
                    const socket = net.createConnection(this.socketPath, () => {
                        socket.write(payload);
                    });

                    let settled = false;
                    let buffer = '';
                    const timer = setTimeout(() => {
                        if (settled) return;
                        settled = true;
                        socket.destroy();
                        const timeoutError = new Error(`RPC timeout after ${this.requestTimeoutMs}ms`);
                        (timeoutError as NodeJS.ErrnoException).code = 'ETIMEDOUT';
                        reject(timeoutError);
                    }, this.requestTimeoutMs);

                    const finish = (handler: () => void) => {
                        if (settled) return;
                        settled = true;
                        clearTimeout(timer);
                        handler();
                    };

                    socket.on('data', (chunk) => {
                        buffer += chunk.toString();
                        const lines = buffer.split('\n');
                        buffer = lines.pop() || '';
                        const line = lines.find((entry) => entry.trim());
                        if (!line) return;
                        finish(() => {
                            socket.end();
                            try {
                                resolve(JSON.parse(line));
                            } catch (error) {
                                reject(error);
                            }
                        });
                    });

                    socket.on('error', (error) => {
                        finish(() => reject(error));
                    });
                });

                if (response?.error) {
                    throw new Error(`GICS error ${response.error.code ?? -1}: ${response.error.message ?? 'Unknown error'}`);
                }
                return response.result as T;
            } catch (error) {
                lastError = error;
                if (attempt >= this.maxRetries || !shouldRetry(error)) {
                    throw error;
                }
                await sleep(this.retryDelayMs);
            }
        }

        throw lastError;
    }

    async put(key: string, fields: Record<string, number | string>): Promise<{ ok: boolean; behavior?: unknown }> {
        return await this.rpc('put', { key, fields });
    }

    async get(key: string, includeSystem: boolean = false): Promise<{ key: string; fields: Record<string, number | string>; tier: string; behavior?: unknown } | null> {
        return await this.rpc('get', { key, includeSystem });
    }

    async delete(key: string): Promise<{ ok: boolean; tombstoneKey: string }> {
        return await this.rpc('delete', { key });
    }

    async scan(options: GICSScanOptions = {}): Promise<GICSScanResult> {
        return await this.rpc('scan', {
            prefix: options.prefix ?? '',
            tiers: options.tiers ?? 'all',
            includeSystem: options.includeSystem ?? false,
            limit: options.limit,
            cursor: options.cursor ?? null,
            mode: options.mode ?? 'current',
        });
    }

    async putMany(records: GICSRecord[], options: GICSPutManyOptions = {}): Promise<Record<string, unknown>> {
        return await this.rpc('putMany', {
            records,
            atomic: options.atomic ?? true,
            idempotency_key: options.idempotencyKey,
            verify: options.verify ?? false,
        });
    }

    async countPrefix(prefix: string, options: Omit<GICSScanOptions, 'prefix' | 'limit' | 'cursor'> = {}): Promise<{ prefix: string; count: number }> {
        return await this.rpc('countPrefix', {
            prefix,
            tiers: options.tiers ?? 'all',
            includeSystem: options.includeSystem ?? false,
            mode: options.mode ?? 'current',
        });
    }

    async latestByPrefix(prefix: string, options: Omit<GICSScanOptions, 'prefix' | 'limit' | 'cursor'> = {}): Promise<GICSScanItem | null> {
        return await this.rpc('latestByPrefix', {
            prefix,
            tiers: options.tiers ?? 'all',
            includeSystem: options.includeSystem ?? false,
            mode: options.mode ?? 'current',
        });
    }

    async scanSummary(prefix: string, options: Omit<GICSScanOptions, 'prefix' | 'limit' | 'cursor'> = {}): Promise<GICSScanSummary> {
        return await this.rpc('scanSummary', {
            prefix,
            tiers: options.tiers ?? 'all',
            includeSystem: options.includeSystem ?? false,
            mode: options.mode ?? 'current',
        });
    }

    async flush(): Promise<Record<string, unknown>> {
        return await this.rpc('flush');
    }

    async compact(): Promise<Record<string, unknown>> {
        return await this.rpc('compact');
    }

    async rotate(): Promise<Record<string, unknown>> {
        return await this.rpc('rotate');
    }

    async verify(tier?: 'warm' | 'cold'): Promise<Record<string, unknown>> {
        return await this.rpc('verify', tier ? { tier } : {});
    }

    async ping(): Promise<Record<string, unknown>> {
        return await this.rpc('ping', {}, false);
    }

    async pingVerbose(): Promise<Record<string, unknown>> {
        return await this.rpc('pingVerbose');
    }

    async getTelemetry(): Promise<Record<string, unknown>> {
        return await this.rpc('getTelemetry');
    }

    async getTelemetryEvents(limit: number = 100, type?: string): Promise<Record<string, unknown>> {
        return await this.rpc('getTelemetryEvents', { limit, type });
    }

    async seedProfile(seed: SeedProfileInput): Promise<Record<string, unknown>> {
        return await this.rpc('seedProfile', seed as unknown as Record<string, unknown>);
    }

    async seedPolicy(seed: SeedPolicyInput): Promise<Record<string, unknown>> {
        return await this.rpc('seedPolicy', seed as unknown as Record<string, unknown>);
    }

    async verifyFile(filePath: string, options: { password?: string } = {}): Promise<boolean> {
        return await verifyGICSFile(filePath, options);
    }
}
