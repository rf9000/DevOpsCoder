import type { CanUseToolFn } from '../agent-stage.ts';
import type { Finding, FindingSeverity } from '../../types/index.ts';

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

/** Severity rank — higher number = more severe. Used for finding deduplication. */
const SEVERITY_RANK: Record<FindingSeverity, number> = {
  blocking: 5,
  critical: 4,
  major: 3,
  minor: 2,
  nit: 1,
};

/**
 * Deduplicate and sort a flat array of reviewer findings before storing them
 * in `state.outputs.reviewer.findings`.
 *
 * **Why deduplicate by file:line?**
 * The Plan 5 reviewer runs 6 independent per-axis Claude agents. Multiple axes
 * can legitimately fire on the same location (e.g. both "security" and
 * "safety-correctness" flag the same unsafe function call on line 42). Without
 * deduplication the PR comment would repeat the same location multiple times,
 * making it noisy and hard to act on. We collapse co-located findings into one,
 * keeping the most severe signal and merging all firing axis names so reviewers
 * know exactly which axes were concerned.
 *
 * **Deduplication key:**
 * `file` + `line`. A missing `line` (file-level finding) groups with other
 * file-level findings on the same file, but never with a line-level finding on
 * that same file.
 *
 * **Winner selection:**
 * Within a group, the highest-severity finding's `title`, `description`,
 * `suggestion`, `file`, `line`, and `severity` are kept verbatim. Only `axis`
 * is enriched: it becomes a comma-separated, deduped, input-order-preserving
 * list of every axis that fired on this location.
 *
 * **Sort:** output is sorted severity-descending (`blocking` first, `nit` last)
 * using a stable comparator so input order is preserved within ties.
 *
 * Pure function — no I/O, no logging, no mutation of input objects.
 */
export function aggregateReviewerFindings(findings: Finding[]): Finding[] {
  // Ordered map: key → accumulated group data.
  // We use a Map to preserve insertion order (first-seen key order).
  type Group = { winner: Finding; axes: string[] };
  const groups = new Map<string, Group>();

  for (const finding of findings) {
    const key =
      finding.line !== undefined
        ? `${finding.file}:${finding.line}`
        : `${finding.file}:__file__`;

    const existing = groups.get(key);
    if (existing === undefined) {
      // First finding for this location — start a new group.
      groups.set(key, { winner: finding, axes: [finding.axis] });
    } else {
      // Accumulate the axis (deduped).
      if (!existing.axes.includes(finding.axis)) {
        existing.axes.push(finding.axis);
      }
      // Promote the winner if this finding has higher severity.
      if (SEVERITY_RANK[finding.severity] > SEVERITY_RANK[existing.winner.severity]) {
        existing.winner = finding;
      }
    }
  }

  // Build output array: one new Finding object per group.
  const deduped: Finding[] = [];
  for (const { winner, axes } of groups.values()) {
    deduped.push({
      severity: winner.severity,
      file: winner.file,
      ...(winner.line !== undefined ? { line: winner.line } : {}),
      title: winner.title,
      description: winner.description,
      ...(winner.suggestion !== undefined ? { suggestion: winner.suggestion } : {}),
      axis: axes.join(', '),
    });
  }

  // Stable severity-descending sort (Bun/V8 sort is stable since 2018).
  deduped.sort(
    (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity],
  );

  return deduped;
}
