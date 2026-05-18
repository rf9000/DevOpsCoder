import { existsSync, mkdirSync, rmSync } from 'fs';
import { resolve } from 'path';
import type { AppConfig, WorktreeContext } from '../types/index.ts';

/** Normalise to forward-slash form for cross-platform path comparisons. */
function normPath(p: string): string {
  return p.replace(/\\/g, '/');
}

export class WorktreeError extends Error {
  override readonly name = 'WorktreeError';
  constructor(
    message: string,
    public readonly command: string[],
    public readonly exitCode: number,
    public readonly stdout: string,
    public readonly stderr: string,
  ) {
    super(message);
  }
}

export interface EnsureWorktreeArgs {
  workItemId: number;
  slug: string;
  /**
   * If state.outputs.worktree is already populated from a previous cycle, pass it.
   * The manager will validate it (path-on-disk + git registry + branch) and reuse if all match.
   * If validation fails, it's treated as an orphan: prune + delete + recreate.
   */
  persistedWorktree?: WorktreeContext;
}

export interface RemoveWorktreeArgs {
  workItemId: number;
  slug: string;
  /** Same as ensureWorktree — prefer persisted path/branch over recomputed. */
  persistedWorktree?: WorktreeContext;
}

export interface WorktreeManager {
  ensureWorktree(args: EnsureWorktreeArgs): Promise<WorktreeContext>;
  removeWorktree(args: RemoveWorktreeArgs): Promise<void>;
}

export interface WorktreeManagerDeps {
  config: AppConfig;
}

interface WorktreeListEntry {
  path: string;
  branch?: string;
}

interface RunGitResult {
  stdout: string;
  stderr: string;
}

function buildWorktreePath(base: string, workItemId: number, slug: string): string {
  return resolve(base, `wi-${workItemId}-${slug}`);
}

function buildBranchName(workItemId: number, slug: string): string {
  return `agent/wi-${workItemId}-${slug}`;
}

export function createWorktreeManager(deps: WorktreeManagerDeps): WorktreeManager {
  const baseRepoPath = deps.config.targetRepoPath;
  const worktreeBase = deps.config.worktreeBase;

  async function runGit(args: string[], cwd: string): Promise<RunGitResult> {
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(['git', ...args], {
        cwd,
        stdout: 'pipe',
        stderr: 'pipe',
      });
    } catch (spawnErr) {
      // Bun.spawn throws (e.g. ENOENT) synchronously when cwd is invalid or git not found.
      const msg = spawnErr instanceof Error ? spawnErr.message : String(spawnErr);
      throw new WorktreeError(
        `git ${args.join(' ')} failed (spawn error): ${msg}`,
        ['git', ...args],
        -1,
        '',
        msg,
      );
    }
    const stdout = await new Response(proc.stdout as ReadableStream).text();
    const stderr = await new Response(proc.stderr as ReadableStream).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new WorktreeError(
        `git ${args.join(' ')} failed (exit ${exitCode}): ${stderr.trim() || stdout.trim() || '(no output)'}`,
        ['git', ...args],
        exitCode,
        stdout,
        stderr,
      );
    }
    return { stdout, stderr };
  }

  async function tryRunGit(
    args: string[],
    cwd: string,
  ): Promise<RunGitResult | null> {
    try {
      return await runGit(args, cwd);
    } catch {
      return null;
    }
  }

  async function listWorktrees(): Promise<WorktreeListEntry[]> {
    const { stdout } = await runGit(
      ['worktree', 'list', '--porcelain'],
      baseRepoPath,
    );
    const result: WorktreeListEntry[] = [];
    let current: Partial<WorktreeListEntry> = {};
    for (const rawLine of stdout.split('\n')) {
      const line = rawLine.replace(/\r$/, '');
      if (line.startsWith('worktree ')) {
        if (current.path) {
          result.push({ path: current.path, branch: current.branch });
        }
        // Normalise to forward-slash so comparisons work on Windows too
        current = { path: normPath(line.slice('worktree '.length).trim()) };
      } else if (line.startsWith('branch ')) {
        const ref = line.slice('branch '.length).trim();
        current.branch = ref.replace(/^refs\/heads\//, '');
      }
    }
    if (current.path) {
      result.push({ path: current.path, branch: current.branch });
    }
    return result;
  }

  async function branchExists(branch: string): Promise<boolean> {
    const result = await tryRunGit(
      ['rev-parse', '--verify', `refs/heads/${branch}`],
      baseRepoPath,
    );
    return result !== null;
  }

  async function getOriginMainSha(): Promise<string> {
    const { stdout } = await runGit(['rev-parse', 'origin/main'], baseRepoPath);
    return stdout.trim();
  }

  return {
    async ensureWorktree(args) {
      // Ensure worktreeBase directory exists (creates parent for git worktree add)
      if (!existsSync(worktreeBase)) {
        mkdirSync(worktreeBase, { recursive: true });
      }

      // Fetch origin so origin/main is current
      await runGit(['fetch', 'origin'], baseRepoPath);

      // Branch name is locked at first creation — persisted wins over computed slug.
      const branch =
        args.persistedWorktree?.branch ?? buildBranchName(args.workItemId, args.slug);
      const path =
        args.persistedWorktree?.path ?? buildWorktreePath(worktreeBase, args.workItemId, args.slug);

      // State-driven reuse: if persisted exists AND validates on disk + registry → return as-is
      if (args.persistedWorktree) {
        const dirExists = existsSync(args.persistedWorktree.path);
        const registry = await listWorktrees();
        const registered = registry.find(
          (w) => w.path === normPath(args.persistedWorktree!.path),
        );
        if (
          dirExists &&
          registered &&
          registered.branch === args.persistedWorktree.branch
        ) {
          return args.persistedWorktree;
        }
      }

      // Treat as orphan: prune stale registry entries, delete unregistered dirs
      await runGit(['worktree', 'prune'], baseRepoPath);
      const registry = await listWorktrees();
      const stillRegistered = registry.find((w) => w.path === normPath(path));
      if (existsSync(path) && !stillRegistered) {
        rmSync(path, { recursive: true, force: true });
      }

      const baseSha = await getOriginMainSha();

      // If the branch exists already (e.g. from a prior crashed run), reuse it.
      // Otherwise create fresh from origin/main.
      const branchAlreadyExists = await branchExists(branch);
      if (branchAlreadyExists) {
        await runGit(['worktree', 'add', path, branch], baseRepoPath);
      } else {
        await runGit(
          ['worktree', 'add', path, '-b', branch, 'origin/main'],
          baseRepoPath,
        );
      }

      return { path, branch, baseSha };
    },

    async removeWorktree(args) {
      const path =
        args.persistedWorktree?.path ?? buildWorktreePath(worktreeBase, args.workItemId, args.slug);
      const branch =
        args.persistedWorktree?.branch ?? buildBranchName(args.workItemId, args.slug);

      // Best-effort cleanup of worktree
      const removed = await tryRunGit(
        ['worktree', 'remove', path, '--force'],
        baseRepoPath,
      );
      if (removed === null && existsSync(path)) {
        rmSync(path, { recursive: true, force: true });
      }
      await tryRunGit(['worktree', 'prune'], baseRepoPath);

      // Best-effort branch deletion
      await tryRunGit(['branch', '-D', branch], baseRepoPath);
    },
  };
}
