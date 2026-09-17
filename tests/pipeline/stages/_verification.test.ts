import { describe, it, expect, mock } from 'bun:test';
import {
  prepareVerification,
  runVerificationRound,
  type PrepareVerificationArgs,
  type RunVerificationRoundArgs,
  type VerificationSetupCache,
} from '../../../src/pipeline/stages/_verification.ts';
import { createLogger, type Logger } from '../../../src/utils/logger.ts';
import type { ContiniaCli } from '../../../src/services/continia-cli.ts';
import type { AppConfig, EnvironmentOutput, WorktreeContext } from '../../../src/types/index.ts';
import type { DiscoveredTestCodeunit } from '../../../src/utils/al-test-discovery.ts';

const worktree: WorktreeContext = {
  path: '/repos/.worktrees/wi-101-fix-login',
  branch: 'agent/wi-101-fix-login',
  baseSha: 'abc123',
};

const environment: EnvironmentOutput = {
  envId: 'env-9',
  name: 'wi-101-fix-login',
  url: 'https://bc/env-9',
  status: 'Running',
  createdAt: '2026-07-07T10:00:00Z',
};

const baseConfig: AppConfig = {
  orgUrl: 'https://x', project: 'p', pat: 't',
  repositoryName: 'test-repo',
  targetRepoPath: '/repos/target', worktreeBase: '/repos/.worktrees',
  triggerTag: 'agent implement', blockedTag: 'agent-blocked', needInputTag: 'need-input',
  pollIntervalMinutes: 5, concurrency: 1, maxRevisions: 3, maxRejectCycles: 3,
  coderMaxTurns: 80, reviewerMaxTurns: 50, testAuthorMaxTurns: 50,
  maxCostUsdPerWi: 5.00, stageTimeoutMs: {},
  claudeModel: 'm', stateDir: '.state', logDir: 'logs', assignedToFilter: [],
  continiaCliPath: '.tools/continia.exe',
  continiaEnvProfileId: 'prof-1',
  continiaEnvLocalization: 'base',
  continiaApiToken: 'tok',
  continiaAppPaths: ['App'],
  continiaTestAppPaths: ['Test'],
  maxTestFixAttempts: 2,
  continiaTestTimeoutS: 600,
  dryRun: false,
  skipBuildTest: false, testSelection: 'all', maxTestCodeunits: 0,
  costLogPath: '.state/cost-ledger.jsonl',
};

const codeunit: DiscoveredTestCodeunit = {
  id: 148001,
  name: 'Tests A',
  file: `${worktree.path}/Test/A.al`,
};
const codeunitInUnrelatedApp: DiscoveredTestCodeunit = {
  id: 148002,
  name: 'Tests B',
  file: `${worktree.path}/Test/B.al`,
};

/**
 * `tests/integration/_continia-fake.ts` is cast to `ContiniaCli`, which hides
 * the `.mock` handles these tests read, and has no per-method override hook —
 * hence a local factory shaped the same way as `build-and-test.test.ts`'s.
 */
function makeCliMock(overrides: Record<string, unknown> = {}) {
  return {
    createEnvironment: mock(async () => ({ id: 'env-9', status: 'Draft' })),
    startEnvironment: mock(async () => {}),
    getEnvironment: mock(async () => ({ id: 'env-9', status: 'Running' })),
    waitForRunning: mock(async () => ({ id: 'env-9', status: 'Running', url: 'https://bc/env-9' })),
    installAppById: mock(async () => {}),
    installDependencies: mock(async () => ({ skippedCount: 0, symbolsMissingCount: 0 })),
    downloadSymbols: mock(async () => {}),
    deployApp: mock(async (_e: string, app: string) => [{ app, compiled: true, published: true }]),
    runTests: mock(async () => ({
      status: 'completed',
      passed: true,
      summary: { total: 1, passed: 1, failed: 0, skipped: 0 },
      tests: [{ name: 'T', result: 'Pass' }],
    })),
    ...overrides,
  };
}

const silentLogger: Logger = {
  ...createLogger(),
  info: () => {},
  warn: () => {},
};

function makeBaseArgs(): PrepareVerificationArgs {
  return {
    config: baseConfig,
    continiaCli: makeCliMock() as unknown as ContiniaCli,
    logger: silentLogger,
    worktree,
    environment,
    cache: {} as VerificationSetupCache,
    discoverTestCodeunits: async () => [codeunit],
    getChangedFiles: async () => [],
    discoverAlApps: () => [],
  };
}

function makeRoundArgs(): RunVerificationRoundArgs {
  return {
    continiaCli: makeCliMock() as unknown as ContiniaCli,
    env: environment,
    worktree,
    appPaths: ['App'],
    codeunits: [codeunit],
    config: baseConfig,
    attempt: 0,
  };
}

describe('prepareVerification', () => {
  it('returns a skipReason instead of throwing when discovery finds nothing', async () => {
    const setup = await prepareVerification({
      ...makeBaseArgs(),
      discoverTestCodeunits: async () => [],
    });
    expect(setup.skipReason).toMatch(/no test codeunits discovered/);
    expect(setup.codeunits).toEqual([]);
  });

  it('returns a skipReason instead of throwing when selection is empty', async () => {
    const base = makeBaseArgs();
    const setup = await prepareVerification({
      ...base,
      discoverTestCodeunits: async () => [codeunitInUnrelatedApp],
      getChangedFiles: async () => ['totally/unrelated.al'],
      config: { ...base.config, testSelection: 'changed' },
    });
    expect(setup.skipReason).toMatch(/no test codeunits selected/);
    expect(setup.codeunits).toEqual([]);
  });

  it('skips a deps install for an appPath already in the cache', async () => {
    const cli = makeCliMock();
    await prepareVerification({
      ...makeBaseArgs(),
      continiaCli: cli as unknown as ContiniaCli,
      cache: { envId: environment.envId, depsInstalled: ['App'] },
    });
    const installedPaths = cli.installDependencies.mock.calls.map((c: unknown[]) => c[1]);
    expect(installedPaths).not.toContain('App');
  });

  it('records newly installed appPaths back into the cache', async () => {
    const cache: VerificationSetupCache = { depsInstalled: [] };
    await prepareVerification({ ...makeBaseArgs(), cache });
    expect(cache.depsInstalled).toContain('App');
    expect(cache.activationInstalled).toBe(true);
    expect(cache.envId).toBe(environment.envId);
  });

  it('skips the activation-app install when the cache says it already ran', async () => {
    const cli = makeCliMock();
    await prepareVerification({
      ...makeBaseArgs(),
      continiaCli: cli as unknown as ContiniaCli,
      cache: { envId: environment.envId, activationInstalled: true },
    });
    expect(cli.installAppById.mock.calls).toHaveLength(0);
  });

  // env-provision legitimately recreates an environment on a resumed WI (Plan
  // 12): wrong BC version, another WI's name, terminal status, or a version it
  // cannot establish. Honouring a cache from the dead environment would skip
  // the activation app and Continia Finance on the fresh one, and the resulting
  // publish failure would be blamed on an app that is not at fault.
  it('treats a cache populated against another environment as cold', async () => {
    const cli = makeCliMock();
    const cache: VerificationSetupCache = {
      envId: 'env-old',
      activationInstalled: true,
      localizationInstalled: true,
      depsInstalled: ['App'],
    };
    await prepareVerification({
      ...makeBaseArgs(),
      continiaCli: cli as unknown as ContiniaCli,
      environment: { ...environment, envId: 'env-new' },
      cache,
    });

    expect(cli.installAppById.mock.calls).toHaveLength(1);
    const installedPaths = cli.installDependencies.mock.calls.map((c: unknown[]) => c[1]);
    expect(installedPaths).toContain('App');
    expect(cache.envId).toBe('env-new');
    expect(cache.depsInstalled).toEqual(['App']);
  });

  it('treats a legacy cache carrying no envId as cold', async () => {
    const cli = makeCliMock();
    const cache: VerificationSetupCache = {
      activationInstalled: true,
      localizationInstalled: true,
      depsInstalled: ['App'],
    };
    await prepareVerification({
      ...makeBaseArgs(),
      continiaCli: cli as unknown as ContiniaCli,
      cache,
    });

    expect(cli.installAppById.mock.calls).toHaveLength(1);
    const installedPaths = cli.installDependencies.mock.calls.map((c: unknown[]) => c[1]);
    expect(installedPaths).toContain('App');
    expect(cache.envId).toBe(environment.envId);
  });
});

describe('runVerificationRound', () => {
  it('returns environmentBlocker instead of throwing on a non-fixable deploy code', async () => {
    const cli = makeCliMock({
      deployApp: mock(async () => [
        { app: 'App', compiled: false, published: false, code: 'symbol-fetch-failed', error: 'no symbols' },
      ]),
    });
    const res = await runVerificationRound({
      ...makeRoundArgs(),
      continiaCli: cli as unknown as ContiniaCli,
    });
    expect(res.environmentBlocker?.code).toBe('symbol-fetch-failed');
    expect(res.output.passed).toBe(false);
    expect(res.output.testRuns).toEqual([]);
  });

  it('returns a failure for a compile error, with no environmentBlocker', async () => {
    const cli = makeCliMock({
      deployApp: mock(async () => [
        { app: 'App', compiled: false, published: false, code: 'compile-failed', error: 'AL0118' },
      ]),
    });
    const res = await runVerificationRound({
      ...makeRoundArgs(),
      continiaCli: cli as unknown as ContiniaCli,
    });
    expect(res.environmentBlocker).toBeUndefined();
    expect(res.failure?.compiled).toBe(false);
    expect(res.output.passed).toBe(false);
  });

  it('returns no failure when every app compiles and every codeunit passes', async () => {
    const res = await runVerificationRound(makeRoundArgs());
    expect(res.failure).toBeUndefined();
    expect(res.output.passed).toBe(true);
    expect(res.output.compiled).toBe(true);
  });
});
