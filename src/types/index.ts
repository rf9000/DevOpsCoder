import type { TestSelectionMode } from '../utils/test-selection.ts';

export type { TestSelectionMode };

export interface AppConfig {
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
  /** Turn budget for the fix-findings step. Falls back to `coderMaxTurns`. */
  fixFindingsMaxTurns?: number;
  /** Turn budget for EACH reviewer axis, not the fan-out as a whole. */
  reviewerMaxTurns: number;
  testAuthorMaxTurns: number;
  maxCostUsdPerWi: number;
  stageTimeoutMs: Record<string, number>;
  /** Global model default; every step falls back to this. */
  claudeModel: string;
  /**
   * Per-step model overrides keyed by `PipelineStep`
   * (src/utils/model-selection.ts), resolved from `CLAUDE_MODEL_*` env vars.
   * A missing key means "use claudeModel"; a missing `coder-plan` /
   * `test-author-plan` key additionally means "no plan step". Read it through
   * `modelFor()` / `planModelFor()`, never directly.
   */
  stepModel?: Record<string, string>;
  /** Turn budget for a plan call. Unset → DEFAULT_PLAN_MAX_TURNS. */
  planMaxTurns?: number;
  stateDir: string;
  /**
   * Directory holding one log file per work item (`WI<id>.log`). Separate from
   * `stateDir` because these are read by a human, not the pipeline — in Docker
   * that means a bind mount, where state is a named volume.
   */
  logDir: string;
  assignedToFilter: string[];
  /** Path to continia.exe. Absolute, or relative to the per-WI worktree. */
  continiaCliPath: string;
  /** DemoPortal profile used for `continia env create --profile`. */
  continiaEnvProfileId: string;
  /** DemoPortal profile localization ("base", "dk", "nl", ...) used when deriving a profile. */
  continiaEnvLocalization: string;
  /** DemoPortal API token, forwarded into the spawned CLI's environment. */
  continiaApiToken: string;
  /** AL app dirs (worktree-relative, dependency-ordered) to deps-install/deploy. */
  continiaAppPaths: string[];
  /** AL app dirs to scan for test codeunits. Defaults to continiaAppPaths. */
  continiaTestAppPaths: string[];
  /** Max coder fix attempts when the deploy/test verification is red. */
  maxTestFixAttempts: number;
  /**
   * Test-fixer calls the in-loop verification gate may make per revision round.
   * Deliberately separate from and smaller than `maxTestFixAttempts` — see
   * MAX_INLOOP_FIX_ATTEMPTS in src/config/index.ts. Default 1.
   */
  maxInLoopFixAttempts?: number;
  /** `--timeout` (seconds) passed to each `continia test run`. */
  continiaTestTimeoutS: number;
  /** Dir containing an orchestrator-owned `skills/` tree (e.g. /app/.claude).
   * When set, worktree-setup symlinks each skill into the worktree's .claude/.
   * Unset → only the target repo's own committed skills are available. */
  skillsSourceDir?: string;
  /** Absolute path to the Claude Code executable, forwarded to the Agent SDK as
   * `pathToClaudeCodeExecutable`. Unset → the SDK probes for its own bundled
   * native binary. Under Bun on a glibc image that probe picks the *-musl
   * package and fails, so the Docker image pins this to the natively-installed
   * CLI at /home/claude/.local/bin/claude. */
  claudeCodeExecutablePath?: string;
  /** Append-only JSONL spend log: one record per finished work item. */
  costLogPath: string;
  /** Skip env-provision + build-and-test (harness smoke tests). */
  skipBuildTest: boolean;
  /** Which discovered test codeunits a verification round runs. */
  testSelection: TestSelectionMode;
  /** Hard ceiling on test codeunits per round; 0 = unlimited. */
  maxTestCodeunits: number;
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
  /**
   * Per-stage outputs keyed by `Stage.name`. Reserved keys: `cost` carries
   * `PipelineCostInfo` (managed by createCostTracker, see src/utils/cost-tracker.ts);
   * `toolUsage` carries a cumulative per-tool call-count map (managed by
   * createToolUsageTracker, see src/utils/tool-usage-tracker.ts).
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
  /**
   * Per-step spend, keyed by the LLM call site rather than `Stage.name`: the
   * plan/write split bills to `coder-plan`/`coder`, the test-fixer nested inside
   * `build-and-test` bills to `test-fixer`, and each reviewer axis bills to
   * `reviewer:<axis>`. A stage that lumps its nested calls under its own name
   * makes the expensive call invisible, which is the whole point of the map.
   *
   * State files written before per-step detail existed hold a bare `number`
   * here; `normalizePerStage` (src/utils/cost-tracker.ts) widens those on read.
   */
  perStage: Record<string, StepSpend>;
}

/**
 * What one pipeline step spent, accumulated across every call it made.
 *
 * `models` is a list rather than a single string because a step can legitimately
 * run on more than one model across a resumed WI — an operator changing
 * `CLAUDE_MODEL_CODER` between cycles must not silently overwrite the record of
 * what the earlier attempt actually cost to run.
 */
export interface StepSpend {
  /** Cumulative USD across every call this step made. */
  usd: number;
  /** How many LLM calls this step made (revisions and retries included). */
  calls: number;
  /** Uncached input tokens — only the part of the prompt the cache did not serve. */
  inputTokens: number;
  outputTokens: number;
  /** Input tokens written into the prompt cache. */
  cacheCreationInputTokens: number;
  /** Input tokens served from the prompt cache. */
  cacheReadInputTokens: number;
  /** Cumulative agent turns, summed across calls. */
  turns: number;
  /** Distinct models this step ran on, in first-seen order. */
  models: string[];
}

/**
 * Per-call usage the SDK reports alongside cost, folded into `StepSpend`.
 *
 * The cache fields are not decoration. `inputTokens` alone counts only what the
 * cache did *not* serve, so a long agentic call reports a handful of input
 * tokens against tens of thousands of output — `coder $4.8681 | 194 in /
 * 61,226 out` was a real line in a real run, and it makes the dominant half of
 * the bill invisible. Anything reasoning about where a WI's money went needs
 * all three numbers.
 */
export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  turns: number;
  model: string;
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

export function formatTimeout(ms: number): string {
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

/**
 * Written to `state.outputs.coderPlan` / `.testPlan` by the plan step that runs
 * ahead of the coder and test-author when a plan model is configured.
 *
 * One shape serves both: the code planner fills `steps` with implementation
 * steps, the test planner fills it with the test cases to write.
 */
export interface PlanOutput {
  approach: string;
  steps: string[];
  filesToTouch: string[];
  risks: string[];
}

/**
 * Written to `state.outputs.environment` by the env-provision stage.
 * Never torn down — DemoPortal environments auto-delete ~10 days after
 * creation; the URL is surfaced in the draft-PR description for manual tests.
 */
export interface EnvironmentOutput {
  envId: string;
  /** wi-<id>-<slug>, truncated. */
  name: string;
  url?: string;
  /** Last observed DemoPortal status (Draft/Starting/Running/...). */
  status: string;
  createdAt: string;
  /** BC version the environment runs — recorded for the reuse-path comparison and for operator visibility. */
  bcVersion?: string;
}

/** One entry of `continia deploy --json`'s per-app result array. */
export interface DeployAppResult {
  app: string;
  compiled: boolean;
  published: boolean;
  /** Free prose — alc's full output on a compile failure. Never regex it. */
  error?: string;
  /**
   * Machine-readable failure kind, present on every failed row. Branch on this,
   * not on `error`: it is what separates a compile failure the coder can fix
   * from an environment problem it cannot. See `.claude/skills/continia-deploy`.
   */
  code?: string;
}

/** One test case from `continia test run --json`. */
export interface TestCaseResult {
  name: string;
  fullName?: string;
  result: string;
  durationSeconds?: number;
  errorMessage?: string;
  stackTrace?: string;
}

/** Result of one `continia test run` against one test codeunit. */
export interface TestRunRecord {
  /** 0 = initial verification, 1..N = after fix attempt N. */
  attempt: number;
  codeunitId: number;
  codeunitName?: string;
  passed: boolean;
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    durationSeconds?: number;
  };
  tests: TestCaseResult[];
}

/**
 * Written to `state.outputs.verification` by the build-and-test stage after
 * every deploy/test round, so a mid-loop timeout still leaves diagnosable state.
 */
export interface VerificationOutput {
  /** Fix attempts consumed (0..maxTestFixAttempts). */
  attempts: number;
  /** Last deploy round: every entry compiled && published. */
  compiled: boolean;
  deploy: DeployAppResult[];
  testRuns: TestRunRecord[];
  passed: boolean;
}

/**
 * Thrown by the build-and-test stage when the deploy/test verification is
 * still red after all fix attempts. The message intentionally contains the
 * literal substring `verification failed` (lowercase) so the processor can
 * route it via `/verification failed/i.test(err.message)` without importing
 * this class directly.
 */
export class VerificationFailedError extends Error {
  override readonly name = 'VerificationFailedError';
  constructor(
    public readonly attempts: number,
    public readonly compiled: boolean,
    summaryLine: string,
  ) {
    super(`verification failed after ${attempts} fix attempt(s): ${summaryLine}`);
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

/** An Azure DevOps identity. `id` is the GUID an @-mention anchor needs. */
export interface IdentityRef {
  id?: string;
  displayName?: string;
  uniqueName?: string;
}

/**
 * One revision from `/workItems/{id}/updates`. `fields` maps a field reference
 * name to its old/new value for that revision — the trigger tag's addition is
 * found by diffing `System.Tags` across revisions.
 */
export interface WorkItemUpdate {
  id?: number;
  revisedBy?: IdentityRef;
  revisedDate?: string;
  fields?: Record<string, { oldValue?: unknown; newValue?: unknown }>;
}

/**
 * Every non-skipped variant carries `perStage` alongside the total so the
 * watcher can print the per-step split without reloading the work item's state
 * file off disk — a grand total on its own cannot be read back to a cause.
 */
export type ProcessOutcome =
  | { kind: 'completed'; workItemId: number; costUsd: number; toolUsage: Record<string, number>; perStage: Record<string, StepSpend> }
  | {
      kind: 'paused';
      workItemId: number;
      stage: string;
      costUsd: number;
      toolUsage: Record<string, number>;
      perStage: Record<string, StepSpend>;
    }
  | {
      kind: 'failed';
      workItemId: number;
      error: PipelineTerminalError;
      costUsd: number;
      toolUsage: Record<string, number>;
      perStage: Record<string, StepSpend>;
    }
  | { kind: 'skipped'; workItemId: number; reason: string }
  | {
      kind: 'rejected';
      workItemId: number;
      severity: 'reject' | 'blocked';
      rejectCount: number;
      costUsd: number;
      toolUsage: Record<string, number>;
      perStage: Record<string, StepSpend>;
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
  /**
   * PR title in the team's house style (see the `fw-step4-pullRequest` skill):
   * 50-70 chars, imperative verb, business outcome, no trailing period, no
   * `feat:` prefix, no work item number. Optional — the draft-PR creator falls
   * back to the work item title.
   */
  prTitle?: string;
  /**
   * PR description bullets, same house style: 2-6 items, each a single line
   * starting with a past-tense action word, AL/BC terminology, no file paths or
   * line numbers. Optional — falls back to the coder summary.
   */
  prBullets?: string[];
}

/**
 * Title + description bullets for the draft PR, written by the `pr-message`
 * step from the branch diff alone (see `src/pipeline/stages/_pr-message.ts`).
 * The coder's `prTitle`/`prBullets` are the fallback when that step is not
 * wired or fails.
 */
export interface PrMessageOutput {
  /** Imperative, business outcome, 50-70 chars, no prefix and no WI number. */
  title: string;
  /** 2-6 one-line, past-tense bullets — one per logical change group. */
  bullets: string[];
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
  /** WI to link via workItemRefs — ADO then shows the PR on the work item. */
  workItemId?: number;
}

export interface CreatePullRequestThreadArgs {
  repositoryName: string;
  pullRequestId: number;
  /** Markdown. @-mentions use the bare `@<GUID>` token, not the HTML anchor. */
  content: string;
}

