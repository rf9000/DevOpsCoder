import { describe, it, expect, mock } from 'bun:test';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { z } from 'zod';
import { runPipeline, createInitialState } from '../../src/pipeline/orchestrator.ts';
import type { AgentRunner } from '../../src/pipeline/agent-stage.ts';
import { revisionLoop } from '../../src/pipeline/revision-loop.ts';
import { PipelinePauseError } from '../../src/pipeline/stage.ts';
import type { PipelineContext, Stage } from '../../src/pipeline/stage.ts';
import { PipelineStateStore } from '../../src/state/state-store.ts';
import type { AppConfig, PipelineState } from '../../src/types/index.ts';

const FIXED_NOW = new Date('2026-05-04T12:00:00.000Z');

function tmpStateDir(): string {
  return mkdtempSync(join(tmpdir(), 'devops-coder-e2e-'));
}

function makeContext(): PipelineContext {
  const config: AppConfig = {
    orgUrl: 'https://dev.azure.com/o', project: 'p', pat: 't',
    repositoryName: 'test-repo',
    targetRepoPath: '/r', worktreeBase: '/w',
    triggerTag: 'agent implement', blockedTag: 'agent-blocked', needInputTag: 'need-input',
    pollIntervalMinutes: 5, concurrency: 1, maxRevisions: 3, maxRejectCycles: 3,
    coderMaxTurns: 80, testAuthorMaxTurns: 50,
    maxCostUsdPerWi: 5.00, stageTimeoutMs: {},
    claudeModel: 'claude-opus-4-7', stateDir: '.state', assignedToFilter: [], continiaCliPath: '.tools/continia.exe', continiaEnvProfileId: 'prof-1', continiaApiToken: 'tok', continiaAppPaths: ['App'], continiaTestAppPaths: ['App'], maxTestFixAttempts: 2, dryRun: false,
  };
  return {
    config,
    logger: { info: mock(() => {}), warn: mock(() => {}), error: mock(() => {}) },
    abortFlag: { aborted: false },
    signal: new AbortController().signal,
    now: () => FIXED_NOW,
  };
}

const AnalyzerSchema = z.object({
  verdict: z.enum(['proceed', 'reject']),
  taskSummary: z.string().optional(),
});
const CoderSchema = z.object({
  branch: z.string(),
  commitsAhead: z.number(),
});
const ReviewerSchema = z.object({
  verdict: z.enum(['approve', 'revise']),
});

/**
 * Minimal runner-backed stage for exercising the orchestrator: builds a prompt,
 * calls the runner, stores the parsed value under `outputs[name]`.
 */
function runnerStage<T>(
  name: string,
  runner: AgentRunner,
  schema: z.ZodSchema<T>,
  buildPrompt: (s: PipelineState) => string,
): Stage {
  return {
    name,
    canRun: () => true,
    async execute(state, ctx) {
      const { value } = await runner.run<T>({
        prompt: buildPrompt(state),
        schema,
        signal: ctx.signal,
      });
      return { ...state, outputs: { ...state.outputs, [name]: value } };
    },
  };
}

describe('orchestrator end-to-end (mock stages)', () => {
  it('analyzer (proceed) → coder → revisionLoop(coder, reviewer approve) → finalizer', async () => {
    const dir = tmpStateDir();
    const store = new PipelineStateStore(dir);
    const ctx = makeContext();

    const analyzerRunner: AgentRunner = {
      run: mock(async () => ({ value: { verdict: 'proceed', taskSummary: 'add a button' }, costUsd: 0, toolUsage: {} })) as unknown as AgentRunner['run'],
    };
    const coderRunner: AgentRunner = {
      run: mock(async () => ({ value: { branch: 'agent/wi-101-add-button', commitsAhead: 1 }, costUsd: 0, toolUsage: {} })) as unknown as AgentRunner['run'],
    };
    const reviewerRunner: AgentRunner = {
      run: mock(async () => ({ value: { verdict: 'approve' }, costUsd: 0, toolUsage: {} })) as unknown as AgentRunner['run'],
    };

    const analyzer = runnerStage('analyzer', analyzerRunner, AnalyzerSchema, (s) => `analyze wi=${s.workItemId}`);
    const coder = runnerStage('coder', coderRunner, CoderSchema, (s) => `implement wi=${s.workItemId}`);
    const reviewer = runnerStage('reviewer', reviewerRunner, ReviewerSchema, () => 'review');

    const reviewLoop = revisionLoop({
      name: 'review-loop',
      producer: coder,
      reviewer,
      maxAttempts: 3,
      isApproved: (s) =>
        (s.outputs.reviewer as { verdict?: string } | undefined)?.verdict === 'approve',
    });

    const finalizer: Stage = {
      name: 'finalizer',
      canRun: () => true,
      execute: async (s) => ({ ...s, outputs: { ...s.outputs, finalized: true } }),
    };

    const stages: Stage[] = [analyzer, coder, reviewLoop, finalizer];
    const state = createInitialState(101, 'wi-101', FIXED_NOW);

    const final = await runPipeline({ stages, state, context: ctx, store });

    expect(final.completedAt).toBe(FIXED_NOW.toISOString());
    expect(final.terminalError).toBeUndefined();
    expect((final.outputs.analyzer as { verdict: string }).verdict).toBe('proceed');
    expect((final.outputs.coder as { branch: string }).branch).toBe('agent/wi-101-add-button');
    expect((final.outputs.reviewer as { verdict: string }).verdict).toBe('approve');
    expect(final.outputs.finalized).toBe(true);
    expect(final.history.map((h) => h.stage)).toEqual([
      'analyzer', 'coder', 'review-loop', 'finalizer',
    ]);

    // Persisted state matches
    const persisted = store.load(101)!;
    expect(persisted.completedAt).toBe(FIXED_NOW.toISOString());
  });

  it('pausing stage halts pipeline; second run with cleared gate completes it', async () => {
    const dir = tmpStateDir();
    const store = new PipelineStateStore(dir);
    const ctx = makeContext();

    let approvalGranted = false;
    const approval: Stage = {
      name: 'human-approval',
      canRun: () => true,
      execute: async (s) => {
        if (!approvalGranted) {
          throw new PipelinePauseError('waiting for human approval');
        }
        return s;
      },
    };
    const tail: Stage = {
      name: 'tail',
      canRun: () => true,
      execute: async (s) => ({ ...s, outputs: { ...s.outputs, tailRan: true } }),
    };
    const stages = [approval, tail];

    const state = createInitialState(101, 'wi-101', FIXED_NOW);

    const paused = await runPipeline({ stages, state, context: ctx, store });
    expect(paused.completedAt).toBeUndefined();
    expect(paused.currentStage).toBe('human-approval');
    expect(paused.outputs.tailRan).toBeUndefined();

    // Reload from disk and resume after approval is granted
    approvalGranted = true;
    const reloaded = store.load(101)!;
    const resumed = await runPipeline({
      stages,
      state: reloaded,
      context: makeContext(),
      store,
    });
    expect(resumed.completedAt).toBe(FIXED_NOW.toISOString());
    expect(resumed.outputs.tailRan).toBe(true);
  });
});
