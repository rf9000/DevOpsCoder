import { describe, it, expect, beforeEach, afterEach, setDefaultTimeout } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createSuggestionGit, HeadMovedError } from '../../src/suggestions/suggestion-git.ts';
import { makeTestConfig } from '../helpers/app-config.ts';

const execFileAsync = promisify(execFile);

// Real git repos on Windows take seconds per test; Bun's default is 5s.
setDefaultTimeout(30000);

// Deliberately node:child_process, not Bun.spawn: Bun.spawn races on Windows
// in the full suite. See tests/services/worktree-manager.test.ts.
async function runGit(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf-8' });
    return stdout;
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    throw new Error(
      `git ${args.join(' ')} (in ${cwd}) failed: ${e.stderr || e.stdout || String(err)}`,
    );
  }
}

async function setupTestRepo(): Promise<{
  root: string;
  originPath: string;
  targetRepoPath: string;
  worktreeBase: string;
  cleanup: () => void;
}> {
  const root = mkdtempSync(join(tmpdir(), 'sgit-'));
  const originPath = join(root, 'origin.git');
  const targetRepoPath = join(root, 'target');
  const worktreeBase = join(root, 'worktrees');

  mkdirSync(originPath, { recursive: true });
  await runGit(['init', '--bare', '--initial-branch=main'], originPath);

  // Seed the origin with one commit on main via a temp clone
  const seedPath = join(root, 'seed');
  await runGit(['clone', originPath, seedPath], root);
  await runGit(['config', 'user.email', 'test@example.com'], seedPath);
  await runGit(['config', 'user.name', 'Test'], seedPath);
  writeFileSync(join(seedPath, 'README.md'), '# seed\n', 'utf-8');
  await runGit(['add', 'README.md'], seedPath);
  await runGit(['commit', '-m', 'seed'], seedPath);
  await runGit(['branch', '-M', 'main'], seedPath);
  await runGit(['push', 'origin', 'main'], seedPath);

  // Clone origin as the target repo (this is what config.targetRepoPath points at)
  await runGit(['clone', originPath, targetRepoPath], root);
  await runGit(['config', 'user.email', 'test@example.com'], targetRepoPath);
  await runGit(['config', 'user.name', 'Test'], targetRepoPath);

  return {
    root,
    originPath,
    targetRepoPath,
    worktreeBase,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

let repo: Awaited<ReturnType<typeof setupTestRepo>>;
let head: string;

async function pushFeature(): Promise<string> {
  // A developer branch feature/foo on origin with one commit over main.
  const seed = join(repo.root, 'dev');
  await runGit(['clone', repo.originPath, seed], repo.root);
  await runGit(['config', 'user.email', 'dev@example.com'], seed);
  await runGit(['config', 'user.name', 'Dev'], seed);
  await runGit(['checkout', '-b', 'feature/foo'], seed);
  writeFileSync(join(seed, 'Test.al'), 'line1\nline2\n', 'utf-8');
  await runGit(['add', 'Test.al'], seed);
  await runGit(['commit', '-m', 'dev work'], seed);
  await runGit(['push', 'origin', 'feature/foo'], seed);
  return (await runGit(['rev-parse', 'HEAD'], seed)).trim();
}

function git() {
  return createSuggestionGit({
    config: makeTestConfig({
      TARGET_REPO_PATH: repo.targetRepoPath,
      WORKTREE_BASE: repo.worktreeBase,
      BOT_GIT_NAME: 'Mutant Bot',
      BOT_GIT_EMAIL: 'bot@example.com',
    }),
  });
}

const args = () => ({ pullRequestId: 7, headCommit: head, sourceRefName: 'refs/heads/feature/foo' });

beforeEach(async () => {
  repo = await setupTestRepo();
  head = await pushFeature();
}, 30000);
afterEach(() => repo.cleanup());

describe('createPrWorktree', () => {
  it('checks out the head commit on mutant/pr-<id>-<sha7>, locked', async () => {
    const wt = await git().createPrWorktree(args());
    expect(wt.branch).toBe(`mutant/pr-7-${head.slice(0, 7)}`);
    expect(wt.baseSha).toBe(head);
    expect((await runGit(['rev-parse', 'HEAD'], wt.path)).trim()).toBe(head);
    const list = await runGit(['worktree', 'list', '--porcelain'], repo.targetRepoPath);
    expect(list).toContain('locked');
  });

  it('replaces its own leftover worktree from a crashed run', async () => {
    const first = await git().createPrWorktree(args());
    writeFileSync(join(first.path, 'junk.txt'), 'x', 'utf-8');
    const second = await git().createPrWorktree(args());
    expect(second.path).toBe(first.path);
    expect(existsSync(join(second.path, 'junk.txt'))).toBe(false);
  });
});

describe('createPushWorktree', () => {
  it('starts at headCommit when origin is there', async () => {
    const wt = await git().createPushWorktree(args());
    expect((await runGit(['rev-parse', 'HEAD'], wt.path)).trim()).toBe(head);
  });

  it('throws HeadMovedError when the developer pushed since', async () => {
    const dev = join(repo.root, 'dev');
    writeFileSync(join(dev, 'Other.al'), 'x\n', 'utf-8');
    await runGit(['add', 'Other.al'], dev);
    await runGit(['commit', '-m', 'more'], dev);
    await runGit(['push', 'origin', 'feature/foo'], dev);
    await expect(git().createPushWorktree(args())).rejects.toBeInstanceOf(HeadMovedError);
  });
});

describe('commitFix', () => {
  it('turns the agent commits into one bot commit with the given message', async () => {
    const g = git();
    const wt = await g.createPrWorktree(args());
    await runGit(['config', 'user.email', 'agent@example.com'], wt.path);
    await runGit(['config', 'user.name', 'Agent'], wt.path);
    writeFileSync(join(wt.path, 'Test.al'), 'line1\nline2\nassert\n', 'utf-8');
    await runGit(['commit', '-am', 'agent says hi'], wt.path);
    writeFileSync(join(wt.path, 'New.al'), 'new\n', 'utf-8');
    await runGit(['add', 'New.al'], wt.path);
    await runGit(['commit', '-m', 'second agent commit'], wt.path);
    const sha = await g.commitFix({ path: wt.path, baselineSha: head, message: 'test: F001 kill mutants 1 (mutant-fixer run 9)' });
    expect(sha).not.toBeNull();
    expect((await runGit(['rev-list', '--count', `${head}..HEAD`], wt.path)).trim()).toBe('1');
    const log = await runGit(['log', '-1', '--format=%an|%ae|%cn|%ce|%s'], wt.path);
    expect(log.trim()).toBe('Mutant Bot|bot@example.com|Mutant Bot|bot@example.com|test: F001 kill mutants 1 (mutant-fixer run 9)');
    expect((await runGit(['show', '--name-only', '--format=', 'HEAD'], wt.path)).trim().split('\n').sort()).toEqual(['New.al', 'Test.al']);
  });

  it('commits tracked edits the agent left uncommitted', async () => {
    const g = git();
    const wt = await g.createPrWorktree(args());
    writeFileSync(join(wt.path, 'Test.al'), 'changed\n', 'utf-8');
    expect(await g.commitFix({ path: wt.path, baselineSha: head, message: 'm' })).not.toBeNull();
  });

  it('returns null and commits nothing when there is no change', async () => {
    const g = git();
    const wt = await g.createPrWorktree(args());
    expect(await g.commitFix({ path: wt.path, baselineSha: head, message: 'm' })).toBeNull();
    expect((await runGit(['rev-parse', 'HEAD'], wt.path)).trim()).toBe(head);
  });
});

describe('push', () => {
  async function oneFix(g: ReturnType<typeof git>, mode: 'pr' | 'push') {
    const wt = mode === 'pr' ? await g.createPrWorktree(args()) : await g.createPushWorktree(args());
    writeFileSync(join(wt.path, 'Test.al'), 'fixed\n', 'utf-8');
    const sha = await g.commitFix({ path: wt.path, baselineSha: head, message: 'm' });
    return { wt, sha: sha! };
  }

  it('pr mode force-pushes the mutant branch', async () => {
    const g = git();
    const { wt, sha } = await oneFix(g, 'pr');
    await g.push({ path: wt.path, mode: 'pr', remoteBranch: wt.branch, headCommit: head });
    const remote = await runGit(['ls-remote', repo.originPath, `refs/heads/${wt.branch}`], repo.root);
    expect(remote).toContain(sha);
  });

  it('push mode updates the developer branch', async () => {
    const g = git();
    const { wt, sha } = await oneFix(g, 'push');
    await g.push({ path: wt.path, mode: 'push', remoteBranch: 'feature/foo', headCommit: head });
    expect(await runGit(['ls-remote', repo.originPath, 'refs/heads/feature/foo'], repo.root)).toContain(sha);
  });

  it('push mode refuses when the remote moved after the fetch', async () => {
    const g = git();
    const { wt } = await oneFix(g, 'push');
    const dev = join(repo.root, 'dev');
    writeFileSync(join(dev, 'Other.al'), 'x\n', 'utf-8');
    await runGit(['add', 'Other.al'], dev);
    await runGit(['commit', '-m', 'race'], dev);
    await runGit(['push', 'origin', 'feature/foo'], dev);
    const devHead = (await runGit(['rev-parse', 'HEAD'], dev)).trim();
    await expect(g.push({ path: wt.path, mode: 'push', remoteBranch: 'feature/foo', headCommit: head })).rejects.toThrow();
    expect(await runGit(['ls-remote', repo.originPath, 'refs/heads/feature/foo'], repo.root)).toContain(devHead);
  });
});

describe('removeWorktree', () => {
  it('removes its locked worktree and local branch', async () => {
    const g = git();
    const wt = await g.createPrWorktree(args());
    await g.removeWorktree(wt);
    expect(existsSync(wt.path)).toBe(false);
    expect(await runGit(['branch', '--list', wt.branch], repo.targetRepoPath)).toBe('');
  });

  it('removeWorktree leaves other registrations alone (no prune)', async () => {
    // Another container's worktree: registered, but its path does not exist here.
    const other = join(repo.root, 'other-wt');
    await runGit(['worktree', 'add', '--detach', other, 'main'], repo.targetRepoPath);
    rmSync(other, { recursive: true, force: true });
    const g = git();
    await g.removeWorktree(await g.createPrWorktree(args()));
    const list = await runGit(['worktree', 'list', '--porcelain'], repo.targetRepoPath);
    expect(list.replace(/\\/g, '/')).toContain(other.replace(/\\/g, '/'));
  });
});
