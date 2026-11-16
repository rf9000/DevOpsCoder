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

/** A conflicting commit the resolver could not resolve. */
export class UnresolvedConflictError extends Error {
  override readonly name = 'UnresolvedConflictError';
  constructor(
    readonly commit: string,
    readonly files: string[],
  ) {
    super(`unresolved conflict in commit ${commit}: ${files.join(', ')}`);
  }
}
