import { describe, it, expect, beforeEach, afterEach, setDefaultTimeout } from 'bun:test';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createPrFixGit } from '../../src/prfix/prfix-git.ts';
import { HeadMovedError } from '../../src/suggestions/suggestion-git.ts';
import { makeTestConfig } from '../helpers/app-config.ts';

const execFileAsync = promisify(execFile);

// Real git repos on Windows take seconds per test; Bun's default is 5s.
setDefaultTimeout(30000);

const BOT_NAME = 'PrFix Bot';

// Deliberately node:child_process, not Bun.spawn: Bun.spawn races on Windows
// in the full suite. See tests/services/worktree-manager.test.ts.
async function runGit(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf-8' });
    return stdout;
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    throw new Error(`git ${args.join(' ')} (in ${cwd}) failed: ${e.stderr || e.stdout || String(err)}`);
  }
}

async function clone(from: string, to: string, root: string, name: string, email: string): Promise<void> {
  await runGit(['clone', from, to], root);
  await runGit(['config', 'user.email', email], to);
  await runGit(['config', 'user.name', name], to);
}

async function commitFile(dir: string, file: string, content: string, message: string): Promise<string> {
  writeFileSync(join(dir, file), content, 'utf-8');
  await runGit(['add', file], dir);
  await runGit(['commit', '-m', message], dir);
  return (await runGit(['rev-parse', 'HEAD'], dir)).trim();
}

let root: string;
let originPath: string;
let targetRepoPath: string;
let worktreeBase: string;
let dev: string; // pushes feat/x
let other: string; // pushes main
let head: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'prfixgit-'));
  originPath = join(root, 'origin.git');
  targetRepoPath = join(root, 'target');
  worktreeBase = join(root, 'worktrees');
  mkdirSync(originPath, { recursive: true });
  await runGit(['init', '--bare', '--initial-branch=main'], originPath);

  const seed = join(root, 'seed');
  await clone(originPath, seed, root, 'Test', 'test@example.com');
  await commitFile(seed, 'README.md', '# seed\n', 'seed');
  await commitFile(seed, 'Shared.al', 'a\nb\nc\n', 'shared');
  await runGit(['branch', '-M', 'main'], seed);
  await runGit(['push', 'origin', 'main'], seed);

  await clone(originPath, targetRepoPath, root, 'Test', 'test@example.com');

  dev = join(root, 'dev');
  await clone(originPath, dev, root, 'Dev', 'dev@example.com');
  await runGit(['checkout', '-b', 'feat/x'], dev);
  head = await commitFile(dev, 'Feature.al', 'feature\n', 'dev work');
  await runGit(['push', 'origin', 'feat/x'], dev);

  other = join(root, 'other');
  await clone(originPath, other, root, 'Other', 'other@example.com');
}, 30000);

afterEach(() => rmSync(root, { recursive: true, force: true }));

function git() {
  return createPrFixGit({
    config: makeTestConfig({
      TARGET_REPO_PATH: targetRepoPath,
      WORKTREE_BASE: worktreeBase,
      BOT_GIT_NAME: BOT_NAME,
      BOT_GIT_EMAIL: 'bot@example.com',
    }),
  });
}

const args = () => ({
  pullRequestId: 9,
  sourceRefName: 'refs/heads/feat/x',
  targetRefName: 'refs/heads/main',
  headCommit: head,
});

async function advanceMain(file: string, content: string, message = 'main moves'): Promise<string> {
  const sha = await commitFile(other, file, content, message);
  await runGit(['push', 'origin', 'main'], other);
  return sha;
}

async function originSha(branch: string): Promise<string> {
  return (await runGit(['rev-parse', `refs/heads/${branch}`], originPath)).trim();
}

describe('createWorktree', () => {
  it('createWorktree checks out the PR head on prfix/pr-<id>', async () => {
    const wt = await git().createWorktree(args());
    expect(wt.branch).toBe('prfix/pr-9');
    expect(wt.path).toBe(join(worktreeBase, 'prfix-9'));
    expect(wt.baseSha).toBe(head);
    expect(wt.targetSha).toBe(await originSha('main'));
    expect((await runGit(['rev-parse', 'HEAD'], wt.path)).trim()).toBe(head);
    const list = await runGit(['worktree', 'list', '--porcelain'], targetRepoPath);
    expect(list).toContain('locked');
  });

  it('createWorktree throws HeadMovedError when origin/<source> moved', async () => {
    await commitFile(dev, 'More.al', 'more\n', 'more');
    await runGit(['push', 'origin', 'feat/x'], dev);
    await expect(git().createWorktree(args())).rejects.toBeInstanceOf(HeadMovedError);
  });

  it('createWorktree throws when the source branch is gone', async () => {
    await runGit(['push', 'origin', '--delete', 'feat/x'], dev);
    await expect(git().createWorktree(args())).rejects.toThrow(/feat\/x/);
  });

  it('replaces its own leftover worktree, even mid-rebase', async () => {
    const g = git();
    await advanceMain('Shared.al', 'a\nMAIN\nc\n');
    const first = await g.createWorktree(args());
    await commitFile(first.path, 'Shared.al', 'a\nPR\nc\n', 'pr edit');
    expect((await g.startRebase(first.path, first.targetSha)).kind).toBe('conflict');
    const second = await g.createWorktree(args());
    expect(second.path).toBe(first.path);
    expect((await runGit(['rev-parse', 'HEAD'], second.path)).trim()).toBe(head);
  });
});

describe('isUpToDate', () => {
  it('isUpToDate: true before main moves, false after main gains a commit', async () => {
    const g = git();
    const wt = await g.createWorktree(args());
    expect(await g.isUpToDate(wt.path, wt.targetSha)).toBe(true);
    await advanceMain('Main.al', 'm\n');
    await g.removeWorktree(wt);
    const wt2 = await g.createWorktree(args());
    expect(await g.isUpToDate(wt2.path, wt2.targetSha)).toBe(false);
  });
});

describe('rebase', () => {
  it('clean rebase returns done and keeps the author', async () => {
    const target = await advanceMain('Main.al', 'm\n');
    const g = git();
    const wt = await g.createWorktree(args());
    const step = await g.startRebase(wt.path, wt.targetSha);
    expect(step.kind).toBe('done');
    const newHead = (await runGit(['rev-parse', 'HEAD'], wt.path)).trim();
    if (step.kind === 'done') expect(step.head).toBe(newHead);
    expect((await runGit(['rev-parse', 'HEAD~1'], wt.path)).trim()).toBe(target);
    expect((await runGit(['log', '-1', '--format=%an'], wt.path)).trim()).toBe('Dev');
    expect((await runGit(['log', '-1', '--format=%cn'], wt.path)).trim()).toBe(BOT_NAME);
  });

  it('conflicting rebase returns conflict with commit, subject and files', async () => {
    await commitFile(dev, 'Shared.al', 'a\nPR\nc\n', 'pr edits shared');
    const prCommit = (await runGit(['rev-parse', 'HEAD'], dev)).trim();
    await runGit(['push', 'origin', 'feat/x'], dev);
    head = prCommit;
    await advanceMain('Shared.al', 'a\nMAIN\nc\n');
    const g = git();
    const wt = await g.createWorktree(args());
    const step = await g.startRebase(wt.path, wt.targetSha);
    expect(step).toEqual({ kind: 'conflict', commit: prCommit, subject: 'pr edits shared', files: ['Shared.al'] });
    expect(await g.filesWithMarkers(wt.path, ['Shared.al'])).toEqual(['Shared.al']);
  });

  it('continueRebase after a manual resolution returns done', async () => {
    await commitFile(dev, 'Shared.al', 'a\nPR\nc\n', 'pr edits shared');
    head = (await runGit(['rev-parse', 'HEAD'], dev)).trim();
    await runGit(['push', 'origin', 'feat/x'], dev);
    await advanceMain('Shared.al', 'a\nMAIN\nc\n');
    const g = git();
    const wt = await g.createWorktree(args());
    expect((await g.startRebase(wt.path, wt.targetSha)).kind).toBe('conflict');
    writeFileSync(join(wt.path, 'Shared.al'), 'a\nMAIN\nPR\nc\n', 'utf-8');
    const step = await g.continueRebase(wt.path, ['Shared.al']);
    expect(step.kind).toBe('done');
    expect(await g.countCommits(wt.path, wt.targetSha)).toBe(2);
    expect((await runGit(['log', '-1', '--format=%an|%cn'], wt.path)).trim()).toBe(`Dev|${BOT_NAME}`);
    expect((await runGit(['show', 'HEAD:Shared.al'], wt.path)).replace(/\r/g, '')).toBe('a\nMAIN\nPR\nc\n');
  });

  it('drops a commit that became empty', async () => {
    // The PR's second commit makes the same change main has since made.
    await commitFile(dev, 'Same.al', 'same\n', 'same change');
    head = (await runGit(['rev-parse', 'HEAD'], dev)).trim();
    await runGit(['push', 'origin', 'feat/x'], dev);
    await advanceMain('Same.al', 'same\n', 'same change on main');
    const g = git();
    const wt = await g.createWorktree(args());
    const mergeBase = (await runGit(['merge-base', head, wt.targetSha], targetRepoPath)).trim();
    expect(await g.countCommits(wt.path, mergeBase)).toBe(2);
    const step = await g.startRebase(wt.path, wt.targetSha);
    expect(step.kind).toBe('done');
    expect(await g.countCommits(wt.path, wt.targetSha)).toBe(1);
  });

  it('abortRebase restores the pre-rebase head', async () => {
    await commitFile(dev, 'Shared.al', 'a\nPR\nc\n', 'pr edits shared');
    head = (await runGit(['rev-parse', 'HEAD'], dev)).trim();
    await runGit(['push', 'origin', 'feat/x'], dev);
    await advanceMain('Shared.al', 'a\nMAIN\nc\n');
    const g = git();
    const wt = await g.createWorktree(args());
    expect((await g.startRebase(wt.path, wt.targetSha)).kind).toBe('conflict');
    await g.abortRebase(wt.path);
    expect(await g.headSha(wt.path)).toBe(head);
    expect((await runGit(['status', '--porcelain'], wt.path)).trim()).toBe('');
  });
});

describe('filesWithMarkers', () => {
  it('filesWithMarkers finds a file with <<<<<<< and ignores a resolved one', async () => {
    const g = git();
    const wt = await g.createWorktree(args());
    writeFileSync(join(wt.path, 'Bad.al'), 'x\r\n<<<<<<< HEAD\r\nours\r\n=======\r\ntheirs\r\n>>>>>>> abc\r\n', 'utf-8');
    writeFileSync(join(wt.path, 'Good.al'), 'x\n// <<<<<<< not at line start\n', 'utf-8');
    writeFileSync(join(wt.path, 'Eq.al'), 'x\r\n=======\r\ny\r\n', 'utf-8');
    expect(await g.filesWithMarkers(wt.path, ['Bad.al', 'Good.al', 'Eq.al', 'Missing.al'])).toEqual(['Bad.al', 'Eq.al']);
  });
});

describe('push', () => {
  it('push updates the remote when the lease holds', async () => {
    await advanceMain('Main.al', 'm\n');
    const g = git();
    const wt = await g.createWorktree(args());
    const step = await g.startRebase(wt.path, wt.targetSha);
    if (step.kind !== 'done') throw new Error('expected done');
    await g.push({ path: wt.path, sourceRefName: 'refs/heads/feat/x', expectedRemoteSha: head });
    expect(await originSha('feat/x')).toBe(step.head);
  });

  it('push rejects when the remote moved', async () => {
    await advanceMain('Main.al', 'm\n');
    const g = git();
    const wt = await g.createWorktree(args());
    expect((await g.startRebase(wt.path, wt.targetSha)).kind).toBe('done');
    const moved = await commitFile(dev, 'Late.al', 'late\n', 'late push');
    await runGit(['push', 'origin', 'feat/x'], dev);
    const err = await g
      .push({ path: wt.path, sourceRefName: 'refs/heads/feat/x', expectedRemoteSha: head })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(HeadMovedError);
    expect((err as HeadMovedError).actual).toBe(moved);
    expect((err as HeadMovedError).expected).toBe(head);
    expect(await originSha('feat/x')).toBe(moved);
  });

  it('push rethrows a rejection when the remote did not move', async () => {
    await advanceMain('Main.al', 'm\n');
    const g = git();
    const wt = await g.createWorktree(args());
    expect((await g.startRebase(wt.path, wt.targetSha)).kind).toBe('done');
    const hook = join(originPath, 'hooks', 'pre-receive');
    writeFileSync(hook, '#!/bin/sh\necho "TF402455: policy says no" >&2\nexit 1\n', 'utf-8');
    chmodSync(hook, 0o755);
    const err = await g
      .push({ path: wt.path, sourceRefName: 'refs/heads/feat/x', expectedRemoteSha: head })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(HeadMovedError);
    expect((err as Error).message).toContain('TF402455');
    expect(await originSha('feat/x')).toBe(head);
  });
});
