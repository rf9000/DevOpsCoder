import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { runPollCycle, createAbortFlag } from '../../src/services/watcher.ts';
import { createProcessor } from '../../src/services/processor.ts';
import { buildPipeline } from '../../src/services/pipeline-builder.ts';
import { REVIEW_AXES } from '../../src/pipeline/stages/reviewer.ts';
import { PipelineStateStore } from '../../src/state/state-store.ts';
import { createLogger } from '../../src/utils/logger.ts';
import { makeGreenContiniaCli, greenCodeunits } from './_continia-fake.ts';
import type { ContiniaCli, TestRunResult } from '../../src/services/continia-cli.ts';
import type { AdoClient } from '../../src/sdk/azure-devops-client.ts';
import type { AppConfig, VerificationOutput, WorktreeContext } from '../../src/types/index.ts';
import type {
  AgentRunArgs,
  AgentRunner,
  AgentRunResult,
} from '../../src/pipeline/agent-stage.ts';
import type { WorktreeManager } from '../../src/services/worktree-manager.ts';
import type { PipelineBuilderDeps } from '../../src/services/pipeline-builder.ts';
import { TEST_USAGE } from '../helpers/agent-usage.ts';

const baseConfig: AppConfig = {
  orgUrl: 'https://x',
  project: 'p',
  pat: 'pat',
  repositoryName: 'test-repo',
  targetRepoPath: '/repos/target',
  worktreeBase: '/repos/.worktrees',
  triggerTag: 'agent implement',
  blockedTag: 'agent-blocked',
  needInputTag: 'need-input',
  pollIntervalMinutes: 5,
  concurrency: 1,
  maxRevisions: 3,
  maxRejectCycles: 3,
  coderMaxTurns: 80, reviewerMaxTurns: 50,
  testAuthorMaxTurns: 50,
  maxCostUsdPerWi: 5.00,
  stageTimeoutMs: {},
  claudeModel: 'claude-opus-4-7',
  stateDir: '', logDir: 'logs',
  assignedToFilter: [],
  continiaCliPath: '.tools/continia.exe',
  continiaEnvProfileId: 'prof-1',
  continiaEnvLocalization: 'base',
  continiaApiToken: 'tok',
  continiaAppPaths: ['App'],
  continiaTestAppPaths: ['App'],
  maxTestFixAttempts: 2,
  continiaTestTimeoutS: 600,
  dryRun: false,
  skipBuildTest: false, testSelection: 'all', maxTestCodeunits: 0, costLogPath: '.state/cost-ledger.jsonl',
};

const sampleWorktree: WorktreeContext = {
  path: '/repos/.worktrees/wi-101-fix-login',
  branch: 'agent/wi-101-fix-login',
  baseSha: 'baselinesha123',
};

const greenRun: TestRunResult = {
  status: 'completed', passed: true,
  summary: { total: 2, passed: 2, failed: 0, skipped: 0 },
  tests: [{ name: 'T1', result: 'Pass' }, { name: 'T2', result: 'Pass' }],
};
const redRun: TestRunResult = {
  status: 'completed', passed: false,
  summary: { total: 2, passed: 1, failed: 1, skipped: 0, codeunitName: 'CDO Setup Tests' },
  tests: [
    { name: 'T1', result: 'Pass' },
    { name: 'RedTest', result: 'Fail', errorMessage: 'Expected 1, got 0', stackTrace: '"CDO Feature"(Codeunit 70001).Calculate line 12' },
  ],
};

function makeAdo(taggedIds: number[]): AdoClient {
  return {
    queryWorkItemsByTag: mock(async () => taggedIds),
    getWorkItem: mock(async (id: number) => ({
      id,
      fields: {
        'System.Title': `WI ${id}`,
        'System.State': 'Active',
        'System.Tags': 'agent implement',
        'System.WorkItemType': 'Bug',
        'System.Description': '<p>desc</p>',
      },
    })),
    getWorkItemComments: mock(async () => []),
    getWorkItemUpdates: mock(async () => []),
    createPullRequestThread: mock(async () => {}),
    addTagToWorkItem: mock(async () => {}),
    removeTagFromWorkItem: mock(async () => {}),
    addWorkItemComment: mock(async () => {}),
    createPullRequest: mock(async () => ({
      id: 1,
      url: 'https://example.com/pr/1',
      sourceRefName: '',
      targetRefName: '',
    })),
  };
}

function makeWorktreeManager(): WorktreeManager {
  return {
    ensureWorktree: mock(async () => sampleWorktree),
    removeWorktree: mock(async () => {}),
  };
}

interface RecordingRunner extends AgentRunner {
  calls: AgentRunArgs<unknown>[];
}

/** Runner keyed on systemPromptAppend: A analyzer, C coder, T test-author, F fixer, R* reviewer. */
function makeRunner(): RecordingRunner {
  const calls: AgentRunArgs<unknown>[] = [];
  return {
    calls,
    async run<T>(args: AgentRunArgs<T>): Promise<AgentRunResult<T>> {
      calls.push(args as AgentRunArgs<unknown>);
      const sys = args.systemPromptAppend ?? '';
      let value: unknown;
      if (sys === 'A') value = { verdict: 'proceed', summary: 'ready', reasons: [] };
      else if (sys === 'C') value = { summary: 'coded', filesChanged: ['x.al'], commits: ['abc'] };
      else if (sys === 'T') value = { summary: 'tested', testFilesChanged: ['x.test.al'], commits: ['def'] };
      else if (sys === 'F') value = { summary: 'fixed', filesChanged: ['x.al'], commits: ['fix'] };
      else if (sys.startsWith('R\n\n')) value = { findings: [] };
      else value = {};
      return { value: value as T, costUsd: 0.1, toolUsage: { Edit: 1 }, usage: TEST_USAGE };
    },
  };
}

function makeHarness(opts: {
  cli: ContiniaCli;
  stateDir: string;
  taggedIds?: number[];
}) {
  const ado = makeAdo(opts.taggedIds ?? [101]);
  const worktreeManager = makeWorktreeManager();
  const runner = makeRunner();
  const config = { ...baseConfig, stateDir: opts.stateDir };
  const store = new PipelineStateStore(opts.stateDir);
  const buildPipelineForTest = (deps: PipelineBuilderDeps) =>
    buildPipeline({
      ...deps,
      runner,
      worktreeManager,
      continiaCli: opts.cli,
      discoveredSkills: [],
      analyzerPromptTemplate: 'A',
      coderPromptTemplate: 'C',
      testAuthorPromptTemplate: 'T',
      testFixerPromptTemplate: 'F',
      reviewerSharedPromptTemplate: 'R',
      reviewerAxisPromptTemplates: Object.fromEntries(
        REVIEW_AXES.map((a) => [a, a]),
      ) as Record<typeof REVIEW_AXES[number], string>,
      prDescriptionTemplate: 'PR for {{wi-id}} on {{environment-id}} at {{environment-url}}',
      pushBranch: mock(async () => {}),
      getCurrentHeadSha: async () => sampleWorktree.baseSha,
      resetWorktree: async () => {},
      discoverTestCodeunits: greenCodeunits,
    });
  const processor = createProcessor({
    config,
    logger: createLogger(),
    ado,
    store,
    buildPipeline: buildPipelineForTest,
    abortFlag: createAbortFlag(),
  });
  return { ado, worktreeManager, runner, config, store, processor };
}

describe('verification e2e (Plan 10 full pipeline)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'verification-e2e-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('scenario 1: green path — env provisioned, deploy+tests pass, PR description carries the env link', async () => {
    const cli = makeGreenContiniaCli();
    const { ado, processor, store, worktreeManager } = makeHarness({ cli, stateDir: dir });

    const outcome = await processor.processWorkItem(101);
    expect(outcome.kind).toBe('completed');

    // Env was created + started, never torn down (no delete method even exists).
    expect((cli.createEnvironment as ReturnType<typeof mock>)).toHaveBeenCalledTimes(1);
    expect((cli.startEnvironment as ReturnType<typeof mock>)).toHaveBeenCalledTimes(1);

    // PR was created with the environment link substituted.
    const createPr = ado.createPullRequest as ReturnType<typeof mock>;
    expect(createPr).toHaveBeenCalledTimes(1);
    const prArgs = createPr.mock.calls[0]?.[0] as { description: string };
    expect(prArgs.description).toContain('env-9');
    expect(prArgs.description).toContain('https://bc/env-9');

    // State captures environment + green verification; worktree torn down on success.
    const state = store.load(101)!;
    expect(state.outputs.environment).toMatchObject({ envId: 'env-9' });
    expect((state.outputs.verification as VerificationOutput)).toMatchObject({ passed: true, attempts: 0 });
    expect(worktreeManager.removeWorktree as ReturnType<typeof mock>).toHaveBeenCalledTimes(1);
  });

  it('scenario 2: red then fixed — exactly one fix call, then PR created', async () => {
    const cli = makeGreenContiniaCli();
    const testResults = [redRun, greenRun];
    (cli.runTests as unknown) = mock(async () =>
      testResults.length > 1 ? testResults.shift()! : testResults[0]!,
    );
    const { ado, processor, runner, store } = makeHarness({ cli, stateDir: dir });

    const outcome = await processor.processWorkItem(101);
    expect(outcome.kind).toBe('completed');

    // The in-loop verify gate runs every revision round, before the reviewer,
    // and reaches `runTests` first — so it is the one that sees the red run
    // and fixes it, not build-and-test's final gate.
    const fixCalls = runner.calls.filter((c) => c.systemPromptAppend === 'F');
    expect(fixCalls).toHaveLength(1);
    expect(fixCalls[0]?.prompt).toContain('RedTest');

    expect(ado.createPullRequest as ReturnType<typeof mock>).toHaveBeenCalledTimes(1);
    const state = store.load(101)!;
    // By the time build-and-test's final gate re-verifies, the environment is
    // already green (fixed in-loop), so its own round needs no further fix —
    // attempts: 0 describes THAT round, not the one the verify gate fixed.
    expect((state.outputs.verification as VerificationOutput)).toMatchObject({ passed: true, attempts: 0 });
  });

  it('scenario 3: red after all fix attempts — failed outcome, comment with failure, blocked tag, no PR, worktree retained', async () => {
    const cli = makeGreenContiniaCli();
    (cli.runTests as unknown) = mock(async () => redRun); // red forever
    const { ado, processor, runner, store, worktreeManager, config } = makeHarness({ cli, stateDir: dir });

    const outcome = await processor.processWorkItem(101);
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(outcome.error.message).toMatch(/verification failed/);
    }

    // Both gates make their own bounded fix attempts against the same
    // always-red mock: the in-loop verify gate makes its own (1, its
    // `maxInLoopFixAttempts` default) every revision round before letting the
    // reviewer judge the round regardless, then build-and-test's final gate
    // makes its own `maxTestFixAttempts` before declaring the WI failed. The
    // total is the sum of the two budgets, not just the final gate's.
    const fixCalls = runner.calls.filter((c) => c.systemPromptAppend === 'F');
    expect(fixCalls).toHaveLength(1 + config.maxTestFixAttempts);

    // WI comment carries the failing test + stack fragment; blocked tag added.
    const addComment = ado.addWorkItemComment as ReturnType<typeof mock>;
    expect(addComment).toHaveBeenCalledTimes(1);
    const html = addComment.mock.calls[0]?.[1] as string;
    expect(html).toContain('RedTest');
    expect(html).toContain('Codeunit 70001');
    expect(ado.addTagToWorkItem as ReturnType<typeof mock>).toHaveBeenCalledWith(101, 'agent-blocked');

    // No PR, worktree retained for inspection.
    expect(ado.createPullRequest as ReturnType<typeof mock>).not.toHaveBeenCalled();
    expect(worktreeManager.removeWorktree as ReturnType<typeof mock>).not.toHaveBeenCalled();

    const state = store.load(101)!;
    expect((state.outputs.verification as VerificationOutput).passed).toBe(false);
  });

  it('scenario 3b: same red-exhausted flow via a full poll cycle counts one failed WI', async () => {
    const cli = makeGreenContiniaCli();
    (cli.runTests as unknown) = mock(async () => redRun);
    const { ado, processor, config } = makeHarness({ cli, stateDir: dir });
    const store = new PipelineStateStore(dir);

    const stats = await runPollCycle({
      config,
      logger: createLogger(),
      ado,
      store,
      processor,
      abortFlag: createAbortFlag(),
    });
    expect(stats.failed).toBe(1);
    expect(stats.completed).toBe(0);
  });
});
