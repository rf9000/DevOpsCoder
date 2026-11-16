import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { resolve } from 'path';
import { HeadMovedError } from '../suggestions/suggestion-git.ts';
import type { AppConfig, WorktreeContext } from '../types/index.ts';
import { buildGitAuthArgs, redactPat } from '../utils/git-auth.ts';
import type { Logger } from '../utils/logger.ts';

export type RebaseStep =
  | { kind: 'done'; head: string }
  | { kind: 'conflict'; commit: string; subject: string; files: string[] };

export interface PrFixGit {
  /** Fetch source + target, check origin/<source> === headCommit (else HeadMovedError), add a locked worktree on branch `prfix/pr-<id>` at headCommit. */
  createWorktree(a: { pullRequestId: number; sourceRefName: string; targetRefName: string; headCommit: string }): Promise<WorktreeContext & { targetSha: string }>;
  /** origin/<target> is already an ancestor of HEAD. */
  isUpToDate(path: string, targetSha: string): Promise<boolean>;
  /** `git rebase --empty=drop <targetSha>` with the bot committer identity. */
  startRebase(path: string, targetSha: string): Promise<RebaseStep>;
  /** Stage `files`, then `rebase --continue` (GIT_EDITOR=true). */
  continueRebase(path: string, files: string[]): Promise<RebaseStep>;
  abortRebase(path: string): Promise<void>;
  /** Files of `files` that still contain a conflict marker line (^<<<<<<< , ^=======$, ^>>>>>>> ). */
  filesWithMarkers(path: string, files: string[]): Promise<string[]>;
  headSha(path: string): Promise<string>;
  /** `git rev-list --count <from>..HEAD`. */
  countCommits(path: string, from: string): Promise<number>;
  push(a: { path: string; sourceRefName: string; expectedRemoteSha: string }): Promise<void>;
  removeWorktree(wt: WorktreeContext): Promise<void>;
}

/** A conflict marker line; `\r?` because a CRLF checkout keeps the carriage return. */
const MARKER_LINE = /^(<<<<<<< .*|=======|>>>>>>> .*)\r?$/m;

/**
 * Every git call fix-pr makes. The clone is shared with the devops-coder
 * service and with other agents whose worktree paths may not exist here: `git
 * worktree prune` would delete their registrations, so nothing here prunes.
 * Worktrees are added `--lock`ed, which is why removal and re-adding pass
 * `--force` twice.
 */
export function createPrFixGit(deps: { config: AppConfig; logger?: Logger }): PrFixGit {
  const repo = deps.config.targetRepoPath;
  const pat = deps.config.pat;

  async function runGit(
    args: string[],
    cwd: string,
    opts: { allowExit?: number[] } = {},
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const describe = redactPat(`git ${args.join(' ')}`, pat);
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(['git', ...args], {
        cwd,
        stdout: 'pipe',
        stderr: 'pipe',
        // GIT_EDITOR=true: `rebase --continue` must never wait on an editor.
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo', GIT_EDITOR: 'true' },
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
    return { stdout, stderr, exitCode };
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

  async function fetchBranch(ref: string): Promise<string> {
    const short = shortBranch(ref);
    await runGit([...buildGitAuthArgs(pat), 'fetch', 'origin', `+refs/heads/${short}:refs/remotes/origin/${short}`], repo);
    return (await runGit(['rev-parse', `refs/remotes/origin/${short}`], repo)).stdout.trim();
  }

  function botIdentity(): string[] {
    const name = deps.config.botGitName;
    const email = deps.config.botGitEmail;
    if (!name || !email) throw new Error('BOT_GIT_NAME and BOT_GIT_EMAIL are required to rebase a PR');
    return ['-c', `user.name=${name}`, '-c', `user.email=${email}`, '-c', 'core.editor=true'];
  }

  async function rebaseInProgress(path: string): Promise<boolean> {
    // In a linked worktree this is under the main repo's .git/worktrees/<name>/;
    // git prints it relative to cwd, or absolute.
    const rel = (await runGit(['rev-parse', '--git-path', 'rebase-merge'], path)).stdout.trim();
    return existsSync(resolve(path, rel));
  }

  /** After a rebase/continue command: either finished, or stopped on a conflict. */
  async function rebaseStep(path: string, exitCode: number, output: string): Promise<RebaseStep> {
    const stopped = await rebaseInProgress(path);
    if (!stopped) {
      if (exitCode !== 0) {
        throw new Error(`git rebase failed (exit ${exitCode}) with no rebase in progress: ${redactPat(output.trim() || '(no output)', pat)}`);
      }
      return { kind: 'done', head: (await runGit(['rev-parse', 'HEAD'], path)).stdout.trim() };
    }
    const files = (await runGit(['diff', '--name-only', '--diff-filter=U'], path)).stdout
      .split('\n')
      .map((f) => f.trim())
      .filter(Boolean);
    if (files.length === 0) {
      throw new Error(`git rebase stopped without conflicted files: ${redactPat(output.trim() || '(no output)', pat)}`);
    }
    const commit = (await runGit(['rev-parse', 'REBASE_HEAD'], path)).stdout.trim();
    const subject = (await runGit(['log', '-1', '--format=%s', commit], path)).stdout.trim();
    return { kind: 'conflict', commit, subject, files };
  }

  return {
    async createWorktree(a) {
      const short = shortBranch(a.sourceRefName);
      const actual = await fetchBranch(a.sourceRefName);
      if (actual !== a.headCommit) throw new HeadMovedError(short, a.headCommit, actual);
      const targetSha = await fetchBranch(a.targetRefName);

      const path = resolve(deps.config.worktreeBase, `prfix-${a.pullRequestId}`);
      const branch = `prfix/pr-${a.pullRequestId}`;
      mkdirSync(deps.config.worktreeBase, { recursive: true });
      // Our own leftover from a crashed run (possibly mid-rebase): remove it, never prune.
      await tryRunGit(['worktree', 'remove', '--force', '--force', path], repo);
      if (existsSync(path)) rmSync(path, { recursive: true, force: true });
      await runGit(['worktree', 'add', '--force', '--force', '--lock', '-B', branch, path, a.headCommit], repo);
      return { path, branch, baseSha: a.headCommit, targetSha };
    },

    async isUpToDate(path, targetSha) {
      const { exitCode } = await runGit(['merge-base', '--is-ancestor', targetSha, 'HEAD'], path, { allowExit: [1] });
      return exitCode === 0;
    },

    async startRebase(path, targetSha) {
      const r = await runGit([...botIdentity(), 'rebase', '--empty=drop', targetSha], path, { allowExit: [1] });
      return rebaseStep(path, r.exitCode, r.stderr || r.stdout);
    },

    async continueRebase(path, files) {
      const identity = botIdentity();
      // -A: a resolution may delete a file.
      if (files.length > 0) await runGit(['add', '-A', '--', ...files], path);
      const r = await runGit([...identity, 'rebase', '--continue'], path, { allowExit: [1] });
      return rebaseStep(path, r.exitCode, r.stderr || r.stdout);
    },

    async abortRebase(path) {
      if (await rebaseInProgress(path)) await runGit(['rebase', '--abort'], path);
    },

    async filesWithMarkers(path, files) {
      const hits: string[] = [];
      for (const f of files) {
        const full = resolve(path, f);
        if (!existsSync(full)) continue;
        if (MARKER_LINE.test(readFileSync(full, 'utf8'))) hits.push(f);
      }
      return hits;
    },

    async headSha(path) {
      return (await runGit(['rev-parse', 'HEAD'], path)).stdout.trim();
    },

    async countCommits(path, from) {
      const out = (await runGit(['rev-list', '--count', `${from}..HEAD`], path)).stdout.trim();
      return Number.parseInt(out, 10);
    },

    async push(a) {
      const short = shortBranch(a.sourceRefName);
      const target = `refs/heads/${short}`;
      try {
        await runGit(
          [...buildGitAuthArgs(pat), 'push', `--force-with-lease=${target}:${a.expectedRemoteSha}`, 'origin', `HEAD:${target}`],
          a.path,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/stale info|rejected/i.test(msg)) throw err;
        const ls = (await runGit([...buildGitAuthArgs(pat), 'ls-remote', 'origin', target], a.path)).stdout.trim();
        const actual = ls.split(/\s+/)[0] ?? '';
        // A hook decline or a branch-policy refusal also reads "rejected", but
        // only a remote that actually moved is a lost lease.
        if (actual === a.expectedRemoteSha) throw err;
        deps.logger?.warn(`fix-pr: push to ${short} rejected; remote is at ${actual || '(gone)'}, expected ${a.expectedRemoteSha}`);
        throw new HeadMovedError(short, a.expectedRemoteSha, actual);
      }
    },

    async removeWorktree(wt) {
      await tryRunGit(['worktree', 'remove', '--force', '--force', wt.path], repo);
      if (existsSync(wt.path)) rmSync(wt.path, { recursive: true, force: true });
      await tryRunGit(['branch', '-D', wt.branch], repo);
    },
  };
}
