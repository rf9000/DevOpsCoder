import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'fs';
import { resolve } from 'path';
import { HeadMovedError } from '../suggestions/suggestion-git.ts';
import type { AppConfig, WorktreeContext } from '../types/index.ts';
import { buildGitAuthArgs, redactPat } from '../utils/git-auth.ts';
import { NO_GIT_LOCK, type GitLock } from '../utils/git-lock.ts';
import type { Logger } from '../utils/logger.ts';

export type RebaseStep =
  | { kind: 'done'; head: string }
  | { kind: 'conflict'; commit: string; subject: string; files: string[] };

/**
 * A conflicted path no edit to its content can settle: `binary` (both sides
 * present, but git cannot merge them as text), or `one-sided` (the stage-2 or
 * stage-3 entry is missing: modify/delete, rename/delete, file/directory).
 */
export interface UnresolvableConflict {
  path: string;
  kind: 'binary' | 'one-sided';
}

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
  /** Files of `files` that still contain a conflict marker line (^<<<<<<< , ^|||||||, ^=======$, ^>>>>>>> ). */
  filesWithMarkers(path: string, files: string[]): Promise<string[]>;
  /** Unmerged paths (`ls-files -u`) that are not both-sides text conflicts. */
  unresolvableConflicts(path: string): Promise<UnresolvableConflict[]>;
  /** sha256 of each file's content; null when the file is missing or not a regular file. */
  fingerprintFiles(path: string, files: string[]): Promise<Record<string, string | null>>;
  /** Tracked files with unstaged edits (`git diff --name-only -z`). */
  unstagedChanges(path: string): Promise<string[]>;
  /** `git status --porcelain --untracked-files=all` entries; empty means the tree is exactly HEAD. */
  dirtyPaths(path: string): Promise<string[]>;
  /** `git rev-list --merges --count <from>..HEAD`. */
  countMergeCommits(path: string, from: string): Promise<number>;
  headSha(path: string): Promise<string>;
  /** `git rev-list --count <from>..HEAD`. */
  countCommits(path: string, from: string): Promise<number>;
  /** `git diff --name-status -z --no-renames <from> HEAD`: repo-relative paths with A|M|D. */
  changedFiles(path: string, from: string): Promise<{ status: 'A' | 'M' | 'D'; file: string }[]>;
  /** `git show <ref>:<file>`; null when the path does not exist at ref. Returns raw text (no newline normalisation). */
  showFileAtRef(path: string, ref: string, file: string): Promise<string | null>;
  /** `git ls-files -z -- <pathspec>` at HEAD, repo-relative, forward slashes (e.g. pathspec `*.al`). */
  listFiles(path: string, pathspec: string): Promise<string[]>;
  /** Stage exactly `files` (`git add -- <files>`) and commit them with the bot identity as author AND committer; returns the new sha. Throws if nothing is staged. */
  commitFiles(path: string, files: string[], message: string): Promise<string>;
  push(a: { path: string; sourceRefName: string; expectedRemoteSha: string }): Promise<void>;
  /** `git range-diff --no-color <base> <oldHead> <newHead>`, capped at DIFF_CAP_CHARS. */
  rangeDiff(path: string, base: string, oldHead: string, newHead: string): Promise<string>;
  /** `git diff --no-color <from> <to> -- <file>`, capped at DIFF_CAP_CHARS. */
  fileDiff(path: string, from: string, to: string, file: string): Promise<string>;
  removeWorktree(wt: WorktreeContext): Promise<void>;
}

/**
 * A conflict marker line, diff3's `|||||||` base marker included; `\r?`
 * because a CRLF checkout keeps the carriage return.
 */
const MARKER_LINE = /^(<<<<<<< .*|\|{7}(?: .*)?|=======|>>>>>>> .*)\r?$/m;

/** The review's range-diff and each conflict file diff are cut here. */
export const DIFF_CAP_CHARS = 20_000;

function capDiff(text: string): string {
  return text.length > DIFF_CAP_CHARS ? `${text.slice(0, DIFF_CAP_CHARS)}\n… (truncated)` : text;
}

/** Split `-z` output; NUL-separated names are never quoted or escaped. */
function splitNul(out: string): string[] {
  return out.split('\0').filter(Boolean);
}

/**
 * Every git call fix-pr makes. The clone is shared with the devops-coder
 * service and with other agents whose worktree paths may not exist here: `git
 * worktree prune` would delete their registrations, so nothing here prunes.
 * Worktrees are added `--lock`ed, which is why removal and re-adding pass
 * `--force` twice.
 */
export function createPrFixGit(deps: { config: AppConfig; logger?: Logger; gitLock?: GitLock }): PrFixGit {
  const repo = deps.config.targetRepoPath;
  const pat = deps.config.pat;
  const gitLock = deps.gitLock ?? NO_GIT_LOCK;
  const sameDir = (a: string, b: string): boolean => a.replace(/\\/g, '/') === b.replace(/\\/g, '/');

  type GitResult = { stdout: string; stderr: string; exitCode: number };
  type GitOpts = { allowExit?: number[]; rawStdout?: boolean };

  /** Commands on the shared clone are serialized; worktree-scoped ones are not. */
  function runGit(args: string[], cwd: string, opts: GitOpts = {}): Promise<GitResult> {
    if (sameDir(cwd, repo)) return gitLock.run(() => spawnGit(args, cwd, opts));
    return spawnGit(args, cwd, opts);
  }

  async function spawnGit(args: string[], cwd: string, opts: GitOpts): Promise<GitResult> {
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
    // Response.text() strips a leading UTF-8 BOM; rawStdout keeps it (file content).
    const stdout = opts.rawStdout
      ? new TextDecoder('utf-8', { ignoreBOM: true }).decode(await new Response(proc.stdout as ReadableStream).arrayBuffer())
      : await new Response(proc.stdout as ReadableStream).text();
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
    // -z: otherwise git quotes non-ASCII names, and trimming mangles edge whitespace.
    const files = splitNul((await runGit(['diff', '--name-only', '--diff-filter=U', '-z'], path)).stdout);
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

    async unresolvableConflicts(path) {
      // One `<mode> <sha> <stage>\t<path>` entry per stage present.
      const stages = new Map<string, Set<string>>();
      for (const entry of splitNul((await runGit(['ls-files', '-u', '-z'], path)).stdout)) {
        const tab = entry.indexOf('\t');
        if (tab < 0) continue;
        const file = entry.slice(tab + 1);
        const set = stages.get(file) ?? new Set<string>();
        set.add(entry.slice(0, tab).split(' ')[2] ?? '');
        stages.set(file, set);
      }
      const out: UnresolvableConflict[] = [];
      const twoSided: string[] = [];
      for (const [file, set] of stages) {
        if (set.has('2') && set.has('3')) twoSided.push(file);
        else out.push({ path: file, kind: 'one-sided' });
      }
      if (twoSided.length > 0) {
        // Mid-rebase, HEAD is the target side and REBASE_HEAD the replayed
        // commit; numstat prints `-\t-` for a binary pair (gitattributes included).
        const numstat = (
          await runGit(['diff', '--numstat', '-z', '--no-renames', 'HEAD', 'REBASE_HEAD', '--', ...twoSided], path)
        ).stdout;
        const binary = new Set(
          splitNul(numstat)
            .filter((e) => e.startsWith('-\t-\t'))
            .map((e) => e.slice(4)),
        );
        for (const file of twoSided) if (binary.has(file)) out.push({ path: file, kind: 'binary' });
      }
      return out.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
    },

    async fingerprintFiles(path, files) {
      const out: Record<string, string | null> = {};
      for (const f of files) {
        const full = resolve(path, f);
        out[f] =
          existsSync(full) && statSync(full).isFile()
            ? createHash('sha256').update(readFileSync(full)).digest('hex')
            : null;
      }
      return out;
    },

    async unstagedChanges(path) {
      return splitNul((await runGit(['diff', '--name-only', '-z'], path)).stdout);
    },

    async dirtyPaths(path) {
      return splitNul((await runGit(['status', '--porcelain', '--untracked-files=all', '-z'], path)).stdout);
    },

    async countMergeCommits(path, from) {
      const out = (await runGit(['rev-list', '--merges', '--count', `${from}..HEAD`], path)).stdout.trim();
      return Number.parseInt(out, 10);
    },

    async headSha(path) {
      return (await runGit(['rev-parse', 'HEAD'], path)).stdout.trim();
    },

    async countCommits(path, from) {
      const out = (await runGit(['rev-list', '--count', `${from}..HEAD`], path)).stdout.trim();
      return Number.parseInt(out, 10);
    },

    async changedFiles(path, from) {
      const parts = splitNul((await runGit(['diff', '--name-status', '-z', '--no-renames', from, 'HEAD'], path)).stdout);
      const out: { status: 'A' | 'M' | 'D'; file: string }[] = [];
      // -z --no-renames: alternating status / path entries.
      for (let i = 0; i + 1 < parts.length; i += 2) {
        const status = (parts[i] ?? '').charAt(0);
        out.push({ status: status === 'A' || status === 'D' ? status : 'M', file: parts[i + 1] ?? '' });
      }
      return out;
    },

    async showFileAtRef(path, ref, file) {
      const r = await runGit(['-c', 'core.autocrlf=false', 'show', `${ref}:${file}`], path, { allowExit: [128], rawStdout: true });
      if (r.exitCode === 0) return r.stdout;
      if (/does not exist|exists on disk, but not in/i.test(r.stderr)) return null;
      throw new Error(`git show ${ref}:${file} failed (exit ${r.exitCode}): ${redactPat(r.stderr.trim() || '(no output)', pat)}`);
    },

    async listFiles(path, pathspec) {
      return splitNul((await runGit(['ls-files', '-z', '--', pathspec], path)).stdout);
    },

    async commitFiles(path, files, message) {
      const identity = botIdentity();
      await runGit(['add', '--', ...files], path);
      const { exitCode } = await runGit(['diff', '--cached', '--quiet'], path, { allowExit: [1] });
      if (exitCode === 0) throw new Error('commitFiles: nothing to commit');
      const author = `${deps.config.botGitName} <${deps.config.botGitEmail}>`;
      await runGit([...identity, 'commit', `--author=${author}`, '-m', message], path);
      return (await runGit(['rev-parse', 'HEAD'], path)).stdout.trim();
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

    async rangeDiff(path, base, oldHead, newHead) {
      return capDiff((await runGit(['range-diff', '--no-color', base, oldHead, newHead], path)).stdout);
    },

    async fileDiff(path, from, to, file) {
      return capDiff((await runGit(['diff', '--no-color', from, to, '--', file], path)).stdout);
    },

    async removeWorktree(wt) {
      await tryRunGit(['worktree', 'remove', '--force', '--force', wt.path], repo);
      if (existsSync(wt.path)) rmSync(wt.path, { recursive: true, force: true });
      await tryRunGit(['branch', '-D', wt.branch], repo);
    },
  };
}
