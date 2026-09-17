import { makeGreenContiniaCli, greenCodeunits } from './_continia-fake.ts';
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
import { AgentOutputParseError } from '../../src/services/claude-agent-runner.ts';
import type { AdoClient } from '../../src/sdk/azure-devops-client.ts';
import type { AppConfig, WorktreeContext } from '../../src/types/index.ts';
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
  continiaCliPath: '.tools/continia.exe', continiaEnvProfileId: 'prof-1', continiaEnvLocalization: 'base', continiaApiToken: 'tok', continiaAppPaths: ['App'], continiaTestAppPaths: ['App'], maxTestFixAttempts: 2, continiaTestTimeoutS: 600, dryRun: false, skipBuildTest: false, testSelection: 'all', maxTestCodeunits: 0, costLogPath: '.state/cost-ledger.jsonl',
};

const sampleWorktree: WorktreeContext = {
  path: '/repos/.worktrees/wi-101-fix-login',
  branch: 'agent/wi-101-fix-login',
  baseSha: 'baselinesha123',
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
    createPullRequest: mock(async () => ({ id: 1, url: 'https://example.com/pr/1', sourceRefName: '', targetRefName: '' })),
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

function makeStagedRunner(
  responder: (args: AgentRunArgs<unknown>, callIndex: number) => unknown,
): RecordingRunner {
  const calls: AgentRunArgs<unknown>[] = [];
  let i = 0;
  return {
    calls,
    async run<T>(args: AgentRunArgs<T>): Promise<AgentRunResult<T>> {
      calls.push(args as AgentRunArgs<unknown>);
      const out = responder(args as AgentRunArgs<unknown>, i++);
      const value = out instanceof Promise ? ((await out) as unknown as T) : (out as unknown as T);
      return { value, costUsd: 0, toolUsage: {}, usage: TEST_USAGE };
    },
  };
}

function makeBuildPipelineWrapper(
  runner: AgentRunner,
  worktreeManager: WorktreeManager,
) {
  return (deps: PipelineBuilderDeps) =>
    buildPipeline({
      ...deps,
      runner,
      continiaCli: makeGreenContiniaCli(),
      testFixerPromptTemplate: 'F',
      discoverTestCodeunits: greenCodeunits,
      worktreeManager,
      discoveredSkills: [],
      analyzerPromptTemplate: 'A',
      coderPromptTemplate: 'C',
      testAuthorPromptTemplate: 'T',
      reviewerSharedPromptTemplate: 'R',
      reviewerAxisPromptTemplates: Object.fromEntries(
        REVIEW_AXES.map((a) => [a, a]),
      ) as Record<typeof REVIEW_AXES[number], string>,
      // Stub the git operations the coder/test-author would otherwise spawn:
      getCurrentHeadSha: async () => sampleWorktree.baseSha,
      resetWorktree: async () => {},
      // Stub draft-PR creator so tests don't git-push or read the prompt file:
      prDescriptionTemplate: 'D',
      prMessagePromptTemplate: 'P',
      pushBranch: async () => {},
    });
}

describe('Plan 4 end-to-end (coder + test-author pipeline)', () => {
  let dir: string;
  let store: PipelineStateStore;
  let config: AppConfig;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'coder-e2e-'));
    config = { ...baseConfig, stateDir: dir };
    store = new PipelineStateStore(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('happy path: analyzer→worktree→coder→reviewer→test-author → completed', async () => {
    const runner = makeStagedRunner((args) => {
      const sys = args.systemPromptAppend ?? '';
      if (sys === 'A') return { verdict: 'proceed', summary: 'ready', reasons: [] };
      if (sys === 'C') return { summary: 'coded', filesChanged: ['x.ts'], commits: ['abc'] };
      if (sys === 'T') return { summary: 'tested', testFilesChanged: ['x.test.ts'], commits: ['def'] };
      if (sys.startsWith('R\n\n')) return { findings: [] };
      if (sys === 'P') return { title: 'Fix the login button handler', bullets: ['Fixed the login button handler', 'Added tests for the login button'] };
      throw new Error(`unexpected stage prompt: ${sys}`);
    });
    const worktreeManager = makeWorktreeManager();
    const ado = makeAdo([201]);
    const abortFlag = createAbortFlag();
    const processor = createProcessor({
      config,
      logger: createLogger(),
      ado,
      store,
      buildPipeline: makeBuildPipelineWrapper(runner, worktreeManager),
      abortFlag,
    });

    const stats = await runPollCycle({
      config,
      logger: createLogger(),
      ado,
      store,
      processor,
      abortFlag,
    });

    expect(stats.completed).toBe(1);
    expect(stats.rejected).toBe(0);
    expect(stats.failed).toBe(0);

    const saved = store.load(201)!;
    expect(saved.completedAt).toBeTruthy();
    expect(saved.outputs.analyzer).toBeDefined();
    expect(saved.outputs.worktree).toEqual(sampleWorktree);
    expect(saved.outputs.coder).toEqual({
      summary: 'coded',
      filesChanged: ['x.ts'],
      commits: ['abc'],
    });
    expect(saved.outputs.reviewer).toEqual({ approved: true, findings: [], attempts: 1 });
    expect(saved.outputs.testAuthor).toEqual({
      summary: 'tested',
      testFilesChanged: ['x.test.ts'],
      commits: ['def'],
    });

    expect(ado.removeTagFromWorkItem).toHaveBeenCalledWith(201, 'agent implement');
    expect(worktreeManager.ensureWorktree).toHaveBeenCalled();
    expect(worktreeManager.removeWorktree).toHaveBeenCalledTimes(1);
    expect(saved.outputs.draftPr).toMatchObject({ id: 1, url: 'https://example.com/pr/1', branch: sampleWorktree.branch });
    // Runner: analyzer (1) + coder (1) + 6 reviewer axes + test-author (1) + pr-message (1) = 10.
    expect(runner.calls).toHaveLength(10);
  });

  it('coder retries on AgentOutputParseError (transient), eventually succeeds', async () => {
    let coderAttempt = 0;
    const runner = makeStagedRunner((args) => {
      const sys = args.systemPromptAppend ?? '';
      if (sys === 'A') return { verdict: 'proceed', summary: 'ready', reasons: [] };
      if (sys === 'C') {
        coderAttempt++;
        if (coderAttempt <= 2) {
          throw new AgentOutputParseError('raw', 'bad json');
        }
        return { summary: 'coded after retries', filesChanged: ['x.ts'], commits: ['abc'] };
      }
      if (sys === 'T') return { summary: 'tested', testFilesChanged: ['x.test.ts'], commits: ['def'] };
      if (sys.startsWith('R\n\n')) return { findings: [] };
      throw new Error(`unexpected: ${sys}`);
    });
    const worktreeManager = makeWorktreeManager();
    const ado = makeAdo([202]);
    const abortFlag = createAbortFlag();
    const processor = createProcessor({
      config,
      logger: createLogger(),
      ado,
      store,
      buildPipeline: makeBuildPipelineWrapper(runner, worktreeManager),
      abortFlag,
    });

    const stats = await runPollCycle({
      config,
      logger: createLogger(),
      ado,
      store,
      processor,
      abortFlag,
    });

    expect(stats.completed).toBe(1);
    expect(stats.failed).toBe(0);

    const saved = store.load(202)!;
    expect(saved.outputs.coder).toEqual({
      summary: 'coded after retries',
      filesChanged: ['x.ts'],
      commits: ['abc'],
    });
    expect(saved.completedAt).toBeTruthy();
    // Total runner calls: analyzer (1) + coder (3 attempts: 2 fail + 1 success) + 6 reviewer axes + test-author (1) + pr-message (1) = 12
    expect(runner.calls).toHaveLength(12);
  });

  it('coder fails terminally (hard error) → terminal failure + blockedTag added', async () => {
    const runner = makeStagedRunner((args) => {
      const sys = args.systemPromptAppend ?? '';
      if (sys === 'A') return { verdict: 'proceed', summary: 'ready', reasons: [] };
      if (sys === 'C') {
        throw new Error('hard error: network down');
      }
      throw new Error(`unexpected: ${sys}`);
    });
    const worktreeManager = makeWorktreeManager();
    const ado = makeAdo([203]);
    const abortFlag = createAbortFlag();
    const processor = createProcessor({
      config,
      logger: createLogger(),
      ado,
      store,
      buildPipeline: makeBuildPipelineWrapper(runner, worktreeManager),
      abortFlag,
    });

    const stats = await runPollCycle({
      config,
      logger: createLogger(),
      ado,
      store,
      processor,
      abortFlag,
    });

    expect(stats.completed).toBe(0);
    expect(stats.failed).toBe(1);

    const saved = store.load(203)!;
    expect(saved.terminalError).toBeDefined();
    expect(saved.terminalError?.message).toContain('hard error');
    expect(saved.completedAt).toBeUndefined();

    expect(ado.addTagToWorkItem).toHaveBeenCalledWith(203, 'agent-blocked');
    // Blocking also un-triggers, so the next poll cycle does not re-run (and
    // re-charge for) the pipeline. Retry is a deliberate human re-tag.
    expect(ado.removeTagFromWorkItem).toHaveBeenCalledWith(203, config.triggerTag);
    // Hard error: 1 analyzer + 1 coder attempt (no retry) = 2; no test-author
    expect(runner.calls).toHaveLength(2);
  });
});
