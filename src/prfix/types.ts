import type { PullRequestDetails } from '../types/index.ts';

export interface PrFixInput {
  pullRequestId: number;
  repository: string;
  pr: PullRequestDetails;
}

export interface ConflictResolution {
  commit: string;
  subject: string;
  files: string[];
  /** The resolver's own summary of how the commit was resolved. */
  summary: string;
  /** Per-file resolution text; a file the resolver omitted has no entry. */
  resolutions: { path: string; resolution: string }[];
}

export interface RebaseOutput {
  preRebaseSha: string;
  targetSha: string;
  newHeadSha: string;
  commitsReplayed: number;
  conflicts: ConflictResolution[];
}

export type PrFixStatus =
  | 'rebased'
  | 'up-to-date'
  | 'head-moved'
  | 'conflict-cap'
  | 'unresolved-conflict'
  | 'merge-commits'
  | 'verification-failed'
  | 'cost-cap'
  | 'cancelled'
  | 'error';

export interface PrFixOutcome {
  ok: boolean;
  status: PrFixStatus;
  pullRequestId: number;
  oldHead: string | null;
  newHead: string | null;
  conflicts: ConflictResolution[];
  costUsd: number;
  error: string | null;
}

/** The PR branch already contains its target; nothing to rebase. */
export class PrUpToDateError extends Error {
  override readonly name = 'PrUpToDateError';
}

/** The rebase would need more conflict resolution than the configured caps allow. */
export class ConflictCapError extends Error {
  override readonly name = 'ConflictCapError';
  constructor(
    readonly reason: string,
    readonly files: string[],
  ) {
    super(reason);
  }
}

/**
 * A conflicting commit that was not (or cannot be) resolved. `reason` says
 * why when it is something other than leftover conflict markers.
 */
export class UnresolvedConflictError extends Error {
  override readonly name = 'UnresolvedConflictError';
  constructor(
    readonly commit: string,
    readonly files: string[],
    reason = 'unresolved conflict',
  ) {
    super(`${reason} in commit ${commit}: ${files.join(', ')}`);
  }
}

/**
 * The PR branch contains merge commits. `git rebase` would linearize them
 * (dropping the merges and whatever resolution they carried), so the pushed
 * branch would no longer be exactly the PR's changes. Refused before the
 * rebase starts.
 */
export class MergeCommitsError extends Error {
  override readonly name = 'MergeCommitsError';
  constructor(readonly count: number) {
    super(`branch contains ${count} merge commit${count === 1 ? '' : 's'}; rebase it manually`);
  }
}
