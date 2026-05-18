import type { CanUseToolFn } from '../agent-stage.ts';

/**
 * Maximum number of times a write-side stage (coder, test-author) retries the
 * Claude runner after an `AgentOutputParseError`. Higher than 2 risks burning
 * through Claude budget on a model that's genuinely confused; lower than 2
 * misses transient JSON-format hiccups. 2 retries = 3 total attempts.
 */
export const MAX_TRANSIENT_RETRIES = 2;

/**
 * Compose multiple `CanUseToolFn` filters into one. Short-circuits on the first
 * `deny`. If all filters return `allow`, the composite returns `allow`.
 *
 * Used by the coder + test-author stages to compose:
 * - `createBashAllowlist(...)` — strict Bash policy
 * - `createPathEscapeFilter(worktreePath)` — Edit/Write must stay inside worktree
 */
export function composeCanUseTool(filters: CanUseToolFn[]): CanUseToolFn {
  return async (toolName, input) => {
    for (const filter of filters) {
      const result = await filter(toolName, input);
      if (result.behavior === 'deny') return result;
    }
    return { behavior: 'allow' };
  };
}

/**
 * Read the current HEAD SHA in a worktree. Used by write-side stages to record
 * the per-attempt baseline so a thrown error can reset the worktree to a known
 * clean state without losing earlier successful commits in the same pipeline run.
 *
 * Throws if `git rev-parse HEAD` fails (e.g. not a git directory, no commits).
 */
export async function defaultGetCurrentHeadSha(
  worktreePath: string,
): Promise<string> {
  const proc = Bun.spawn(['git', 'rev-parse', 'HEAD'], {
    cwd: worktreePath,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const out = await new Response(proc.stdout as ReadableStream).text();
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(
      `git rev-parse HEAD failed (exit ${code}) in ${worktreePath}`,
    );
  }
  return out.trim();
}

/**
 * Reset a worktree to a given SHA via `git reset --hard ${sha}` plus
 * `git clean -fd`. Best-effort: errors are swallowed (the worktree may be in
 * a weird state and there's nothing meaningful the caller can do beyond logging).
 *
 * Note: this is the framework's reset, not the agent's — the same `git clean -fd`
 * verb the Bash allowlist denies to the model. Intentional asymmetry: the agent
 * is forbidden from cleaning the worktree, but the framework wraps the agent's
 * work in a clean cycle.
 */
export async function defaultResetWorktree(
  worktreePath: string,
  baselineSha: string,
): Promise<void> {
  try {
    const reset = Bun.spawn(['git', 'reset', '--hard', baselineSha], {
      cwd: worktreePath,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await reset.exited;
  } catch {
    // ignore
  }
  try {
    const clean = Bun.spawn(['git', 'clean', '-fd'], {
      cwd: worktreePath,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await clean.exited;
  } catch {
    // ignore
  }
}
