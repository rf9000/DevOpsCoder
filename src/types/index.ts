export interface AppConfig {
  org: string;
  orgUrl: string;
  project: string;
  pat: string;
  repositoryName: string;
  targetRepoPath: string;
  worktreeBase: string;
  triggerTag: string;
  blockedTag: string;
  needInputTag: string;
  pollIntervalMinutes: number;
  concurrency: number;
  maxRevisions: number;
  maxRejectCycles: number;
  coderMaxTurns: number;
  testAuthorMaxTurns: number;
  claudeModel: string;
  stateDir: string;
  assignedToFilter: string[];
  dryRun: boolean;
}

export type StageOutcome = 'success' | 'failure' | 'skip' | 'pause' | 'reject';

export interface StageHistoryEntry {
  stage: string;
  startedAt: string;
  endedAt: string;
  outcome: StageOutcome;
  message?: string;
}

export interface PipelineTerminalError {
  stage: string;
  message: string;
  at: string;
}

export interface PipelineRejection {
  reasons: string[];
  summary: string;
  questions?: string[];
  stage: string;
  at: string;
  /**
   * Processor-managed: set to true after the processor has fully dispatched
   * the reject side-effects (comment posted, tags swapped). On next entry,
   * `dispatched: true` means the previous cycle finished cleanly and the
   * human has re-added the trigger tag — clear rejection and re-run pipeline.
   * `dispatched` undefined/false means the previous dispatch was interrupted
   * (crash) — re-run only the tag ops (skip the comment to avoid duplicates).
   * The orchestrator never writes this field.
   */
  dispatched?: boolean;
}

export interface PipelineState {
  workItemId: number;
  slug: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  cancelled?: boolean;
  terminalError?: PipelineTerminalError;
  rejection?: PipelineRejection;
  rejectCount?: number;
  currentStage: string | null;
  history: StageHistoryEntry[];
  attempts: Record<string, number>;
  /**
   * Per-stage outputs keyed by `Stage.name`. Reserved keys: `cost` carries
   * `PipelineCostInfo` (managed by createCostTracker, see src/utils/cost-tracker.ts).
   */
  outputs: Record<string, unknown>;
}

/**
 * Cumulative cost information written to `state.outputs.cost` by createCostTracker
 * (task-04, src/utils/cost-tracker.ts). Consumers can read this from the pipeline
 * state to observe per-stage and total spend.
 */
export interface PipelineCostInfo {
  /** Cumulative cost across all stages so far, in USD. */
  total: number;
  /** Per-stage spend, keyed by Stage.name (e.g. 'analyzer', 'coder', 'reviewer'). */
  perStage: Record<string, number>;
}

/**
 * Thrown by the orchestrator when the cumulative pipeline cost exceeds the
 * configured cap. The message intentionally contains the literal substring
 * `cost cap` (lowercase) so that the processor (src/services/processor.ts,
 * task-09) can route it via `/cost cap/i.test(err.message)` without importing
 * this class directly.
 */
export class CostExceededError extends Error {
  override readonly name = 'CostExceededError';
  constructor(
    public readonly currentTotalUsd: number,
    public readonly capUsd: number,
    public readonly stage: string,
  ) {
    super(
      `cost cap exceeded at stage "${stage}": $${currentTotalUsd.toFixed(4)} > $${capUsd.toFixed(4)}`,
    );
  }
}

function formatTimeout(ms: number): string {
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1).replace(/\.0$/, '')}min`;
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1).replace(/\.0$/, '')}s`;
  return `${ms}ms`;
}

/**
 * Thrown by the orchestrator when a single stage exceeds its wall-clock time
 * budget. The message intentionally contains the literal substring `timeout`
 * (lowercase) so that the processor (src/services/processor.ts, task-10) can
 * route it via `/timeout/i.test(err.message)` without importing this class
 * directly. `timeoutMs` stays raw on the class for programmatic access; only
 * the human-readable message uses a min/s/ms format.
 */
export class StageTimeoutError extends Error {
  override readonly name = 'StageTimeoutError';
  constructor(
    public readonly stage: string,
    public readonly timeoutMs: number,
  ) {
    super(`stage "${stage}" exceeded timeout of ${formatTimeout(timeoutMs)}`);
  }
}

export interface WorkItemReference {
  id: number;
  url?: string;
}

export interface WiqlQueryResponse {
  workItems: WorkItemReference[];
}

export interface WorkItemFields {
  'System.Title'?: string;
  'System.State'?: string;
  'System.Tags'?: string;
  'System.AssignedTo'?: { displayName?: string; uniqueName?: string } | string;
  'System.Description'?: string;
  'System.WorkItemType'?: string;
  'Microsoft.VSTS.TCM.ReproSteps'?: string;
  'Microsoft.VSTS.Common.AcceptanceCriteria'?: string;
}

export interface WorkItem {
  id: number;
  rev?: number;
  fields: WorkItemFields;
  url?: string;
}

export interface CommentResponse {
  id?: number;
  text?: string;
  createdDate?: string;
}

export interface WorkItemComment {
  id?: number;
  text?: string;
  createdDate?: string;
  createdBy?: { displayName?: string; uniqueName?: string };
}

export type ProcessOutcome =
  | { kind: 'completed'; workItemId: number }
  | { kind: 'paused'; workItemId: number; stage: string }
  | { kind: 'failed'; workItemId: number; error: PipelineTerminalError }
  | { kind: 'skipped'; workItemId: number; reason: string }
  | {
      kind: 'rejected';
      workItemId: number;
      severity: 'reject' | 'blocked';
      rejectCount: number;
    };

export interface CycleStats {
  considered: number;
  completed: number;
  paused: number;
  failed: number;
  skipped: number;
  rejected: number;
}

export interface WorktreeContext {
  /** Absolute path to the worktree directory. */
  path: string;
  /** Branch name (e.g. `agent/wi-101-fix-login`). Locked at first creation. */
  branch: string;
  /** SHA of `origin/main` at worktree creation time. Used by the coder for per-attempt baseline reset. */
  baseSha: string;
}

export interface CoderOutput {
  /** 1-3 sentences describing what the coder did. */
  summary: string;
  /** Paths (relative to worktree root) of files the coder created or modified. */
  filesChanged: string[];
  /** Commit SHAs the coder created in this attempt. */
  commits: string[];
}

export interface TestAuthorOutput {
  /** 1-3 sentences describing what tests were added or updated. */
  summary: string;
  /** Paths (relative to worktree root) of test files the test-author created or modified. */
  testFilesChanged: string[];
  /** Commit SHAs the test-author created. */
  commits: string[];
}

export type FindingSeverity = 'blocking' | 'critical' | 'major' | 'minor' | 'nit';

export interface Finding {
  severity: FindingSeverity;
  /** Path relative to repo root. */
  file: string;
  /** Optional line number; some findings are file-level, not line-level. */
  line?: number;
  /** Short imperative summary. */
  title: string;
  /** Explanation of the issue. */
  description: string;
  /** Optional remediation hint. */
  suggestion?: string;
  /** Which reviewer axis raised it (or "multiple" after aggregation). */
  axis: string;
}

export interface ReviewerOutput {
  /** True iff zero blocking AND zero critical findings. */
  approved: boolean;
  /** Aggregated findings across all 6 review axes. */
  findings: Finding[];
  /** Number of reviewer iterations run so far (revisionLoop tracks this). */
  attempts: number;
}

export interface DraftPrOutput {
  id: number;
  url: string;
  branch: string;
  /** ISO timestamp. */
  createdAt: string;
}

export interface PullRequest {
  id: number;
  url: string;
  sourceRefName: string;
  targetRefName: string;
}

export interface CreatePullRequestArgs {
  repositoryName: string;
  /** e.g. "refs/heads/agent/wi-101-fix-login" */
  sourceRefName: string;
  /** e.g. "refs/heads/main" */
  targetRefName: string;
  title: string;
  description: string;
  isDraft: boolean;
}

