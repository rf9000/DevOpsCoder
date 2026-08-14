import { describe, it, expect, mock } from 'bun:test';
import { revisionLoop } from '../../src/pipeline/revision-loop.ts';
import type { Stage, PipelineContext } from '../../src/pipeline/stage.ts';
import type { AppConfig, PipelineState } from '../../src/types/index.ts';

const FIXED_NOW = new Date('2026-05-04T12:00:00.000Z');

function mockContext(overrides: Partial<PipelineContext> = {}): PipelineContext {
  const config: AppConfig = {
    orgUrl: 'https://dev.azure.com/o', project: 'p', pat: 't',
    repositoryName: 'test-repo',
    targetRepoPath: '/r', worktreeBase: '/w',
    triggerTag: 'agent implement', blockedTag: 'agent-blocked', needInputTag: 'need-input',
    pollIntervalMinutes: 5, concurrency: 1, maxRevisions: 3, maxRejectCycles: 3,
    coderMaxTurns: 80, testAuthorMaxTurns: 50,
    maxCostUsdPerWi: 5.00, stageTimeoutMs: {},
    claudeModel: 'm', stateDir: '.state', assignedToFilter: [], continiaCliPath: '.tools/continia.exe', continiaEnvProfileId: 'prof-1', continiaApiToken: 'tok', continiaAppPaths: ['App'], continiaTestAppPaths: ['App'], maxTestFixAttempts: 2, continiaTestTimeoutS: 600, dryRun: false,
  };
  return {
    config,
    logger: { info: mock(() => {}), warn: mock(() => {}), error: mock(() => {}) },
    abortFlag: { aborted: false },
    signal: new AbortController().signal,
    now: () => FIXED_NOW,
    ...overrides,
  };
}

function mockState(): PipelineState {
  return {
    workItemId: 101,
    slug: 'wi-101',
    startedAt: FIXED_NOW.toISOString(),
    updatedAt: FIXED_NOW.toISOString(),
    currentStage: null,
    history: [],
    outputs: {},
  };
}

function makeStage(
  name: string,
  exec: (s: PipelineState, c: PipelineContext) => Promise<PipelineState>,
): Stage {
  return { name, canRun: () => true, execute: exec };
}

describe('revisionLoop', () => {
  it('calls producer then reviewer, exits on first approval', async () => {
    const calls: string[] = [];
    const producer = makeStage('coder', async (s) => { calls.push('coder'); return s; });
    const reviewer = makeStage('reviewer', async (s) => {
      calls.push('reviewer');
      return { ...s, outputs: { ...s.outputs, reviewer: { verdict: 'approve' } } };
    });

    const stage = revisionLoop({
      name: 'review-loop',
      producer,
      reviewer,
      maxAttempts: 3,
      isApproved: (s) =>
        (s.outputs.reviewer as { verdict?: string } | undefined)?.verdict === 'approve',
    });

    const final = await stage.execute(mockState(), mockContext());
    expect(calls).toEqual(['coder', 'reviewer']);
    expect((final.outputs.reviewer as { verdict: string }).verdict).toBe('approve');
  });

  it('loops up to maxAttempts when reviewer keeps rejecting', async () => {
    const calls: string[] = [];
    let attempt = 0;
    const producer = makeStage('coder', async (s) => { calls.push('coder'); return s; });
    const reviewer = makeStage('reviewer', async (s) => {
      attempt++;
      calls.push(`reviewer:${attempt}`);
      const verdict = attempt >= 3 ? 'approve' : 'revise';
      return { ...s, outputs: { ...s.outputs, reviewer: { verdict } } };
    });

    const stage = revisionLoop({
      name: 'review-loop',
      producer,
      reviewer,
      maxAttempts: 5,
      isApproved: (s) =>
        (s.outputs.reviewer as { verdict?: string } | undefined)?.verdict === 'approve',
    });

    await stage.execute(mockState(), mockContext());
    expect(calls).toEqual([
      'coder', 'reviewer:1',
      'coder', 'reviewer:2',
      'coder', 'reviewer:3',
    ]);
  });

  it('calls onExhausted and returns its state when maxAttempts is hit without approval', async () => {
    const producer = makeStage('coder', async (s) => s);
    const reviewer = makeStage('reviewer', async (s) =>
      ({ ...s, outputs: { ...s.outputs, reviewer: { verdict: 'revise' } } }),
    );
    const onExhausted = mock(async (s: PipelineState) =>
      ({ ...s, outputs: { ...s.outputs, exhausted: true } }),
    );

    const stage = revisionLoop({
      name: 'review-loop',
      producer,
      reviewer,
      maxAttempts: 2,
      isApproved: () => false,
      onExhausted,
    });

    const final = await stage.execute(mockState(), mockContext());
    expect(onExhausted).toHaveBeenCalledTimes(1);
    expect(final.outputs.exhausted).toBe(true);
  });

  it('returns the latest state when maxAttempts is hit and onExhausted is not provided', async () => {
    const producer = makeStage('coder', async (s) => s);
    const reviewer = makeStage('reviewer', async (s) =>
      ({ ...s, outputs: { ...s.outputs, reviewer: { verdict: 'revise' } } }),
    );

    const stage = revisionLoop({
      name: 'review-loop',
      producer,
      reviewer,
      maxAttempts: 2,
      isApproved: () => false,
    });

    const final = await stage.execute(mockState(), mockContext());
    expect((final.outputs.reviewer as { verdict: string }).verdict).toBe('revise');
  });

  it('breaks out of the loop when abortFlag becomes true between attempts', async () => {
    const abortFlag = { aborted: false };
    const calls: string[] = [];
    const producer = makeStage('coder', async (s) => { calls.push('coder'); return s; });
    const reviewer = makeStage('reviewer', async (s) => {
      calls.push('reviewer');
      abortFlag.aborted = true;
      return { ...s, outputs: { ...s.outputs, reviewer: { verdict: 'revise' } } };
    });

    const stage = revisionLoop({
      name: 'review-loop',
      producer,
      reviewer,
      maxAttempts: 5,
      isApproved: () => false,
    });
    await stage.execute(mockState(), mockContext({ abortFlag }));
    expect(calls).toEqual(['coder', 'reviewer']);
  });

  it('exposes the configured stage name', () => {
    const noop = makeStage('x', async (s) => s);
    const stage = revisionLoop({
      name: 'rl',
      producer: noop,
      reviewer: noop,
      maxAttempts: 1,
      isApproved: () => true,
    });
    expect(stage.name).toBe('rl');
  });
});
