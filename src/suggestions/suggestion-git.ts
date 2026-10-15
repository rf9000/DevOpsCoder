import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import type { AppConfig, WorktreeContext } from '../types/index.ts';
import { buildGitAuthArgs, redactPat } from '../utils/git-auth.ts';
import type { Logger } from '../utils/logger.ts';
import { mutantBranchName, sha7 } from './input.ts';

/** commitFix refuses a commit that deletes more files than this. */
export const MAX_DELETED_FILES = 5;

/** push mode: origin/<branch> is no longer the commit the fixes were computed against. */
export class HeadMovedError extends Error {
  override readonly name = 'HeadMovedError';
  constructor(
    public readonly branch: string,
    public readonly expected: string,
    public readonly actual: string,
  ) {
    super(`origin/${branch} is at ${actual}, expected ${expected}`);
  }
}

export interface PrepareArgs {
  pullRequestId: number;
  headCommit: string;
  sourceRefName: string;
}

export interface SuggestionGit {
  createPrWorktree(a: PrepareArgs): Promise<WorktreeContext>;
  createPushWorktree(a: PrepareArgs): Promise<WorktreeContext>;
  headSha(path: string): Promise<string>;
  resetHard(path: string, sha: string): Promise<void>;
  commitFix(a: { path: string; baselineSha: string; message: string }): Promise<string | null>;
  /**
   * `git apply -p1` the unified diff in the worktree, paths rooted at
   * `directory` (repo-relative), and stage it (`--index`), new files too.
   * False when git refuses the patch; the worktree is then unchanged.
   */
  applyPatch(a: { path: string; patch: string; directory?: string }): Promise<boolean>;
  push(a: { path: string; mode: 'pr' | 'push'; remoteBranch: string; headCommit: string }): Promise<void>;
  removeWorktree(wt: WorktreeContext): Promise<void>;
}

/**
 * Every git call apply-suggestions makes. The clone is shared with the
 * devops-coder service and with mutant-fixer, whose worktree paths do not
 * exist in this container: `git worktree prune` would delete their
 * registrations, so nothing here prunes. Worktrees are added `--lock`ed, which
 * is why removal and re-adding pass `--force` twice.
 */
export function createSuggestionGit(deps: { config: AppConfig; logger?: Logger }): SuggestionGit {
  const repo = deps.config.targetRepoPath;
  const pat = deps.config.pat;

  async function runGit(args: string[], cwd: string, opts: { allowExit?: number[] } = {}): Promise<{ stdout: string; exitCode: number }> {
    const describe = redactPat(`git ${args.join(' ')}`, pat);
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(['git', ...args], {
        cwd,
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' },
      });
    } catch (spawnErr) {
      const msg = spawnErr instanceof Error ? spawnErr.message : String(spawnErr);
      throw new Error(`${describe} failed (spawn error): ${redactPat(msg, pat)}`);
    }
    const stdout = await new Response(proc.stdout as ReadableStream).text();
    const stderr = await new Response(proc.stderr as ReadableStream).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0 && !(opts.allowExit ?? []).includes(exitCode)) {
      throw new Error(`${describe} failed (exit ${exitCode}): ${redactPat(stderr.trim() || stdout.trim() || '(no output)', pat)}`);
    }
    return { stdout, exitCode };
  }

  async function tryRunGit(args: string[], cwd: string): Promise<void> {
    try {
      await runGit(args, cwd);
    } catch {
      // best-effort
    }
  }

  function shortBranch(ref: string): string {
    return ref.replace(/^refs\/heads\//, '');
  }

  async function fetchBranch(ref: string): Promise<void> {
    const short = shortBranch(ref);
    await runGit([...buildGitAuthArgs(pat), 'fetch', 'origin', `+refs/heads/${short}:refs/remotes/origin/${short}`], repo);
  }

  async function addWorktree(path: string, branch: string, start: string): Promise<WorktreeContext> {
    mkdirSync(deps.config.worktreeBase, { recursive: true });
    // Our own leftover from a crashed run: remove it, never prune.
    await tryRunGit(['worktree', 'remove', '--force', '--force', path], repo);
    if (existsSync(path)) rmSync(path, { recursive: true, force: true });
    await runGit(['worktree', 'add', '--force', '--force', '--lock', '-B', branch, path, start], repo);
    return { path, branch, baseSha: start };
  }

  function worktreePath(kind: 'pr' | 'push', a: PrepareArgs): string {
    return resolve(deps.config.worktreeBase, `mutant-${kind}-${a.pullRequestId}-${sha7(a.headCommit)}`);
  }

  return {
    async createPrWorktree(a) {
      await fetchBranch(a.sourceRefName);
      await runGit(['cat-file', '-e', `${a.headCommit}^{commit}`], repo);
      return addWorktree(worktreePath('pr', a), mutantBranchName(a.pullRequestId, a.headCommit), a.headCommit);
    },

    async createPushWorktree(a) {
      await fetchBranch(a.sourceRefName);
      const short = shortBranch(a.sourceRefName);
      const actual = (await runGit(['rev-parse', `refs/remotes/origin/${short}`], repo)).stdout.trim();
      if (actual !== a.headCommit) throw new HeadMovedError(short, a.headCommit, actual);
      return addWorktree(worktreePath('push', a), `mutant-push/pr-${a.pullRequestId}-${sha7(a.headCommit)}`, a.headCommit);
    },

    async headSha(path) {
      return (await runGit(['rev-parse', 'HEAD'], path)).stdout.trim();
    },

    async resetHard(path, sha) {
      await runGit(['reset', '--hard', sha], path);
      await runGit(['clean', '-fd'], path);
    },

    async commitFix(a) {
      const name = deps.config.botGitName;
      const email = deps.config.botGitEmail;
      if (!name || !email) throw new Error('BOT_GIT_NAME and BOT_GIT_EMAIL are required to commit fixes');
      // Whatever the agent committed, and the tracked edits it did not, become
      // one commit with the contract message and the bot identity.
      await runGit(['reset', '--soft', a.baselineSha], a.path);
      await runGit(['add', '-u'], a.path);
      const { exitCode } = await runGit(['diff', '--cached', '--quiet'], a.path, { allowExit: [1] });
      if (exitCode === 0) return null;
      // A test fix never deletes files wholesale. mutant-fixer run 1042: an index that had lost
      // every file but one became a commit deleting 4019 files.
      const deleted = (await runGit(['diff', '--cached', '--name-only', '--diff-filter=D'], a.path)).stdout
        .split('\n')
        .filter(Boolean);
      if (deleted.length > MAX_DELETED_FILES) {
        throw new Error(`commitFix: the commit would delete ${deleted.length} files (at most ${MAX_DELETED_FILES} allowed), e.g. ${deleted.slice(0, 3).join(', ')}; not committing`);
      }
      await runGit(['-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit', '--no-verify', '-m', a.message], a.path);
      return (await runGit(['rev-parse', 'HEAD'], a.path)).stdout.trim();
    },

    async applyPatch(a) {
      // Outside the worktree, so a failed apply leaves nothing to clean up.
      // A Buffer keeps the bytes exact: CRLF content lines must match the file.
      const dir = mkdtempSync(join(tmpdir(), 'mutant-patch-'));
      const file = join(dir, 'fix.patch');
      try {
        writeFileSync(file, Buffer.from(a.patch, 'utf8'));
        // --index, not --intent-to-add: on git 2.47.3 (the VM's), --intent-to-add without --index
        // left only the patched file in the index (mutant-fixer run 1042).
        const args = ['apply', '-p1', '--whitespace=nowarn', '--index'];
        if (a.directory) args.push(`--directory=${a.directory}`);
        args.push(file);
        try {
          await runGit(args, a.path);
          return true;
        } catch (err) {
          deps.logger?.warn(`apply-suggestions: ${err instanceof Error ? err.message : String(err)}`);
          return false;
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },

    async push(a) {
      const target = `refs/heads/${a.remoteBranch}`;
      const lease = a.mode === 'pr' ? ['--force'] : [`--force-with-lease=${target}:${a.headCommit}`];
      await runGit([...buildGitAuthArgs(pat), 'push', ...lease, 'origin', `HEAD:${target}`], a.path);
    },

    async removeWorktree(wt) {
      await tryRunGit(['worktree', 'remove', '--force', '--force', wt.path], repo);
      if (existsSync(wt.path)) rmSync(wt.path, { recursive: true, force: true });
      await tryRunGit(['branch', '-D', wt.branch], repo);
    },
  };
}
