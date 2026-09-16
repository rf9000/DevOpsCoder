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
import { AzureDevOpsError } from '../../src/sdk/azure-devops-client.ts';
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
  coderMaxTurns: 80,
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

function makeAdo(
  taggedIds: number[],
  createPrImpl?: (args: unknown) => Promise<{ id: number; url: string; sourceRefName: string; targetRefName: string }>,
): AdoClient {
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
    createPullRequest: mock(
      createPrImpl ??
        (async () => ({
          id: 1,
          url: 'https://example.com/pr/1',
          sourceRefName: '',
          targetRefName: '',
        })),
    ),
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
  pushBranch: ((branch: string, cwd: string) => Promise<void>) | undefined = async () => {},
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
      getCurrentHeadSha: async () => sampleWorktree.baseSha,
      resetWorktree: async () => {},
      prDescriptionTemplate: 'D',
      prMessagePromptTemplate: 'P',
      pushBranch,
    });
}

describe('PR e2e (Plan 5 full pipeline)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pr-e2e-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('scenario 1: happy path — analyzer→coder→reviewer approves→test-author→draft PR→teardown', async () => {
    const config = { ...baseConfig, stateDir: dir };
    const store = new PipelineStateStore(dir);

    const adoCreatePr = mock(async (args: { repositoryName: string; sourceRefName: string; targetRefName: string; title: string; description: string; isDraft: boolean }) => ({
      id: 42,
      url: 'https://example.com/pr/42',
      sourceRefName: args.sourceRefName,
      targetRefName: args.targetRefName,
    }));
    const ado = makeAdo([101], adoCreatePr as unknown as (args: unknown) => Promise<{ id: number; url: string; sourceRefName: string; targetRefName: string }>);

    const pushBranch = mock(async (_branch: string, _cwd: string) => {});

    const runner = makeStagedRunner((args) => {
      const sys = args.systemPromptAppend ?? '';
      if (sys === 'A') return { verdict: 'proceed', summary: 'go', reasons: [] };
      if (sys === 'C') return { summary: 'coded', filesChanged: ['x.ts'], commits: ['abc'] };
      if (sys === 'T') return { summary: 'tested', testFilesChanged: ['x.test.ts'], commits: ['def'] };
      if (sys.startsWith('R\n\n')) return { findings: [] };
      if (sys === 'P') return { title: 'Fix the login button handler', bullets: ['Fixed the login button handler', 'Added tests for the login button'] };
      throw new Error(`unexpected stage prompt: ${sys}`);
    });

    const worktreeManager = makeWorktreeManager();
    const abortFlag = createAbortFlag();
    const processor = createProcessor({
      config,
      logger: createLogger(),
      ado,
      store,
      buildPipeline: makeBuildPipelineWrapper(runner, worktreeManager, pushBranch),
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

    // Watcher stats
    expect(stats.completed).toBe(1);
    expect(stats.failed).toBe(0);

    // State assertions
    const saved = store.load(101)!;
    expect(saved.completedAt).toBeTruthy();
    expect(saved.outputs.reviewer).toMatchObject({ approved: true, findings: [], attempts: 1 });

    // Draft PR was created with correct params
    expect(adoCreatePr).toHaveBeenCalledTimes(1);
    const prArgs = adoCreatePr.mock.calls[0]?.[0] as { repositoryName: string; sourceRefName: string; targetRefName: string; title: string; isDraft: boolean } | undefined;
    expect(prArgs?.repositoryName).toBe('test-repo');
    expect(prArgs?.sourceRefName).toBe('refs/heads/agent/wi-101-fix-login');
    expect(prArgs?.targetRefName).toBe('refs/heads/main');
    // Title comes from the pr-message step, not the WI title (that is the last fallback).
    expect(prArgs?.title).toBe('Fix the login button handler');
    expect(prArgs?.isDraft).toBe(true);

    // pushBranch called with branch + worktree path
    expect(pushBranch).toHaveBeenCalledTimes(1);
    const pushArgs = pushBranch.mock.calls[0] as [string, string] | undefined;
    expect(pushArgs?.[0]).toBe('agent/wi-101-fix-login');
    expect(pushArgs?.[1]).toBe('/repos/.worktrees/wi-101-fix-login');

    // Worktree removed after success
    expect(worktreeManager.removeWorktree).toHaveBeenCalledTimes(1);

    // draftPr stored in state
    expect(saved.outputs.draftPr).toMatchObject({
      id: 42,
      url: 'https://example.com/pr/42',
      branch: sampleWorktree.branch,
    });
    expect(typeof (saved.outputs.draftPr as { createdAt: string }).createdAt).toBe('string');

    // Runner call count: 1 analyzer + 1 coder + 6 axes + 1 test-author + 1 pr-message = 10
    expect(runner.calls).toHaveLength(10);
  });

  it('scenario 2: revisionLoop iterates — reviewer rejects attempt 1, approves attempt 2', async () => {

    const config = { ...baseConfig, stateDir: dir };
    const store = new PipelineStateStore(dir);

    // Count how many reviewer-axis calls have been made (6 per attempt).
    let reviewerAxisCallCount = 0;

    const runner = makeStagedRunner((args) => {
      const sys = args.systemPromptAppend ?? '';
      if (sys === 'A') return { verdict: 'proceed', summary: 'go', reasons: [] };
      if (sys === 'C') return { summary: 'coded', filesChanged: ['x.ts'], commits: ['abc'] };
      if (sys === 'T') return { summary: 'tested', testFilesChanged: ['x.test.ts'], commits: ['def'] };
      if (sys.startsWith('R\n\n')) {
        reviewerAxisCallCount++;
        // Attempt 1 = calls 1–6: first call returns a blocking finding, rest clean
        if (reviewerAxisCallCount === 1) {
          return {
            findings: [
              {
                severity: 'blocking',
                file: 'src/auth.ts',
                line: 42,
                title: 'null dereference',
                description: 'login may crash',
                axis: 'safety-correctness',
              },
            ],
          };
        }
        // All other axis calls (2–6 for attempt 1, 7–12 for attempt 2): no findings
        return { findings: [] };
      }
      if (sys === 'P') return { title: 'Fix the login button handler', bullets: ['Fixed the login button handler', 'Added tests for the login button'] };
      throw new Error(`unexpected stage prompt: ${sys}`);
    });

    const adoCreatePr = mock(async () => ({
      id: 42,
      url: 'https://example.com/pr/42',
      sourceRefName: 'refs/heads/agent/wi-101-fix-login',
      targetRefName: 'refs/heads/main',
    }));
    const ado = makeAdo([101], adoCreatePr as unknown as (args: unknown) => Promise<{ id: number; url: string; sourceRefName: string; targetRefName: string }>);

    const worktreeManager = makeWorktreeManager();
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

    // Full pipeline completes
    expect(stats.completed).toBe(1);
    expect(stats.failed).toBe(0);

    const saved = store.load(101)!;
    expect(saved.completedAt).toBeTruthy();
    expect(saved.outputs.draftPr).toBeDefined();

    // Reviewer approved on attempt 2
    expect((saved.outputs.reviewer as { attempts: number }).attempts).toBe(2);

    // Coder was called twice (once per revision attempt)
    const coderCalls = runner.calls.filter((c) => c.systemPromptAppend === 'C');
    expect(coderCalls).toHaveLength(2);

    // Second coder call's prompt must include "Previous reviewer findings"
    const secondCoderCall = coderCalls[1];
    expect(secondCoderCall?.prompt).toContain('Previous reviewer findings');

    // Total runner calls: 1 analyzer + (1 coder + 6 axes) × 2 + 1 test-author + 1 pr-message = 17
    expect(runner.calls).toHaveLength(17);

    // Worktree torn down after success
    expect(worktreeManager.removeWorktree).toHaveBeenCalledTimes(1);
  });

  it('scenario 3: revisionLoop exhausts — reviewer rejects all 3 attempts → blocked tag, no PR, worktree retained', async () => {

    const config = { ...baseConfig, stateDir: dir };
    const store = new PipelineStateStore(dir);

    // All reviewer axis calls return a blocking finding — no attempts pass.
    const runner = makeStagedRunner((args) => {
      const sys = args.systemPromptAppend ?? '';
      if (sys === 'A') return { verdict: 'proceed', summary: 'go', reasons: [] };
      if (sys === 'C') return { summary: 'coded', filesChanged: ['x.ts'], commits: ['abc'] };
      if (sys.startsWith('R\n\n')) {
        return {
          findings: [
            {
              severity: 'blocking',
              file: 'src/auth.ts',
              title: 'null dereference',
              description: 'crash on login',
              axis: sys.replace('R\n\n', ''),
            },
          ],
        };
      }
      if (sys === 'P') return { title: 'Fix the login button handler', bullets: ['Fixed the login button handler', 'Added tests for the login button'] };
      throw new Error(`unexpected stage prompt: ${sys}`);
    });

    const adoCreatePr = mock(async () => ({
      id: 1,
      url: 'https://example.com/pr/1',
      sourceRefName: '',
      targetRefName: '',
    }));
    const ado = makeAdo([101], adoCreatePr as unknown as (args: unknown) => Promise<{ id: number; url: string; sourceRefName: string; targetRefName: string }>);

    const pushBranch = mock(async (_branch: string, _cwd: string) => {});
    const worktreeManager = makeWorktreeManager();
    const abortFlag = createAbortFlag();
    const processor = createProcessor({
      config,
      logger: createLogger(),
      ado,
      store,
      buildPipeline: makeBuildPipelineWrapper(runner, worktreeManager, pushBranch),
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

    // Pipeline fails after exhausting revision loop
    expect(stats.failed).toBe(1);
    expect(stats.completed).toBe(0);

    // WI comment posted with reviewer findings HTML
    expect(ado.addWorkItemComment).toHaveBeenCalledTimes(1);
    const commentHtml = (ado.addWorkItemComment as ReturnType<typeof mock>).mock.calls[0]?.[1] as string | undefined;
    expect(commentHtml).toBeDefined();
    // The rendered HTML should contain the word "blocking" from the findings section
    expect(commentHtml).toContain('blocking');

    // Blocked tag added
    expect(ado.addTagToWorkItem).toHaveBeenCalledTimes(1);
    const tagArgs = (ado.addTagToWorkItem as ReturnType<typeof mock>).mock.calls[0] as [number, string] | undefined;
    expect(tagArgs?.[1]).toBe('agent-blocked');

    // No PR created
    expect(adoCreatePr.mock.calls).toHaveLength(0);

    // Branch NOT pushed (draft-pr-creator never ran)
    expect(pushBranch.mock.calls).toHaveLength(0);

    // Worktree intentionally retained — removeWorktree must NOT be called
    expect(worktreeManager.removeWorktree).not.toHaveBeenCalled();
  });

  it('scenario 4: PR creation fails — branch pushed but createPullRequest throws → blocked tag, worktree retained', async () => {

    const config = { ...baseConfig, stateDir: dir };
    const store = new PipelineStateStore(dir);

    const runner = makeStagedRunner((args) => {
      const sys = args.systemPromptAppend ?? '';
      if (sys === 'A') return { verdict: 'proceed', summary: 'go', reasons: [] };
      if (sys === 'C') return { summary: 'coded', filesChanged: ['x.ts'], commits: ['abc'] };
      if (sys === 'T') return { summary: 'tested', testFilesChanged: ['x.test.ts'], commits: ['def'] };
      if (sys.startsWith('R\n\n')) return { findings: [] };
      if (sys === 'P') return { title: 'Fix the login button handler', bullets: ['Fixed the login button handler', 'Added tests for the login button'] };
      throw new Error(`unexpected stage prompt: ${sys}`);
    });

    const adoCreatePr = mock(async () => {
      throw new AzureDevOpsError('Conflict: PR already exists', 409);
    });
    const ado = makeAdo([101], adoCreatePr as unknown as (args: unknown) => Promise<{ id: number; url: string; sourceRefName: string; targetRefName: string }>);

    const pushBranch = mock(async (_branch: string, _cwd: string) => {});
    const worktreeManager = makeWorktreeManager();
    const abortFlag = createAbortFlag();
    const processor = createProcessor({
      config,
      logger: createLogger(),
      ado,
      store,
      buildPipeline: makeBuildPipelineWrapper(runner, worktreeManager, pushBranch),
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

    // Pipeline fails because createPullRequest threw
    expect(stats.failed).toBe(1);
    expect(stats.completed).toBe(0);

    // Blocked tag added
    expect(ado.addTagToWorkItem).toHaveBeenCalledTimes(1);
    const tagArgs = (ado.addTagToWorkItem as ReturnType<typeof mock>).mock.calls[0] as [number, string] | undefined;
    expect(tagArgs?.[1]).toBe('agent-blocked');

    // pushBranch WAS called (push happened before createPullRequest)
    expect(pushBranch).toHaveBeenCalledTimes(1);

    // Worktree NOT torn down — retained for inspection
    expect(worktreeManager.removeWorktree).not.toHaveBeenCalled();
  });
});
