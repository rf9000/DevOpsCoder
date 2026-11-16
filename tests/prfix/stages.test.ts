import { describe, it, expect, mock } from 'bun:test';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  createPrCommentStage,
  createPrIntakeStage,
  createPrWorktreeStage,
  createPushRebasedStage,
} from '../../src/prfix/stages.ts';
import { renderSuccessComment } from '../../src/prfix/comment.ts';
import type { PrFixGit } from '../../src/prfix/prfix-git.ts';
import { PrUpToDateError, type PrFixInput, type RebaseOutput } from '../../src/prfix/types.ts';
import type { AdoClient } from '../../src/sdk/azure-devops-client.ts';
import type { PipelineContext } from '../../src/pipeline/stage.ts';
import type { PipelineState, PullRequestDetails, WorktreeContext } from '../../src/types/index.ts';
import { makeTestConfig } from '../helpers/app-config.ts';

const PR: PullRequestDetails = {
  id: 42,
  status: 'active',
  title: 'My PR',
  sourceRefName: 'refs/heads/feature',
  targetRefName: 'refs/heads/main',
  headCommit: 'head000',
  isDraft: false,
  url: 'https://example/pr/42',
};

const REBASE: RebaseOutput = {
  preRebaseSha: 'pre0000',
  targetSha: 'target0',
  newHeadSha: 'new0000',
  commitsReplayed: 2,
  conflicts: [],
};

const FULL_INPUT = { pullRequestId: 42, repository: 'repo', pr: PR };

function makeState(outputs: Record<string, unknown> = {}): PipelineState {
  return {
    workItemId: 0,
    slug: 'pr-42',
    startedAt: '2026-11-16T00:00:00.000Z',
    updatedAt: '2026-11-16T00:00:00.000Z',
    currentStage: null,
    history: [],
    outputs: {
      prFixInput: { pullRequestId: 42, repository: 'repo' },
      ...outputs,
    },
  };
}

function makeCtx(dryRun = false): PipelineContext {
  return {
    config: makeTestConfig({}, { dryRun, skipBuildTest: false }),
    logger: { info: mock(() => {}), warn: mock(() => {}), error: mock(() => {}) },
    abortFlag: { aborted: false },
    signal: new AbortController().signal,
    now: () => new Date('2026-11-16T00:00:00.000Z'),
  };
}

function fakeAdo(pr: PullRequestDetails) {
  const getPullRequest = mock(async (_r: string, _id: number, _o?: unknown) => pr);
  const createPullRequestThread = mock(async (_a: unknown, _o?: unknown) => {});
  return {
    ado: { getPullRequest, createPullRequestThread } as unknown as AdoClient,
    getPullRequest,
    createPullRequestThread,
  };
}

describe('pr-intake', () => {
  it('refuses a non-active PR', async () => {
    const { ado } = fakeAdo({ ...PR, status: 'completed' });
    const stage = createPrIntakeStage({ ado });
    expect(stage.costFree).toBe(true);
    await expect(stage.execute(makeState(), makeCtx())).rejects.toThrow('PR 42 is completed, not active');
  });

  it('refuses a PR with no source or target branch', async () => {
    for (const bad of [{ sourceRefName: '' }, { targetRefName: '' }]) {
      const { ado } = fakeAdo({ ...PR, ...bad });
      await expect(createPrIntakeStage({ ado }).execute(makeState(), makeCtx())).rejects.toThrow(
        /PR 42 has no source\/target branch/,
      );
    }
  });

  it('writes prFixInput.pr and a synthetic wiContext', async () => {
    const { ado, getPullRequest } = fakeAdo(PR);
    const out = await createPrIntakeStage({ ado }).execute(makeState(), makeCtx());
    expect(getPullRequest.mock.calls[0]?.[0]).toBe('repo');
    expect(getPullRequest.mock.calls[0]?.[1]).toBe(42);
    expect((out.outputs.prFixInput as PrFixInput).pr).toEqual(PR);
    expect(out.outputs.wiContext).toMatchObject({ id: 42, title: 'My PR', workItemType: 'Pull Request' });
  });
});

describe('pr-worktree', () => {
  const wt = { path: '/w/p', branch: 'b', baseSha: 'head000', targetSha: 'target0' };
  const gitOf = (upToDate: boolean) =>
    ({
      createWorktree: mock(async (_a: unknown) => wt),
      isUpToDate: mock(async (_p: string, _t: string) => upToDate),
    }) as unknown as PrFixGit;

  it('creates the worktree and records it', async () => {
    const git = gitOf(false);
    const out = await createPrWorktreeStage({ git }).execute(makeState({ prFixInput: FULL_INPUT }), makeCtx());
    expect(out.outputs.worktree).toEqual(wt);
    expect((git.createWorktree as ReturnType<typeof mock>).mock.calls[0]?.[0]).toEqual({
      pullRequestId: 42,
      sourceRefName: 'refs/heads/feature',
      targetRefName: 'refs/heads/main',
      headCommit: 'head000',
    });
  });

  it('applies every worktree overlay dir to the new worktree, in order', async () => {
    const git = gitOf(false);
    const applyOverlay = mock((_src: string, _wt: string) => [] as string[]);
    const ctx = makeCtx();
    ctx.config = { ...ctx.config, worktreeOverlayDirs: ['/overlay/team', '/overlay/extra'] };
    await createPrWorktreeStage({ git, applyOverlay }).execute(makeState({ prFixInput: FULL_INPUT }), ctx);
    expect(applyOverlay.mock.calls).toEqual([
      ['/overlay/team', '/w/p'],
      ['/overlay/extra', '/w/p'],
    ]);
  });

  it('copies a real overlay into the worktree (default copier)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'prfix-overlay-'));
    try {
      const overlayDir = join(root, 'overlay');
      const wtPath = join(root, 'wt');
      mkdirSync(join(overlayDir, 'Banking Rulesets'), { recursive: true });
      writeFileSync(join(overlayDir, 'Banking Rulesets', '.cli-ruleset.json'), '{}', 'utf-8');
      execFileSync('git', ['init', '-q', wtPath]);
      const git = {
        createWorktree: mock(async (_a: unknown) => ({ ...wt, path: wtPath })),
        isUpToDate: mock(async () => false),
      } as unknown as PrFixGit;
      const ctx = makeCtx();
      ctx.config = { ...ctx.config, worktreeOverlayDirs: [overlayDir] };
      await createPrWorktreeStage({ git }).execute(makeState({ prFixInput: FULL_INPUT }), ctx);
      expect(existsSync(join(wtPath, 'Banking Rulesets', '.cli-ruleset.json'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('throws PrUpToDateError when up to date, after the worktree exists', async () => {
    const git = gitOf(true);
    const p = createPrWorktreeStage({ git }).execute(makeState({ prFixInput: FULL_INPUT }), makeCtx());
    await expect(p).rejects.toBeInstanceOf(PrUpToDateError);
    expect(git.createWorktree).toHaveBeenCalled();
  });
});

describe('push-rebased', () => {
  const worktree: WorktreeContext = { path: '/w/p', branch: 'b', baseSha: 'target0' };
  const mk = () => {
    const push = mock(async (_a: unknown) => {});
    const headSha = mock(async (_p: string) => 'new0000');
    return { git: { push, headSha } as unknown as PrFixGit, push };
  };
  const st = () => makeState({ prFixInput: FULL_INPUT, worktree, rebase: REBASE });

  it('passes preRebaseSha as the lease', async () => {
    const { git, push } = mk();
    const out = await createPushRebasedStage({ git }).execute(st(), makeCtx());
    expect(push.mock.calls[0]?.[0]).toEqual({
      path: '/w/p',
      sourceRefName: 'refs/heads/feature',
      expectedRemoteSha: 'pre0000',
    });
    expect(out.outputs.pushedCommit).toBe('new0000');
  });

  it('does not push in a dry run but records the commit', async () => {
    const { git, push } = mk();
    const out = await createPushRebasedStage({ git }).execute(st(), makeCtx(true));
    expect(push).not.toHaveBeenCalled();
    expect(out.outputs.pushedCommit).toBe('new0000');
  });
});

describe('pr-comment', () => {
  const state = () => makeState({ prFixInput: FULL_INPUT, rebase: REBASE });

  it('posts renderSuccessComment', async () => {
    const { ado, createPullRequestThread } = fakeAdo(PR);
    await createPrCommentStage({ ado }).execute(state(), makeCtx());
    expect(createPullRequestThread).toHaveBeenCalledTimes(1);
    expect(createPullRequestThread.mock.calls[0]?.[0]).toEqual({
      repositoryName: 'repo',
      pullRequestId: 42,
      content: renderSuccessComment({ pr: PR, rebase: REBASE, skippedVerification: false }),
    });
  });

  it('marks verification skipped when the config skips build/test', async () => {
    const { ado, createPullRequestThread } = fakeAdo(PR);
    const ctx = makeCtx();
    ctx.config = { ...ctx.config, skipBuildTest: true };
    await createPrCommentStage({ ado }).execute(state(), ctx);
    expect((createPullRequestThread.mock.calls[0]?.[0] as { content: string }).content).toContain('Not verified');
  });

  it('posts nothing in a dry run', async () => {
    const { ado, createPullRequestThread } = fakeAdo(PR);
    await createPrCommentStage({ ado }).execute(state(), makeCtx(true));
    expect(createPullRequestThread).not.toHaveBeenCalled();
  });
});
