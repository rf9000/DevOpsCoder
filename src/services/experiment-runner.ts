import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { promisify } from 'util';
import { z } from 'zod';
import { loadConfig as defaultLoadConfig } from '../config/index.ts';
import { createInitialState, runPipeline } from '../pipeline/orchestrator.ts';
import type { AgentRunner } from '../pipeline/agent-stage.ts';
import { PipelineRejectError, type AbortFlag, type PipelineContext, type Stage } from '../pipeline/stage.ts';
import { runPrMessageStep as defaultRunPrMessageStep } from '../pipeline/stages/_pr-message.ts';
import type { AdoClient } from '../sdk/azure-devops-client.ts';
import { PipelineStateStore } from '../state/state-store.ts';
import type {
  AppConfig,
  Finding,
  FindingSeverity,
  PipelineCostInfo,
  PipelineState,
  ReviewerOutput,
  StepSpend,
  VerificationOutput,
  WorktreeContext,
} from '../types/index.ts';
import { createCostTracker, normalizePerStage } from '../utils/cost-tracker.ts';
import { renderCostReport } from '../utils/cost-report.ts';
import { buildGitAuthArgs, redactPat } from '../utils/git-auth.ts';
import type { Logger } from '../utils/logger.ts';
import { effortFor, modelFor } from '../utils/model-selection.ts';
import { createToolUsageTracker } from '../utils/tool-usage-tracker.ts';
import { createClaudeAgentRunner } from './claude-agent-runner.ts';
import {
  buildPipeline as defaultBuildPipeline,
  createDefaultReviewerStage,
  type PipelineBuilderDeps,
} from './pipeline-builder.ts';
import { fetchWiContext, type WorkItemContext } from './wi-context.ts';
import { createWiLogFactory } from './wi-log.ts';
import { createWorktreeManager, type WorktreeManager } from './worktree-manager.ts';
import { createContiniaCli, type ContiniaCli } from './continia-cli.ts';
import { prepareVerification, runVerificationRound } from '../pipeline/stages/_verification.ts';
import type { EnvironmentOutput } from '../types/index.ts';

const execFileAsync = promisify(execFile);
const PR_MESSAGE_PROMPT_PATH = `${import.meta.dir}/../prompts/pr-message.md`;

/** Stages a replay never runs: both push or delete things the harness owns. */
const STRIPPED_STAGES = new Set(['draft-pr-creator', 'worktree-teardown']);

// ---------------------------------------------------------------------------
// Input files
// ---------------------------------------------------------------------------

export const corpusSchema = z
  .array(
    z.object({
      wiId: z.number().int().positive(),
      /** Commit the work item was filed against — before the human fix landed. */
      baseSha: z.string().min(7),
      /**
       * ISO timestamp. Comments created at or after it are dropped from the
       * replayed WI context, so the resolution (a "fixed in PR !123" note, the
       * reviewer's discussion) cannot leak into the prompt.
       */
      commentsBefore: z.string().datetime({ offset: true }).optional(),
      /**
       * A commit holding the human fix on top of `baseSha` (normally the fix's
       * merge). Its diff against `baseSha` seeds the base check's deploy set and
       * test selection; without it the base check is skipped.
       */
      fixSha: z.string().min(7).optional(),
      note: z.string().optional(),
    }),
  )
  .min(1);
export type CorpusEntry = z.infer<typeof corpusSchema>[number];

export const variantsSchema = z
  .array(
    z.object({
      // Feeds the branch slug, which slugify truncates at 40 chars — a long
      // name could collide with another variant's branch after truncation.
      name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,29}$/, 'lowercase a-z0-9-, max 30 chars'),
      /** Env overrides on top of the operator's env. "" unsets (blank reads as unset). */
      env: z.record(z.string(), z.string()).default({}),
      /** Re-run the analyzer on this variant's config instead of reusing the shared one. */
      rerunAnalyzer: z.boolean().default(false),
    }),
  )
  .min(1)
  .refine((vs) => vs.some((v) => v.name === 'baseline'), 'one variant must be named "baseline"')
  .refine((vs) => new Set(vs.map((v) => v.name)).size === vs.length, 'variant names must be unique');
export type Variant = z.infer<typeof variantsSchema>[number];

export function readJsonFile<T>(path: string, schema: z.ZodType<T>): T {
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`${path}: ${issues}`);
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

/**
 * `env-failed`: the run never got an environment (env-provision threw — on
 * 2026-10-03 every create past DemoPortal's 50-environment quota). Says
 * nothing about the variant: not scored, no result.json, retried on resume.
 */
export type RunOutcome = 'completed' | 'failed' | 'rejected' | 'rate-limited' | 'env-failed' | 'cancelled';

/** Only environments the harness itself named are ever deleted. */
export const HARNESS_ENV_NAME = /^wi-\d+-x[0-9a-f]{5}-/;

export type SeverityCounts = Record<FindingSeverity, number>;

export interface RunResult {
  wiId: number;
  variant: string;
  rep: number;
  startedAt: string;
  endedAt: string;
  wallMs: number;
  outcome: RunOutcome;
  error?: { stage: string; message: string };
  /**
   * The variant's own spend. On a subscription this is the SDK's API-price
   * estimate, not a bill — the report labels it "est. $" and ranks on tokens.
   */
  costUsd: number;
  totalTokens: number;
  perStage: Record<string, StepSpend>;
  /** Wall time per top-level stage, summed across history entries. */
  stageMs: Record<string, number>;
  verification?: {
    /** True when the authoritative build-and-test gate ran (not just the in-loop gate). */
    finalGate: boolean;
    compiled: boolean;
    passed: boolean;
    skipped: boolean;
    skipReason?: string;
    attempts: number;
    testsPassed: number;
    testsFailed: number;
  };
  reviewer?: { approved: boolean; rounds: number; findings: SeverityCounts };
  /** Baseline-config review of the final diff; billed to the experiment, not the variant. */
  referee?: { costUsd: number; totalTokens: number; findings: SeverityCounts; items: Finding[] };
  diff: { files: number; insertions: number; deletions: number };
}

/** BC refusing a publish because the installed build has a newer schema. */
export const SCHEMA_DOWNGRADE_ERROR =
  /Removing fields is not allowed|has reduced the length of the data type|cannot be located\. Removing|higher-version-installed/i;

export function emptySeverityCounts(): SeverityCounts {
  return { blocking: 0, critical: 0, major: 0, minor: 0, nit: 0 };
}

export function countSeverities(findings: Finding[] | undefined): SeverityCounts {
  const counts = emptySeverityCounts();
  for (const f of findings ?? []) counts[f.severity] += 1;
  return counts;
}

export function totalTokensOf(perStage: Record<string, StepSpend>): number {
  let sum = 0;
  for (const s of Object.values(perStage)) {
    sum += s.inputTokens + s.outputTokens + s.cacheCreationInputTokens + s.cacheReadInputTokens;
  }
  return sum;
}

/**
 * A run that hit the subscription's usage limit says nothing about the
 * variant. It is excluded from scoring and retried on the next invocation.
 */
export function isRateLimitMessage(message: string): boolean {
  return /rate.?limit|usage limit|\b429\b|overloaded|quota|too many requests/i.test(message);
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export type GitFn = (args: string[], cwd: string) => Promise<string>;

export interface ExperimentDeps {
  /** Operator env the variants overlay (normally process.env, minus API keys). */
  baseEnv: Record<string, string | undefined>;
  corpus: CorpusEntry[];
  variants: Variant[];
  /** `experiments/runs/<runId>` — everything this experiment writes lives here. */
  outDir: string;
  runId: string;
  reps: number;
  /** Stop scheduling new runs once cumulative est. spend (variants + analyzer + referee) crosses this. */
  maxTotalUsd?: number;
  referee: boolean;
  logger: Logger;
  /** Read-only — `createReadOnlyAdoClient`. */
  ado: AdoClient;
  abortFlag: AbortFlag;
  now?: () => Date;
  loadConfig?: (env: Record<string, string | undefined>) => AppConfig;
  buildPipeline?: (deps: PipelineBuilderDeps) => Stage[];
  createRunner?: (config: AppConfig, logger: Logger) => AgentRunner;
  createWorktreeManager?: (config: AppConfig) => WorktreeManager;
  createReferee?: (config: AppConfig, runner: AgentRunner) => Stage;
  runPrMessageStep?: typeof defaultRunPrMessageStep;
  fetchWiContext?: (ado: AdoClient, id: number) => Promise<WorkItemContext>;
  git?: GitFn;
  prMessagePromptTemplate?: string;
  /** Test override for the environment cleanup's CLI. */
  createContiniaCli?: (config: AppConfig) => Pick<ContiniaCli, 'deleteEnvironment'>;
  /** Run only the base checks — no analyzer, no variants, no LLM calls. */
  baseCheckOnly?: boolean;
  /** The base check: deploy + test the base commit once per WI before any variant runs. */
  checkBase?: (entry: CorpusEntry) => Promise<BaseCheckResult>;
}

/**
 * Whether a work item's base commit is a fair starting point: it compiles, and
 * the tests the human fix would select are green before any change.
 *
 * Added after WI 83666's first replay: its base sat in a window where main did
 * not compile, and the run spent $14 and 4 test-fixer rounds "fixing" code
 * unrelated to the work item. Every variant would have paid the same.
 */
export interface BaseCheckResult {
  wiId: number;
  /**
   * `base-too-old`: the base compiled but could not be *published*, because
   * the environment's dependency install already brought a newer build of the
   * same app with a schema the base would remove ("Removing fields is not
   * allowed"). Every variant would hit it too, so it skips like
   * `compile-failed` — but it is a statement about the corpus entry's age,
   * not about the code.
   */
  status: 'green' | 'tests-red' | 'compile-failed' | 'base-too-old' | 'env-blocked' | 'unchecked';
  reason?: string;
  /** Codeunits already red at base — a variant cannot be blamed for these. */
  redCodeunits: { id: number; name?: string; failed: number }[];
  deployErrors?: string;
  /**
   * Every deploy row, in deploy order, without the compiler output. A failed
   * row alone could not explain an `unpublished-sibling` on an app the same
   * round had just deployed — the sibling's own row is the evidence.
   */
  deployRows?: Record<string, unknown>[];
  /** The derived deploy order. */
  appPaths?: string[];
}

export interface ExperimentSummary {
  results: RunResult[];
  baseChecks: BaseCheckResult[];
  /** Runs not started because the budget was spent. */
  skippedForBudget: number;
  overheadUsd: number;
}

const defaultGit: GitFn = async (args, cwd) => {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new Error(`git ${args.filter((a) => !a.includes('extraHeader')).join(' ')} failed: ${e.stderr || e.message}`);
  }
};

/**
 * Refuse to run against a repo that is shared with someone's day-to-day work.
 *
 * Replays create and delete branches, run `git worktree prune`, and add
 * worktrees — all of which act on the repo's *common* `.git`. Pointed at a
 * developer's clone (or at one of its linked worktrees, which shares the same
 * `.git`), that is their branch list and their worktree registry. A dedicated
 * clone has neither, so the check is: the target is a main working tree, and
 * every other registered worktree lives under `worktreeBase`.
 */
export async function assertIsolatedTargetRepo(
  targetRepoPath: string,
  worktreeBase: string,
  git: GitFn = defaultGit,
): Promise<void> {
  const norm = (p: string): string => resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const gitDir = norm(resolve(targetRepoPath, (await git(['rev-parse', '--git-dir'], targetRepoPath)).trim()));
  const commonDir = norm(resolve(targetRepoPath, (await git(['rev-parse', '--git-common-dir'], targetRepoPath)).trim()));
  if (gitDir !== commonDir) {
    throw new Error(
      `TARGET_REPO_PATH ${targetRepoPath} is a linked worktree sharing ${commonDir} — replays would create branches and prune worktrees in that repo. Use a dedicated clone (EXPERIMENT_TARGET_REPO_PATH).`,
    );
  }
  const porcelain = await git(['worktree', 'list', '--porcelain'], targetRepoPath);
  const paths = porcelain
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => norm(l.slice('worktree '.length).trim()));
  // Location alone is not enough: a developer's clone whose worktrees all sit
  // in one folder passes a "under WORKTREE_BASE" test when that folder is the
  // base. Every other worktree must also carry a replay slug (`runSlug`).
  const base = norm(worktreeBase);
  const replayName = /^wi-\d+-x[0-9a-f]{5}-/;
  const foreign = paths.filter(
    (p) =>
      p !== norm(targetRepoPath) &&
      !(p.startsWith(`${base}/`) && replayName.test(p.slice(base.length + 1))),
  );
  if (foreign.length > 0) {
    throw new Error(
      `TARGET_REPO_PATH ${targetRepoPath} has worktrees the harness did not create (${foreign.join(', ')}) — it looks like a working clone, not a dedicated experiment clone. Use EXPERIMENT_TARGET_REPO_PATH / EXPERIMENT_WORKTREE_BASE.`,
    );
  }
}

/** Short, stable id folded into every branch slug so two experiments never share a branch. */
export function runTag(runId: string): string {
  return createHash('sha1').update(runId).digest('hex').slice(0, 5);
}

export function runSlug(runId: string, variant: string, rep: number): string {
  return `x${runTag(runId)}-${variant}-r${rep}`;
}

function sumStageMs(state: PipelineState): Record<string, number> {
  const out: Record<string, number> = {};
  for (const h of state.history) {
    const ms = Date.parse(h.endedAt) - Date.parse(h.startedAt);
    if (Number.isFinite(ms)) out[h.stage] = (out[h.stage] ?? 0) + ms;
  }
  return out;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf-8');
}

/** Replays are judged as if the WI were still open: the resolution must not reach the prompt. */
export function replayContext(ctx: WorkItemContext, entry: CorpusEntry): WorkItemContext {
  const cutoff = entry.commentsBefore ? Date.parse(entry.commentsBefore) : undefined;
  return {
    ...ctx,
    state: 'Active',
    comments:
      cutoff === undefined
        ? ctx.comments
        : ctx.comments.filter((c) => Date.parse(c.createdDate) < cutoff),
  };
}

export async function runExperiment(deps: ExperimentDeps): Promise<ExperimentSummary> {
  const loadConfig = deps.loadConfig ?? defaultLoadConfig;
  const buildPipeline = deps.buildPipeline ?? defaultBuildPipeline;
  const createRunner =
    deps.createRunner ?? ((config, logger) => createClaudeAgentRunner({ config, logger }));
  const worktreeManagerFor =
    deps.createWorktreeManager ?? ((config) => createWorktreeManager({ config }));
  const createReferee =
    deps.createReferee ?? ((config, runner) => createDefaultReviewerStage({ config, runner }));
  const runPrMessage = deps.runPrMessageStep ?? defaultRunPrMessageStep;
  const fetchCtx = deps.fetchWiContext ?? fetchWiContext;
  const git = deps.git ?? defaultGit;
  const now = deps.now ?? (() => new Date());
  const { logger } = deps;

  mkdirSync(deps.outDir, { recursive: true });

  // The orchestrator polls `abortFlag` between and inside its own stages, but
  // the work the harness drives directly — the base check's waitForRunning
  // and deploy round, the referee, the pr-message step — only listens to a
  // signal. Without this, a Ctrl+C during a base check waited out the full
  // 10-minute Running poll before anything stopped.
  const abort = new AbortController();
  const abortPoll = setInterval(() => {
    if (deps.abortFlag.aborted && !abort.signal.aborted) abort.abort('external');
  }, 250);
  abortPoll.unref?.();
  const variants = [...deps.variants].sort((a, b) =>
    a.name === 'baseline' ? -1 : b.name === 'baseline' ? 1 : 0,
  );
  const baselineEnv = { ...deps.baseEnv, ...variants[0]!.env };

  const results: RunResult[] = [];
  let spent = 0;
  let overheadUsd = 0;
  let skippedForBudget = 0;
  const overBudget = (): boolean => deps.maxTotalUsd !== undefined && spent >= deps.maxTotalUsd;

  // Spend already banked by a previous invocation of this run counts against the budget.
  const ledgerPath = join(deps.outDir, 'overhead.json');
  if (existsSync(ledgerPath)) {
    overheadUsd = (JSON.parse(readFileSync(ledgerPath, 'utf-8')) as { usd: number }).usd;
    spent += overheadUsd;
  }
  const addOverhead = (usd: number): void => {
    overheadUsd += usd;
    spent += usd;
    writeJson(ledgerPath, { usd: overheadUsd });
  };

  // ---- analyzer: one run per WI per config, on a checkout of the base sha --
  async function runAnalyzer(
    entry: CorpusEntry,
    config: AppConfig,
    runner: AgentRunner,
    state: PipelineState,
    log: Logger,
  ): Promise<void> {
    const checkout = resolve(deps.outDir, entry.wiId.toString(), `.analyzer-${state.slug}`);
    await git([...buildGitAuthArgs(config.pat), 'fetch', 'origin'], config.targetRepoPath).catch(
      (err: unknown) => log.warn(`fetch before analyzer failed: ${redactPat(String(err), config.pat)}`),
    );
    if (existsSync(checkout)) await git(['worktree', 'remove', '--force', checkout], config.targetRepoPath).catch(() => {});
    await git(['worktree', 'add', '--detach', checkout, entry.baseSha], config.targetRepoPath);
    try {
      // The production analyzer reads the main checkout; on a replay that is
      // the *future* of this WI, possibly with the fix already in it.
      const stages = buildPipeline({
        config: { ...config, targetRepoPath: checkout },
        logger: log,
        ado: deps.ado,
        runner,
        fetchWiContext: async (ado, id) => replayContext(await fetchCtx(ado, id), entry),
      });
      const analyzer = stages.find((s) => s.name === 'analyzer');
      if (!analyzer) throw new Error('pipeline has no analyzer stage');
      await analyzer.execute(state, stageContext(config, log));
    } finally {
      await git(['worktree', 'remove', '--force', checkout], config.targetRepoPath).catch(() => {});
    }
  }

  function stageContext(config: AppConfig, log: Logger): PipelineContext {
    return { config, logger: log, abortFlag: deps.abortFlag, signal: abort.signal, now };
  }

  async function sharedAnalyzer(entry: CorpusEntry): Promise<{ analyzer: unknown; wiContext: unknown }> {
    const dir = join(deps.outDir, entry.wiId.toString());
    const path = join(dir, 'analyzer.json');
    if (existsSync(path)) {
      const cached = JSON.parse(readFileSync(path, 'utf-8')) as {
        analyzer?: unknown;
        wiContext?: unknown;
        rejected?: string;
      };
      // Cached rejections too: every variant of this WI would otherwise
      // re-pay for an analyzer that will reject it again.
      if (cached.rejected !== undefined) throw new Error(`analyzer rejected WI ${entry.wiId}: ${cached.rejected}`);
      return { analyzer: cached.analyzer, wiContext: cached.wiContext };
    }
    mkdirSync(dir, { recursive: true });
    const config = loadConfig(baselineEnv);
    const runner = createRunner(config, logger);
    const state = createInitialState(entry.wiId, `x${runTag(deps.runId)}-analyzer`, now());
    try {
      await runAnalyzer(entry, config, runner, state, logger);
    } catch (err) {
      if (err instanceof PipelineRejectError) {
        writeJson(path, { rejected: err.payload.summary });
        throw new Error(`analyzer rejected WI ${entry.wiId}: ${err.payload.summary}`);
      }
      throw err;
    } finally {
      addOverhead((state.outputs.cost as PipelineCostInfo | undefined)?.total ?? 0);
    }
    const cached = { analyzer: state.outputs.analyzer, wiContext: state.outputs.wiContext };
    writeJson(path, cached);
    return cached;
  }

  // ---- one wi × variant × rep -------------------------------------------
  async function runOne(entry: CorpusEntry, variant: Variant, rep: number): Promise<RunResult> {
    const runDir = resolve(deps.outDir, entry.wiId.toString(), `${variant.name}-${rep}`);
    const stateDir = join(runDir, 'state');
    mkdirSync(runDir, { recursive: true });
    const config = loadConfig({
      ...deps.baseEnv,
      ...variant.env,
      WORKTREE_BASE_REF: entry.baseSha,
      STATE_DIR: stateDir,
      LOG_DIR: runDir,
      COST_LOG_PATH: join(runDir, 'ledger.jsonl'),
    });
    const wiLog = createWiLogFactory({ dir: runDir, logger }).open(entry.wiId);
    const log = wiLog.logger;
    const runner = createRunner(config, log);
    const store = new PipelineStateStore(stateDir);
    const startedAt = now();
    log.info(`experiment ${deps.runId}: WI ${entry.wiId} variant ${variant.name} rep ${rep}`);

    let state = store.load(entry.wiId);
    if (state === null) {
      state = createInitialState(entry.wiId, runSlug(deps.runId, variant.name, rep), startedAt);
      if (variant.rerunAnalyzer) {
        await runAnalyzer(entry, config, runner, state, log);
      } else {
        const shared = await sharedAnalyzer(entry);
        state.outputs.analyzer = shared.analyzer;
        state.outputs.wiContext = shared.wiContext;
      }
      state.currentStage = 'worktree-setup';
      store.save(state);
    } else if (state.terminalError) {
      // Resuming a rate-limited run: same move as the processor — clear the
      // error and pick up at the failed stage instead of re-paying for the rest.
      state.terminalError = undefined;
      store.save(state);
    }
    // A resumed run restarts at the failed stage, which skips worktree-setup.
    // If its worktree is gone (runs before this fix removed it even when the
    // run was meant to be resumed), every later stage fails on an empty path —
    // send it back through worktree-setup, which recreates it.
    const persistedWt = state.outputs.worktree as WorktreeContext | undefined;
    if (persistedWt && !existsSync(persistedWt.path) && state.currentStage && state.currentStage !== 'worktree-setup') {
      log.warn(`worktree ${persistedWt.path} is missing — resuming from worktree-setup`);
      state.currentStage = 'worktree-setup';
      store.save(state);
    }

    const stages = buildPipeline({ config, logger: log, ado: deps.ado, runner }).filter(
      (s) => !STRIPPED_STAGES.has(s.name),
    );

    let error: { stage: string; message: string } | undefined;
    try {
      state = await runPipeline({ stages, state, context: stageContext(config, log), store });
    } catch (err) {
      state = store.load(entry.wiId) ?? state;
      error = {
        stage: state.terminalError?.stage ?? state.currentStage ?? 'unknown',
        message: err instanceof Error ? err.message : String(err),
      };
      log.error(`run failed at ${error.stage}: ${error.message}`);
    }

    const worktree = state.outputs.worktree as WorktreeContext | undefined;
    const completed = error === undefined && !state.rejection && !state.cancelled;

    // pr-message runs in production too; measure it, but never push.
    if (completed && worktree && state.outputs.prMessage === undefined) {
      try {
        const template = deps.prMessagePromptTemplate ?? readFileSync(PR_MESSAGE_PROMPT_PATH, 'utf-8');
        const r = await runPrMessage({
          runner,
          model: modelFor(config, 'pr-message'),
          effort: effortFor(config, 'pr-message'),
          systemPromptAppend: template,
          wiCtx: state.outputs.wiContext as WorkItemContext,
          worktree,
          signal: abort.signal,
        });
        createCostTracker(state).add('pr-message', r.costUsd, r.usage);
        createToolUsageTracker(state).add('pr-message', r.toolUsage);
        state.outputs.prMessage = r.message;
        store.save(state);
      } catch (err) {
        log.warn(`pr-message failed (not scored): ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const outcome: RunOutcome = state.cancelled
      ? 'cancelled'
      : state.rejection
        ? 'rejected'
        : error && isRateLimitMessage(error.message)
          ? 'rate-limited'
          : error && error.stage === 'env-provision'
            ? 'env-failed'
            : error
              ? 'failed'
              : 'completed';
    // An unscored run is resumed later from its own state, so its worktree
    // must survive; removing it is what broke the first resume.
    const scored = outcome !== 'rate-limited' && outcome !== 'cancelled' && outcome !== 'env-failed';

    let diff = { files: 0, insertions: 0, deletions: 0 };
    let referee: RunResult['referee'];
    if (worktree && existsSync(worktree.path)) {
      try {
        const patch = await git(['diff', `${worktree.baseSha}..HEAD`], worktree.path);
        writeFileSync(join(runDir, 'diff.patch'), patch, 'utf-8');
        const stat = await git(['diff', '--shortstat', `${worktree.baseSha}..HEAD`], worktree.path);
        diff = {
          files: Number(/(\d+) files? changed/.exec(stat)?.[1] ?? 0),
          insertions: Number(/(\d+) insertions?/.exec(stat)?.[1] ?? 0),
          deletions: Number(/(\d+) deletions?/.exec(stat)?.[1] ?? 0),
        };
      } catch (err) {
        log.warn(`diff capture failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      if (scored && deps.referee && state.outputs.coder && diff.files > 0) {
        referee = await runReferee(state, worktree, log, runDir);
      }

      if (scored) {
        try {
          await worktreeManagerFor(config).removeWorktree({
            workItemId: entry.wiId,
            slug: state.slug,
            persistedWorktree: worktree,
          });
        } catch (err) {
          log.warn(`worktree removal failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    const perStage = normalizePerStage((state.outputs.cost as PipelineCostInfo | undefined)?.perStage);
    const costUsd = (state.outputs.cost as PipelineCostInfo | undefined)?.total ?? 0;
    wiLog.append(
      renderCostReport({
        workItemId: entry.wiId,
        outcome: completed ? 'completed' : 'failed',
        totalUsd: costUsd,
        at: now().toISOString(),
        perStage,
        toolUsage: (state.outputs.toolUsage as Record<string, number> | undefined) ?? {},
      }),
    );


    const verification = state.outputs.verification as VerificationOutput | undefined;
    const lastAttempt = verification ? Math.max(-1, ...verification.testRuns.map((t) => t.attempt)) : -1;
    const lastRuns = verification?.testRuns.filter((t) => t.attempt === lastAttempt) ?? [];
    const review = state.outputs.reviewer as ReviewerOutput | undefined;
    const endedAt = now();

    const result: RunResult = {
      wiId: entry.wiId,
      variant: variant.name,
      rep,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      wallMs: endedAt.getTime() - startedAt.getTime(),
      outcome,
      ...(error ? { error } : {}),
      costUsd,
      totalTokens: totalTokensOf(perStage),
      perStage,
      stageMs: sumStageMs(state),
      ...(verification
        ? {
            verification: {
              finalGate: state.history.some((h) => h.stage === 'build-and-test'),
              compiled: verification.compiled,
              passed: verification.passed,
              skipped: verification.skipped === true,
              ...(verification.skipReason ? { skipReason: verification.skipReason } : {}),
              attempts: verification.attempts,
              testsPassed: lastRuns.reduce((n, t) => n + t.summary.passed, 0),
              testsFailed: lastRuns.reduce((n, t) => n + t.summary.failed, 0),
            },
          }
        : {}),
      ...(review
        ? { reviewer: { approved: review.approved, rounds: review.attempts, findings: countSeverities(review.findings) } }
        : {}),
      ...(referee ? { referee } : {}),
      diff,
    };
    // An unscored run gets no result.json, so the next invocation resumes it.
    if (scored) {
      writeJson(join(runDir, 'result.json'), result);
    } else {
      writeJson(join(runDir, 'partial-result.json'), result);
    }
    await deleteRunEnvironment(config, state, log);
    return result;
  }

  /**
   * Delete the environment a run or base check created. Production keeps its
   * environments (DemoPortal expires them), but a 30-run experiment exhausted
   * the account's 50-environment quota in one night — which also blocks the
   * production pipeline. Best-effort, and only for a name the harness gave.
   * A resumed run whose environment is gone simply gets a fresh one.
   */
  async function deleteRunEnvironment(config: AppConfig, state: PipelineState, log: Logger): Promise<void> {
    const env = state.outputs.environment as EnvironmentOutput | undefined;
    if (!env?.envId) return;
    if (!HARNESS_ENV_NAME.test(env.name)) {
      log.warn(`not deleting environment ${env.envId} — '${env.name}' is not a harness-created name`);
      return;
    }
    // Not the run's worktree: by now a scored run has removed it, and a
    // missing cwd makes the spawn itself fail. The clone always exists.
    const worktreePath = config.targetRepoPath;
    try {
      await (deps.createContiniaCli ?? ((c: AppConfig) => createContiniaCli({ config: c })))(config).deleteEnvironment(
        env.envId,
        { worktreePath },
      );
      log.info(`deleted environment ${env.envId} (${env.name})`);
    } catch (err) {
      log.warn(`could not delete environment ${env.envId} (${env.name}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function runReferee(
    state: PipelineState,
    worktree: WorktreeContext,
    log: Logger,
    runDir: string,
  ): Promise<RunResult['referee']> {
    const config = loadConfig(baselineEnv);
    const runner = createRunner(config, log);
    // A fresh state: no prior findings, no byAxis, no findingsAddressed — the
    // referee is a first read, and its spend must not land on the variant.
    const refState = createInitialState(state.workItemId, state.slug, now());
    for (const key of ['wiContext', 'analyzer', 'coder', 'testAuthor']) {
      if (state.outputs[key] !== undefined) refState.outputs[key] = state.outputs[key];
    }
    refState.outputs.worktree = worktree;
    try {
      const out = await createReferee(config, runner).execute(refState, stageContext(config, log));
      const review = out.outputs.reviewer as ReviewerOutput | undefined;
      const cost = out.outputs.cost as PipelineCostInfo | undefined;
      const perStage = normalizePerStage(cost?.perStage);
      const items = review?.findings ?? [];
      writeJson(join(runDir, 'referee.json'), { findings: items, perStage });
      return {
        costUsd: cost?.total ?? 0,
        totalTokens: totalTokensOf(perStage),
        findings: countSeverities(items),
        items,
      };
    } catch (err) {
      log.warn(`referee failed: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    } finally {
      addOverhead((refState.outputs.cost as PipelineCostInfo | undefined)?.total ?? 0);
    }
  }

  async function defaultCheckBase(entry: CorpusEntry): Promise<BaseCheckResult> {
    const unchecked = (reason: string): BaseCheckResult => ({
      wiId: entry.wiId,
      status: 'unchecked',
      reason,
      redCodeunits: [],
    });
    if (!entry.fixSha) return unchecked('no fixSha in corpus entry');
    const dir = resolve(deps.outDir, entry.wiId.toString(), 'base-check');
    const config = loadConfig({
      ...baselineEnv,
      WORKTREE_BASE_REF: entry.baseSha,
      STATE_DIR: join(dir, 'state'),
      LOG_DIR: dir,
    });
    if (config.skipBuildTest) return unchecked('SKIP_BUILD_TEST is set');
    const log = createWiLogFactory({ dir, logger }).open(entry.wiId).logger;
    const continiaCli = createContiniaCli({ config, onRetry: (message) => log.warn(message) });
    const store = new PipelineStateStore(join(dir, 'state'));
    let state =
      store.load(entry.wiId) ??
      createInitialState(entry.wiId, `x${runTag(deps.runId)}-basecheck`, now());
    state.terminalError = undefined;
    state.currentStage ??= 'worktree-setup';
    // Same resume rule as a variant run: a check restarted past
    // worktree-setup whose worktree is gone would fail on an empty path.
    const checkWt = state.outputs.worktree as WorktreeContext | undefined;
    if (checkWt && !existsSync(checkWt.path)) state.currentStage = 'worktree-setup';
    // Only the two stages that produce a worktree and an environment: the
    // check itself makes no LLM call.
    const stages = buildPipeline({
      config,
      logger: log,
      ado: deps.ado,
      runner: createRunner(config, log),
    }).filter((st) => st.name === 'worktree-setup' || st.name === 'env-provision');
    try {
      state = await runPipeline({ stages, state, context: stageContext(config, log), store });
      if (deps.abortFlag.aborted || state.cancelled) return unchecked('aborted');
      const worktree = state.outputs.worktree as WorktreeContext;
      const changed = (await git(['diff', '--name-only', entry.baseSha, entry.fixSha], worktree.path))
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      const setup = await prepareVerification({
        config,
        continiaCli,
        logger: log,
        worktree,
        environment: state.outputs.environment as EnvironmentOutput,
        cache: {},
        getChangedFiles: async () => changed,
        logPrefix: 'base-check',
        signal: abort.signal,
      });
      if (setup.skipReason) return unchecked(setup.skipReason);
      const round = await runVerificationRound({
        logger: log,
        continiaCli,
        env: setup.env,
        worktree,
        appPaths: setup.appPaths,
        codeunits: setup.codeunits,
        config,
        attempt: 0,
        signal: abort.signal,
      });
      const out = round.output;
      const deployErrors = out.deploy
        .filter((d) => !(d.compiled && d.published))
        // The compiler's own `error ALxxxx` lines sit after a long banner; a
        // 1500-char cut kept only the banner and hid the cause.
        .map((d) => JSON.stringify(d).slice(0, 20_000))
        .join('\n');
      // Everything the CLI said about each app except alc's full output.
      const deployRows = out.deploy.map((d) => {
        const { error: _error, ...rest } = d as unknown as Record<string, unknown>;
        return rest;
      });
      const redCodeunits = out.testRuns
        .filter((t) => !t.passed)
        .map((t) => ({
          id: t.codeunitId,
          ...(t.codeunitName ? { name: t.codeunitName } : {}),
          failed: t.summary.failed,
        }));
      const schemaBlocked = out.deploy.some(
        (d) => !d.published && SCHEMA_DOWNGRADE_ERROR.test(`${d.code ?? ''} ${String(d.error ?? '')}`),
      );
      const status: BaseCheckResult['status'] = schemaBlocked
        ? 'base-too-old'
        : round.environmentBlocker
        ? 'env-blocked'
        : !out.compiled
          ? 'compile-failed'
          : out.passed
            ? 'green'
            : 'tests-red';
      // Name the blocker: an env-blocked verdict is not cached, so without
      // this the only record of *which* environment fault it was is lost.
      const blocker = round.environmentBlocker;
      return {
        wiId: entry.wiId,
        status,
        redCodeunits,
        ...(blocker && status === 'env-blocked'
          ? { reason: `${blocker.code ?? 'unknown'} in ${blocker.app}: ${String(blocker.error ?? '').slice(0, 400)}` }
          : {}),
        ...(deployErrors ? { deployErrors } : {}),
        deployRows,
        appPaths: setup.appPaths,
      };
    } finally {
      const worktree = state.outputs.worktree as WorktreeContext | undefined;
      await deleteRunEnvironment(config, state, log);
      if (worktree) {
        await worktreeManagerFor(config)
          .removeWorktree({ workItemId: entry.wiId, slug: state.slug, persistedWorktree: worktree })
          .catch((err: unknown) => log.warn(`base-check worktree removal failed: ${String(err)}`));
      }
    }
  }

  async function baseCheckFor(entry: CorpusEntry): Promise<BaseCheckResult> {
    const path = join(deps.outDir, entry.wiId.toString(), 'base-check.json');
    if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf-8')) as BaseCheckResult;
    mkdirSync(join(deps.outDir, entry.wiId.toString()), { recursive: true });
    let result: BaseCheckResult;
    try {
      result = await (deps.checkBase ?? defaultCheckBase)(entry);
    } catch (err) {
      // A check that cannot run must not block the experiment — but say so.
      result = {
        wiId: entry.wiId,
        status: 'unchecked',
        reason: `base check errored: ${err instanceof Error ? err.message : String(err)}`,
        redCodeunits: [],
      };
    }
    // Only a verdict about the *code* is cached. `env-blocked` says the
    // environment could not serve the check (a 503 from a half-woken env was
    // the first case), which is as uninformative as `unchecked`: retry it.
    if (result.status !== 'unchecked' && result.status !== 'env-blocked') writeJson(path, result);
    // Every attempt is kept for diagnosis, cached or not.
    writeJson(join(deps.outDir, entry.wiId.toString(), 'base-check.last.json'), result);
    return result;
  }

  // ---- schedule -----------------------------------------------------------
  const baseChecks: BaseCheckResult[] = [];
  try {
  for (const entry of deps.corpus) {
    if (deps.abortFlag.aborted) break;
    const check = await baseCheckFor(entry);
    baseChecks.push(check);
    if (deps.baseCheckOnly) {
      logger.info(`WI ${entry.wiId}: base check ${check.status}${check.reason ? ` (${check.reason.slice(0, 300)})` : ''}`);
      continue;
    }
    if (check.status === 'compile-failed' || check.status === 'base-too-old') {
      logger.error(
        `WI ${entry.wiId}: base ${entry.baseSha.slice(0, 9)} is ${check.status} — skipping every variant (see ${entry.wiId}/base-check.json)`,
      );
      continue;
    }
    if (check.status === 'tests-red') {
      logger.warn(
        `WI ${entry.wiId}: ${check.redCodeunits.length} codeunit(s) already red at base — gate results for this WI include pre-existing failures`,
      );
    } else if (check.status === 'unchecked' || check.status === 'env-blocked') {
      // Variants get their own environments, so a sick base-check env is no
      // reason to skip them.
      logger.warn(`WI ${entry.wiId}: base not checked (${check.reason ?? check.status})`);
    }
    for (const variant of variants) {
      for (let rep = 1; rep <= deps.reps; rep++) {
        if (deps.abortFlag.aborted) return { results, baseChecks, skippedForBudget, overheadUsd };
        const done = join(deps.outDir, entry.wiId.toString(), `${variant.name}-${rep}`, 'result.json');
        if (existsSync(done)) {
          const prior = JSON.parse(readFileSync(done, 'utf-8')) as RunResult;
          results.push(prior);
          spent += prior.costUsd;
          continue;
        }
        if (overBudget()) {
          skippedForBudget += 1;
          continue;
        }
        try {
          const r = await runOne(entry, variant, rep);
          results.push(r);
          spent += r.costUsd;
        } catch (err) {
          // A harness fault (analyzer rejected the WI, config error) — log and
          // move on; one bad corpus entry must not sink the whole experiment.
          logger.error(
            `WI ${entry.wiId} ${variant.name} r${rep}: harness error :: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  }
  return { results, baseChecks, skippedForBudget, overheadUsd };
  } finally {
    clearInterval(abortPoll);
  }
}
