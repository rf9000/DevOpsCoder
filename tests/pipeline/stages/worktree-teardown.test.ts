/**
 * Tests for createWorktreeTeardownStage (Plan 5 task-10).
 *
 * Coverage map:
 *  T1 â€” happy path: removeWorktree called once with correct args; state returned unchanged
 *  T2 â€” best-effort on failure: removeWorktree throws; stage does NOT rethrow; logger.warn called; state unchanged
 *  T3 â€” no-op when state.outputs.worktree is undefined: removeWorktree NOT called; no log; state unchanged
 *  T4 â€” returns state unchanged on error (deep-equal input vs output when removeWorktree throws)
 */
import { describe, it, expect, mock } from 'bun:test';
import { createWorktreeTeardownStage } from '../../../src/pipeline/stages/worktree-teardown.ts';
import type { WorktreeManager } from '../../../src/services/worktree-manager.ts';
import type { Logger } from '../../../src/utils/logger.ts';
import type { AppConfig, PipelineState, WorktreeContext } from '../../../src/types/index.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const sampleWorktree: WorktreeContext = {
  path: '/w/wi-101-fix-login',
  branch: 'agent/wi-101-fix-login',
  baseSha: 'abc123',
};

function makeState(overrides: Partial<PipelineState> = {}): PipelineState {
  return {
    workItemId: 101,
    slug: 'fix-login',
    startedAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    currentStage: 'worktree-teardown',
    history: [],
    outputs: {
      worktree: sampleWorktree,
    },
    ...overrides,
  };
}

const baseConfig: AppConfig = {
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
  continiaCliPath: '.tools/continia.exe', continiaEnvProfileId: 'prof-1', continiaApiToken: 'tok', continiaAppPaths: ['App'], continiaTestAppPaths: ['App'], maxTestFixAttempts: 2, continiaTestTimeoutS: 600, dryRun: false,
};

function makeCtx() {
  return {
    config: baseConfig,
    logger: makeLogger(),
    abortFlag: { aborted: false },
    signal: new AbortController().signal,
    now: () => new Date(),
  };
}

function makeLogger(): Logger {
  return {
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  };
}

function makeWorktreeManager(overrides: Partial<WorktreeManager> = {}): WorktreeManager {
  return {
    ensureWorktree: mock(async () => sampleWorktree),
    removeWorktree: mock(async () => {}),
    ...overrides,
  } as WorktreeManager;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createWorktreeTeardownStage', () => {
  // T1 â€” happy path
  it('T1: calls removeWorktree once with correct args and returns state unchanged', async () => {
    const mgr = makeWorktreeManager();
    const logger = makeLogger();
    const stage = createWorktreeTeardownStage({ worktreeManager: mgr, logger });

    expect(stage.name).toBe('worktree-teardown');
    expect(stage.canRun(makeState())).toBe(true);

    const inputState = makeState();
    const result = await stage.execute(inputState, makeCtx());

    // removeWorktree called once with the correct args
    const removeCalls = (mgr.removeWorktree as ReturnType<typeof mock>).mock.calls;
    expect(removeCalls).toHaveLength(1);
    const callArg = removeCalls[0]![0] as { workItemId: number; slug: string; persistedWorktree: WorktreeContext };
    expect(callArg.workItemId).toBe(101);
    expect(callArg.slug).toBe('fix-login');
    expect(callArg.persistedWorktree).toEqual(sampleWorktree);

    // State returned unchanged
    expect(result).toBe(inputState);
    expect(result.outputs.worktree).toEqual(sampleWorktree);
  });

  // T2 â€” best-effort on failure
  it('T2: does NOT rethrow when removeWorktree throws; logs warn; returns state unchanged', async () => {
    const removeError = new Error('permission denied');
    const mgr = makeWorktreeManager({
      removeWorktree: mock(async () => {
        throw removeError;
      }),
    });
    const logger = makeLogger();
    const stage = createWorktreeTeardownStage({ worktreeManager: mgr, logger });

    const inputState = makeState();

    // Must NOT throw
    let result: PipelineState | undefined;
    await expect(async () => {
      result = await stage.execute(inputState, makeCtx());
    }).not.toThrow();

    // logger.warn was called with message + an error-shaped payload
    const warnCalls = (logger.warn as ReturnType<typeof mock>).mock.calls;
    expect(warnCalls.length).toBeGreaterThan(0);
    expect(warnCalls[0]![0]).toContain('worktree teardown failed');
    const warnPayload = warnCalls[0]![1] as { err: unknown };
    expect(warnPayload.err).toBe(removeError);

    // State returned unchanged
    expect(result).toBe(inputState);
  });

  // T3 â€” no-op when state.outputs.worktree is undefined
  it('T3: no-ops silently when state.outputs.worktree is undefined', async () => {
    const mgr = makeWorktreeManager();
    const logger = makeLogger();
    const stage = createWorktreeTeardownStage({ worktreeManager: mgr, logger });

    const inputState = makeState({ outputs: {} });
    const result = await stage.execute(inputState, makeCtx());

    // removeWorktree NOT called
    const removeCalls = (mgr.removeWorktree as ReturnType<typeof mock>).mock.calls;
    expect(removeCalls).toHaveLength(0);

    // No logging at all
    expect((logger.warn as ReturnType<typeof mock>).mock.calls).toHaveLength(0);
    expect((logger.info as ReturnType<typeof mock>).mock.calls).toHaveLength(0);
    expect((logger.error as ReturnType<typeof mock>).mock.calls).toHaveLength(0);

    // State returned unchanged
    expect(result).toBe(inputState);
    expect(result.outputs.worktree).toBeUndefined();
  });

  // T4 â€” deep-equal state on error path
  it('T4: state is deep-equal to input state when removeWorktree throws', async () => {
    const mgr = makeWorktreeManager({
      removeWorktree: mock(async () => {
        throw new Error('cleanup blew up');
      }),
    });
    const logger = makeLogger();
    const stage = createWorktreeTeardownStage({ worktreeManager: mgr, logger });

    const inputState = makeState({
      outputs: {
        worktree: sampleWorktree,
        coder: { summary: 'fixed', filesChanged: [], commits: ['abc'] },
      },
    });

    // Snapshot before execute
    const snapshot = JSON.parse(JSON.stringify(inputState)) as PipelineState;

    const result = await stage.execute(inputState, makeCtx());

    // Deep-equal
    expect(result).toEqual(snapshot);
  });
});

