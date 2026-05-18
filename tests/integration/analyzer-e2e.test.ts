import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { runPollCycle, createAbortFlag } from '../../src/services/watcher.ts';
import { createProcessor } from '../../src/services/processor.ts';
import { buildPipeline } from '../../src/services/pipeline-builder.ts';
import { PipelineStateStore } from '../../src/state/state-store.ts';
import { createLogger } from '../../src/utils/logger.ts';
import type { AdoClient } from '../../src/sdk/azure-devops-client.ts';
import type { AppConfig } from '../../src/types/index.ts';
import type {
  AgentRunArgs,
  AgentRunner,
} from '../../src/pipeline/agent-stage.ts';
import type {
  PipelineBuilderDeps,
} from '../../src/services/pipeline-builder.ts';

const baseConfig: AppConfig = {
  org: 'o',
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
  claudeModel: 'claude-opus-4-7',
  stateDir: '',
  assignedToFilter: [],
  dryRun: false,
};

function makeAdo(tagged: number[]): AdoClient {
  return {
    queryWorkItemsByTag: mock(async () => tagged),
    getWorkItem: mock(async (id: number) => ({
      id,
      fields: {
        'System.Title': `WI ${id}`,
        'System.State': 'Active',
        'System.Tags': 'agent implement',
        'System.WorkItemType': 'Bug',
        'System.Description': '<p>Some description</p>',
      },
    })),
    getWorkItemComments: mock(async () => []),
    addTagToWorkItem: mock(async () => {}),
    removeTagFromWorkItem: mock(async () => {}),
    addWorkItemComment: mock(async () => {}),
    createPullRequest: mock(async () => ({ id: 0, url: '', sourceRefName: '', targetRefName: '' })),
  };
}

interface RecordingRunner extends AgentRunner {
  calls: AgentRunArgs<unknown>[];
}

function makeRunner(
  out: (call: number) => Promise<unknown>,
): RecordingRunner {
  const calls: AgentRunArgs<unknown>[] = [];
  let i = 0;
  return {
    calls,
    async run<T>(args: AgentRunArgs<T>): Promise<T> {
      calls.push(args as AgentRunArgs<unknown>);
      const result = await out(i++);
      return result as unknown as T;
    },
  };
}

function makeBuildPipeline(runner: AgentRunner) {
  return (deps: PipelineBuilderDeps) =>
    buildPipeline({
      ...deps,
      runner,
      worktreeManager: {
        ensureWorktree: async () => ({ path: '/tmp/wt', branch: 'agent/test', baseSha: 'sha' }),
        removeWorktree: async () => {},
      },
      discoveredSkills: [],
      analyzerPromptTemplate: 'analyzer prompt body for test',
      coderPromptTemplate: 'coder prompt body for test',
      testAuthorPromptTemplate: 'test-author prompt body for test',
      getCurrentHeadSha: async () => 'deadbeef',
      resetWorktree: async () => {},
    });
}

describe('analyzer end-to-end (reject lifecycle)', () => {
  let dir: string;
  let store: PipelineStateStore;
  let config: AppConfig;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'analyzer-e2e-'));
    config = { ...baseConfig, stateDir: dir };
    store = new PipelineStateStore(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('cycle 1: analyzer rejects a fresh WI → reject outcome with rejectCount=1, need-input tag added', async () => {
    const ado = makeAdo([301]);
    const runner = makeRunner(async () => ({
      verdict: 'reject',
      summary: 'WI is too vague',
      reasons: ['no acceptance criteria', 'no design'],
      questions: ['What is the expected UI?'],
    }));
    const abortFlag = createAbortFlag();
    const processor = createProcessor({
      config,
      logger: createLogger(),
      ado,
      store,
      buildPipeline: makeBuildPipeline(runner),
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
    expect(stats.rejected).toBe(1);
    expect(stats.completed).toBe(0);

    const saved = store.load(301)!;
    expect(saved.rejectCount).toBe(1);
    expect(saved.rejection?.summary).toBe('WI is too vague');
    expect(saved.rejection?.reasons).toEqual([
      'no acceptance criteria',
      'no design',
    ]);
    expect(saved.completedAt).toBeUndefined();

    expect(ado.addWorkItemComment).toHaveBeenCalledTimes(1);
    expect(ado.removeTagFromWorkItem).toHaveBeenCalledWith(301, 'agent implement');
    expect(ado.addTagToWorkItem).toHaveBeenCalledWith(301, 'need-input');
    expect(ado.addTagToWorkItem).not.toHaveBeenCalledWith(301, 'agent-blocked');
  });

  it('escalates to blocked severity when rejectCount reaches maxRejectCycles', async () => {
    // Pre-seed: this WI has been rejected twice already
    store.save({
      workItemId: 302,
      slug: 'wi-302',
      startedAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
      currentStage: 'analyzer',
      history: [],
      attempts: {},
      outputs: {},
      rejectCount: 2,
    });

    const ado = makeAdo([302]);
    const runner = makeRunner(async () => ({
      verdict: 'reject',
      summary: 'Still vague',
      reasons: ['still no AC'],
    }));
    const abortFlag = createAbortFlag();
    const processor = createProcessor({
      config,
      logger: createLogger(),
      ado,
      store,
      buildPipeline: makeBuildPipeline(runner),
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

    expect(stats.rejected).toBe(1);

    const saved = store.load(302)!;
    expect(saved.rejectCount).toBe(3);

    expect(ado.removeTagFromWorkItem).toHaveBeenCalledWith(302, 'agent implement');
    expect(ado.addTagToWorkItem).toHaveBeenCalledWith(302, 'agent-blocked');
    expect(ado.addTagToWorkItem).not.toHaveBeenCalledWith(302, 'need-input');
  });

  it('re-entry then proceed: stale state.rejection cleared, pipeline completes, rejectCount reset to 0', async () => {
    // Pre-seed: WI was rejected once, now human re-tagged
    store.save({
      workItemId: 303,
      slug: 'wi-303',
      startedAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
      currentStage: 'analyzer',
      history: [],
      attempts: {},
      outputs: {},
      rejectCount: 1,
      rejection: {
        reasons: ['previous'],
        summary: 'previous reject',
        stage: 'analyzer',
        at: '2026-01-02T00:00:00Z',
        dispatched: true,
      },
    });

    const ado = makeAdo([303]);
    const runner = makeRunner(async (call) => {
      if (call === 0) return { verdict: 'proceed', summary: 'Now it makes sense', reasons: [] };
      if (call === 1) return { summary: 'coded', filesChanged: [], commits: [] };
      return { summary: 'tested', testFilesChanged: [], commits: [] };
    });
    const abortFlag = createAbortFlag();
    const processor = createProcessor({
      config,
      logger: createLogger(),
      ado,
      store,
      buildPipeline: makeBuildPipeline(runner),
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

    const saved = store.load(303)!;
    expect(saved.rejection).toBeUndefined();
    expect(saved.rejectCount).toBe(0);
    expect(saved.completedAt).toBeTruthy();

    // Trigger tag removed (because of completedAt), no rejection tags added
    expect(ado.removeTagFromWorkItem).toHaveBeenCalledWith(303, 'agent implement');
    expect(ado.addTagToWorkItem).not.toHaveBeenCalled();
    expect(ado.addWorkItemComment).not.toHaveBeenCalled();

    // The runner WAS called for all 3 agent stages (analyzer + coder + test-author)
    expect(runner.calls).toHaveLength(3);
  });
});
