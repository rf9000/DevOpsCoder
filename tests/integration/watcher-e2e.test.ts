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
import type { AgentRunArgs, AgentRunner } from '../../src/pipeline/agent-stage.ts';
import type { PipelineBuilderDeps } from '../../src/services/pipeline-builder.ts';

const baseConfig: AppConfig = {
  org: 'o',
  orgUrl: 'https://x',
  project: 'p',
  pat: 'pat',
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
  claudeModel: 'claude-opus-4-7',
  stateDir: '',
  assignedToFilter: [],
  dryRun: false,
};

function makeRecordingRunner(): AgentRunner {
  return {
    async run<T>(args: AgentRunArgs<T>): Promise<T> {
      void args;
      return { verdict: 'proceed', summary: 'ok', reasons: [] } as unknown as T;
    },
  };
}

/** Wraps buildPipeline with test-safe overrides so no real SDK binary is invoked. */
function buildPipelineForTest(deps: PipelineBuilderDeps) {
  return buildPipeline({
    ...deps,
    runner: makeRecordingRunner(),
    discoveredSkills: [],
    analyzerPromptTemplate: 'test-prompt',
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
      attempts: {},
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
