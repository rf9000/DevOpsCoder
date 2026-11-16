import { createInitialState, runPipeline } from '../pipeline/orchestrator.ts';
import type { AbortFlag, Stage } from '../pipeline/stage.ts';
import type { AdoClient } from '../sdk/azure-devops-client.ts';
import type { ContiniaCli } from '../services/continia-cli.ts';
import type { PipelineStateStore } from '../state/state-store.ts';
import { HeadMovedError } from '../suggestions/suggestion-git.ts';
import {
  CostExceededError,
  VerificationFailedError,
  type EnvironmentOutput,
  type PipelineCostInfo,
  type VerificationOutput,
  type WorktreeContext,
} from '../types/index.ts';
import { redactPat } from '../utils/git-auth.ts';
import type { Logger } from '../utils/logger.ts';
import type { CollisionGroup } from './al-objects.ts';
import type { PrFixConfig } from './config.ts';
import { AL_ERROR_LINE, renderFailureComment } from './comment.ts';
import { createNinjaClient, type NinjaClient } from './ninja.ts';
import type { PrFixGit } from './prfix-git.ts';
import {
  ConflictCapError,
  IdCollisionError,
  finalHeadSha,
  MergeCommitsError,
  PrUpToDateError,
  UnresolvedConflictError,
  type PrFixInput,
  type PrFixOutcome,
  type PrFixStatus,
  type RebaseOutput,
  type RenumberOutput,
} from './types.ts';

export interface FixPrDeps {
  prfix: PrFixConfig;
  logger: Logger;
  ado: AdoClient;
  git: PrFixGit;
  continiaCli?: Pick<ContiniaCli, 'deleteEnvironment'>;
  stages: Stage[];
  store: PipelineStateStore;
  pullRequestId: number;
  /** Leave the DemoPortal environment running for inspection. */
  keepEnv: boolean;
  /** Set by the CLI's SIGINT/SIGTERM handler. */
  abortFlag?: AbortFlag;
  now?: () => Date;
  /**
   * Creates a fresh Object ID Ninja client, used to release reserved IDs that
   * were never pushed. `renumber-collisions` closes its own client, so this
   * must hand out a new one per call. Default: built from `prfix.ninjaCommand`.
   */
  ninja?: () => NinjaClient;
}

/** A fresh, lazily connecting Ninja client per call, from the fix-pr config. */
export function ninjaFactoryFor(prfix: PrFixConfig): () => NinjaClient {
  return () =>
    createNinjaClient({
      command: prfix.ninjaCommand.command,
      args: prfix.ninjaCommand.args,
      timeoutMs: prfix.ninjaCallTimeoutMs,
      ...(prfix.ninjaGitIdentity ? { gitIdentity: prfix.ninjaGitIdentity } : {}),
    });
}

/**
 * The compiler's and analyzers' error lines from the failed deploy rows, for a reader who
 * has only the outcome or the PR comment. alc usually prints project-relative
 * paths (`Feature Management\PontoFeature.Codeunit.al(1,10): error AL0264: ...`),
 * which are kept as they are. An absolute path loses its leading worktree root
 * (`worktreePath`) and, when the row carries a `projectPath`, the app directory
 * after it. A row's `app` is the app's *name*, never a path, so it is not used.
 * De-duplicated (alc repeats a diagnostic per compile pass) and capped at `max`.
 */
export function alErrorLines(
  verification: VerificationOutput | undefined,
  max = 10,
  worktreePath?: string,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const row of verification?.deploy ?? []) {
    if (!(row.compiled === false || row.published === false) || !row.error) continue;
    // `projectPath` is a passthrough field of the CLI's deploy row, not typed.
    const projectPath = (row as unknown as Record<string, unknown>).projectPath;
    const prefixes = pathPrefixes(worktreePath, typeof projectPath === 'string' ? projectPath : undefined);
    for (const raw of row.error.split(/\r?\n/)) {
      if (!AL_ERROR_LINE.test(raw)) continue;
      const line = stripPrefix(raw.trim(), prefixes);
      if (seen.has(line)) continue;
      seen.add(line);
      out.push(line);
      if (out.length >= max) return out;
    }
  }
  return out;
}

const isAbsolutePath = (p: string): boolean => /^(?:[A-Za-z]:[\\/]|[\\/])/.test(p);
const trimSeparators = (p: string): string => p.replace(/[\\/]+$/, '');

/** Most specific first: the app's own directory, then the worktree root. */
function pathPrefixes(worktreePath: string | undefined, projectPath: string | undefined): string[] {
  const out: string[] = [];
  const root = worktreePath ? trimSeparators(worktreePath) : undefined;
  if (projectPath) {
    const project = trimSeparators(projectPath);
    if (isAbsolutePath(project)) out.push(project);
    else if (root && project !== '' && project !== '.') out.push(`${root}/${project.replace(/^\.[\\/]/, '')}`);
  }
  if (root) out.push(root);
  return out.filter((p) => p !== '');
}

/** Same path with `\` and `/` interchangeable and case ignored (length-preserving). */
const comparable = (p: string): string => p.replace(/\\/g, '/').toLowerCase();

function stripPrefix(line: string, prefixes: string[]): string {
  if (!isAbsolutePath(line)) return line;
  const l = comparable(line);
  for (const p of prefixes) {
    const c = comparable(p);
    if (l.startsWith(`${c}/`)) return line.slice(p.length + 1);
  }
  return line;
}

function statusOf(err: unknown): PrFixStatus {
  if (err instanceof PrUpToDateError) return 'up-to-date';
  if (err instanceof IdCollisionError) return 'id-collision';
  if (err instanceof HeadMovedError) return 'head-moved';
  if (err instanceof ConflictCapError) return 'conflict-cap';
  if (err instanceof UnresolvedConflictError) return 'unresolved-conflict';
  if (err instanceof MergeCommitsError) return 'merge-commits';
  if (err instanceof VerificationFailedError) return 'verification-failed';
  if (err instanceof CostExceededError) return 'cost-cap';
  return 'error';
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Runs the fix-pr pipeline for one PR and turns its end state into a
 * `PrFixOutcome`. The state is fresh each run (`.state/prfix/<prId>.json` is
 * overwritten), with slug `pr-<prId>` so env-provision names the environment
 * `wi-<prId>-pr-<prId>`.
 *
 * Once `push-rebased` has pushed (`state.outputs.pushed`), the remote branch
 * IS the rebased one: any later failure or cancellation is logged as a warning
 * and the outcome is still `rebased`, so nothing claims the branch is unchanged.
 *
 * A failure comment is best-effort and never posted for up-to-date, a
 * cancelled run, a pushed branch or a dry run. The environment is deleted unless keepEnv — dry
 * runs included, since a dry run still created one. The worktree is removed on
 * success and up-to-date, and kept on failure for inspection; the next run's
 * createWorktree replaces it.
 */
export async function fixPr(deps: FixPrDeps): Promise<PrFixOutcome> {
  const { prfix, logger, pullRequestId } = deps;
  const config = prfix.app;
  const now = deps.now ?? (() => new Date());
  const state = createInitialState(pullRequestId, `pr-${pullRequestId}`, now());
  state.outputs.prFixInput = { pullRequestId, repository: config.repositoryName };

  const build = (status: PrFixStatus, error: string | null): PrFixOutcome => {
    const input = state.outputs.prFixInput as Partial<PrFixInput>;
    const rebase = state.outputs.rebase as RebaseOutput | undefined;
    const renumber = state.outputs.renumber as RenumberOutput | undefined;
    return {
      ok: status === 'rebased' || status === 'up-to-date',
      status,
      pullRequestId,
      oldHead: input.pr?.headCommit ?? null,
      newHead: finalHeadSha(state.outputs),
      conflicts: rebase?.conflicts ?? [],
      renumbered: renumber?.renumbered ?? [],
      costUsd: (state.outputs.cost as PipelineCostInfo | undefined)?.total ?? 0,
      error,
    };
  };

  let outcome: PrFixOutcome;
  let collisions: CollisionGroup[] | undefined;
  try {
    await runPipeline({
      stages: deps.stages,
      state,
      context: {
        config,
        logger,
        abortFlag: deps.abortFlag ?? { aborted: false },
        signal: new AbortController().signal,
        now,
      },
      store: deps.store,
    });
    if (state.cancelled && state.outputs.pushed === true) {
      logger.warn(`fix-pr: cancelled after the rebased branch was pushed; reporting PR ${pullRequestId} as rebased`);
      outcome = build('rebased', null);
    } else {
      outcome = state.cancelled ? build('cancelled', 'cancelled') : build('rebased', null);
    }
  } catch (err) {
    const status = statusOf(err);
    if (err instanceof IdCollisionError) collisions = err.groups;
    let text = messageOf(err);
    if (status === 'verification-failed') {
      // Otherwise the cause is visible only in the state file.
      const al = alErrorLines(
        state.outputs.verification as VerificationOutput | undefined,
        undefined,
        (state.outputs.worktree as WorktreeContext | undefined)?.path,
      );
      if (al.length > 0) text = `${text}\n${al.join('\n')}`;
    }
    const message = redactPat(text, config.pat);
    if (state.outputs.pushed === true) {
      const stage = state.terminalError?.stage ?? 'fix-pr';
      logger.warn(`fix-pr: ${stage} failed after the rebased branch was pushed; reporting PR ${pullRequestId} as rebased :: ${message}`);
      outcome = build('rebased', null);
    } else if (status === 'up-to-date') {
      outcome = build(status, null);
    } else if (status === 'error') {
      const stage = state.terminalError?.stage ?? 'fix-pr';
      outcome = build(status, `${stage}: ${message}`);
    } else {
      outcome = build(status, message);
    }
  }

  await postFailureComment(deps, state.outputs.prFixInput as Partial<PrFixInput>, outcome, collisions);
  await cleanUp(deps, state.outputs, outcome);
  return outcome;
}

async function postFailureComment(
  deps: FixPrDeps,
  input: Partial<PrFixInput>,
  outcome: PrFixOutcome,
  collisions: CollisionGroup[] | undefined,
): Promise<void> {
  if (outcome.ok || outcome.status === 'cancelled' || deps.prfix.app.dryRun) return;
  // Without the PR (intake failed) there is no target branch to name, and
  // likely no PR to comment on.
  if (!input.pr) return;
  try {
    await deps.ado.createPullRequestThread({
      repositoryName: deps.prfix.app.repositoryName,
      pullRequestId: deps.pullRequestId,
      content: renderFailureComment({ pr: input.pr, outcome, ...(collisions ? { collisions } : {}) }),
    });
  } catch (err) {
    deps.logger.warn(`fix-pr: failure comment on PR ${deps.pullRequestId} not posted :: ${redactPat(messageOf(err), deps.prfix.app.pat)}`);
  }
}

/**
 * Releases every ID `renumber-collisions` reserved, for a run that ends
 * without a push (dry run, failure, cancel); a pushed branch uses them. Each
 * unassign is best-effort: a failure only warns and leaves that ID reserved.
 * An ID rejected because the app already declares it is never released:
 * unassigning it would free an ID that is in use.
 */
async function releaseReservedIds(deps: FixPrDeps, renumber: RenumberOutput | undefined): Promise<void> {
  const reserved = (renumber?.reserved ?? []).filter((r) => r.status !== 'rejected-in-use');
  if (reserved.length === 0) return;
  const { logger } = deps;
  logger.info(`fix-pr: releasing ${reserved.length} reserved Ninja ID(s)`);
  let client: NinjaClient;
  try {
    client = (deps.ninja ?? ninjaFactoryFor(deps.prfix))();
  } catch (err) {
    logger.warn(`fix-pr: could not create a Ninja client to release ${reserved.length} reserved ID(s) :: ${messageOf(err)}`);
    return;
  }
  try {
    for (const [i, r] of reserved.entries()) {
      try {
        await client.unassign(r.type, r.id, r.file);
        logger.info(`fix-pr: released reserved ${r.type} ${r.id} (${r.file})`);
      } catch (err) {
        const message = messageOf(err);
        logger.warn(`fix-pr: could not release reserved ${r.type} ${r.id} (${r.file}) :: ${message}`);
        // The server never started: every further call would wait out its own connect timeout.
        if (message.includes('could not start')) {
          const left = reserved.slice(i).map((x) => `${x.type} ${x.id} (${x.file})`);
          logger.warn(`fix-pr: Ninja could not start; ${left.length} reserved ID(s) left unreleased, release by hand: ${left.join(', ')}`);
          break;
        }
      }
    }
  } finally {
    try {
      await client.close();
    } catch (err) {
      logger.warn(`fix-pr: closing the Ninja client failed :: ${messageOf(err)}`);
    }
  }
}

async function cleanUp(deps: FixPrDeps, outputs: Record<string, unknown>, outcome: PrFixOutcome): Promise<void> {
  const { logger, pullRequestId } = deps;
  const env = outputs.environment as EnvironmentOutput | undefined;
  const wt = outputs.worktree as WorktreeContext | undefined;

  // Before the worktree goes: Ninja resolves each ID's app from its file.
  if (outputs.pushed !== true) await releaseReservedIds(deps, outputs.renumber as RenumberOutput | undefined);

  if (env && !deps.keepEnv) {
    if (!env.name.startsWith(`wi-${pullRequestId}-pr-`)) {
      logger.warn(`fix-pr: not deleting environment ${env.envId} — '${env.name}' is not a fix-pr name`);
    } else if (deps.continiaCli) {
      try {
        await deps.continiaCli.deleteEnvironment(env.envId, { worktreePath: wt?.path ?? deps.prfix.app.targetRepoPath });
        logger.info(`fix-pr: deleted environment ${env.envId}`);
      } catch (err) {
        logger.warn(`fix-pr: could not delete environment ${env.envId} :: ${messageOf(err)}`);
      }
    }
  } else if (env) {
    logger.info(`fix-pr: keeping environment ${env.envId} (${env.url ?? 'no url'})`);
  }

  if (!wt) return;
  if (outcome.ok) {
    try {
      await deps.git.removeWorktree(wt);
    } catch (err) {
      logger.warn(`fix-pr: worktree removal failed :: ${messageOf(err)}`);
    }
  } else {
    logger.warn(`fix-pr: ${outcome.status}; keeping worktree ${wt.path} for inspection`);
  }
}
