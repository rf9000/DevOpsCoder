import { describe, it, expect, mock } from 'bun:test';
import { checkpoint } from '../../src/pipeline/checkpoint.ts';
import { PipelinePauseError } from '../../src/pipeline/stage.ts';
import type { PipelineContext } from '../../src/pipeline/stage.ts';
import type { AppConfig, PipelineState } from '../../src/types/index.ts';

const FIXED_NOW = new Date('2026-05-04T12:00:00.000Z');

function mockContext(): PipelineContext {
  const config: AppConfig = {
    org: 'o', orgUrl: 'https://dev.azure.com/o', project: 'p', pat: 't',
    repositoryName: 'test-repo',
    targetRepoPath: '/r', worktreeBase: '/w',
    triggerTag: 'agent implement', blockedTag: 'agent-blocked', needInputTag: 'need-input',
    pollIntervalMinutes: 5, concurrency: 1, maxRevisions: 3, maxRejectCycles: 3,
    coderMaxTurns: 80, testAuthorMaxTurns: 50,
    maxCostUsdPerWi: 5.00, stageTimeoutMs: {},
    claudeModel: 'm', stateDir: '.state', assignedToFilter: [], dryRun: false,
  };
  return {
    config,
    logger: { info: mock(() => {}), warn: mock(() => {}), error: mock(() => {}) },
    abortFlag: { aborted: false },
    now: () => FIXED_NOW,
  };
}

function mockState(currentStage = 'human-approval'): PipelineState {
  return {
    workItemId: 101,
    slug: 'wi-101',
    startedAt: FIXED_NOW.toISOString(),
    updatedAt: FIXED_NOW.toISOString(),
    currentStage,
    history: [],
    attempts: {},
    outputs: {},
  };
}

describe('checkpoint', () => {
  it('passes through when detect resolves true', async () => {
    const stage = checkpoint({
      name: 'human-approval',
      detect: async () => true,
    });
    const next = await stage.execute(mockState(), mockContext());
    expect(next.currentStage).toBe('human-approval');
    // currentStage is left as the checkpoint name; orchestrator advances it
  });

  it('throws PipelinePauseError when detect resolves false and pins currentStage', async () => {
    const stage = checkpoint({
      name: 'human-approval',
      detect: async () => false,
    });
    const initial = mockState('human-approval');
    let caught: unknown;
    try {
      await stage.execute(initial, mockContext());
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(PipelinePauseError);
    expect((caught as PipelinePauseError).reason).toContain('human-approval');
    expect(initial.currentStage).toBe('human-approval');
  });

  it('exposes the configured name and a default canRun of true', () => {
    const stage = checkpoint({
      name: 'cp',
      detect: async () => true,
    });
    expect(stage.name).toBe('cp');
    expect(stage.canRun(mockState())).toBe(true);
  });

  it('passes the state and context to the detect function', async () => {
    const detect = mock(async (_s: PipelineState, _ctx: PipelineContext) => true);
    const stage = checkpoint({ name: 'cp', detect });
    const ctx = mockContext();
    const state = mockState();
    await stage.execute(state, ctx);
    expect(detect).toHaveBeenCalledTimes(1);
    expect(detect.mock.calls[0]?.[0]).toBe(state);
    expect(detect.mock.calls[0]?.[1]).toBe(ctx);
  });
});
