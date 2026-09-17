import { describe, it, expect, mock } from 'bun:test';
import { createVerifyGateStage, type VerifyGateDeps } from '../../../src/pipeline/stages/_verify-gate.ts';
import { createLogger, type Logger } from '../../../src/utils/logger.ts';
import type { AgentRunArgs, AgentRunner } from '../../../src/pipeline/agent-stage.ts';
import type { PipelineContext } from '../../../src/pipeline/stage.ts';
import type { ContiniaCli, TestRunResult } from '../../../src/services/continia-cli.ts';
import type {
  AppConfig,
  EnvironmentOutput,
  PipelineState,
  VerificationOutput,
  WorktreeContext,
} from '../../../src/types/index.ts';
import type { WorkItemContext } from '../../../src/services/wi-context.ts';
import { TEST_USAGE } from '../../helpers/agent-usage.ts';

const wiCtx: WorkItemContext = {
  id: 101,
  title: 'Fix login',
  workItemType: 'Bug',
  state: 'Active',
  description: 'The login button is broken',
  reproSteps: '',
  acceptanceCriteria: '',
  images: [],
  comments: [],
};

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
  maxInLoopFixAttempts: 1,
  continiaTestTimeoutS: 600,
  dryRun: false,
  skipBuildTest: false, testSelection: 'all', maxTestCodeunits: 0,
  costLogPath: '.state/cost-ledger.jsonl',
};

/**
 * `tests/integration/_continia-fake.ts` is cast to `ContiniaCli`, which hides
 * the `.mock` handles some tests read — hence a local factory, mirroring
 * `_verification.test.ts`'s and `build-and-test.test.ts`'s.
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

function redTestRun(): TestRunResult {
  return {
    status: 'completed',
    passed: false,
    summary: { total: 2, passed: 1, failed: 1, skipped: 0 },
    tests: [
      { name: 'T1', result: 'Pass' },
      { name: 'T2', result: 'Fail', errorMessage: 'boom', stackTrace: 'Codeunit 70001 line 5' },
    ],
  };
}

/** An `AgentRunner` fake that just counts how many times it was called. */
function countingRunner() {
  const runner = {
    calls: 0,
    async run<T>(_args: AgentRunArgs<T>) {
      runner.calls++;
      return {
        value: { summary: 'fixed', filesChanged: ['a.al'], commits: ['fix'] } as unknown as T,
        costUsd: 0.1,
        toolUsage: { Edit: 1 },
        usage: TEST_USAGE,
      };
    },
  };
  return runner;
}

function readyState(): PipelineState {
  return {
    workItemId: 101,
    slug: 'fix-login',
    startedAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    currentStage: 'verify',
    history: [],
    outputs: {
      worktree,
      environment,
      wiContext: wiCtx,
      coder: { summary: 's', filesChanged: [], commits: [] },
    },
  };
}

function makeStageCtx(overrides: Partial<{ aborted: boolean }> = {}): PipelineContext {
  return {
    config: baseConfig,
    logger: createLogger(),
    abortFlag: { aborted: overrides.aborted ?? false },
    signal: new AbortController().signal,
    now: () => new Date('2026-07-07T10:00:00Z'),
  };
}

/**
 * Builds a `VerifyGateDeps` plus the warn/info sinks a test reads assertions
 * off. The stage logs exclusively through `deps.logger` (never `ctx.logger`,
 * which is the orchestrator's own per-stage logger) — same split as
 * `build-and-test.test.ts`'s `makeHarness`.
 */
function makeDeps(overrides: Partial<VerifyGateDeps & { config: AppConfig }> = {}) {
  const warnings: string[] = [];
  const infos: string[] = [];
  const logger: Logger = {
    ...createLogger(),
    info: (m: string) => {
      infos.push(m);
    },
    warn: (m: string) => {
      warnings.push(m);
    },
  };
  const deps: VerifyGateDeps = {
    config: baseConfig,
    continiaCli: makeCliMock() as unknown as ContiniaCli,
    runner: {
      async run<T>() {
        return {
          value: { summary: 'fixed', filesChanged: [], commits: [] } as unknown as T,
          costUsd: 0.1,
          toolUsage: { Edit: 1 },
          usage: TEST_USAGE,
        };
      },
    } as AgentRunner,
    logger,
    fixerPromptTemplate: 'FIXER_PROMPT',
    discoveredSkills: [],
    getCurrentHeadSha: async () => 'base-sha',
    resetWorktree: async () => {},
    discoverTestCodeunits: async () => [{ id: 148001, name: 'Tests A', file: 'x.al' }],
    getChangedFiles: async () => [],
    discoverAlApps: () => [],
    ...overrides,
  };
  return { deps, warnings, infos };
}

describe('createVerifyGateStage', () => {
  it('returns immediately and calls no CLI when SKIP_BUILD_TEST is set', async () => {
    const cli = makeCliMock();
    const { deps } = makeDeps({
      continiaCli: cli as unknown as ContiniaCli,
      config: { ...baseConfig, skipBuildTest: true },
    });
    const stage = createVerifyGateStage(deps);
    await stage.execute(readyState(), makeStageCtx());
    expect(cli.waitForRunning).not.toHaveBeenCalled();
  });

  it('logs and skips — never throws — when there is nothing to run', async () => {
    const { deps, warnings } = makeDeps({ discoverTestCodeunits: async () => [] });
    const stage = createVerifyGateStage(deps);
    const out = await stage.execute(readyState(), makeStageCtx());
    expect(out.outputs.verification).toBeUndefined();
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some((w) => /no test codeunits discovered/.test(w))).toBe(true);
  });

  it('logs and skips — never throws — on an environment-class deploy failure', async () => {
    const cli = makeCliMock({
      deployApp: mock(async () => [
        { app: 'App', compiled: false, published: false, code: 'symbol-fetch-failed' },
      ]),
    });
    const { deps, warnings } = makeDeps({ continiaCli: cli as unknown as ContiniaCli });
    const stage = createVerifyGateStage(deps);
    const out = await stage.execute(readyState(), makeStageCtx());
    expect(warnings.some((w) => /symbol-fetch-failed/.test(w))).toBe(true);
    expect((out.outputs.verification as VerificationOutput).passed).toBe(false);
  });

  it('runs at most maxInLoopFixAttempts fix calls, then returns red without throwing', async () => {
    const runner = countingRunner();
    const cli = makeCliMock({ runTests: mock(async () => redTestRun()) });
    const { deps, warnings } = makeDeps({
      runner: runner as unknown as AgentRunner,
      continiaCli: cli as unknown as ContiniaCli,
      config: { ...baseConfig, maxInLoopFixAttempts: 1 },
    });
    const stage = createVerifyGateStage(deps);

    const out = await stage.execute(readyState(), makeStageCtx());
    expect(runner.calls).toBe(1);
    expect((out.outputs.verification as VerificationOutput).passed).toBe(false);
    expect(warnings.some((w) => /still red after 1 in-loop fix attempt/.test(w))).toBe(true);
  });

  it('persists verification output on the green path', async () => {
    const { deps } = makeDeps();
    const out = await createVerifyGateStage(deps).execute(readyState(), makeStageCtx());
    expect((out.outputs.verification as VerificationOutput).passed).toBe(true);
  });

  it('logs and skips without throwing when upstream outputs are not populated', async () => {
    const { deps, warnings } = makeDeps();
    const stage = createVerifyGateStage(deps);
    const state = readyState();
    delete state.outputs.environment;
    const out = await stage.execute(state, makeStageCtx());
    expect(out.outputs.verification).toBeUndefined();
    expect(warnings.some((w) => /not populated/.test(w))).toBe(true);
  });

  it('returns early without a fix call when abortFlag is set after a red round', async () => {
    const cli = makeCliMock({ runTests: mock(async () => redTestRun()) });
    const runner = countingRunner();
    const { deps } = makeDeps({
      runner: runner as unknown as AgentRunner,
      continiaCli: cli as unknown as ContiniaCli,
    });
    const stage = createVerifyGateStage(deps);
    await stage.execute(readyState(), makeStageCtx({ aborted: true }));
    expect(runner.calls).toBe(0);
  });

  it('leaves the live environment in state even when a throw happens inside prepareVerification', async () => {
    // `installAppById` throwing simulates a mid-setup failure. Before the fix,
    // state.outputs.environment would still carry env-provision's stale
    // record (no live status/url) because the assignment only ran after
    // prepareVerification returned successfully.
    const cli = makeCliMock({
      waitForRunning: mock(async () => ({ id: 'env-9', status: 'Running', url: 'https://bc/live' })),
      installAppById: mock(async () => {
        throw new Error('activation install failed');
      }),
    });
    const { deps } = makeDeps({ continiaCli: cli as unknown as ContiniaCli });
    const stage = createVerifyGateStage(deps);
    const state = readyState();
    state.outputs.environment = { ...environment, status: 'Creating', url: undefined };

    await expect(stage.execute(state, makeStageCtx())).rejects.toThrow('activation install failed');

    const liveEnv = state.outputs.environment as EnvironmentOutput;
    expect(liveEnv.status).toBe('Running');
    expect(liveEnv.url).toBe('https://bc/live');
  });

  it('uses the verify log prefix rather than build-and-test', async () => {
    const { deps, warnings, infos } = makeDeps();
    const stage = createVerifyGateStage(deps);
    await stage.execute(readyState(), makeStageCtx());
    const derivationLine = infos.find((m) => /deploying \d+ app/.test(m));
    expect(derivationLine).toBeDefined();
    expect(derivationLine).toContain('verify:');
    expect([...warnings, ...infos].some((m) => m.includes('build-and-test:'))).toBe(false);
  });
});
