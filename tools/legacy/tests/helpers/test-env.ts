/**
 * Test Environment Helpers
 * 
 * Provides utilities for integration test gating and temp directory management.
 * 
 * RULE: No direct describe.skip in test files.
 *       Only use describeIntegration() for integration tests.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

type SuiteFactory = () => void | Promise<void>;

/**
 * Whether integration tests are enabled.
 * Set RUN_INTEGRATION=1 to run integration tests.
 */
export const INTEGRATION_ENABLED = process.env.RUN_INTEGRATION === '1';

/**
 * Use this for integration tests that require:
 * - External resources or network access
 * - Production data files
 * - Long-running operations
 * - Flaky or environment-dependent behavior
 * 
 * These tests are SKIPPED by default.
 * Run with: RUN_INTEGRATION=1 npm test
 * Or: npm run test:integration
 */
export const describeIntegration = (name: string, fn: SuiteFactory) =>
    (INTEGRATION_ENABLED ? describe : describe.skip)(name, fn);

/**
 * Creates a unique temporary directory for test fixtures.
 * Each test should call this to get its own isolated directory.
 * 
 * @param prefix - Optional prefix for the temp directory name
 * @returns Promise resolving to absolute path of the created temp directory
 */
export async function mkTempDir(prefix = 'gil-test-'): Promise<string> {
    return mkdtemp(path.join(tmpdir(), prefix));
}
