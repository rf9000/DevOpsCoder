import { describe, it, expect, mock } from 'bun:test';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { fixPr } from '../../src/prfix/fix-pr.ts';
import type { PrFixConfig } from '../../src/prfix/config.ts';
import type { PrFixGit } from '../../src/prfix/prfix-git.ts';
import {
  ConflictCapError,
  MergeCommitsError,
  PrUpToDateError,
  UnresolvedConflictError,
  type ConflictResolution,
  type RebaseOutput,
} from '../../src/prfix/types.ts';
import { HeadMovedError } from '../../src/suggestions/suggestion-git.ts';
import { CostExceededError, VerificationFailedError, type PullRequestDetails } from '../../src/types/index.ts';
import type { Stage } from '../../src/pipeline/stage.ts';
import type { AdoClient } from '../../src/sdk/azure-devops-client.ts';
import { PipelineStateStore } from '../../src/state/state-store.ts';
import { makeTestConfig } from '../helpers/app-config.ts';

const PAT = 'secret-pat-0123456789';
const PR_ID = 42;
const PR: PullRequestDetails = {
  id: PR_ID,
  status: 'active',
  title: 'My PR',
  sourceRefName: 'refs/heads/feature',
  targetRefName: 'refs/heads/main',
  headCommit: 'head000',
  isDraft: false,
  url: 'https://example/pr/42',
};
const WT = { path: '/wt/prfix-42', branch: 'prfix/pr-42', baseSha: 'head000', targetSha: 'target0' };
const CONFLICT: ConflictResolution = {
  commit: 'c1',
  subject: 'feat: x',
  files: ['a.al'],
  summary: 'kept both',
  resolutions: [{ path: 'a.al', resolution: 'kept both' }],
};
const REBASE: RebaseOutput = {
  preRebaseSha: 'head000',
  targetSha: 'target0',
  newHeadSha: 'new0000',
  commitsReplayed: 2,
  conflicts: [CONFLICT],
};
const ENV = { envId: 'env-1', name: `wi-${PR_ID}-pr-${PR_ID}`, status: 'Running', createdAt: 'x' };

function stage(name: string, fn: (o: Record<string, unknown>) => void): Stage {
  return { name, costFree: true, canRun: () => true, async execute(s) { fn(s.outputs); return s; } };
}

function throwing(name: string, err: Error): Stage {
  return { name, costFree: true, canRun: () => true, async execute() { throw err; } };
}

const intake = stage('pr-intake', (o) => {
  o.prFixInput = { ...(o.prFixInput as object), pr: PR };
});
const worktree = stage('pr-worktree', (o) => {
  o.worktree = WT;
});
const env = stage('env-provision', (o) => {
  o.environment = ENV;
});
const rebase = stage('rebase-onto-target', (o) => {
  o.rebase = REBASE;
});
const push = stage('push-rebased', () => {});
const comment = stage('pr-comment', () => {});

function setup(
  stages: Stage[],
  opts: { dryRun?: boolean; keepEnv?: boolean; commentFails?: boolean; deleteFails?: boolean; abortFlag?: { aborted: boolean } } = {},
) {
  const app = makeTestConfig(
    { STATE_DIR: mkdtempSync(join(tmpdir(), 'prfix-')) },
    { dryRun: opts.dryRun ?? false, pat: PAT },
  );
  const prfix: PrFixConfig = {
    app,
    maxConflictCommits: 3,
    maxConflictFiles: 10,
    resolverMaxTurns: 40,
    renumberCollisions: true,
    ninjaCommand: { command: 'npx', args: [] },
    ninjaCallTimeoutMs: 60_000,
  };
  const removeWorktree = mock(async (_wt: unknown) => {});
  const git = { removeWorktree } as unknown as PrFixGit;
  const createPullRequestThread = mock(async (_a: { content: string }, _o?: unknown) => {
    if (opts.commentFails) throw new Error('ado down');
  });
  const ado = { createPullRequestThread } as unknown as AdoClient;
  const deleteEnvironment = mock(async (_id: string, _o: unknown) => {
    if (opts.deleteFails) throw new Error('delete failed');
  });
  const warn = mock((_m: string) => {});
  const logger = { info: () => {}, warn, error: () => {} };
  const outcome = fixPr({
    prfix,
    logger,
    ado,
    git,
    continiaCli: { deleteEnvironment },
    stages,
    store: new PipelineStateStore(join(app.stateDir, 'prfix')),
    pullRequestId: PR_ID,
    keepEnv: opts.keepEnv ?? false,
    ...(opts.abortFlag ? { abortFlag: opts.abortFlag } : {}),
    now: () => new Date('2026-11-16T00:00:00.000Z'),
  });
  return { outcome, removeWorktree, createPullRequestThread, deleteEnvironment, warn };
}

describe('fixPr', () => {
  it('success: rebased outcome, worktree removed, environment deleted', async () => {
    const { outcome, removeWorktree, deleteEnvironment } = setup([intake, worktree, rebase, env, push, comment]);
    expect(await outcome).toEqual({
      ok: true,
      status: 'rebased',
      pullRequestId: PR_ID,
      oldHead: 'head000',
      newHead: 'new0000',
      conflicts: [CONFLICT],
      renumbered: [],
      costUsd: 0,
      error: null,
    });
    expect(removeWorktree.mock.calls).toEqual([[WT]]);
    expect(deleteEnvironment.mock.calls[0]?.[0]).toBe('env-1');
  });

  it('PrUpToDateError maps to up-to-date, ok', async () => {
    const o = await setup([intake, throwing('pr-worktree', new PrUpToDateError('already'))]).outcome;
    expect(o.status).toBe('up-to-date');
    expect(o.ok).toBe(true);
    expect(o.oldHead).toBe('head000');
    expect(o.newHead).toBeNull();
    expect(o.error).toBeNull();
  });

  it('up-to-date skips every later stage', async () => {
    const later = mock(() => {});
    const o = await setup([
      intake,
      { name: 'pr-worktree', costFree: true, canRun: () => true, async execute(s) { s.outputs.worktree = WT; throw new PrUpToDateError('already'); } },
      stage('rebase-onto-target', later),
      stage('push-rebased', later),
    ]).outcome;
    expect(o.status).toBe('up-to-date');
    expect(later).not.toHaveBeenCalled();
  });

  it('HeadMovedError maps to head-moved', async () => {
    const o = await setup([intake, worktree, rebase, throwing('push-rebased', new HeadMovedError('feature', 'head000', 'other00'))]).outcome;
    expect(o).toMatchObject({ ok: false, status: 'head-moved', oldHead: 'head000', newHead: 'new0000', conflicts: [CONFLICT] });
  });

  it('ConflictCapError maps to conflict-cap', async () => {
    const o = await setup([intake, worktree, throwing('rebase-onto-target', new ConflictCapError('too many', ['a.al']))]).outcome;
    expect(o).toMatchObject({ ok: false, status: 'conflict-cap', newHead: null, conflicts: [] });
    expect(o.error).toContain('too many');
  });

  it('UnresolvedConflictError maps to unresolved-conflict', async () => {
    const o = await setup([intake, worktree, throwing('rebase-onto-target', new UnresolvedConflictError('c1', ['a.al']))]).outcome;
    expect(o).toMatchObject({ ok: false, status: 'unresolved-conflict' });
  });

  it('VerificationFailedError maps to verification-failed', async () => {
    const o = await setup([intake, worktree, rebase, env, throwing('build-and-test', new VerificationFailedError(0, true, 'red'))]).outcome;
    expect(o).toMatchObject({ ok: false, status: 'verification-failed', newHead: 'new0000' });
  });

  it('CostExceededError maps to cost-cap', async () => {
    const o = await setup([intake, worktree, throwing('rebase-onto-target', new CostExceededError(6, 5, 'rebase-onto-target'))]).outcome;
    expect(o).toMatchObject({ ok: false, status: 'cost-cap' });
  });

  it('a cancelled run maps to cancelled', async () => {
    const abortFlag = { aborted: false };
    const o = await setup([intake, stage('pr-worktree', (out) => { out.worktree = WT; abortFlag.aborted = true; }), rebase], { abortFlag }).outcome;
    expect(o).toMatchObject({ ok: false, status: 'cancelled' });
  });

  it('anything else maps to error with the stage name', async () => {
    const o = await setup([intake, worktree, throwing('rebase-onto-target', new Error('boom'))]).outcome;
    expect(o).toMatchObject({ ok: false, status: 'error', error: 'rebase-onto-target: boom' });
  });

  it('redacts the PAT in error', async () => {
    const o = await setup([intake, throwing('pr-worktree', new Error(`fetch failed with ${PAT}`))]).outcome;
    expect(o.error).toBe('pr-worktree: fetch failed with <redacted>');
  });

  it('posts a failure comment on conflict-cap, not on up-to-date, not in dry run', async () => {
    const cap = setup([intake, worktree, throwing('rebase-onto-target', new ConflictCapError('too many', ['a.al']))]);
    await cap.outcome;
    expect(cap.createPullRequestThread).toHaveBeenCalledTimes(1);
    const arg = cap.createPullRequestThread.mock.calls[0]?.[0] as { content: string; pullRequestId: number };
    expect(arg.content).toContain('conflict-cap');
    expect(arg.pullRequestId).toBe(PR_ID);

    const upToDate = setup([intake, throwing('pr-worktree', new PrUpToDateError('already'))]);
    await upToDate.outcome;
    expect(upToDate.createPullRequestThread).not.toHaveBeenCalled();

    const dry = setup([intake, worktree, throwing('rebase-onto-target', new ConflictCapError('too many', ['a.al']))], { dryRun: true });
    await dry.outcome;
    expect(dry.createPullRequestThread).not.toHaveBeenCalled();
  });

  it('does not post a failure comment when cancelled', async () => {
    const abortFlag = { aborted: false };
    const r = setup([intake, stage('pr-worktree', (out) => { out.worktree = WT; abortFlag.aborted = true; }), rebase], { abortFlag });
    await r.outcome;
    expect(r.createPullRequestThread).not.toHaveBeenCalled();
  });

  it('a failing failure comment only warns', async () => {
    const r = setup([intake, worktree, throwing('rebase-onto-target', new ConflictCapError('too many', ['a.al']))], { commentFails: true });
    const o = await r.outcome;
    expect(o.status).toBe('conflict-cap');
    expect(r.warn.mock.calls.some((c) => String(c[0]).includes('ado down'))).toBe(true);
  });

  it('deletes the environment unless keepEnv', async () => {
    const del = setup([intake, worktree, rebase, env, push, comment]);
    await del.outcome;
    expect(del.deleteEnvironment).toHaveBeenCalledTimes(1);

    const failed = setup([intake, worktree, rebase, env, throwing('build-and-test', new VerificationFailedError(0, true, 'red'))]);
    await failed.outcome;
    expect(failed.deleteEnvironment).toHaveBeenCalledTimes(1);

    const dry = setup([intake, worktree, rebase, env, push, comment], { dryRun: true });
    await dry.outcome;
    expect(dry.deleteEnvironment).toHaveBeenCalledTimes(1);

    const keep = setup([intake, worktree, rebase, env, push, comment], { keepEnv: true });
    await keep.outcome;
    expect(keep.deleteEnvironment).not.toHaveBeenCalled();
  });

  it('a failed environment delete only warns', async () => {
    const r = setup([intake, worktree, rebase, env, push, comment], { deleteFails: true });
    const o = await r.outcome;
    expect(o.ok).toBe(true);
    expect(r.warn.mock.calls.some((c) => String(c[0]).includes('delete failed'))).toBe(true);
  });

  it('never deletes an environment whose name is not wi-<id>-pr-', async () => {
    const foreign = stage('env-provision', (o) => {
      o.environment = { ...ENV, name: 'wi-42-some-wi' };
    });
    const r = setup([intake, worktree, rebase, foreign, push, comment]);
    await r.outcome;
    expect(r.deleteEnvironment).not.toHaveBeenCalled();
  });

  it('MergeCommitsError maps to merge-commits and posts the failure comment', async () => {
    const r = setup([intake, worktree, throwing('rebase-onto-target', new MergeCommitsError(2))]);
    const o = await r.outcome;
    expect(o).toMatchObject({ ok: false, status: 'merge-commits', error: 'branch contains 2 merge commits; rebase it manually' });
    expect(r.createPullRequestThread).toHaveBeenCalledTimes(1);
    const content = (r.createPullRequestThread.mock.calls[0]?.[0] as { content: string }).content;
    expect(content).toContain('merge-commits');
    expect(content).toContain('branch contains 2 merge commits; rebase it manually');
  });

  const pushed = stage('push-rebased', (o) => {
    o.pushed = true;
  });

  it('a failure after the push is reported as rebased, with a warning and no failure comment', async () => {
    const r = setup([intake, worktree, rebase, pushed, throwing('pr-comment', new Error('ado down'))]);
    const o = await r.outcome;
    expect(o).toMatchObject({ ok: true, status: 'rebased', newHead: 'new0000', error: null });
    expect(r.createPullRequestThread).not.toHaveBeenCalled();
    expect(r.warn.mock.calls.some((c) => String(c[0]).includes('ado down'))).toBe(true);
    expect(r.removeWorktree).toHaveBeenCalledTimes(1);
  });

  it('a run cancelled after the push is reported as rebased, with no failure comment', async () => {
    const abortFlag = { aborted: false };
    const r = setup(
      [intake, worktree, rebase, stage('push-rebased', (o) => { o.pushed = true; abortFlag.aborted = true; }), comment],
      { abortFlag },
    );
    const o = await r.outcome;
    expect(o).toMatchObject({ ok: true, status: 'rebased' });
    expect(r.createPullRequestThread).not.toHaveBeenCalled();
    expect(r.warn.mock.calls.some((c) => /pushed/i.test(String(c[0])))).toBe(true);
  });

  it('keeps the worktree on failure, removes it on success', async () => {
    const fail = setup([intake, worktree, throwing('rebase-onto-target', new Error('boom'))]);
    await fail.outcome;
    expect(fail.removeWorktree).not.toHaveBeenCalled();
    expect(fail.warn.mock.calls.some((c) => String(c[0]).includes(WT.path))).toBe(true);

    const ok = setup([intake, worktree, rebase, push, comment]);
    await ok.outcome;
    expect(ok.removeWorktree).toHaveBeenCalledTimes(1);

    const upToDate = setup([intake, { name: 'pr-worktree', costFree: true, canRun: () => true, async execute(s) { s.outputs.worktree = WT; throw new PrUpToDateError('already'); } }]);
    await upToDate.outcome;
    expect(upToDate.removeWorktree).toHaveBeenCalledTimes(1);
  });
});
