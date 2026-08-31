import { describe, it, expect, mock } from 'bun:test';
import { createEnvProvisionStage } from '../../../src/pipeline/stages/env-provision.ts';
import { ContiniaCliError, type ContiniaCli, type EnvironmentInfo } from '../../../src/services/continia-cli.ts';
import { createLogger } from '../../../src/utils/logger.ts';
import type { AppConfig, EnvironmentOutput, PipelineState, WorktreeContext } from '../../../src/types/index.ts';

const baseConfig: AppConfig = {
  orgUrl: 'https://x', project: 'p', pat: 't',
  repositoryName: 'test-repo',
  targetRepoPath: '/repos/target', worktreeBase: '/repos/.worktrees',
  triggerTag: 'agent implement', blockedTag: 'agent-blocked', needInputTag: 'need-input',
  pollIntervalMinutes: 5, concurrency: 1, maxRevisions: 3, maxRejectCycles: 3,
  coderMaxTurns: 80, testAuthorMaxTurns: 50,
  maxCostUsdPerWi: 5.00, stageTimeoutMs: {},
  claudeModel: 'm', stateDir: '.state', assignedToFilter: [],
  continiaCliPath: '.tools/continia.exe',
  continiaEnvProfileId: 'prof-1',
  continiaApiToken: 'tok',
  continiaAppPaths: ['App'],
  continiaTestAppPaths: ['App'],
  maxTestFixAttempts: 2,
  continiaTestTimeoutS: 600,
  dryRun: false,
  skipBuildTest: false, testSelection: 'all', maxTestCodeunits: 0,
};

const FIXED_NOW = new Date('2026-07-07T10:00:00.000Z');

const worktree: WorktreeContext = {
  path: '/repos/.worktrees/wi-101-fix-login',
  branch: 'agent/wi-101-fix-login',
  baseSha: 'abc123',
};

function makeState(overrides: Partial<PipelineState> = {}): PipelineState {
  return {
    workItemId: 101,
    slug: 'fix-login',
    startedAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    currentStage: 'env-provision',
    history: [],
    outputs: { worktree },
    ...overrides,
  };
}

function makeCtx() {
  return {
    config: baseConfig,
    logger: createLogger(),
    abortFlag: { aborted: false },
    signal: new AbortController().signal,
    now: () => FIXED_NOW,
  };
}

type CliMocks = {
  [K in keyof ContiniaCli]: ReturnType<typeof mock>;
};

function makeCli(overrides: Partial<Record<keyof ContiniaCli, unknown>> = {}): ContiniaCli & CliMocks {
  const created: EnvironmentInfo = { id: 'env-9', name: 'wi-101-fix-login', status: 'Draft', url: 'https://bc/env-9' };
  const cli = {
    createEnvironment: mock(async () => created),
    startEnvironment: mock(async () => {}),
    getEnvironment: mock(async () => created),
    waitForRunning: mock(async () => ({ ...created, status: 'Running' })),
    installDependencies: mock(async () => ({ skippedCount: 0, symbolsMissingCount: 0 })),
    installAppById: mock(async () => {}),
    downloadSymbols: mock(async () => {}),
    deployApp: mock(async () => []),
    runTests: mock(async () => ({ status: 'completed', passed: true, summary: { total: 0, passed: 0, failed: 0, skipped: 0 }, tests: [] })),
    ...overrides,
  };
  return cli as unknown as ContiniaCli & CliMocks;
}

describe('createEnvProvisionStage', () => {
  it('fresh run: creates + starts the env, persists outputs.environment, never polls', async () => {
    const cli = makeCli();
    const stage = createEnvProvisionStage({ config: baseConfig, continiaCli: cli, logger: createLogger() });
    const result = await stage.execute(makeState(), makeCtx());

    expect(cli.createEnvironment).toHaveBeenCalledTimes(1);
    const [name, profileId] = cli.createEnvironment.mock.calls[0] as unknown as [string, string];
    expect(name).toBe('wi-101-fix-login');
    expect(profileId).toBe('prof-1');
    expect(cli.startEnvironment).toHaveBeenCalledTimes(1);
    expect(cli.waitForRunning).not.toHaveBeenCalled();

    const env = result.outputs.environment as EnvironmentOutput;
    expect(env.envId).toBe('env-9');
    expect(env.name).toBe('wi-101-fix-login');
    expect(env.url).toBe('https://bc/env-9');
    expect(env.createdAt).toBe(FIXED_NOW.toISOString());
  });

  it('truncates the env name to 40 chars for very long slugs', async () => {
    const cli = makeCli();
    const stage = createEnvProvisionStage({ config: baseConfig, continiaCli: cli, logger: createLogger() });
    await stage.execute(
      makeState({ slug: 'a-very-long-slug-that-goes-on-and-on-and-on-forever' }),
      makeCtx(),
    );
    const [name] = cli.createEnvironment.mock.calls[0] as unknown as [string];
    expect(name.length).toBeLessThanOrEqual(40);
    expect(name.startsWith('wi-101-')).toBe(true);
  });

  it('reuses a persisted env that still exists; refreshes status/url; no create', async () => {
    const persisted: EnvironmentOutput = {
      envId: 'env-9', name: 'wi-101-fix-login', status: 'Starting', createdAt: '2026-07-06T00:00:00Z',
    };
    const cli = makeCli({
      getEnvironment: mock(async () => ({ id: 'env-9', status: 'Running', url: 'https://bc/env-9' })),
    });
    const stage = createEnvProvisionStage({ config: baseConfig, continiaCli: cli, logger: createLogger() });
    const state = makeState({ outputs: { worktree, environment: persisted } });
    const result = await stage.execute(state, makeCtx());

    expect(cli.createEnvironment).not.toHaveBeenCalled();
    expect(cli.startEnvironment).not.toHaveBeenCalled(); // already Running
    const env = result.outputs.environment as EnvironmentOutput;
    expect(env.envId).toBe('env-9');
    expect(env.status).toBe('Running');
    expect(env.url).toBe('https://bc/env-9');
  });

  it('starts a reused env that is not yet started (Draft/Stopped)', async () => {
    const persisted: EnvironmentOutput = {
      envId: 'env-9', name: 'n', status: 'Draft', createdAt: '2026-07-06T00:00:00Z',
    };
    const cli = makeCli({
      getEnvironment: mock(async () => ({ id: 'env-9', status: 'Stopped' })),
    });
    const stage = createEnvProvisionStage({ config: baseConfig, continiaCli: cli, logger: createLogger() });
    await stage.execute(makeState({ outputs: { worktree, environment: persisted } }), makeCtx());
    expect(cli.startEnvironment).toHaveBeenCalledTimes(1);
  });

  it('recreates when the persisted env no longer resolves', async () => {
    const persisted: EnvironmentOutput = {
      envId: 'env-gone', name: 'n', status: 'Running', createdAt: '2026-07-06T00:00:00Z',
    };
    const cli = makeCli({
      getEnvironment: mock(async () => {
        throw new ContiniaCliError('no such environment', [], 3, '', 'no such environment');
      }),
    });
    const stage = createEnvProvisionStage({ config: baseConfig, continiaCli: cli, logger: createLogger() });
    const result = await stage.execute(makeState({ outputs: { worktree, environment: persisted } }), makeCtx());

    expect(cli.createEnvironment).toHaveBeenCalledTimes(1);
    expect((result.outputs.environment as EnvironmentOutput).envId).toBe('env-9');
  });

  it('throws when the worktree output is missing', async () => {
    const stage = createEnvProvisionStage({ config: baseConfig, continiaCli: makeCli(), logger: createLogger() });
    await expect(stage.execute(makeState({ outputs: {} }), makeCtx())).rejects.toThrow(/worktree/);
  });
});
