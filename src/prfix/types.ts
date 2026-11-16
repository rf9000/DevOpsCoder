import type { PullRequestDetails } from '../types/index.ts';
import type { CollisionGroup } from './al-objects.ts';

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

/** One AL object the `renumber-collisions` stage moved to a new ID. */
export interface RenumberedObject {
  type: string;
  name: string;
  /** Repo-relative, forward slashes. */
  file: string;
  /** Repo-relative app directory. */
  app: string;
  oldId: number;
  newId: number;
}

/**
 * Written to `state.outputs.renumber`. `reserved` lists every ID Ninja
 * assigned this run (used or rejected), pushed the moment `assign` returns, so
 * a run that ends without a push can release them even when the stage threw.
 */
export interface RenumberOutput {
  commit: string | null;
  renumbered: RenumberedObject[];
  reserved: { type: string; id: number; /** Absolute path of the .al file. */ file: string }[];
}

export type PrFixStatus =
  | 'rebased'
  | 'up-to-date'
  | 'head-moved'
  | 'conflict-cap'
  | 'unresolved-conflict'
  | 'merge-commits'
  | 'id-collision'
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
  /** AL objects the run renumbered to clear an ID collision with the target. */
  renumbered: RenumberedObject[];
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

/**
 * AL object ID collisions that cannot be resolved by renumbering a single
 * PR-introduced object.
 */
export class IdCollisionError extends Error {
  override readonly name = 'IdCollisionError';
  constructor(
    readonly groups: CollisionGroup[],
    reason: string,
  ) {
    super(reason);
  }
}
