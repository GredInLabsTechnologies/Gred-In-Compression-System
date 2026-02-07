import { beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
process.on('unhandledRejection', (reason: unknown) => {
  console.error('UNHANDLED_REJECTION', reason);
});
process.on('uncaughtException', (err: Error) => {
  console.error('UNCAUGHT_EXCEPTION', err);
});

// GLOBAL TEST SANDBOX & NETWORK BLOCKING
const blockMsg = 'â›” NETWORK BLOCKED: Unit tests must not access external resources. Use vi.spyOn() or mocks.';

// Mock http/https modules
vi.mock('http', async (importOriginal) => {
  const actual = await (importOriginal as () => Promise<typeof import('http')>)();
  return {
    ...actual,
    request: () => { throw new Error(blockMsg); },
    get: () => { throw new Error(blockMsg); }
  };
});

vi.mock('https', async (importOriginal) => {
  const actual = await (importOriginal as () => Promise<typeof import('https')>)();
  return {
    ...actual,
    request: () => { throw new Error(blockMsg); },
    get: () => { throw new Error(blockMsg); }
  };
});

// Block fetch
globalThis.fetch = async () => { throw new Error(blockMsg); };


// 1. Setup Data Sandbox (Global & Synchronous to catch imports)
const testDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gics-test-env-'));
process.env.DATA_ROOT = testDataRoot;

// Create necessary subdirectories to avoid ENOENT in naive tests
fs.mkdirSync(path.join(testDataRoot, 'gics'), { recursive: true });
fs.mkdirSync(path.join(testDataRoot, 'logs'), { recursive: true });

beforeAll(async () => {
  // any async setup if needed
});


afterAll(async () => {
  if (testDataRoot) {
    // Cleanup sandbox
    try {
      await fs.promises.rm(testDataRoot, { recursive: true, force: true });
    } catch (e) {
      console.error('Failed to cleanup test sandbox', e);
    }
  }
});

console.log('GLOBAL SETUP LOADED');


