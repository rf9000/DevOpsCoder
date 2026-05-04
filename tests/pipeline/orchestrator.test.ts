import { describe, it, expect, mock } from 'bun:test';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  runPipeline,
  createInitialState,
  StageNotFoundError,
} from '../../src/pipeline/orchestrator.ts';
import type { Stage, PipelineContext } from '../../src/pipeline/stage.ts';
import { PipelinePauseError } from '../../src/pipeline/stage.ts';
import { PipelineStateStore } from '../../src/state/state-store.ts';
import type { AppConfig, PipelineState } from '../../src/types/index.ts';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'devops-coder-orch-'));
}

const FIXED_NOW = new Date('2026-05-04T12:00:00.000Z');

function makeContext(overrides: Partial<PipelineContext> = {}): PipelineContext {
  const config: AppConfig = {
    org: 'o', orgUrl: 'https://dev.azure.com/o', project: 'p', pat: 't',
    targetRepoPath: '/r', worktreeBase: '/w',
    triggerTag: 'agent implement', blockedTag: 'agent-blocked', needInputTag: 'need-input',
    pollIntervalMinutes: 5, concurrency: 1, maxRevisions: 3, maxRejectCycles: 3,
    claudeModel: 'm', stateDir: '.state', assignedToFilter: [], dryRun: false,
  };
  const logger = { info: mock(() => {}), error: mock(() => {}) };
  return {
    config,
    logger,
    abortFlag: { aborted: false },
    now: () => FIXED_NOW,
    ...overrides,
  };
}

function makeStage(
  name: string,
  exec: (s: PipelineState, c: PipelineContext) => Promise<PipelineState> = async (s) => s,
  canRun: (s: PipelineState) => boolean = () => true,
): Stage {
  return { name, canRun, execute: exec };
}

describe('createInitialState', () => {
  it('produces a state with timestamps and empty bookkeeping fields', () => {
    const state = createInitialState(101, 'wi-101', FIXED_NOW);
    expect(state.workItemId).toBe(101);
    expect(state.slug).toBe('wi-101');
    expect(state.startedAt).toBe(FIXED_NOW.toISOString());
    expect(state.updatedAt).toBe(FIXED_NOW.toISOString());
    expect(state.currentStage).toBeNull();
    expect(state.history).toEqual([]);
    expect(state.attempts).toEqual({});
    expect(state.outputs).toEqual({});
    expect(state.completedAt).toBeUndefined();
  });
});

describe('runPipeline', () => {
  it('runs stages in order and marks completedAt at the end', async () => {
    const dir = tmpDir();
    const store = new PipelineStateStore(dir);
    const ctx = makeContext();
    const calls: string[] = [];
    const stages: Stage[] = [
      makeStage('a', async (s) => { calls.push('a'); return s; }),
      makeStage('b', async (s) => { calls.push('b'); return s; }),
      makeStage('c', async (s) => { calls.push('c'); return s; }),
    ];
    const state = createInitialState(101, 'wi-101', FIXED_NOW);

    const final = await runPipeline({ stages, state, context: ctx, store });

    expect(calls).toEqual(['a', 'b', 'c']);
    expect(final.completedAt).toBe(FIXED_NOW.toISOString());
    expect(final.currentStage).toBeNull();
    expect(final.history.map((h) => h.stage)).toEqual(['a', 'b', 'c']);
    expect(final.history.every((h) => h.outcome === 'success')).toBe(true);
    expect(final.attempts).toEqual({ a: 1, b: 1, c: 1 });
  });

  it('persists state after each stage', async () => {
    const dir = tmpDir();
    const store = new PipelineStateStore(dir);
    const ctx = makeContext();
    let stageBSaw: PipelineState | undefined;
    const stages: Stage[] = [
      makeStage('a', async (s) => s),
      makeStage('b', async (s, _c) => {
        stageBSaw = store.load(s.workItemId)!;
        return s;
      }),
    ];
    const state = createInitialState(101, 'wi-101', FIXED_NOW);
    await runPipeline({ stages, state, context: ctx, store });

    expect(stageBSaw).toBeDefined();
    expect(stageBSaw!.history.map((h) => h.stage)).toEqual(['a']);
  });

  it('skips stages whose canRun returns false and records a skip outcome', async () => {
    const dir = tmpDir();
    const store = new PipelineStateStore(dir);
    const ctx = makeContext();
    const stages: Stage[] = [
      makeStage('a'),
      makeStage('b', async (s) => s, () => false),
      makeStage('c'),
    ];
    const state = createInitialState(101, 'wi-101', FIXED_NOW);
    const final = await runPipeline({ stages, state, context: ctx, store });
    expect(final.history.map((h) => `${h.stage}:${h.outcome}`)).toEqual([
      'a:success', 'b:skip', 'c:success',
    ]);
    expect(final.completedAt).toBeDefined();
  });

  it('records terminal error and rethrows when a stage throws', async () => {
    const dir = tmpDir();
    const store = new PipelineStateStore(dir);
    const ctx = makeContext();
    const stages: Stage[] = [
      makeStage('a'),
      makeStage('b', async () => { throw new Error('boom'); }),
      makeStage('c'),
    ];
    const state = createInitialState(101, 'wi-101', FIXED_NOW);

    let caught: unknown;
    try {
      await runPipeline({ stages, state, context: ctx, store });
    } catch (e) { caught = e; }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('boom');

    const persisted = store.load(101)!;
    expect(persisted.terminalError?.stage).toBe('b');
    expect(persisted.terminalError?.message).toBe('boom');
    expect(persisted.completedAt).toBeUndefined();
    expect(persisted.history.find((h) => h.stage === 'b')?.outcome).toBe('failure');
  });

  it('stops gracefully and persists state when a stage throws PipelinePauseError', async () => {
    const dir = tmpDir();
    const store = new PipelineStateStore(dir);
    const ctx = makeContext();
    const stages: Stage[] = [
      makeStage('a'),
      makeStage('b', async (s) => {
        s.currentStage = 'b';
        throw new PipelinePauseError('waiting on human');
      }),
      makeStage('c'),
    ];
    const state = createInitialState(101, 'wi-101', FIXED_NOW);
    const final = await runPipeline({ stages, state, context: ctx, store });

    expect(final.currentStage).toBe('b');
    expect(final.completedAt).toBeUndefined();
    expect(final.terminalError).toBeUndefined();

    const persisted = store.load(101)!;
    expect(persisted.currentStage).toBe('b');
    expect(persisted.history.find((h) => h.stage === 'b')?.outcome).toBe('pause');
  });

  it('honours abortFlag and exits without running further stages', async () => {
    const dir = tmpDir();
    const store = new PipelineStateStore(dir);
    const abortFlag = { aborted: false };
    const ctx = makeContext({ abortFlag });
    const calls: string[] = [];
    const stages: Stage[] = [
      makeStage('a', async (s) => { calls.push('a'); abortFlag.aborted = true; return s; }),
      makeStage('b', async (s) => { calls.push('b'); return s; }),
    ];
    const state = createInitialState(101, 'wi-101', FIXED_NOW);
    const final = await runPipeline({ stages, state, context: ctx, store });

    expect(calls).toEqual(['a']);
    expect(final.completedAt).toBeUndefined();
  });

  it('throws StageNotFoundError when currentStage is unknown', async () => {
    const dir = tmpDir();
    const store = new PipelineStateStore(dir);
    const ctx = makeContext();
    const stages: Stage[] = [makeStage('a'), makeStage('b')];
    const state = createInitialState(101, 'wi-101', FIXED_NOW);
    state.currentStage = 'ghost';

    let caught: unknown;
    try {
      await runPipeline({ stages, state, context: ctx, store });
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(StageNotFoundError);
  });

  it('resumes from state.currentStage when set', async () => {
    const dir = tmpDir();
    const store = new PipelineStateStore(dir);
    const ctx = makeContext();
    const calls: string[] = [];
    const stages: Stage[] = [
      makeStage('a', async (s) => { calls.push('a'); return s; }),
      makeStage('b', async (s) => { calls.push('b'); return s; }),
      makeStage('c', async (s) => { calls.push('c'); return s; }),
    ];
    const state = createInitialState(101, 'wi-101', FIXED_NOW);
    state.currentStage = 'b';
    await runPipeline({ stages, state, context: ctx, store });
    expect(calls).toEqual(['b', 'c']);
  });
});
