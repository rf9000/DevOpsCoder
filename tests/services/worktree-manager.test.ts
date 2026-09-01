import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  createWorktreeManager,
  WorktreeError,
} from '../../src/services/worktree-manager.ts';
import type { AppConfig, WorktreeContext } from '../../src/types/index.ts';

async function runGit(args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(
      `git ${args.join(' ')} (in ${cwd}) failed: ${stderr || stdout}`,
    );
  }
  return stdout;
}

async function setupTestRepo(): Promise<{
  root: string;
  originPath: string;
  targetRepoPath: string;
  worktreeBase: string;
  cleanup: () => void;
}> {
  const root = mkdtempSync(join(tmpdir(), 'wtm-'));
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

function makeConfig(targetRepoPath: string, worktreeBase: string): AppConfig {
  return {
    orgUrl: 'https://x',
    project: 'p',
    pat: 'pat',
    repositoryName: 'test-repo',
    targetRepoPath,
    worktreeBase,
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
    stateDir: '.state', logDir: 'logs',
    assignedToFilter: [],
    continiaCliPath: '.tools/continia.exe', continiaEnvProfileId: 'prof-1', continiaApiToken: 'tok', continiaAppPaths: ['App'], continiaTestAppPaths: ['App'], maxTestFixAttempts: 2, continiaTestTimeoutS: 600, dryRun: false, skipBuildTest: false, testSelection: 'all', maxTestCodeunits: 0, costLogPath: '.state/cost-ledger.jsonl',
  };
}

describe('createWorktreeManager', () => {
  let sandbox: Awaited<ReturnType<typeof setupTestRepo>>;

  // setupTestRepo runs ~9 sequential `git` subprocess calls (~9s on Windows).
  // Bun's default hook timeout is 5s — bump to 30s for these tests.
  beforeEach(async () => {
    sandbox = await setupTestRepo();
  }, 30000);

  afterEach(() => {
    sandbox.cleanup();
  }, 30000);

  it('ensureWorktree creates a fresh worktree off origin/main on first call', async () => {
    const mgr = createWorktreeManager({
      config: makeConfig(sandbox.targetRepoPath, sandbox.worktreeBase),
    });
    const ctx = await mgr.ensureWorktree({ workItemId: 101, slug: 'fix-login' });
    expect(ctx.path).toBe(join(sandbox.worktreeBase, 'wi-101-fix-login'));
    expect(ctx.branch).toBe('agent/wi-101-fix-login');
    expect(ctx.baseSha).toMatch(/^[0-9a-f]{40}$/);
    expect(existsSync(ctx.path)).toBe(true);
    const list = await runGit(
      ['worktree', 'list', '--porcelain'],
      sandbox.targetRepoPath,
    );
    // git porcelain outputs forward-slash paths on Windows; normalise ctx.path for comparison
    expect(list).toContain(ctx.path.replace(/\\/g, '/'));
    expect(list).toContain('branch refs/heads/agent/wi-101-fix-login');
  }, 30000);

  it('ensureWorktree reuses when persistedWorktree validates on disk + registry', async () => {
    const mgr = createWorktreeManager({
      config: makeConfig(sandbox.targetRepoPath, sandbox.worktreeBase),
    });
    const first = await mgr.ensureWorktree({ workItemId: 101, slug: 'fix-login' });
    const second = await mgr.ensureWorktree({
      workItemId: 101,
      slug: 'fix-login',
      persistedWorktree: first,
    });
    expect(second).toEqual(first);
  }, 30000);

  it('ensureWorktree recovers from an orphan: path on disk but not in git registry', async () => {
    const mgr = createWorktreeManager({
      config: makeConfig(sandbox.targetRepoPath, sandbox.worktreeBase),
    });
    // Manually drop a stale dir into worktreeBase that's not a real worktree
    const orphanPath = join(sandbox.worktreeBase, 'wi-101-fix-login');
    mkdirSync(orphanPath, { recursive: true });
    writeFileSync(join(orphanPath, 'junk.txt'), 'orphan', 'utf-8');

    const ctx = await mgr.ensureWorktree({ workItemId: 101, slug: 'fix-login' });
    expect(ctx.path).toBe(orphanPath);
    expect(existsSync(join(ctx.path, '.git'))).toBe(true); // proper worktree marker
    expect(existsSync(join(ctx.path, 'junk.txt'))).toBe(false); // orphan dir was wiped
  }, 30000);

  it('persistedWorktree.branch wins over recomputed slug (branch name immutability)', async () => {
    const mgr = createWorktreeManager({
      config: makeConfig(sandbox.targetRepoPath, sandbox.worktreeBase),
    });
    const first = await mgr.ensureWorktree({ workItemId: 101, slug: 'old-slug' });
    // Simulate a slug rename via WI title edit: caller still passes the OLD persisted state
    const second = await mgr.ensureWorktree({
      workItemId: 101,
      slug: 'new-different-slug',
      persistedWorktree: first,
    });
    expect(second.branch).toBe(first.branch);
    expect(second.path).toBe(first.path);
  }, 30000);

  it('ensureWorktree creates worktreeBase if missing', async () => {
    const customBase = join(sandbox.root, 'fresh-base');
    expect(existsSync(customBase)).toBe(false);
    const mgr = createWorktreeManager({
      config: makeConfig(sandbox.targetRepoPath, customBase),
    });
    const ctx = await mgr.ensureWorktree({ workItemId: 99, slug: 'wi' });
    expect(existsSync(customBase)).toBe(true);
    expect(existsSync(ctx.path)).toBe(true);
  }, 30000);

  it('removeWorktree cleans up both the registry entry and the branch', async () => {
    const mgr = createWorktreeManager({
      config: makeConfig(sandbox.targetRepoPath, sandbox.worktreeBase),
    });
    const ctx = await mgr.ensureWorktree({ workItemId: 101, slug: 'fix-login' });
    expect(existsSync(ctx.path)).toBe(true);

    await mgr.removeWorktree({
      workItemId: 101,
      slug: 'fix-login',
      persistedWorktree: ctx,
    });

    expect(existsSync(ctx.path)).toBe(false);
    const list = await runGit(
      ['worktree', 'list', '--porcelain'],
      sandbox.targetRepoPath,
    );
    expect(list).not.toContain(ctx.path);
    const branches = await runGit(['branch'], sandbox.targetRepoPath);
    expect(branches).not.toContain('agent/wi-101-fix-login');
  }, 30000);

  it('removeWorktree is best-effort: silently succeeds when worktree does not exist', async () => {
    const mgr = createWorktreeManager({
      config: makeConfig(sandbox.targetRepoPath, sandbox.worktreeBase),
    });
    // No worktree was ever created — remove should not throw
    await expect(
      mgr.removeWorktree({ workItemId: 999, slug: 'nonexistent' }),
    ).resolves.toBeUndefined();
  }, 30000);

  it('authenticates fetch per-invocation and never leaks the PAT into errors', async () => {
    const config = {
      ...makeConfig(sandbox.targetRepoPath, sandbox.worktreeBase),
      pat: 'super-secret-pat-value-1234',
    };
    const mgr = createWorktreeManager({ config });
    // Break the remote so the initial `git fetch origin` fails.
    await runGit(
      ['remote', 'set-url', 'origin', join(sandbox.root, 'does-not-exist.git')],
      sandbox.targetRepoPath,
    );
    let caught: unknown;
    try {
      await mgr.ensureWorktree({ workItemId: 101, slug: 'x' });
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(WorktreeError);
    const err = caught as WorktreeError;
    const basic = Buffer.from(':super-secret-pat-value-1234').toString('base64');
    // The fetch argv carries the auth header, so the message proves both that
    // auth args are present and that they are redacted.
    expect(err.message).toContain('http.extraHeader');
    expect(err.message).not.toContain('super-secret-pat-value-1234');
    expect(err.message).not.toContain(basic);
    expect(err.command.join(' ')).not.toContain(basic);
  }, 30000);

  it('throws WorktreeError when run against an invalid baseRepoPath', async () => {
    const mgr = createWorktreeManager({
      config: makeConfig(
        join(sandbox.root, 'does-not-exist'),
        sandbox.worktreeBase,
      ),
    });
    let caught: unknown;
    try {
      await mgr.ensureWorktree({ workItemId: 101, slug: 'wi' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(WorktreeError);
    if (caught instanceof WorktreeError) {
      expect(caught.exitCode).not.toBe(0);
      expect(caught.command[0]).toBe('git');
    }
  }, 30000);
});
