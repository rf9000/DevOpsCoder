import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { createProcessor } from '../../src/services/processor.ts';
import { PipelineStateStore } from '../../src/state/state-store.ts';
import { createLogger } from '../../src/utils/logger.ts';
import { PipelinePauseError } from '../../src/pipeline/stage.ts';
import type { AdoClient } from '../../src/sdk/azure-devops-client.ts';
import type { AppConfig, WorkItem } from '../../src/types/index.ts';
import type { Stage } from '../../src/pipeline/stage.ts';

const baseConfig = {
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
  concurrency: 1,
  maxRevisions: 3,
  maxRejectCycles: 3,
  claudeModel: 'claude-opus-4-7',
  stateDir: '.state',
  assignedToFilter: [],
  dryRun: false,
} satisfies AppConfig;

function makeAdo(overrides: Partial<AdoClient> = {}): AdoClient {
  return {
    queryWorkItemsByTag: mock(async () => []),
    getWorkItem: mock(async () =>
      ({
        id: 101,
        fields: {
          'System.Title': 'Fix login',
          'System.State': 'Active',
          'System.Tags': 'agent implement',
        },
      }) satisfies WorkItem,
    ),
    addTagToWorkItem: mock(async () => {}),
    removeTagFromWorkItem: mock(async () => {}),
    addWorkItemComment: mock(async () => {}),
    ...overrides,
  };
}

describe('createProcessor', () => {
  let dir: string;
  let store: PipelineStateStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'proc-'));
    store = new PipelineStateStore(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('runs an empty pipeline, sets completedAt, and removes the trigger tag', async () => {
    const ado = makeAdo();
    const proc = createProcessor({
      config: baseConfig,
      logger: createLogger(),
      ado,
      store,
      buildPipeline: () => [],
      abortFlag: { aborted: false },
    });
    const outcome = await proc.processWorkItem(101);
    expect(outcome.kind).toBe('completed');
    const state = store.load(101)!;
    expect(state.completedAt).toBeTruthy();
    expect(ado.removeTagFromWorkItem).toHaveBeenCalledWith(101, 'agent implement');
    expect(ado.addTagToWorkItem).not.toHaveBeenCalled();
  });

  it('skips when getWorkItem throws a 404-shaped AzureDevOpsError', async () => {
    class FakeAdoError extends Error {
      readonly statusCode = 404;
    }
    const ado = makeAdo({
      getWorkItem: mock(async () => {
        throw new FakeAdoError('not found');
      }),
    });
    const proc = createProcessor({
      config: baseConfig,
      logger: createLogger(),
      ado,
      store,
      buildPipeline: () => [],
      abortFlag: { aborted: false },
    });
    const outcome = await proc.processWorkItem(101);
    expect(outcome).toEqual({ kind: 'skipped', workItemId: 101, reason: 'not-found' });
    expect(store.load(101)).toBeNull();
  });

  it('skips when the work item is in a closed state', async () => {
    const ado = makeAdo({
      getWorkItem: mock(async () => ({
        id: 101,
        fields: { 'System.Title': 't', 'System.State': 'Closed' },
      })),
    });
    const proc = createProcessor({
      config: baseConfig,
      logger: createLogger(),
      ado,
      store,
      buildPipeline: () => [],
      abortFlag: { aborted: false },
    });
    const outcome = await proc.processWorkItem(101);
    expect(outcome).toEqual({ kind: 'skipped', workItemId: 101, reason: 'closed-state' });
  });

  it('returns paused and does NOT remove the trigger tag when a stage pauses', async () => {
    const pauseStage: Stage = {
      name: 'await-human',
      canRun: () => true,
      execute: async (state) => {
        state.currentStage = 'await-human';
        throw new PipelinePauseError('waiting for human input');
      },
    };
    const ado = makeAdo();
    const proc = createProcessor({
      config: baseConfig,
      logger: createLogger(),
      ado,
      store,
      buildPipeline: () => [pauseStage],
      abortFlag: { aborted: false },
    });
    const outcome = await proc.processWorkItem(101);
    expect(outcome).toEqual({ kind: 'paused', workItemId: 101, stage: 'await-human' });
    expect(ado.removeTagFromWorkItem).not.toHaveBeenCalled();
    expect(ado.addTagToWorkItem).not.toHaveBeenCalled();
  });

  it('returns failed and adds the blocked tag on terminal error', async () => {
    const boomStage: Stage = {
      name: 'boom',
      canRun: () => true,
      execute: async () => {
        throw new Error('exploded');
      },
    };
    const ado = makeAdo();
    const proc = createProcessor({
      config: baseConfig,
      logger: createLogger(),
      ado,
      store,
      buildPipeline: () => [boomStage],
      abortFlag: { aborted: false },
    });
    const outcome = await proc.processWorkItem(101);
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(outcome.error.stage).toBe('boom');
      expect(outcome.error.message).toBe('exploded');
    }
    expect(ado.addTagToWorkItem).toHaveBeenCalledWith(101, 'agent-blocked');
    expect(ado.removeTagFromWorkItem).not.toHaveBeenCalled();
  });

  it('suppresses ADO writes when dryRun is true', async () => {
    const ado = makeAdo();
    const proc = createProcessor({
      config: { ...baseConfig, dryRun: true },
      logger: createLogger(),
      ado,
      store,
      buildPipeline: () => [],
      abortFlag: { aborted: false },
    });
    const outcome = await proc.processWorkItem(101);
    expect(outcome.kind).toBe('completed');
    expect(ado.removeTagFromWorkItem).not.toHaveBeenCalled();
    expect(ado.addTagToWorkItem).not.toHaveBeenCalled();
    expect(store.load(101)?.completedAt).toBeTruthy();
  });
});
