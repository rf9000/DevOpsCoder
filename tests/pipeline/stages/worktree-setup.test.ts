import { describe, it, expect, mock } from 'bun:test';
import { createWorktreeSetupStage } from '../../../src/pipeline/stages/worktree-setup.ts';
import type {
  WorktreeManager,
  EnsureWorktreeArgs,
} from '../../../src/services/worktree-manager.ts';
import type {
  AppConfig,
  PipelineState,
  WorktreeContext,
} from '../../../src/types/index.ts';
import { createLogger } from '../../../src/utils/logger.ts';

function makeState(overrides: Partial<PipelineState> = {}): PipelineState {
  return {
    workItemId: 101,
    slug: 'fix-login',
    startedAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    currentStage: 'worktree-setup',
    history: [],
    attempts: {},
    outputs: {},
    ...overrides,
  };
}

function makeCtx(config: Partial<AppConfig> = {}) {
  const base: AppConfig = {
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
    ...config,
  };
  return {
    config: base,
    logger: createLogger(),
    abortFlag: { aborted: false },
    now: () => new Date(),
  };
}

interface RecordingManager extends WorktreeManager {
  ensureCalls: EnsureWorktreeArgs[];
}

function makeMgr(returnCtx: WorktreeContext): RecordingManager {
  const ensureCalls: EnsureWorktreeArgs[] = [];
  return {
    ensureCalls,
    async ensureWorktree(args) {
      ensureCalls.push(args);
      return returnCtx;
    },
    async removeWorktree() {},
  };
}

describe('createWorktreeSetupStage', () => {
  const sampleCtx: WorktreeContext = {
    path: '/w/wi-101-fix-login',
    branch: 'agent/wi-101-fix-login',
    baseSha: 'abc123',
  };

  it('stage.name is "worktree-setup" and canRun is true', () => {
    const stage = createWorktreeSetupStage({ worktreeManager: makeMgr(sampleCtx) });
    expect(stage.name).toBe('worktree-setup');
    expect(stage.canRun(makeState())).toBe(true);
  });

  it('first-time setup: no persisted worktree → ensureWorktree called without persistedWorktree', async () => {
    const mgr = makeMgr(sampleCtx);
    const stage = createWorktreeSetupStage({ worktreeManager: mgr });
    const state = await stage.execute(makeState(), makeCtx());
    expect(mgr.ensureCalls).toHaveLength(1);
    expect(mgr.ensureCalls[0]?.workItemId).toBe(101);
    expect(mgr.ensureCalls[0]?.slug).toBe('fix-login');
    expect(mgr.ensureCalls[0]?.persistedWorktree).toBeUndefined();
    expect(state.outputs.worktree).toEqual(sampleCtx);
  });

  it('re-entry: state.outputs.worktree present → forwarded as persistedWorktree', async () => {
    const mgr = makeMgr(sampleCtx);
    const stage = createWorktreeSetupStage({ worktreeManager: mgr });
    const stateWithPrior = makeState({
      outputs: {
        worktree: {
          path: '/w/old',
          branch: 'agent/wi-101-old-slug',
          baseSha: 'oldsha',
        },
      },
    });
    await stage.execute(stateWithPrior, makeCtx());
    expect(mgr.ensureCalls[0]?.persistedWorktree).toEqual({
      path: '/w/old',
      branch: 'agent/wi-101-old-slug',
      baseSha: 'oldsha',
    });
  });

  it('forwards workItemId and slug from state', async () => {
    const mgr = makeMgr(sampleCtx);
    const stage = createWorktreeSetupStage({ worktreeManager: mgr });
    await stage.execute(makeState({ workItemId: 999, slug: 'other' }), makeCtx());
    expect(mgr.ensureCalls[0]?.workItemId).toBe(999);
    expect(mgr.ensureCalls[0]?.slug).toBe('other');
  });

  it('propagates errors from worktree-manager', async () => {
    const mgr: WorktreeManager = {
      ensureWorktree: mock(async () => {
        throw new Error('git failed');
      }),
      removeWorktree: mock(async () => {}),
    };
    const stage = createWorktreeSetupStage({ worktreeManager: mgr });
    await expect(stage.execute(makeState(), makeCtx())).rejects.toThrow(
      'git failed',
    );
  });
});
