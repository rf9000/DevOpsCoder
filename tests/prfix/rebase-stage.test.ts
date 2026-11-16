import { describe, it, expect, mock } from 'bun:test';
import { createRebaseStage } from '../../src/prfix/stages.ts';
import type { PrFixGit, RebaseStep } from '../../src/prfix/prfix-git.ts';
import type { PrFixConfig } from '../../src/prfix/config.ts';
import {
  ConflictCapError,
  MergeCommitsError,
  UnresolvedConflictError,
  type PrFixInput,
  type RebaseOutput,
} from '../../src/prfix/types.ts';
import type { AgentRunArgs, AgentRunner } from '../../src/pipeline/agent-stage.ts';
import type { PipelineContext } from '../../src/pipeline/stage.ts';
import { CostExceededError, type PipelineState, type WorktreeContext } from '../../src/types/index.ts';
import { makeTestConfig } from '../helpers/app-config.ts';
import { TEST_USAGE } from '../helpers/agent-usage.ts';

const TARGET = 'target0000';
const PRE = 'prehead000';
const NEW_HEAD = 'newhead000';

type Conflict = Extract<RebaseStep, { kind: 'conflict' }>;
const conflict = (n: number, files: string[] = ['a.al']): Conflict => ({
  kind: 'conflict',
  commit: `commit${n}abcdef`,
  subject: `subject ${n}`,
  files,
});
const done: RebaseStep = { kind: 'done', head: NEW_HEAD };

interface FakeGitOpts {
  start: RebaseStep;
  /** Steps returned by successive continueRebase calls. */
  continues?: RebaseStep[];
  markers?: string[];
  abortThrows?: boolean;
  unresolvable?: { path: string; kind: 'binary' | 'one-sided' }[];
  /** Successive fingerprintFiles results; by default every call returns fresh hashes (files changed). */
  fingerprints?: Record<string, string | null>[];
  unstaged?: string[];
  dirty?: string[];
  merges?: number;
}

function fakeGit(o: FakeGitOpts) {
  const continues = [...(o.continues ?? [])];
  const fingerprints = [...(o.fingerprints ?? [])];
  let fingerprintCalls = 0;
  const calls = {
    startRebase: mock(async (_p: string, _t: string) => o.start),
    continueRebase: mock(async (_p: string, _f: string[]) => {
      const next = continues.shift();
      if (!next) throw new Error('no more continue steps');
      return next;
    }),
    abortRebase: mock(async (_p: string) => {
      if (o.abortThrows) throw new Error('abort failed');
    }),
    filesWithMarkers: mock(async (_p: string, _f: string[]) => o.markers ?? []),
    headSha: mock(async (_p: string) => PRE),
    countCommits: mock(async (_p: string, _from: string) => 4),
    unresolvableConflicts: mock(async (_p: string) => o.unresolvable ?? []),
    fingerprintFiles: mock(async (_p: string, files: string[]) => {
      const next = fingerprints.shift();
      if (next) return next;
      fingerprintCalls += 1;
      return Object.fromEntries(files.map((f) => [f, `hash-${f}-${fingerprintCalls}`]));
    }),
    unstagedChanges: mock(async (_p: string) => o.unstaged ?? []),
    dirtyPaths: mock(async (_p: string) => o.dirty ?? []),
    countMergeCommits: mock(async (_p: string, _from: string) => o.merges ?? 0),
  };
  const git = {
    ...calls,
    createWorktree: mock(async () => { throw new Error('unused'); }),
    isUpToDate: mock(async () => false),
    push: mock(async () => {}),
    removeWorktree: mock(async () => {}),
  } as unknown as PrFixGit;
  return { git, calls };
}

function fakeRunner(costUsd = 0.1) {
  const calls: AgentRunArgs<unknown>[] = [];
  const runner = {
    run: mock(async (args: AgentRunArgs<unknown>) => {
      calls.push(args);
      return { value: { files: [{ path: 'a.al', resolution: 'kept both sides' }], summary: 'ok' }, costUsd, toolUsage: {}, usage: TEST_USAGE };
    }),
  } as unknown as AgentRunner;
  return { runner, calls };
}

function prfixConfig(overrides: Partial<Omit<PrFixConfig, 'app'>> = {}): PrFixConfig {
  return {
    app: makeTestConfig(),
    maxConflictCommits: 3,
    maxConflictFiles: 10,
    resolverMaxTurns: 40,
    ...overrides,
  };
}

function makeState(): PipelineState {
  const worktree: WorktreeContext & { targetSha: string } = {
    path: '/w/prfix-42',
    branch: 'prfix/pr-42',
    baseSha: PRE,
    targetSha: TARGET,
  };
  const prFixInput: PrFixInput = {
    pullRequestId: 42,
    repository: 'test-repo',
    pr: {
      id: 42,
      status: 'active',
      title: 'My PR',
      sourceRefName: 'refs/heads/feature',
      targetRefName: 'refs/heads/main',
      headCommit: PRE,
      isDraft: false,
      url: 'https://example/pr/42',
    },
  };
  return {
    workItemId: 0,
    slug: 'pr-42',
    startedAt: '2026-11-16T00:00:00.000Z',
    updatedAt: '2026-11-16T00:00:00.000Z',
    currentStage: null,
    history: [],
    outputs: { worktree, prFixInput },
  };
}

function makeCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    config: makeTestConfig(),
    logger: { info: mock(() => {}), warn: mock(() => {}), error: mock(() => {}) },
    abortFlag: { aborted: false },
    signal: new AbortController().signal,
    now: () => new Date('2026-11-16T00:00:00.000Z'),
    ...overrides,
  };
}

function stage(git: PrFixGit, runner: AgentRunner, prfix = prfixConfig()) {
  return createRebaseStage({ git, prfix, runner, promptTemplate: 'SYSTEM' });
}

describe('createRebaseStage', () => {
  it('is named rebase-onto-target', () => {
    const { git } = fakeGit({ start: done });
    expect(stage(git, fakeRunner().runner).name).toBe('rebase-onto-target');
  });

  it('clean rebase makes no agent call and records commitsReplayed', async () => {
    const { git, calls } = fakeGit({ start: done });
    const r = fakeRunner();
    const out = await stage(git, r.runner).execute(makeState(), makeCtx());

    expect(r.calls).toHaveLength(0);
    expect(calls.startRebase).toHaveBeenCalledWith('/w/prfix-42', TARGET);
    expect(calls.countCommits).toHaveBeenCalledWith('/w/prfix-42', TARGET);
    const rebase = out.outputs.rebase as RebaseOutput;
    expect(rebase).toEqual({
      preRebaseSha: PRE,
      targetSha: TARGET,
      newHeadSha: NEW_HEAD,
      commitsReplayed: 4,
      conflicts: [],
    });
    expect(calls.abortRebase).not.toHaveBeenCalled();
  });

  it('one conflict → resolver called once → continueRebase with exactly the conflicted files → conflicts[0] recorded', async () => {
    const c = conflict(1, ['a.al', 'b.al']);
    const { git, calls } = fakeGit({ start: c, continues: [done] });
    const r = fakeRunner();
    const reportProgress = mock((_d: string) => {});
    const out = await stage(git, r.runner).execute(makeState(), makeCtx({ reportProgress }));

    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.prompt).toContain(c.commit);
    expect(calls.filesWithMarkers).toHaveBeenCalledWith('/w/prfix-42', ['a.al', 'b.al']);
    expect(calls.continueRebase).toHaveBeenCalledTimes(1);
    expect(calls.continueRebase).toHaveBeenCalledWith('/w/prfix-42', ['a.al', 'b.al']);
    const rebase = out.outputs.rebase as RebaseOutput;
    expect(rebase.conflicts).toEqual([
      {
        commit: c.commit,
        subject: c.subject,
        files: ['a.al', 'b.al'],
        summary: 'ok',
        resolutions: [{ path: 'a.al', resolution: 'kept both sides' }],
      },
    ]);
    expect(rebase.newHeadSha).toBe(NEW_HEAD);
    expect(reportProgress).toHaveBeenCalledWith('conflict 1 · commit1');
  });

  it('refuses to continue while markers remain', async () => {
    const { git, calls } = fakeGit({ start: conflict(1), continues: [done], markers: ['a.al'] });
    const err = await stage(git, fakeRunner().runner).execute(makeState(), makeCtx()).catch((e) => e);

    expect(err).toBeInstanceOf(UnresolvedConflictError);
    expect((err as UnresolvedConflictError).files).toEqual(['a.al']);
    expect(calls.abortRebase).toHaveBeenCalledTimes(1);
    expect(calls.continueRebase).not.toHaveBeenCalled();
  });

  it('aborts with ConflictCapError when conflicted commits exceed maxConflictCommits', async () => {
    const { git, calls } = fakeGit({ start: conflict(1), continues: [conflict(2), done] });
    const r = fakeRunner();
    const err = await stage(git, r.runner, prfixConfig({ maxConflictCommits: 1 }))
      .execute(makeState(), makeCtx())
      .catch((e) => e);

    expect(err).toBeInstanceOf(ConflictCapError);
    expect((err as ConflictCapError).reason).toContain('1');
    expect(r.calls).toHaveLength(1);
    expect(calls.abortRebase).toHaveBeenCalledTimes(1);
  });

  it('aborts with ConflictCapError when one commit has more than maxConflictFiles files, before calling the resolver', async () => {
    const { git, calls } = fakeGit({ start: conflict(1, ['a.al', 'b.al', 'c.al']) });
    const r = fakeRunner();
    const err = await stage(git, r.runner, prfixConfig({ maxConflictFiles: 2 }))
      .execute(makeState(), makeCtx())
      .catch((e) => e);

    expect(err).toBeInstanceOf(ConflictCapError);
    expect((err as ConflictCapError).files).toEqual(['a.al', 'b.al', 'c.al']);
    expect(r.calls).toHaveLength(0);
    expect(calls.abortRebase).toHaveBeenCalledTimes(1);
  });

  it('checks the cost cap before every resolver call', async () => {
    const { git, calls } = fakeGit({ start: conflict(1), continues: [done] });
    const r = fakeRunner();
    const state = makeState();
    state.outputs.cost = { total: 999, perStage: {} };
    const err = await stage(git, r.runner).execute(state, makeCtx()).catch((e) => e);

    expect(err).toBeInstanceOf(CostExceededError);
    expect((err as CostExceededError).stage).toBe('rebase-onto-target');
    expect(r.calls).toHaveLength(0);
    expect(calls.abortRebase).toHaveBeenCalledTimes(1);
  });

  it('checks the cost cap again after the first resolver call spent past it', async () => {
    const { git, calls } = fakeGit({ start: conflict(1), continues: [conflict(2), done] });
    // makeTestConfig caps at $5; one call costs $6.
    const r = fakeRunner(6);
    const err = await stage(git, r.runner).execute(makeState(), makeCtx()).catch((e) => e);

    expect(err).toBeInstanceOf(CostExceededError);
    expect(r.calls).toHaveLength(1);
    expect(calls.abortRebase).toHaveBeenCalledTimes(1);
  });

  it('an aborted signal aborts the rebase and rethrows', async () => {
    const { git, calls } = fakeGit({ start: conflict(1), continues: [done] });
    const r = fakeRunner();
    const ac = new AbortController();
    ac.abort();
    const err = await stage(git, r.runner).execute(makeState(), makeCtx({ signal: ac.signal })).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe('AbortError');
    expect(r.calls).toHaveLength(0);
    expect(calls.abortRebase).toHaveBeenCalledTimes(1);
  });

  it('a failing abort is logged and never masks the original error', async () => {
    const { git } = fakeGit({ start: conflict(1), markers: ['a.al'], abortThrows: true });
    const ctx = makeCtx();
    const err = await stage(git, fakeRunner().runner).execute(makeState(), ctx).catch((e) => e);

    expect(err).toBeInstanceOf(UnresolvedConflictError);
    expect(ctx.logger.warn).toHaveBeenCalled();
  });

  it('a resolver failure aborts the rebase and rethrows', async () => {
    const { git, calls } = fakeGit({ start: conflict(1), continues: [done] });
    const runner = { run: mock(async () => { throw new Error('runner down'); }) } as unknown as AgentRunner;
    await expect(stage(git, runner).execute(makeState(), makeCtx())).rejects.toThrow('runner down');
    expect(calls.abortRebase).toHaveBeenCalledTimes(1);
  });

  it('a throwing startRebase also aborts the rebase', async () => {
    const { git, calls } = fakeGit({ start: done });
    calls.startRebase.mockImplementation(async () => { throw new Error('stopped without conflicted files'); });
    await expect(stage(git, fakeRunner().runner).execute(makeState(), makeCtx())).rejects.toThrow('stopped without');
    expect(calls.abortRebase).toHaveBeenCalledTimes(1);
  });

  it('sets worktree.baseSha to targetSha', async () => {
    const { git } = fakeGit({ start: done });
    const out = await stage(git, fakeRunner().runner).execute(makeState(), makeCtx());
    expect((out.outputs.worktree as WorktreeContext).baseSha).toBe(TARGET);
  });

  it('refuses a branch with merge commits before the rebase starts', async () => {
    const { git, calls } = fakeGit({ start: done, merges: 2 });
    const r = fakeRunner();
    const err = await stage(git, r.runner).execute(makeState(), makeCtx()).catch((e) => e);

    expect(err).toBeInstanceOf(MergeCommitsError);
    expect((err as MergeCommitsError).count).toBe(2);
    expect((err as Error).message).toBe('branch contains 2 merge commits; rebase it manually');
    expect(calls.countMergeCommits).toHaveBeenCalledWith('/w/prfix-42', TARGET);
    expect(calls.startRebase).not.toHaveBeenCalled();
    expect(r.calls).toHaveLength(0);
  });

  it('a binary or one-sided conflict is unresolvable up front: no resolver call', async () => {
    const { git, calls } = fakeGit({
      start: conflict(1, ['a.al', 'Bin.dat', 'Gone.al']),
      continues: [done],
      unresolvable: [
        { path: 'Bin.dat', kind: 'binary' },
        { path: 'Gone.al', kind: 'one-sided' },
      ],
    });
    const r = fakeRunner();
    const err = await stage(git, r.runner).execute(makeState(), makeCtx()).catch((e) => e);

    expect(err).toBeInstanceOf(UnresolvedConflictError);
    expect((err as UnresolvedConflictError).files).toEqual(['Bin.dat', 'Gone.al']);
    expect(r.calls).toHaveLength(0);
    expect(calls.continueRebase).not.toHaveBeenCalled();
    expect(calls.abortRebase).toHaveBeenCalledTimes(1);
  });

  it('a listed file the resolver left unchanged is unresolved, even without markers', async () => {
    const { git, calls } = fakeGit({
      start: conflict(1, ['a.al', 'b.al']),
      continues: [done],
      fingerprints: [
        { 'a.al': 'h-a', 'b.al': 'h-b' },
        { 'a.al': 'h-a2', 'b.al': 'h-b' },
      ],
    });
    const err = await stage(git, fakeRunner().runner).execute(makeState(), makeCtx()).catch((e) => e);

    expect(err).toBeInstanceOf(UnresolvedConflictError);
    expect((err as UnresolvedConflictError).files).toEqual(['b.al']);
    expect(calls.continueRebase).not.toHaveBeenCalled();
    expect(calls.abortRebase).toHaveBeenCalledTimes(1);
  });

  it('a listed file the resolver deleted is unresolved', async () => {
    const { git, calls } = fakeGit({
      start: conflict(1, ['a.al']),
      continues: [done],
      fingerprints: [{ 'a.al': 'h-a' }, { 'a.al': null }],
    });
    const err = await stage(git, fakeRunner().runner).execute(makeState(), makeCtx()).catch((e) => e);

    expect(err).toBeInstanceOf(UnresolvedConflictError);
    expect((err as UnresolvedConflictError).files).toEqual(['a.al']);
    expect(calls.continueRebase).not.toHaveBeenCalled();
  });

  it('tracked edits outside the conflicted files are refused before continueRebase, naming them', async () => {
    const { git, calls } = fakeGit({ start: conflict(1, ['a.al']), continues: [done], unstaged: ['a.al', 'Other.al'] });
    const err = await stage(git, fakeRunner().runner).execute(makeState(), makeCtx()).catch((e) => e);

    expect(err).toBeInstanceOf(UnresolvedConflictError);
    expect((err as UnresolvedConflictError).files).toEqual(['Other.al']);
    expect((err as Error).message).toContain('Other.al');
    expect(calls.continueRebase).not.toHaveBeenCalled();
    expect(calls.abortRebase).toHaveBeenCalledTimes(1);
  });

  it('refuses a finished rebase that leaves untracked or modified files (they would be verified, not pushed)', async () => {
    const { git } = fakeGit({ start: conflict(1), continues: [done], dirty: ['?? Stray.al'] });
    const err = await stage(git, fakeRunner().runner).execute(makeState(), makeCtx()).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('Stray.al');
  });

  it('a clean worktree after the rebase passes the dirty check', async () => {
    const { git, calls } = fakeGit({ start: done, dirty: [] });
    await stage(git, fakeRunner().runner).execute(makeState(), makeCtx());
    expect(calls.dirtyPaths).toHaveBeenCalledWith('/w/prfix-42');
  });

  it('throws when worktree or prFixInput is missing', async () => {
    const { git } = fakeGit({ start: done });
    const s = makeState();
    delete s.outputs.prFixInput;
    await expect(stage(git, fakeRunner().runner).execute(s, makeCtx())).rejects.toThrow(/prFixInput/);
  });
});
