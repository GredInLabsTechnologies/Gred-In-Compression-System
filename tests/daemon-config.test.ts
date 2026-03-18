import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { resolveDaemonConfig } from '../src/daemon/config.js';

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gics-config-test-'));
    try {
        await run(dir);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
}

describe('resolveDaemonConfig', () => {
    it('treats --modules overrides as an authoritative module set', async () => {
        await withTempDir(async (dir) => {
            const configPath = path.join(dir, 'gics.config.json');
            const resolved = await resolveDaemonConfig(configPath, {
                socketPath: path.join(dir, 'gics.sock'),
                dataPath: path.join(dir, 'data'),
                tokenPath: path.join(dir, 'gics.token'),
                walType: 'binary',
            }, ['inference-engine']);

            expect(resolved.modules['inference-engine']?.enabled).toBe(true);
            expect(resolved.modules['audit-chain']?.enabled).toBe(false);
            expect(resolved.modules['native-insight']?.enabled).toBe(false);
            expect(resolved.modules['prompt-distiller']?.enabled).toBe(false);
        });
    });
});
