import { describe, it, expect, mock } from 'bun:test';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { alErrorLines, approvePrFix, cleanupInterruptedPrFix, fixPr, rejectPrFix, type FixPrDeps } from '../../src/prfix/fix-pr.ts';
import { buildPrFixFinishStages } from '../../src/services/pipeline-builder.ts';
import type { PrFixConfig } from '../../src/prfix/config.ts';
import type { PrFixGit } from '../../src/prfix/prfix-git.ts';
import type { NinjaClient } from '../../src/prfix/ninja.ts';
import {
  ConflictCapError,
  IdCollisionError,
  MergeCommitsError,
  PrUpToDateError,
  UnresolvedConflictError,
  type ConflictResolution,
  type RebaseOutput,
} from '../../src/prfix/types.ts';
import { HeadMovedError } from '../../src/suggestions/suggestion-git.ts';
import { CostExceededError, VerificationFailedError, type PullRequestDetails } from '../../src/types/index.ts';
import type { Stage } from '../../src/pipeline/stage.ts';
import { createInitialState } from '../../src/pipeline/orchestrator.ts';
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
  opts: {
    dryRun?: boolean;
    keepEnv?: boolean;
    commentFails?: boolean;
    deleteFails?: boolean;
    abortFlag?: { aborted: boolean };
    unassignFails?: boolean;
  } = {},
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
    approvalTtlHours: 24,
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
  const unassign = mock(async (_type: string, _id: number, _file: string) => {
    if (opts.unassignFails) throw new Error('ninja down');
  });
  const close = mock(async () => {});
  const ninjaFactory = mock(() => ({ assign: async () => 0, unassign, close }) as unknown as NinjaClient);
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
    ninja: ninjaFactory,
  });
  return { outcome, removeWorktree, createPullRequestThread, deleteEnvironment, warn, unassign, close, ninjaFactory };
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

  const RESERVED = [
    { type: 'codeunit', id: 72918790, file: '/wt/prfix-42/app/P.al', status: 'used' as const },
    { type: 'codeunit', id: 72918791, file: '/wt/prfix-42/app/Q.al', status: 'used' as const },
  ];
  const RENUMBERED = [
    { type: 'codeunit', name: 'P', file: 'app/P.al', app: 'app', oldId: 72918753, newId: 72918790 },
  ];
  const renumber = stage('renumber-collisions', (o) => {
    o.renumber = { commit: 'renum00', renumbered: RENUMBERED, reserved: RESERVED };
  });

  it('IdCollisionError maps to id-collision and the failure comment lists the group', async () => {
    const group = {
      app: 'app',
      type: 'codeunit',
      id: 5,
      members: [
        { type: 'codeunit', id: 5, name: 'A', file: 'app/A.al', app: 'app' },
        { type: 'codeunit', id: 5, name: 'B', file: 'app/B.al', app: 'app' },
      ],
    };
    const r = setup([intake, worktree, rebase, throwing('renumber-collisions', new IdCollisionError([group], `bad ${PAT}`))]);
    const o = await r.outcome;
    expect(o).toMatchObject({ ok: false, status: 'id-collision', error: 'bad <redacted>' });
    const content = r.createPullRequestThread.mock.calls[0]?.[0].content ?? '';
    expect(content).toContain('Object ID collision needs a manual fix');
    expect(content).toContain('`app/A.al`');
  });

  it('dry run releases reserved IDs', async () => {
    const r = setup([intake, worktree, rebase, renumber, push, comment], { dryRun: true });
    const o = await r.outcome;
    expect(o.status).toBe('rebased');
    expect(r.unassign.mock.calls).toEqual(RESERVED.map((x) => [x.type, x.id, x.file]));
    expect(r.close).toHaveBeenCalledTimes(1);
    expect(r.ninjaFactory).toHaveBeenCalledTimes(1);
  });

  it('releases reserved IDs before the worktree is removed', async () => {
    const order: string[] = [];
    const r = setup([intake, worktree, rebase, renumber, push, comment], { dryRun: true });
    r.unassign.mockImplementation(async () => {
      order.push('unassign');
    });
    r.removeWorktree.mockImplementation(async () => {
      order.push('remove');
    });
    await r.outcome;
    expect(order).toEqual(['unassign', 'unassign', 'remove']);
  });

  it('failure before push releases reserved IDs', async () => {
    const r = setup([intake, worktree, rebase, renumber, env, throwing('build-and-test', new Error('boom'))]);
    await r.outcome;
    expect(r.unassign).toHaveBeenCalledTimes(2);
    expect(r.close).toHaveBeenCalledTimes(1);
  });

  it('pushed run keeps reserved IDs', async () => {
    const r = setup([intake, worktree, rebase, renumber, stage('push-rebased', (o) => { o.pushed = true; }), comment]);
    await r.outcome;
    expect(r.unassign).not.toHaveBeenCalled();
    expect(r.ninjaFactory).not.toHaveBeenCalled();
  });

  it('no reserved IDs: the Ninja client is never created', async () => {
    const none = stage('renumber-collisions', (o) => {
      o.renumber = { commit: null, renumbered: [], reserved: [] };
    });
    const r = setup([intake, worktree, rebase, none, push, comment], { dryRun: true });
    await r.outcome;
    expect(r.ninjaFactory).not.toHaveBeenCalled();
  });

  it('dry run releases a used ID but never one rejected as already in use', async () => {
    const mixed = stage('renumber-collisions', (o) => {
      o.renumber = {
        commit: 'renum00',
        renumbered: RENUMBERED,
        reserved: [
          { type: 'codeunit', id: 72918700, file: '/wt/prfix-42/app/P.al', status: 'rejected-in-use' as const },
          { type: 'codeunit', id: 72918790, file: '/wt/prfix-42/app/P.al', status: 'used' as const },
        ],
      };
    });
    const r = setup([intake, worktree, rebase, mixed, push, comment], { dryRun: true });
    await r.outcome;
    expect(r.unassign.mock.calls).toEqual([['codeunit', 72918790, '/wt/prfix-42/app/P.al']]);
  });

  it('an ID rejected as out of range is released', async () => {
    const outOfRange = stage('renumber-collisions', (o) => {
      o.renumber = {
        commit: null,
        renumbered: [],
        reserved: [{ type: 'codeunit', id: 50000, file: '/wt/prfix-42/app/P.al', status: 'rejected-out-of-range' as const }],
      };
    });
    const r = setup([intake, worktree, rebase, outOfRange, push, comment], { dryRun: true });
    await r.outcome;
    expect(r.unassign.mock.calls).toEqual([['codeunit', 50000, '/wt/prfix-42/app/P.al']]);
  });

  it('release stops at the first could-not-start failure and lists what is left', async () => {
    const r = setup([intake, worktree, rebase, renumber, push, comment], { dryRun: true });
    r.unassign.mockImplementation(async () => {
      throw new Error('ninja: could not start "npx -y x" (NINJA_MCP_COMMAND): spawn ENOENT');
    });
    const o = await r.outcome;
    expect(o.status).toBe('rebased');
    expect(r.unassign).toHaveBeenCalledTimes(1);
    expect(r.close).toHaveBeenCalledTimes(1);
    const left = r.warn.mock.calls.map((c) => String(c[0])).find((m) => m.includes('left unreleased'));
    expect(left).toBeDefined();
    for (const x of RESERVED) expect(left).toContain(`${x.type} ${x.id} (${x.file})`);
  });

  it('unassign failure only warns', async () => {
    const r = setup([intake, worktree, rebase, renumber, push, comment], { dryRun: true, unassignFails: true });
    const o = await r.outcome;
    expect(o.status).toBe('rebased');
    expect(r.unassign).toHaveBeenCalledTimes(2);
    expect(r.close).toHaveBeenCalledTimes(1);
    expect(r.warn.mock.calls.filter((c) => String(c[0]).includes('ninja down')).length).toBe(2);
  });

  it('verification-failed outcome error carries AL error lines', async () => {
    const alc = [
      'Microsoft (R) AL Compiler version 18.1',
      '/wt/prfix-42/base-application/Feature Management\\PontoFeature.Codeunit.al(1,10): error AL0264: Already declared A',
      '/wt/prfix-42/base-application/Feature Management\\Other.al(3,1): info AL0749: noise',
      '/wt/prfix-42/base-application/Export\\Hash.Codeunit.al(1,10): error AL0264: Already declared B',
      '/wt/prfix-42/base-application/Feature Management\\PontoFeature.Codeunit.al(1,10): error AL0264: Already declared A',
      'Compilation ended',
    ].join('\r\n');
    const verify = stage('build-and-test', (o) => {
      o.verification = {
        attempts: 0,
        compiled: false,
        deploy: [
          // fixPr passes the worktree path (WT.path = /wt/prfix-42); `app` is a name.
          { app: 'Continia Banking', projectPath: 'base-application', compiled: false, published: false, error: alc, code: 'compile-failed' },
          { app: 'tests', compiled: true, published: true, error: 'x(1,1): error AL0001: ignored, row succeeded' },
        ],
        testRuns: [],
        passed: false,
      };
      throw new VerificationFailedError(0, false, 'compile failed');
    });
    const o = await setup([intake, worktree, rebase, env, verify]).outcome;
    expect(o.status).toBe('verification-failed');
    expect(o.error).toBe(
      'verification failed after 0 fix attempt(s): compile failed\n' +
        'Feature Management\\PontoFeature.Codeunit.al(1,10): error AL0264: Already declared A\n' +
        'Export\\Hash.Codeunit.al(1,10): error AL0264: Already declared B',
    );
  });

  it('outcome carries renumbered, and newHead is the renumber commit when nothing was pushed', async () => {
    const o = await setup([intake, worktree, rebase, renumber], { dryRun: true }).outcome;
    expect(o.renumbered).toEqual(RENUMBERED);
    expect(o.newHead).toBe('renum00');
  });

  it('newHead prefers the pushed commit', async () => {
    const pushedCommit = stage('push-rebased', (out) => {
      out.pushedCommit = 'pushed0';
    });
    const o = await setup([intake, worktree, rebase, renumber, pushedCommit, comment], { dryRun: true }).outcome;
    expect(o.newHead).toBe('pushed0');
  });
});

describe('alErrorLines', () => {
  const v = (deploy: { app: string; compiled: boolean; published: boolean; error?: string; projectPath?: string }[]) => ({
    attempts: 0,
    compiled: false,
    deploy,
    testRuns: [],
    passed: false,
  });

  it('returns [] without a verification', () => {
    expect(alErrorLines(undefined)).toEqual([]);
  });

  it('keeps analyzer errors (AA0210) as well as compiler errors, and no warning or info lines', () => {
    const error = [
      'General\\Codeunits\\NoSeriesIntegrity.Codeunit.al(61,9): warning AA0210: The table X does not contain a key with the field Y.',
      'General\\Codeunits\\NoSeriesIntegrity.Codeunit.al(61,9): error AA0210: The table Gen. Journal Line does not contain a key with the field Check Printed.',
      'Export\\Hash.Codeunit.al(3,1): info AL0749: noise',
      'Export\\Hash.Codeunit.al(1,10): error AL0264: Already declared',
      'Export\\Hash.Codeunit.al(4,1): warning AL0432: noise',
    ].join('\n');
    expect(alErrorLines(v([{ app: 'App', compiled: false, published: false, error }]))).toEqual([
      'General\\Codeunits\\NoSeriesIntegrity.Codeunit.al(61,9): error AA0210: The table Gen. Journal Line does not contain a key with the field Check Printed.',
      'Export\\Hash.Codeunit.al(1,10): error AL0264: Already declared',
    ]);
  });

  it('caps at max and reads published === false rows too', () => {
    const lines = Array.from({ length: 5 }, (_, i) => `f${i}.al(1,1): error AL000${i}: e`).join('\n');
    const out = alErrorLines(v([{ app: 'App', compiled: true, published: false, error: lines }]), 3);
    expect(out).toEqual(['f0.al(1,1): error AL0000: e', 'f1.al(1,1): error AL0001: e', 'f2.al(1,1): error AL0002: e']);
  });

  it('keeps the project-relative lines of a real CLI row (app is a name), dropping info and warning lines', () => {
    const error = [
      'Microsoft (R) AL Compiler version 18.1.0.0',
      'Copyright (C) Microsoft Corporation. All rights reserved',
      '',
      'Compilation started for project \'Continia Banking\' containing \'2140\' files at \'09:12:01.123\'.',
      '',
      "Feature Management\\FeatureMgt.Codeunit.al(40,5): info AL0749: The type 'X' is obsolete",
      "Feature Management\\PontoFeature.Codeunit.al(1,10): error AL0264: An application object of type 'Codeunit' with ID '72918753' is already declared by the extension 'Continia Banking by Continia Software (29.0.0.0)'",
      "Payment Register\\Payment.Page.al(12,9): warning AL0432: Method 'Y' is marked for removal",
      "Payment Register\\ExportFileHash.Codeunit.al(1,10): error AL0264: An application object of type 'Codeunit' with ID '72918753' is already declared by the extension 'Continia Banking by Continia Software (29.0.0.0)'",
      '',
      "Compilation ended at '09:12:40.456'.",
    ].join('\r\n');
    const out = alErrorLines(
      v([{ app: 'Continia Software_Continia Banking', compiled: false, published: false, error }]),
      10,
      'C:\\wt\\prfix-61400',
    );
    expect(out).toEqual([
      "Feature Management\\PontoFeature.Codeunit.al(1,10): error AL0264: An application object of type 'Codeunit' with ID '72918753' is already declared by the extension 'Continia Banking by Continia Software (29.0.0.0)'",
      "Payment Register\\ExportFileHash.Codeunit.al(1,10): error AL0264: An application object of type 'Codeunit' with ID '72918753' is already declared by the extension 'Continia Banking by Continia Software (29.0.0.0)'",
    ]);
  });

  it('strips the worktree root and the projectPath app dir from an absolute line (app is a name)', () => {
    const line = 'c:\\WT\\prfix-61400\\base-application\\Feature Management\\P.Codeunit.al(1,10): error AL0264: dup';
    const row = { app: 'Continia Software_Continia Banking', compiled: false, published: false, error: line };
    expect(alErrorLines(v([{ ...row, projectPath: 'base-application' }]), 10, 'C:/wt/prfix-61400/')).toEqual([
      'Feature Management\\P.Codeunit.al(1,10): error AL0264: dup',
    ]);
    expect(
      alErrorLines(v([{ ...row, projectPath: 'C:\\wt\\prfix-61400\\base-application' }]), 10, 'C:\\wt\\prfix-61400'),
    ).toEqual(['Feature Management\\P.Codeunit.al(1,10): error AL0264: dup']);
    // Without a projectPath only the worktree root goes.
    expect(alErrorLines(v([row]), 10, 'C:\\wt\\prfix-61400')).toEqual([
      'base-application\\Feature Management\\P.Codeunit.al(1,10): error AL0264: dup',
    ]);
    // A path outside the worktree is left alone.
    expect(alErrorLines(v([row]), 10, 'D:\\other')).toEqual([line]);
  });
});

describe('fix-pr hold mode, approve and reject', () => {
  const HOLD_RESERVED = [
    { type: 'codeunit', id: 72918790, file: '/wt/prfix-42/app/P.al', status: 'used' as const },
    { type: 'codeunit', id: 72918700, file: '/wt/prfix-42/app/P.al', status: 'rejected-in-use' as const },
    { type: 'codeunit', id: 72918791, file: '/wt/prfix-42/app/Q.al', status: 'used' as const },
  ];
  const USED = HOLD_RESERVED.filter((r) => r.status === 'used').map((r): [string, number, string] => [r.type, r.id, r.file]);
  const HOLD_RENUMBERED = [{ type: 'codeunit', name: 'P', file: 'app/P.al', app: 'app', oldId: 72918753, newId: 72918790 }];
  const renumbered = stage('renumber-collisions', (o) => {
    o.renumber = { commit: 'renum00', renumbered: HOLD_RENUMBERED, reserved: HOLD_RESERVED };
  });
  const green = stage('build-and-test', (o) => {
    o.verification = {
      attempts: 0,
      compiled: true,
      deploy: [],
      testRuns: [
        { attempt: 0, codeunitId: 1, passed: true, summary: { total: 1, passed: 1, failed: 0, skipped: 0 }, tests: [] },
        { attempt: 0, codeunitId: 2, passed: true, summary: { total: 1, passed: 1, failed: 0, skipped: 0 }, tests: [] },
      ],
      passed: true,
    };
  });
  const HELD_STAGES = [intake, worktree, rebase, renumbered, env, green];

  function makeDeps(store: PipelineStateStore, opts: { pushThrows?: Error; rangeDiffThrows?: boolean; holdBeforePush?: boolean; deleteFails?: boolean; worktreeHead?: string; prStatus?: PullRequestDetails['status'] } = {}) {
    const app = makeTestConfig({ STATE_DIR: mkdtempSync(join(tmpdir(), 'prfix-')) }, { dryRun: false, pat: PAT });
    const prfix: PrFixConfig = {
      app,
      maxConflictCommits: 3,
      maxConflictFiles: 10,
      resolverMaxTurns: 40,
      renumberCollisions: true,
      ninjaCommand: { command: 'npx', args: [] },
      ninjaCallTimeoutMs: 60_000,
      approvalTtlHours: 24,
    };
    const removeWorktree = mock(async (_wt: unknown) => {});
    const headSha = mock(async (_p: string) => opts.worktreeHead ?? 'renum00');
    const push = mock(async (_a: { path: string; sourceRefName: string; expectedRemoteSha: string }) => {
      if (opts.pushThrows) throw opts.pushThrows;
    });
    const rangeDiff = mock(async (_p: string, _b: string, _o: string, _n: string) => {
      if (opts.rangeDiffThrows) throw new Error('range-diff broke');
      return 'RANGE DIFF TEXT';
    });
    const fileDiff = mock(async (_p: string, _f: string, _t: string, file: string) => `diff of ${file}`);
    const git = { removeWorktree, headSha, push, rangeDiff, fileDiff } as unknown as PrFixGit;
    const createPullRequestThread = mock(async (_a: { content: string }, _o?: unknown) => {});
    const getPullRequest = mock(async (_r: string, _id: number) => ({ ...PR, status: opts.prStatus ?? PR.status }));
    const ado = { createPullRequestThread, getPullRequest } as unknown as AdoClient;
    const deleteEnvironment = mock(async (_id: string, _o: unknown) => {
      if (opts.deleteFails) throw new Error('delete failed');
    });
    const unassign = mock(async (_type: string, _id: number, _file: string) => {});
    const ninja = mock(() => ({ assign: async () => 0, unassign, close: async () => {} }) as unknown as NinjaClient);
    const progress: [string, string | null][] = [];
    const deps: FixPrDeps = {
      prfix,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      ado,
      git,
      continiaCli: { deleteEnvironment },
      stages: HELD_STAGES,
      store,
      pullRequestId: PR_ID,
      keepEnv: false,
      now: () => new Date('2026-11-16T00:00:00.000Z'),
      ninja,
      holdBeforePush: opts.holdBeforePush ?? true,
      onProgress: (s, d) => progress.push([s, d]),
    };
    const finishStages = buildPrFixFinishStages({ ado, git, keepEnv: false });
    return { deps, finishStages, getPullRequest, removeWorktree, push, rangeDiff, fileDiff, createPullRequestThread, deleteEnvironment, unassign, progress };
  }

  const newStore = () => new PipelineStateStore(mkdtempSync(join(tmpdir(), 'prfix-store-')));

  it('hold: green run ends awaiting-approval with a review', async () => {
    const store = newStore();
    const r = makeDeps(store);
    const o = await fixPr(r.deps);
    expect(o).toMatchObject({ ok: true, status: 'awaiting-approval', newHead: 'renum00', error: null });
    expect(o.review).toEqual({
      preRebaseSha: 'head000',
      targetSha: 'target0',
      targetRefName: 'refs/heads/main',
      newHead: 'renum00',
      commitsReplayed: 2,
      conflicts: [{ ...CONFLICT, diffs: [{ path: 'a.al', diff: 'diff of a.al' }] }],
      renumbered: HOLD_RENUMBERED,
      tests: { passed: true, codeunits: 2 },
      rangeDiff: 'RANGE DIFF TEXT',
      costUsd: 0,
    });
    expect(r.rangeDiff.mock.calls).toEqual([[WT.path, 'target0', 'head000', 'renum00']]);
    expect(r.fileDiff.mock.calls).toEqual([[WT.path, 'head000', 'renum00', 'a.al']]);
    expect(r.deleteEnvironment).toHaveBeenCalledTimes(1);
    expect(r.removeWorktree).not.toHaveBeenCalled();
    expect(r.unassign).not.toHaveBeenCalled();
    expect(r.push).not.toHaveBeenCalled();
    expect(r.createPullRequestThread).not.toHaveBeenCalled();
    expect(store.load(PR_ID)?.outputs.rebase).toEqual(REBASE);
    expect(r.progress[0]).toEqual(['pr-intake', null]);
    expect(r.progress.map(([s]) => s)).toContain('build-and-test');
  });

  it('hold: a failing diff call is reported in the review, not as a failed run', async () => {
    const r = makeDeps(newStore(), { rangeDiffThrows: true });
    const o = await fixPr(r.deps);
    expect(o.status).toBe('awaiting-approval');
    expect(o.review?.rangeDiff).toBe('(diff unavailable: range-diff broke)');
  });

  it('hold: red gate ends verification-failed, releases IDs, no review', async () => {
    const r = makeDeps(newStore());
    r.deps.stages = [intake, worktree, rebase, renumbered, env, throwing('build-and-test', new VerificationFailedError(0, true, 'red'))];
    const o = await fixPr(r.deps);
    expect(o).toMatchObject({ ok: false, status: 'verification-failed' });
    expect(o.review).toBeUndefined();
    expect(r.unassign.mock.calls).toEqual(USED);
    expect(r.removeWorktree).not.toHaveBeenCalled();
    expect(r.createPullRequestThread).toHaveBeenCalledTimes(1);
  });

  it('hold: up-to-date ends up-to-date, no review', async () => {
    const r = makeDeps(newStore());
    r.deps.stages = [intake, throwing('pr-worktree', new PrUpToDateError('already'))];
    const o = await fixPr(r.deps);
    expect(o).toMatchObject({ ok: true, status: 'up-to-date' });
    expect(o.review).toBeUndefined();
  });

  it('approve pushes from the saved state and removes the worktree', async () => {
    const store = newStore();
    await fixPr(makeDeps(store).deps);
    const r = makeDeps(store, { holdBeforePush: false });
    const o = await approvePrFix({ ...r.deps, finishStages: r.finishStages });
    expect(r.push.mock.calls).toEqual([[{ path: WT.path, sourceRefName: PR.sourceRefName, expectedRemoteSha: REBASE.preRebaseSha }]]);
    expect(o).toMatchObject({ ok: true, status: 'rebased', newHead: 'renum00', error: null });
    expect(o.review).toBeUndefined();
    expect(r.removeWorktree.mock.calls).toEqual([[WT]]);
    expect(r.unassign).not.toHaveBeenCalled();
    // The environment went at hold time.
    expect(r.deleteEnvironment).not.toHaveBeenCalled();
    expect(r.createPullRequestThread).toHaveBeenCalledTimes(1);
    expect(r.createPullRequestThread.mock.calls[0]?.[0].content).toContain('Rebased onto');
    expect(r.progress.map(([s]) => s)).toEqual(['push-rebased', 'pr-comment']);
  });

  it('approve after a developer push ends head-moved', async () => {
    const store = newStore();
    await fixPr(makeDeps(store).deps);
    const r = makeDeps(store, { pushThrows: new HeadMovedError('feature', 'head000', 'dev0000') });
    const o = await approvePrFix({ ...r.deps, finishStages: r.finishStages });
    expect(r.push.mock.calls[0]?.[0].expectedRemoteSha).toBe('head000');
    expect(o).toMatchObject({ ok: false, status: 'head-moved' });
    expect(r.unassign.mock.calls).toEqual(USED);
    expect(r.removeWorktree).not.toHaveBeenCalled();
    expect(r.createPullRequestThread).toHaveBeenCalledTimes(1);
    expect(r.createPullRequestThread.mock.calls[0]?.[0].content).toContain('head-moved');
  });

  it('approve does not push when the worktree head is not the reviewed head', async () => {
    const store = newStore();
    await fixPr(makeDeps(store).deps);
    const r = makeDeps(store, { worktreeHead: 'other00' });
    const o = await approvePrFix({ ...r.deps, finishStages: r.finishStages });
    expect(o).toMatchObject({
      ok: false,
      status: 'error',
      error: 'PR 42: worktree head other00 is not the reviewed head renum00; not pushed',
    });
    expect(r.push).not.toHaveBeenCalled();
    expect(r.getPullRequest).not.toHaveBeenCalled();
    expect(r.unassign.mock.calls).toEqual(USED);
    expect(r.removeWorktree).not.toHaveBeenCalled();
    // Consumed: it cannot be approved a second time, but the state stays for inspection.
    await expect(approvePrFix({ ...r.deps, finishStages: r.finishStages })).rejects.toThrow('no held fix-pr state');
    expect(store.load(PR_ID)?.outputs.rebase).toEqual(REBASE);
  });

  it('approve does not push a PR that is no longer active', async () => {
    const store = newStore();
    await fixPr(makeDeps(store).deps);
    const r = makeDeps(store, { prStatus: 'completed' });
    const o = await approvePrFix({ ...r.deps, finishStages: r.finishStages });
    expect(o).toMatchObject({ ok: false, status: 'error', error: 'PR 42 is completed; not pushed' });
    expect(r.getPullRequest.mock.calls[0]?.[1]).toBe(PR_ID);
    expect(r.push).not.toHaveBeenCalled();
    expect(r.progress).toEqual([]);
    expect(r.unassign.mock.calls).toEqual(USED);
    expect(r.removeWorktree).not.toHaveBeenCalled();
  });

  it('reject releases IDs and removes the worktree', async () => {
    const store = newStore();
    await fixPr(makeDeps(store).deps);
    const r = makeDeps(store);
    const o = await rejectPrFix(r.deps);
    expect(o).toMatchObject({ ok: false, status: 'rejected', error: null, newHead: 'renum00' });
    expect(r.unassign.mock.calls).toEqual(USED);
    expect(r.removeWorktree.mock.calls).toEqual([[WT]]);
    expect(r.push).not.toHaveBeenCalled();
    expect(r.createPullRequestThread).not.toHaveBeenCalled();
    // The hold already deleted the environment.
    expect(r.deleteEnvironment).not.toHaveBeenCalled();
  });

  it('reject retries an environment delete that failed at hold time', async () => {
    const store = newStore();
    const held = makeDeps(store, { deleteFails: true });
    expect((await fixPr(held.deps)).status).toBe('awaiting-approval');
    expect(held.deleteEnvironment).toHaveBeenCalledTimes(1);
    const r = makeDeps(store);
    await rejectPrFix(r.deps);
    expect(r.deleteEnvironment.mock.calls[0]?.[0]).toBe(ENV.envId);
  });

  it('approve and reject without a held state throw', async () => {
    const r = makeDeps(newStore());
    await expect(approvePrFix({ ...r.deps, finishStages: r.finishStages })).rejects.toThrow('no held fix-pr state for PR 42');
    await expect(rejectPrFix(r.deps)).rejects.toThrow('no held fix-pr state for PR 42');
  });
});

describe('cleanupInterruptedPrFix', () => {
  const RESERVED = [
    { type: 'codeunit', id: 72918790, file: '/wt/prfix-42/app/P.al', status: 'used' as const },
    { type: 'codeunit', id: 72918700, file: '/wt/prfix-42/app/P.al', status: 'rejected-in-use' as const },
  ];

  function interrupted(outputs: Record<string, unknown>, opts: { noState?: boolean; deleteFails?: boolean } = {}) {
    const app = makeTestConfig({ STATE_DIR: mkdtempSync(join(tmpdir(), 'prfix-')) }, { dryRun: false, pat: PAT });
    const store = new PipelineStateStore(join(app.stateDir, 'prfix'));
    if (!opts.noState) {
      const state = createInitialState(PR_ID, `pr-${PR_ID}`, new Date('2026-11-16T00:00:00.000Z'));
      state.currentStage = 'build-and-test';
      Object.assign(state.outputs, outputs);
      store.save(state);
    }
    const deleteEnvironment = mock(async (_id: string, _o: unknown) => {
      if (opts.deleteFails) throw new Error('delete failed');
    });
    const unassign = mock(async (_type: string, _id: number, _file: string) => {});
    const warn = mock((_m: string) => {});
    const deps: FixPrDeps = {
      prfix: {
        app,
        maxConflictCommits: 3,
        maxConflictFiles: 10,
        resolverMaxTurns: 40,
        renumberCollisions: true,
        ninjaCommand: { command: 'npx', args: [] },
        ninjaCallTimeoutMs: 60_000,
        approvalTtlHours: 24,
      },
      logger: { info: () => {}, warn, error: () => {} },
      ado: {} as AdoClient,
      git: {} as PrFixGit,
      continiaCli: { deleteEnvironment },
      stages: [],
      store,
      pullRequestId: PR_ID,
      keepEnv: false,
      ninja: () => ({ assign: async () => 0, unassign, close: async () => {} }) as unknown as NinjaClient,
    };
    return { deps, deleteEnvironment, unassign, warn };
  }

  it('deletes the fix-pr environment and releases the unpushed reserved IDs', async () => {
    const r = interrupted({ environment: ENV, worktree: WT, renumber: { renumbered: [], reserved: RESERVED } });
    await cleanupInterruptedPrFix(r.deps);
    expect(r.deleteEnvironment.mock.calls[0]?.[0]).toBe(ENV.envId);
    expect(r.unassign.mock.calls).toEqual([['codeunit', 72918790, '/wt/prfix-42/app/P.al']]);
  });

  it('a pushed run keeps its IDs', async () => {
    const r = interrupted({ environment: ENV, pushed: true, renumber: { renumbered: [], reserved: RESERVED } });
    await cleanupInterruptedPrFix(r.deps);
    expect(r.unassign).not.toHaveBeenCalled();
    expect(r.deleteEnvironment).toHaveBeenCalledTimes(1);
  });

  it('never deletes a foreign-named or already deleted environment', async () => {
    const foreign = interrupted({ environment: { ...ENV, name: 'wi-42-fix-thing' } });
    await cleanupInterruptedPrFix(foreign.deps);
    expect(foreign.deleteEnvironment).not.toHaveBeenCalled();
    const gone = interrupted({ environment: ENV, environmentDeletedAt: '2026-11-16T00:00:00.000Z' });
    await cleanupInterruptedPrFix(gone.deps);
    expect(gone.deleteEnvironment).not.toHaveBeenCalled();
  });

  it('leaves a state held for approval alone', async () => {
    const r = interrupted({
      environment: ENV,
      awaitingApprovalSince: '2026-11-16T00:00:00.000Z',
      renumber: { renumbered: [], reserved: RESERVED },
    });
    await cleanupInterruptedPrFix(r.deps);
    expect(r.deleteEnvironment).not.toHaveBeenCalled();
    expect(r.unassign).not.toHaveBeenCalled();
  });

  it('never throws: no state, or a failing delete, only warns', async () => {
    const none = interrupted({}, { noState: true });
    await cleanupInterruptedPrFix(none.deps);
    expect(none.warn).toHaveBeenCalled();
    const failing = interrupted({ environment: ENV }, { deleteFails: true });
    await cleanupInterruptedPrFix(failing.deps);
    expect(failing.warn).toHaveBeenCalled();
  });
});
