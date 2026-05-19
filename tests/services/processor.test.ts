import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { createProcessor } from '../../src/services/processor.ts';
import { PipelineStateStore } from '../../src/state/state-store.ts';
import { createLogger } from '../../src/utils/logger.ts';
import { PipelinePauseError, PipelineRejectError } from '../../src/pipeline/stage.ts';
import type { AdoClient } from '../../src/sdk/azure-devops-client.ts';
import type { AppConfig, WorkItem, ReviewerOutput } from '../../src/types/index.ts';
import type { Stage } from '../../src/pipeline/stage.ts';

const baseConfig = {
  org: 'o',
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
  concurrency: 1,
  maxRevisions: 3,
  maxRejectCycles: 3,
  coderMaxTurns: 80,
  testAuthorMaxTurns: 50,
  maxCostUsdPerWi: 5.00,
  stageTimeoutMs: {},
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
    getWorkItemComments: mock(async () => []),
    addTagToWorkItem: mock(async () => {}),
    removeTagFromWorkItem: mock(async () => {}),
    addWorkItemComment: mock(async () => {}),
    createPullRequest: mock(async () => ({ id: 0, url: '', sourceRefName: '', targetRefName: '' })),
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

  it('reject path: increments rejectCount, posts a markdown comment, removes triggerTag, adds needInputTag', async () => {
    const rejectStage: Stage = {
      name: 'analyzer',
      canRun: () => true,
      execute: async () => {
        throw new PipelineRejectError({
          reasons: ['no AC', 'vague description'],
          summary: 'WI is not ready',
        });
      },
    };
    const ado = makeAdo();
    const proc = createProcessor({
      config: baseConfig,
      logger: createLogger(),
      ado,
      store,
      buildPipeline: () => [rejectStage],
      abortFlag: { aborted: false },
    });
    const outcome = await proc.processWorkItem(101);
    expect(outcome).toEqual({
      kind: 'rejected',
      workItemId: 101,
      severity: 'reject',
      rejectCount: 1,
    });
    const saved = store.load(101)!;
    expect(saved.rejectCount).toBe(1);
    expect(saved.rejection?.summary).toBe('WI is not ready');
    expect(ado.addWorkItemComment).toHaveBeenCalled();
    expect(ado.removeTagFromWorkItem).toHaveBeenCalledWith(101, 'agent implement');
    expect(ado.addTagToWorkItem).toHaveBeenCalledWith(101, 'need-input');
  });

  it('reject path: escalates to blocked severity when rejectCount reaches maxRejectCycles', async () => {
    store.save({
      workItemId: 101,
      slug: 'wi',
      startedAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      currentStage: 'analyzer',
      history: [],
      attempts: {},
      outputs: {},
      rejectCount: 2,
    });
    const rejectStage: Stage = {
      name: 'analyzer',
      canRun: () => true,
      execute: async () => {
        throw new PipelineRejectError({
          reasons: ['still vague'],
          summary: 'still not ready',
        });
      },
    };
    const ado = makeAdo();
    const proc = createProcessor({
      config: baseConfig, // maxRejectCycles defaults to 3
      logger: createLogger(),
      ado,
      store,
      buildPipeline: () => [rejectStage],
      abortFlag: { aborted: false },
    });
    const outcome = await proc.processWorkItem(101);
    expect(outcome.kind).toBe('rejected');
    if (outcome.kind === 'rejected') {
      expect(outcome.severity).toBe('blocked');
      expect(outcome.rejectCount).toBe(3);
    }
    expect(ado.addTagToWorkItem).toHaveBeenCalledWith(101, 'agent-blocked');
    expect(ado.addTagToWorkItem).not.toHaveBeenCalledWith(101, 'need-input');
  });

  it('clears stale state.rejection at entry so the pipeline re-runs on re-tag', async () => {
    store.save({
      workItemId: 101,
      slug: 'wi',
      startedAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      currentStage: 'analyzer',
      history: [],
      attempts: {},
      outputs: {},
      rejectCount: 1,
      rejection: {
        reasons: ['stale'],
        summary: 'stale',
        stage: 'analyzer',
        at: '2026-01-01T00:00:00Z',
        dispatched: true,
      },
    });
    const stageRunCount = { n: 0 };
    const proceedStage: Stage = {
      name: 'analyzer',
      canRun: () => true,
      execute: async (state) => {
        stageRunCount.n++;
        state.outputs.analyzer = { verdict: 'proceed', summary: 'ok', reasons: [] };
        return state;
      },
    };
    const ado = makeAdo();
    const proc = createProcessor({
      config: baseConfig,
      logger: createLogger(),
      ado,
      store,
      buildPipeline: () => [proceedStage],
      abortFlag: { aborted: false },
    });
    const outcome = await proc.processWorkItem(101);
    expect(stageRunCount.n).toBe(1); // pipeline DID run again
    expect(outcome.kind).toBe('completed');
    const saved = store.load(101)!;
    expect(saved.rejection).toBeUndefined();
  });

  it('resets rejectCount to 0 on completion (analyzer accepted a previously-rejected WI)', async () => {
    store.save({
      workItemId: 101,
      slug: 'wi',
      startedAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      currentStage: null,
      history: [],
      attempts: {},
      outputs: {},
      rejectCount: 2,
    });
    const ado = makeAdo();
    const proc = createProcessor({
      config: baseConfig,
      logger: createLogger(),
      ado,
      store,
      buildPipeline: () => [], // empty pipeline → immediate completion
      abortFlag: { aborted: false },
    });
    const outcome = await proc.processWorkItem(101);
    expect(outcome.kind).toBe('completed');
    const saved = store.load(101)!;
    expect(saved.rejectCount).toBe(0);
    expect(saved.completedAt).toBeTruthy();
  });

  it('reject path with dryRun=true: persists state but suppresses ADO writes', async () => {
    const rejectStage: Stage = {
      name: 'analyzer',
      canRun: () => true,
      execute: async () => {
        throw new PipelineRejectError({
          reasons: ['vague'],
          summary: 'not ready',
        });
      },
    };
    const ado = makeAdo();
    const proc = createProcessor({
      config: { ...baseConfig, dryRun: true },
      logger: createLogger(),
      ado,
      store,
      buildPipeline: () => [rejectStage],
      abortFlag: { aborted: false },
    });
    const outcome = await proc.processWorkItem(101);
    expect(outcome.kind).toBe('rejected');
    expect(store.load(101)?.rejectCount).toBe(1);
    expect(ado.addWorkItemComment).not.toHaveBeenCalled();
    expect(ado.removeTagFromWorkItem).not.toHaveBeenCalled();
    expect(ado.addTagToWorkItem).not.toHaveBeenCalled();
  });

  it('reject comment markdown includes summary, reasons, and the re-tag instruction', async () => {
    let postedHtml = '';
    const ado = makeAdo({
      addWorkItemComment: mock(async (_id: number, html: string) => {
        postedHtml = html;
      }),
    });
    const rejectStage: Stage = {
      name: 'analyzer',
      canRun: () => true,
      execute: async () => {
        throw new PipelineRejectError({
          reasons: ['no AC', 'no design'],
          summary: 'WI lacks acceptance criteria',
          questions: ['What is the expected UI?'],
        });
      },
    };
    const proc = createProcessor({
      config: baseConfig,
      logger: createLogger(),
      ado,
      store,
      buildPipeline: () => [rejectStage],
      abortFlag: { aborted: false },
    });
    await proc.processWorkItem(101);
    expect(postedHtml).toContain('WI lacks acceptance criteria');
    expect(postedHtml).toContain('no AC');
    expect(postedHtml).toContain('no design');
    expect(postedHtml).toContain('What is the expected UI?');
    expect(postedHtml).toContain('agent implement');
  });

  it('terminal error with reviewer findings: posts comment + adds blocked tag (comment before tag)', async () => {
    const reviewerOutput: ReviewerOutput = {
      approved: false,
      findings: [
        {
          severity: 'blocking',
          file: 'src/auth.ts',
          line: 42,
          title: 'SQL injection vulnerability',
          description: 'Unsanitised input passed directly to query.',
          suggestion: 'Use parameterised queries.',
          axis: 'security',
        },
        {
          severity: 'critical',
          file: 'src/utils.ts',
          title: 'Missing null check',
          description: 'Value can be null at runtime.',
          axis: 'correctness',
        },
      ],
      attempts: 3,
    };

    const callOrder: string[] = [];
    let postedHtml = '';
    const ado = makeAdo({
      addWorkItemComment: mock(async (_id: number, html: string) => {
        postedHtml = html;
        callOrder.push('comment');
      }),
      addTagToWorkItem: mock(async () => {
        callOrder.push('tag');
      }),
    });

    const boomStage: Stage = {
      name: 'revision-loop',
      canRun: () => true,
      execute: async (state) => {
        state.outputs.reviewer = reviewerOutput as unknown;
        throw new Error('revision loop exhausted');
      },
    };

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

    // Comment was posted with reviewer findings HTML
    expect(ado.addWorkItemComment).toHaveBeenCalledTimes(1);
    expect(postedHtml).toContain('blocking findings');
    expect(postedHtml).toContain('SQL injection vulnerability');

    // Blocked tag was added
    expect(ado.addTagToWorkItem).toHaveBeenCalledTimes(1);
    expect(ado.addTagToWorkItem).toHaveBeenCalledWith(101, 'agent-blocked');

    // Comment posted BEFORE the tag
    expect(callOrder).toEqual(['comment', 'tag']);
  });

  it('terminal error WITHOUT reviewer findings: adds blocked tag, no comment posted', async () => {
    const boomStage: Stage = {
      name: 'revision-loop',
      canRun: () => true,
      execute: async () => {
        throw new Error('pipeline exploded with no reviewer output');
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
    expect(ado.addWorkItemComment).not.toHaveBeenCalled();
    expect(ado.addTagToWorkItem).toHaveBeenCalledTimes(1);
    expect(ado.addTagToWorkItem).toHaveBeenCalledWith(101, 'agent-blocked');
  });

  it('dry run: terminal error with reviewer findings — neither comment nor tag is posted', async () => {
    const reviewerOutput: ReviewerOutput = {
      approved: false,
      findings: [
        {
          severity: 'blocking',
          file: 'src/foo.ts',
          title: 'Bad thing',
          description: 'Very bad.',
          axis: 'security',
        },
      ],
      attempts: 2,
    };

    const boomStage: Stage = {
      name: 'revision-loop',
      canRun: () => true,
      execute: async (state) => {
        state.outputs.reviewer = reviewerOutput as unknown;
        throw new Error('exhausted');
      },
    };

    const ado = makeAdo();

    const proc = createProcessor({
      config: { ...baseConfig, dryRun: true },
      logger: createLogger(),
      ado,
      store,
      buildPipeline: () => [boomStage],
      abortFlag: { aborted: false },
    });

    const outcome = await proc.processWorkItem(101);
    expect(outcome.kind).toBe('failed');
    expect(ado.addWorkItemComment).not.toHaveBeenCalled();
    expect(ado.addTagToWorkItem).not.toHaveBeenCalled();
  });

  it('crash-recovery: state.rejection set without dispatched flag → retry tag ops, no new comment, no pipeline run', async () => {
    // Pre-seed the state as if a previous cycle crashed AFTER the rejectCount
    // was incremented and saved, but BEFORE the comment-post and tag-swap
    // finished (or after the comment but before the tags).
    store.save({
      workItemId: 101,
      slug: 'wi',
      startedAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      currentStage: 'analyzer',
      history: [],
      attempts: {},
      outputs: {},
      rejectCount: 1,
      rejection: {
        reasons: ['vague'],
        summary: 'WI is not ready',
        stage: 'analyzer',
        at: '2026-01-01T00:00:00Z',
        // dispatched intentionally OMITTED — signals a crashed dispatch
      },
    });
    const stageRunCount = { n: 0 };
    const tripwireStage: Stage = {
      name: 'analyzer',
      canRun: () => true,
      execute: async () => {
        stageRunCount.n++;
        throw new Error('pipeline must not run during crash recovery');
      },
    };
    const ado = makeAdo();
    const proc = createProcessor({
      config: baseConfig,
      logger: createLogger(),
      ado,
      store,
      buildPipeline: () => [tripwireStage],
      abortFlag: { aborted: false },
    });
    const outcome = await proc.processWorkItem(101);
    expect(stageRunCount.n).toBe(0); // pipeline did NOT run
    expect(outcome.kind).toBe('rejected');
    if (outcome.kind === 'rejected') {
      expect(outcome.rejectCount).toBe(1); // unchanged (not incremented again)
      expect(outcome.severity).toBe('reject');
    }
    // Comment NOT posted (recovery skips the comment to avoid duplicates)
    expect(ado.addWorkItemComment).not.toHaveBeenCalled();
    // Tag ops DID retry (they're idempotent)
    expect(ado.removeTagFromWorkItem).toHaveBeenCalledWith(101, 'agent implement');
    expect(ado.addTagToWorkItem).toHaveBeenCalledWith(101, 'need-input');
    // Dispatched flag set at the end so subsequent re-tag triggers a fresh attempt
    const saved = store.load(101)!;
    expect(saved.rejection?.dispatched).toBe(true);
  });

  // ── Plan 6 task-08: cancelled-state handling ─────────────────────────────

  it('entry-clear: state.cancelled=true is cleared before pipeline runs and outcome is completed', async () => {
    // Pre-populate state with cancelled: true (simulates previous cycle bailed via external abort)
    store.save({
      workItemId: 101,
      slug: 'fix-login',
      startedAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      currentStage: null,
      history: [],
      attempts: {},
      outputs: {},
      cancelled: true,
    });

    const ado = makeAdo();
    const proc = createProcessor({
      config: baseConfig,
      logger: createLogger(),
      ado,
      store,
      buildPipeline: () => [], // empty pipeline → immediate completion
      abortFlag: { aborted: false },
    });

    const outcome = await proc.processWorkItem(101);

    // Pipeline ran successfully; cancelled flag was cleared before pipeline started
    expect(outcome.kind).toBe('completed');
    const persisted = store.load(101)!;
    expect(persisted.cancelled).toBe(false);
  });

  it('runPipeline returns cancelled state → outcome skipped/cancelled + zero ADO writes', async () => {
    // Stage that sets state.cancelled = true and returns (simulates what external-abort path produces)
    const cancelStage: Stage = {
      name: 'coder',
      canRun: () => true,
      execute: async (state) => {
        state.cancelled = true;
        state.currentStage = 'coder';
        return state;
      },
    };

    const ado = makeAdo();
    const proc = createProcessor({
      config: baseConfig,
      logger: createLogger(),
      ado,
      store,
      buildPipeline: () => [cancelStage],
      abortFlag: { aborted: false },
    });

    const outcome = await proc.processWorkItem(101);

    // Must return skipped/cancelled
    expect(outcome.kind).toBe('skipped');
    if (outcome.kind === 'skipped') {
      expect(outcome.reason).toBe('cancelled');
      expect(outcome.workItemId).toBe(101);
    }

    // Zero ADO writes: trigger tag stays, no blocked tag, no comment
    expect(ado.addWorkItemComment).not.toHaveBeenCalled();
    expect(ado.addTagToWorkItem).not.toHaveBeenCalled();
    expect(ado.removeTagFromWorkItem).not.toHaveBeenCalled();
  });

});
