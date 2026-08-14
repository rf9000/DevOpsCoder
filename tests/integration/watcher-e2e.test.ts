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
import type { AdoClient } from '../../src/sdk/azure-devops-client.ts';
import type { AppConfig } from '../../src/types/index.ts';
import type { AgentRunArgs, AgentRunner, AgentRunResult } from '../../src/pipeline/agent-stage.ts';
import type { PipelineBuilderDeps } from '../../src/services/pipeline-builder.ts';

const baseConfig: AppConfig = {
  orgUrl: 'https://x',
  project: 'p',
  pat: 'pat',
  repositoryName: 'test-repo',
  targetRepoPath: '/r',
  worktreeBase: '/w',
  triggerTag: 'agent implement',
  blockedTag: 'agent-blocked',
  needInputTag: 'need-input',
  pollIntervalMinutes: 5,
  concurrency: 2,
  maxRevisions: 3,
  maxRejectCycles: 3,
  coderMaxTurns: 80,
  testAuthorMaxTurns: 50,
  maxCostUsdPerWi: 5.00,
  stageTimeoutMs: {},
  claudeModel: 'claude-opus-4-7',
  stateDir: '',
  assignedToFilter: [],
  continiaCliPath: '.tools/continia.exe', continiaEnvProfileId: 'prof-1', continiaApiToken: 'tok', continiaAppPaths: ['App'], continiaTestAppPaths: ['App'], maxTestFixAttempts: 2, continiaTestTimeoutS: 600, dryRun: false, skipBuildTest: false,
};

function makeRecordingRunner(): AgentRunner {
  let callIndex = 0;
  return {
    async run<T>(args: AgentRunArgs<T>): Promise<AgentRunResult<T>> {
      void args;
      const i = callIndex++;
      // call 0 = analyzer, call 1 = coder, calls 2-7 = 6 reviewer axes, call 8 = test-author
      let value: unknown;
      if (i === 0) value = { verdict: 'proceed', summary: 'ok', reasons: [] };
      else if (i === 1) value = { summary: 'ok', filesChanged: [], commits: [] };
      else if (i >= 2 && i <= 7) value = { findings: [] };
      else value = { summary: 'ok', testFilesChanged: [], commits: [] };
      return { value: value as unknown as T, costUsd: 0, toolUsage: {} };
    },
  };
}

/** Wraps buildPipeline with test-safe overrides so no real SDK binary is invoked. */
function buildPipelineForTest(deps: PipelineBuilderDeps) {
  return buildPipeline({
    ...deps,
    runner: makeRecordingRunner(),
    continiaCli: makeGreenContiniaCli(),
    testFixerPromptTemplate: 'F',
    discoverTestCodeunits: greenCodeunits,
    worktreeManager: {
      ensureWorktree: async () => ({ path: '/tmp/wt', branch: 'agent/test', baseSha: 'sha' }),
      removeWorktree: async () => {},
    },
    discoveredSkills: [],
    analyzerPromptTemplate: 'test-prompt',
    coderPromptTemplate: 'test-coder-prompt',
    testAuthorPromptTemplate: 'test-test-author-prompt',
    reviewerSharedPromptTemplate: 'R',
    reviewerAxisPromptTemplates: Object.fromEntries(
      REVIEW_AXES.map((a) => [a, a]),
    ) as Record<typeof REVIEW_AXES[number], string>,
    getCurrentHeadSha: async () => 'deadbeef',
    resetWorktree: async () => {},
    // Stub draft-PR creator so tests don't git-push or read the prompt file:
    prDescriptionTemplate: 'D',
    pushBranch: async () => {},
  });
}

function makeAdo(taggedIds: number[]): AdoClient {
  return {
    queryWorkItemsByTag: mock(async () => taggedIds),
    getWorkItem: mock(async (id: number) => ({
      id,
      fields: {
        'System.Title': `WI ${id}`,
        'System.State': 'Active',
        'System.Tags': 'agent implement',
      },
    })),
    getWorkItemComments: mock(async () => []),
    addTagToWorkItem: mock(async () => {}),
    removeTagFromWorkItem: mock(async () => {}),
    addWorkItemComment: mock(async () => {}),
    createPullRequest: mock(async () => ({ id: 0, url: '', sourceRefName: '', targetRefName: '' })),
  };
}

describe('watcher end-to-end (empty pipeline)', () => {
  let dir: string;
  let store: PipelineStateStore;
  let config: AppConfig;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'watcher-e2e-'));
    config = { ...baseConfig, stateDir: dir };
    store = new PipelineStateStore(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('completes every tagged WI and removes the trigger tag', async () => {
    const ado = makeAdo([201, 202]);
    const abortFlag = createAbortFlag();
    const processor = createProcessor({
      config,
      logger: createLogger(),
      ado,
      store,
      buildPipeline: buildPipelineForTest,
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

    expect(stats).toEqual({
      considered: 2,
      completed: 2,
      paused: 0,
      failed: 0,
      skipped: 0,
      rejected: 0,
    });
    expect(store.load(201)?.completedAt).toBeTruthy();
    expect(store.load(202)?.completedAt).toBeTruthy();
    expect(ado.removeTagFromWorkItem).toHaveBeenCalledTimes(2);
  });

  it('processes a resumable WI even when no tagged WIs are returned', async () => {
    store.save({
      workItemId: 777,
      slug: 'resume',
      startedAt: '2026-05-01T00:00:00Z',
      updatedAt: '2026-05-01T00:00:00Z',
      currentStage: null,
      history: [],
      outputs: {},
    });
    const ado = makeAdo([]);
    const abortFlag = createAbortFlag();
    const processor = createProcessor({
      config,
      logger: createLogger(),
      ado,
      store,
      buildPipeline: buildPipelineForTest,
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

    expect(stats.considered).toBe(1);
    expect(stats.completed).toBe(1);
    expect(store.load(777)?.completedAt).toBeTruthy();
  });

  it('does not touch ADO tags when dryRun=true but still completes pipelines', async () => {
    const ado = makeAdo([301]);
    const abortFlag = createAbortFlag();
    const dryConfig = { ...config, dryRun: true };
    const processor = createProcessor({
      config: dryConfig,
      logger: createLogger(),
      ado,
      store,
      buildPipeline: buildPipelineForTest,
      abortFlag,
    });

    const stats = await runPollCycle({
      config: dryConfig,
      logger: createLogger(),
      ado,
      store,
      processor,
      abortFlag,
    });

    expect(stats.completed).toBe(1);
    expect(ado.removeTagFromWorkItem).not.toHaveBeenCalled();
    expect(ado.addTagToWorkItem).not.toHaveBeenCalled();
    expect(store.load(301)?.completedAt).toBeTruthy();
  });
});
