import { mock } from 'bun:test';
import type { ContiniaCli } from '../../src/services/continia-cli.ts';
import type { DiscoveredTestCodeunit } from '../../src/utils/al-test-discovery.ts';

/**
 * Fully green fake ContiniaCli for integration tests: env provisions instantly,
 * every deploy compiles + publishes, every test run passes.
 */
export function makeGreenContiniaCli(): ContiniaCli {
  return {
    createEnvironment: mock(async () => ({ id: 'env-9', status: 'Draft', url: 'https://bc/env-9' })),
    startEnvironment: mock(async () => {}),
    getEnvironment: mock(async () => ({ id: 'env-9', status: 'Running', url: 'https://bc/env-9' })),
    waitForRunning: mock(async () => ({ id: 'env-9', status: 'Running', url: 'https://bc/env-9' })),
    installDependencies: mock(async () => ({ skippedCount: 0, symbolsMissingCount: 0 })),
    installAppById: mock(async () => {}),
    downloadSymbols: mock(async () => {}),
    deployApp: mock(async () => [{ app: 'App', compiled: true, published: true }]),
    runTests: mock(async () => ({
      status: 'completed',
      passed: true,
      summary: { total: 1, passed: 1, failed: 0, skipped: 0 },
      tests: [{ name: 'T', result: 'Pass' }],
    })),
  } as unknown as ContiniaCli;
}

export const greenCodeunits = async (): Promise<DiscoveredTestCodeunit[]> => [
  { id: 148001, name: 'Tests', file: 'x.al' },
];
