import { describe, it, expect } from 'bun:test';
import { createReviewerStage } from '../../../src/pipeline/stages/reviewer.ts';
import { createLogger } from '../../../src/utils/logger.ts';
import type { AppConfig, PipelineState } from '../../../src/types/index.ts';

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
  concurrency: 1,
  maxRevisions: 3,
  maxRejectCycles: 3,
  coderMaxTurns: 80,
  testAuthorMaxTurns: 50,
  claudeModel: 'claude-opus-4-7',
  stateDir: '.state',
  assignedToFilter: [],
  dryRun: false,
};

function makeState(): PipelineState {
  return {
    workItemId: 101,
    slug: 'wi',
    startedAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    currentStage: 'reviewer',
    history: [],
    attempts: {},
    outputs: {},
  };
}

function makeCtx() {
  return {
    config: baseConfig,
    logger: createLogger(),
    abortFlag: { aborted: false },
    now: () => new Date(),
  };
}

describe('createReviewerStage (Plan 4 stub)', () => {
  it('stage.name is "reviewer" and canRun returns true', () => {
    const stage = createReviewerStage({});
    expect(stage.name).toBe('reviewer');
    expect(stage.canRun(makeState())).toBe(true);
  });

  it('sets state.outputs.reviewer = { approved: true, findings: [], attempts: 0 }', async () => {
    const stage = createReviewerStage({});
    const result = await stage.execute(makeState(), makeCtx());
    expect(result.outputs.reviewer).toEqual({ approved: true, findings: [], attempts: 0 });
  });
});
