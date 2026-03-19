import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { existsSync } from 'fs';
import type { GICSDaemonConfig } from './server.js';

export interface GICSModuleRuntimeConfig {
    enabled?: boolean;
    embedded?: boolean;
    options?: Record<string, unknown>;
}

export interface GICSDaemonFileConfig {
    runtime?: Partial<GICSDaemonConfig>;
    paths?: {
        socketPath?: string;
        dataPath?: string;
        tokenPath?: string;
    };
    modules?: Record<string, GICSModuleRuntimeConfig>;
    profiles?: {
        defaultScope?: string;
    };
    policies?: Record<string, unknown>;
}

export interface ResolvedDaemonConfig {
    daemon: GICSDaemonConfig;
    modules: Record<string, GICSModuleRuntimeConfig>;
    profiles: { defaultScope: string };
    policies: Record<string, unknown>;
    filePath: string;
}

export const DEFAULT_CONFIG_PATH = path.join(os.homedir(), '.gics', 'gics.config.json');
const BUILTIN_MODULE_IDS = ['audit-chain', 'native-insight', 'prompt-distiller', 'inference-engine'] as const;

export async function loadDaemonFileConfig(configPath: string = DEFAULT_CONFIG_PATH): Promise<GICSDaemonFileConfig> {
    if (!existsSync(configPath)) return {};
    const raw = await fs.readFile(configPath, 'utf8');
    return JSON.parse(raw) as GICSDaemonFileConfig;
}

export async function writeDaemonFileConfig(configPath: string, config: GICSDaemonFileConfig): Promise<void> {
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
}

export async function resolveDaemonConfig(
    configPath: string,
    defaults: GICSDaemonConfig,
    moduleOverrides?: string[]
): Promise<ResolvedDaemonConfig> {
    const fileConfig = await loadDaemonFileConfig(configPath);
    const modules = { ...(fileConfig.modules ?? {}) };

    if (moduleOverrides && moduleOverrides.length > 0) {
        const overrideSet = new Set(moduleOverrides.map((value) => value.trim()).filter(Boolean));
        const moduleIds = new Set<string>([...BUILTIN_MODULE_IDS, ...Object.keys(modules)]);
        for (const key of moduleIds) {
            modules[key] = { ...(modules[key] ?? {}), enabled: overrideSet.has(key) };
        }
    }

    const daemon: GICSDaemonConfig = {
        ...defaults,
        ...(fileConfig.runtime ?? {}),
        socketPath: fileConfig.paths?.socketPath ?? defaults.socketPath,
        dataPath: fileConfig.paths?.dataPath ?? defaults.dataPath,
        tokenPath: fileConfig.paths?.tokenPath ?? defaults.tokenPath,
    };

    return {
        daemon,
        modules,
        profiles: {
            defaultScope: fileConfig.profiles?.defaultScope ?? 'host:default',
        },
        policies: { ...(fileConfig.policies ?? {}) },
        filePath: configPath,
    };
}
