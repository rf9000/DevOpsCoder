import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { createProcessor } from '../../src/services/processor.ts';
import { PipelineStateStore } from '../../src/state/state-store.ts';
import { createLogger } from '../../src/utils/logger.ts';
import { PipelinePauseError, PipelineRejectError } from '../../src/pipeline/stage.ts';
import { createInitialState } from '../../src/pipeline/orchestrator.ts';
import type { AdoClient } from '../../src/sdk/azure-devops-client.ts';
import type { AppConfig, WorkItem, ReviewerOutput } from '../../src/types/index.ts';
import { CostExceededError, StageTimeoutError, VerificationFailedError } from '../../src/types/index.ts';
import type { Stage } from '../../src/pipeline/stage.ts';

const baseConfig = {
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
  continiaCliPath: '.tools/continia.exe', continiaEnvProfileId: 'prof-1', continiaApiToken: 'tok', continiaAppPaths: ['App'], continiaTestAppPaths: ['App'], maxTestFixAttempts: 2, continiaTestTimeoutS: 600, dryRun: false, skipBuildTest: false,
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
    expect(outcome).toEqual({
      kind: 'paused',
      workItemId: 101,
      stage: 'await-human',
      costUsd: 0,
      toolUsage: {},
    });
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
      costUsd: 0,
      toolUsage: {},
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
        throw new Error('reviewer rejected 3 times — exhausted revision loop');
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

  it('a stale terminalError is cleared on re-entry so a resumed run completes and drops the trigger tag', async () => {
    // Production shape: WI failed at draft-pr-creator (bad repo name), the
    // operator fixed the config, the resumed run opened the PR — but the stale
    // terminalError kept the orchestrator from stamping completedAt, so the
    // trigger tag was never removed and the next poll re-ran everything.
    const seeded = store.load(101) ?? createInitialState(101, 'fix-login');
    seeded.terminalError = {
      stage: 'draft-pr-creator',
      message: 'ADO POST ... failed (404): TF401019',
      at: new Date().toISOString(),
    };
    seeded.currentStage = 'draft-pr-creator';
    store.save(seeded);

    const ado = makeAdo();
    const prStage: Stage = {
      name: 'draft-pr-creator',
      canRun: () => true,
      execute: async (state) => state,
    };

    const proc = createProcessor({
      config: baseConfig,
      logger: createLogger(),
      ado,
      store,
      buildPipeline: () => [prStage],
      abortFlag: { aborted: false },
    });

    const outcome = await proc.processWorkItem(101);

    expect(outcome.kind).toBe('completed');
    expect(store.load(101)?.terminalError).toBeUndefined();
    expect(store.load(101)?.completedAt).toBeDefined();
    expect(ado.removeTagFromWorkItem).toHaveBeenCalledWith(101, 'agent implement');
  });

  it('terminal error WITHOUT reviewer findings: posts the generic failure comment + blocked tag', async () => {
    const boomStage: Stage = {
      name: 'revision-loop',
      canRun: () => true,
      execute: async () => {
        throw new Error('pipeline exploded with no reviewer output');
      },
    };

    let postedHtml = '';
    const ado = makeAdo({
      addWorkItemComment: mock(async (_id: number, html: string) => {
        postedHtml = html;
      }),
    });

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
    // Previously this posted nothing, leaving a blocked tag with no explanation.
    expect(ado.addWorkItemComment).toHaveBeenCalledTimes(1);
    expect(postedHtml).toContain('pipeline exploded with no reviewer output');
    expect(postedHtml).toContain('revision-loop');
    expect(ado.addTagToWorkItem).toHaveBeenCalledTimes(1);
    expect(ado.addTagToWorkItem).toHaveBeenCalledWith(101, 'agent-blocked');
  });

  it('later-stage failure with non-blocking reviewer findings is NOT reported as a reviewer rejection', async () => {
    // Real-world shape: the reviewer approved with major/nit findings, the
    // pipeline ran on, and draft-pr-creator hit an ADO 404. The findings-based
    // renderer used to hijack this and claim "reviewer rejected".
    const reviewerOutput: ReviewerOutput = {
      approved: true,
      findings: [
        {
          severity: 'major',
          file: 'src/bank.al',
          line: 239,
          title: 'BACS ID not carried over by the cross-company copy',
          description: 'Allow-list omits the new field.',
          axis: 'integration',
        },
      ],
      attempts: 1,
    };

    let postedHtml = '';
    const ado = makeAdo({
      addWorkItemComment: mock(async (_id: number, html: string) => {
        postedHtml = html;
      }),
    });

    const reviewStage: Stage = {
      name: 'revision-loop',
      canRun: () => true,
      execute: async (state) => {
        state.outputs.reviewer = reviewerOutput as unknown;
        return state;
      },
    };
    const prStage: Stage = {
      name: 'draft-pr-creator',
      canRun: () => true,
      execute: async () => {
        throw new Error(
          'ADO POST /_apis/git/repositories/continia-banking/pullrequests failed (404): TF401019',
        );
      },
    };

    const proc = createProcessor({
      config: baseConfig,
      logger: createLogger(),
      ado,
      store,
      buildPipeline: () => [reviewStage, prStage],
      abortFlag: { aborted: false },
    });

    const outcome = await proc.processWorkItem(101);
    expect(outcome.kind).toBe('failed');
    expect(ado.addWorkItemComment).toHaveBeenCalledTimes(1);
    expect(postedHtml).not.toContain('reviewer rejected');
    expect(postedHtml).toContain('draft-pr-creator');
    expect(postedHtml).toContain('TF401019');
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

  // ── Plan 6 task-09: cost-cap comment routing ─────────────────────────────

  it('cost-cap terminal error: posts comment with cap/total/per-stage HTML and adds blocked tag', async () => {
    let postedHtml = '';
    const callOrder: string[] = [];
    const ado = makeAdo({
      addWorkItemComment: mock(async (_id: number, html: string) => {
        postedHtml = html;
        callOrder.push('comment');
      }),
      addTagToWorkItem: mock(async () => {
        callOrder.push('tag');
      }),
    });

    const costCapStage: Stage = {
      name: 'reviewer',
      canRun: () => true,
      execute: async (state) => {
        // Simulate cost accumulation across prior stages
        state.outputs.cost = {
          total: 6.0,
          perStage: { analyzer: 1.0, coder: 5.0 },
        };
        throw new CostExceededError(6.0, 5.0, 'reviewer');
      },
    };

    const proc = createProcessor({
      config: baseConfig,
      logger: createLogger(),
      ado,
      store,
      buildPipeline: () => [costCapStage],
      abortFlag: { aborted: false },
    });

    const outcome = await proc.processWorkItem(101);
    expect(outcome.kind).toBe('failed');

    // Comment was posted once
    expect(ado.addWorkItemComment).toHaveBeenCalledTimes(1);

    // HTML must contain cap value, total, and per-stage stage names
    expect(postedHtml).toContain('cost cap');
    expect(postedHtml).toContain('5.0000'); // cap
    expect(postedHtml).toContain('6.0000'); // total
    expect(postedHtml).toContain('analyzer');
    expect(postedHtml).toContain('coder');

    // Blocked tag was added
    expect(ado.addTagToWorkItem).toHaveBeenCalledTimes(1);
    expect(ado.addTagToWorkItem).toHaveBeenCalledWith(101, 'agent-blocked');

    // Comment posted BEFORE the tag
    expect(callOrder).toEqual(['comment', 'tag']);
  });

  it('dry-run with cost-cap terminal error: suppresses comment and tag', async () => {
    const costCapStage: Stage = {
      name: 'reviewer',
      canRun: () => true,
      execute: async (state) => {
        state.outputs.cost = {
          total: 6.0,
          perStage: { analyzer: 1.0, coder: 5.0 },
        };
        throw new CostExceededError(6.0, 5.0, 'reviewer');
      },
    };

    const ado = makeAdo();

    const proc = createProcessor({
      config: { ...baseConfig, dryRun: true },
      logger: createLogger(),
      ado,
      store,
      buildPipeline: () => [costCapStage],
      abortFlag: { aborted: false },
    });

    const outcome = await proc.processWorkItem(101);
    expect(outcome.kind).toBe('failed');
    expect(ado.addWorkItemComment).not.toHaveBeenCalled();
    expect(ado.addTagToWorkItem).not.toHaveBeenCalled();
  });

  // ── Plan 6 task-10: stage-timeout comment routing ────────────────────────

  it('timeout terminal error posts comment with stage name + timeout value in HTML', async () => {
    let postedHtml = '';
    const callOrder: string[] = [];
    const ado = makeAdo({
      addWorkItemComment: mock(async (_id: number, html: string) => {
        postedHtml = html;
        callOrder.push('comment');
      }),
      addTagToWorkItem: mock(async () => {
        callOrder.push('tag');
      }),
    });

    const timeoutStage: Stage = {
      name: 'reviewer',
      canRun: () => true,
      execute: async () => {
        throw new StageTimeoutError('reviewer', 900_000);
      },
    };

    const proc = createProcessor({
      config: { ...baseConfig, stageTimeoutMs: { reviewer: 900_000 } },
      logger: createLogger(),
      ado,
      store,
      buildPipeline: () => [timeoutStage],
      abortFlag: { aborted: false },
    });

    const outcome = await proc.processWorkItem(101);
    expect(outcome.kind).toBe('failed');

    // Comment posted once
    expect(ado.addWorkItemComment).toHaveBeenCalledTimes(1);

    // HTML must contain: "timed out", stage name, formatted timeout, env-var name
    expect(postedHtml).toContain('timed out');
    expect(postedHtml).toContain('reviewer');
    expect(postedHtml).toContain('15min');
    expect(postedHtml).toContain('STAGE_TIMEOUT_MS_REVIEWER');

    // Blocked tag was added
    expect(ado.addTagToWorkItem).toHaveBeenCalledTimes(1);
    expect(ado.addTagToWorkItem).toHaveBeenCalledWith(101, 'agent-blocked');

    // Comment posted BEFORE the tag
    expect(callOrder).toEqual(['comment', 'tag']);
  });

  it('dry-run with timeout terminal error: suppresses both comment and tag', async () => {
    const timeoutStage: Stage = {
      name: 'reviewer',
      canRun: () => true,
      execute: async () => {
        throw new StageTimeoutError('reviewer', 900_000);
      },
    };

    const ado = makeAdo();

    const proc = createProcessor({
      config: { ...baseConfig, dryRun: true, stageTimeoutMs: { reviewer: 900_000 } },
      logger: createLogger(),
      ado,
      store,
      buildPipeline: () => [timeoutStage],
      abortFlag: { aborted: false },
    });

    const outcome = await proc.processWorkItem(101);
    expect(outcome.kind).toBe('failed');
    expect(ado.addWorkItemComment).not.toHaveBeenCalled();
    expect(ado.addTagToWorkItem).not.toHaveBeenCalled();
  });

  // ── Plan 10: verification-failure comment routing ────────────────────────

  function makeVerificationFailingStage(overrides: {
    compiled?: boolean;
    withReviewerFindings?: boolean;
  } = {}): Stage {
    const compiled = overrides.compiled ?? true;
    return {
      name: 'build-and-test',
      canRun: () => true,
      execute: async (s) => {
        s.outputs.environment = {
          envId: 'env-9',
          name: 'wi-101',
          url: 'https://bc/env-9',
          status: 'Running',
          createdAt: '2026-07-07T10:00:00Z',
        };
        if (overrides.withReviewerFindings) {
          s.outputs.reviewer = {
            approved: true,
            findings: [
              { severity: 'minor', file: 'a.al', title: 'nit', description: 'd', axis: 'naming-style' },
            ],
            attempts: 1,
          };
        }
        s.outputs.verification = {
          attempts: 2,
          compiled,
          deploy: compiled
            ? [{ app: 'Continia Banking', compiled: true, published: true }]
            : [{ app: 'Continia Banking', compiled: false, published: false, error: 'AL0118: missing symbol Foo' }],
          testRuns: compiled
            ? [{
                attempt: 2, codeunitId: 148001, codeunitName: 'CDO Setup Tests', passed: false,
                summary: { total: 3, passed: 2, failed: 1, skipped: 0 },
                tests: [
                  { name: 'GreenTest', result: 'Pass' },
                  { name: 'RedTest', result: 'Fail', errorMessage: 'Expected 1, got 0', stackTrace: '"CDO Feature"(Codeunit 70001).Calculate line 12' },
                ],
              }]
            : [],
          passed: false,
        };
        throw new VerificationFailedError(2, compiled, compiled ? '1 failing test(s) in codeunit(s) 148001' : 'app Continia Banking failed to compile/publish');
      },
    };
  }

  it('verification failure posts a comment with failing test, stack fragment, and env id', async () => {
    let postedHtml = '';
    const ado = makeAdo({
      addWorkItemComment: mock(async (_id: number, html: string) => { postedHtml = html; }),
    });
    const proc = createProcessor({
      config: baseConfig,
      logger: createLogger(),
      ado,
      store,
      buildPipeline: () => [makeVerificationFailingStage()],
      abortFlag: { aborted: false },
    });

    const outcome = await proc.processWorkItem(101);
    expect(outcome.kind).toBe('failed');
    expect(ado.addWorkItemComment).toHaveBeenCalledTimes(1);
    expect(postedHtml).toContain('verification failed');
    expect(postedHtml).toContain('RedTest');
    expect(postedHtml).toContain('Expected 1, got 0');
    expect(postedHtml).toContain('Codeunit 70001');
    expect(postedHtml).toContain('env-9');
    expect(postedHtml).toContain('reset-state 101');
    expect(ado.addTagToWorkItem).toHaveBeenCalledWith(101, 'agent-blocked');
  });

  it('verification failure with compile errors renders the app and error detail', async () => {
    let postedHtml = '';
    const ado = makeAdo({
      addWorkItemComment: mock(async (_id: number, html: string) => { postedHtml = html; }),
    });
    const proc = createProcessor({
      config: baseConfig,
      logger: createLogger(),
      ado,
      store,
      buildPipeline: () => [makeVerificationFailingStage({ compiled: false })],
      abortFlag: { aborted: false },
    });

    await proc.processWorkItem(101);
    expect(postedHtml).toContain('Compile / deploy errors');
    expect(postedHtml).toContain('Continia Banking');
    expect(postedHtml).toContain('AL0118');
  });

  it('verification failure wins over reviewer findings in comment routing (regression guard)', async () => {
    let postedHtml = '';
    const ado = makeAdo({
      addWorkItemComment: mock(async (_id: number, html: string) => { postedHtml = html; }),
    });
    const proc = createProcessor({
      config: baseConfig,
      logger: createLogger(),
      ado,
      store,
      buildPipeline: () => [makeVerificationFailingStage({ withReviewerFindings: true })],
      abortFlag: { aborted: false },
    });

    await proc.processWorkItem(101);
    expect(ado.addWorkItemComment).toHaveBeenCalledTimes(1);
    expect(postedHtml).toContain('verification failed');
    expect(postedHtml).not.toContain('reviewer rejected');
  });

  // ── Plan 7 task-01: costUsd on ProcessOutcome ────────────────────────────

  it('completed outcome carries costUsd from state.outputs.cost.total', async () => {
    // Pre-seed state with cost info
    store.save({
      workItemId: 101,
      slug: 'fix-login',
      startedAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      currentStage: null,
      history: [],
      outputs: {
        cost: { total: 0.42, perStage: { coder: 0.40, reviewer: 0.02 } },
      },
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
    if (outcome.kind === 'completed') {
      expect(outcome.costUsd).toBe(0.42);
    }
  });

  it('paused outcome carries costUsd from state.outputs.cost.total', async () => {
    // Pre-seed state with cost info
    store.save({
      workItemId: 101,
      slug: 'fix-login',
      startedAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      currentStage: null,
      history: [],
      outputs: {
        cost: { total: 0.15, perStage: { coder: 0.15 } },
      },
    });

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
    expect(outcome.kind).toBe('paused');
    if (outcome.kind === 'paused') {
      expect(outcome.costUsd).toBe(0.15);
    }
  });

  it('failed outcome carries costUsd from persisted state.outputs.cost.total', async () => {
    const boomStage: Stage = {
      name: 'coder',
      canRun: () => true,
      execute: async (state) => {
        // Simulate cost accumulated before failure
        state.outputs.cost = { total: 0.77, perStage: { coder: 0.77 } };
        throw new Error('coder exploded');
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
      expect(outcome.costUsd).toBe(0.77);
    }
  });

  it('rejected outcome (fresh dispatch) carries costUsd from state.outputs.cost.total', async () => {
    const rejectStage: Stage = {
      name: 'analyzer',
      canRun: () => true,
      execute: async (state) => {
        state.outputs.cost = { total: 0.05, perStage: { analyzer: 0.05 } };
        throw new PipelineRejectError({
          reasons: ['insufficient AC'],
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
    expect(outcome.kind).toBe('rejected');
    if (outcome.kind === 'rejected') {
      expect(outcome.costUsd).toBe(0.05);
    }
  });

  it('rejected outcome (recovery dispatch) carries costUsd from pre-existing state.outputs.cost.total', async () => {
    // Pre-seed state as if a previous cycle crashed mid-dispatch with cost accumulated
    store.save({
      workItemId: 101,
      slug: 'wi',
      startedAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      currentStage: 'analyzer',
      history: [],
      outputs: {
        cost: { total: 0.08, perStage: { analyzer: 0.08 } },
      },
      rejectCount: 1,
      rejection: {
        reasons: ['vague'],
        summary: 'WI is not ready',
        stage: 'analyzer',
        at: '2026-01-01T00:00:00Z',
        // dispatched intentionally OMITTED — signals a crashed dispatch
      },
    });

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
    expect(outcome.kind).toBe('rejected');
    if (outcome.kind === 'rejected') {
      expect(outcome.costUsd).toBe(0.08);
    }
  });

  it('missing-cost fallback: outcome.costUsd === 0 when state.outputs.cost is undefined', async () => {
    // No cost seeded — state.outputs.cost will be undefined
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
    if (outcome.kind === 'completed') {
      expect(outcome.costUsd).toBe(0);
    }
  });

  // ── Plan 8 task-05: toolUsage on ProcessOutcome ──────────────────────────

  it('completed outcome carries toolUsage from state.outputs.toolUsage', async () => {
    // Pre-seed state with tool-usage info
    store.save({
      workItemId: 101,
      slug: 'fix-login',
      startedAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      currentStage: null,
      history: [],
      outputs: {
        toolUsage: { Edit: 3, Bash: 1 },
      },
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
    if (outcome.kind === 'completed') {
      expect(outcome.toolUsage).toEqual({ Edit: 3, Bash: 1 });
    }
  });

  it('paused outcome carries toolUsage from state.outputs.toolUsage', async () => {
    // Pre-seed state with tool-usage info
    store.save({
      workItemId: 101,
      slug: 'fix-login',
      startedAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      currentStage: null,
      history: [],
      outputs: {
        toolUsage: { Edit: 3, Bash: 1 },
      },
    });

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
    expect(outcome.kind).toBe('paused');
    if (outcome.kind === 'paused') {
      expect(outcome.toolUsage).toEqual({ Edit: 3, Bash: 1 });
    }
  });

  it('failed outcome carries toolUsage from persisted state.outputs.toolUsage', async () => {
    const boomStage: Stage = {
      name: 'coder',
      canRun: () => true,
      execute: async (state) => {
        // Simulate tool usage accumulated before failure
        state.outputs.toolUsage = { Edit: 3, Bash: 1 };
        throw new Error('coder exploded');
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
      expect(outcome.toolUsage).toEqual({ Edit: 3, Bash: 1 });
    }
  });

  it('rejected outcome (fresh dispatch) carries toolUsage from state.outputs.toolUsage', async () => {
    const rejectStage: Stage = {
      name: 'analyzer',
      canRun: () => true,
      execute: async (state) => {
        state.outputs.toolUsage = { Edit: 3, Bash: 1 };
        throw new PipelineRejectError({
          reasons: ['insufficient AC'],
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
    expect(outcome.kind).toBe('rejected');
    if (outcome.kind === 'rejected') {
      expect(outcome.toolUsage).toEqual({ Edit: 3, Bash: 1 });
    }
  });

  it('missing-toolUsage fallback: outcome.toolUsage === {} when state.outputs.toolUsage is undefined', async () => {
    // No toolUsage seeded — state.outputs.toolUsage will be undefined
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
    if (outcome.kind === 'completed') {
      expect(outcome.toolUsage).toEqual({});
    }
  });

});
