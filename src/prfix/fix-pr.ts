import { createInitialState, runPipeline, type RunPipelineOptions } from '../pipeline/orchestrator.ts';
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
  type PipelineState,
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
  type PrFixReview,
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
  /**
   * Dashboard mode: the pipeline (built without `push-rebased`/`pr-comment`)
   * ends green as `awaiting-approval` with a review, keeping the worktree, the
   * reserved Ninja IDs and the saved state for `approvePrFix`/`rejectPrFix`.
   */
  holdBeforePush?: boolean;
  onProgress?: RunPipelineOptions['onProgress'];
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
 *
 * With `holdBeforePush`, a green run ends `awaiting-approval` instead (see
 * `concludeRun`); every other ending is the same as without it.
 */
export async function fixPr(deps: FixPrDeps): Promise<PrFixOutcome> {
  const { pullRequestId } = deps;
  const now = deps.now ?? (() => new Date());
  const state = createInitialState(pullRequestId, `pr-${pullRequestId}`, now());
  state.outputs.prFixInput = { pullRequestId, repository: deps.prfix.app.repositoryName };
  return concludeRun(deps, state, deps.stages, deps.holdBeforePush === true);
}

/** Marks a state held by `fixPr` in hold mode; approve and reject accept only such a state. */
const AWAITING_APPROVAL_KEY = 'awaitingApprovalSince';
/** Set when the hold deleted the environment, so approve does not delete it again. */
const ENV_DELETED_KEY = 'environmentDeletedAt';

function loadHeld(deps: FixPrDeps): PipelineState {
  const state = deps.store.load(deps.pullRequestId);
  if (!state || typeof state.outputs[AWAITING_APPROVAL_KEY] !== 'string') {
    throw new Error(`no held fix-pr state for PR ${deps.pullRequestId}`);
  }
  return state;
}

/**
 * Runs `push-rebased` then `pr-comment` (`finishStages`) from the state a
 * hold saved. The push leases on the saved `rebase.preRebaseSha` — the head
 * read before the rebase — so a developer push since then ends `head-moved`.
 * The ending (comment, ID release, cleanup) follows the same rules as `fixPr`.
 */
export async function approvePrFix(deps: FixPrDeps & { finishStages: Stage[] }): Promise<PrFixOutcome> {
  const state = loadHeld(deps);
  // A held result is approved once: whatever happens next consumes it.
  delete state.outputs[AWAITING_APPROVAL_KEY];
  state.currentStage = 'push-rebased';
  delete state.terminalError;
  delete state.cancelled;
  delete state.completedAt;
  deps.store.save(state);
  return concludeRun(deps, state, deps.finishStages, false);
}

/** Discards a held result: releases its reserved IDs and removes its worktree. Nothing is pushed. */
export async function rejectPrFix(deps: FixPrDeps): Promise<PrFixOutcome> {
  const state = loadHeld(deps);
  delete state.outputs[AWAITING_APPROVAL_KEY];
  deps.store.save(state);
  await releaseReservedIds(deps, state.outputs.renumber as RenumberOutput | undefined);
  const wt = state.outputs.worktree as WorktreeContext | undefined;
  if (wt) {
    try {
      await deps.git.removeWorktree(wt);
    } catch (err) {
      deps.logger.warn(`fix-pr: worktree removal failed :: ${messageOf(err)}`);
    }
  }
  return buildOutcome(deps.pullRequestId, state.outputs, 'rejected', null);
}

function buildOutcome(
  pullRequestId: number,
  outputs: Record<string, unknown>,
  status: PrFixStatus,
  error: string | null,
): PrFixOutcome {
  const input = outputs.prFixInput as Partial<PrFixInput>;
  const rebase = outputs.rebase as RebaseOutput | undefined;
  const renumber = outputs.renumber as RenumberOutput | undefined;
  return {
    ok: status === 'rebased' || status === 'up-to-date' || status === 'awaiting-approval',
    status,
    pullRequestId,
    oldHead: input.pr?.headCommit ?? null,
    newHead: finalHeadSha(outputs),
    conflicts: rebase?.conflicts ?? [],
    renumbered: renumber?.renumbered ?? [],
    costUsd: (outputs.cost as PipelineCostInfo | undefined)?.total ?? 0,
    error,
  };
}

/**
 * Runs `stages` on `state` and turns the end state into the outcome, then
 * posts the failure comment and cleans up — the one place these rules live
 * for `fixPr` and `approvePrFix`. With `hold`, a green run that pushed nothing
 * ends `awaiting-approval` with a review: the environment is deleted (unless
 * keepEnv), the IDs and worktree stay, and the state is saved for approval.
 */
async function concludeRun(deps: FixPrDeps, state: PipelineState, stages: Stage[], hold: boolean): Promise<PrFixOutcome> {
  const { logger, pullRequestId } = deps;
  const config = deps.prfix.app;
  const now = deps.now ?? (() => new Date());
  const build = (status: PrFixStatus, error: string | null): PrFixOutcome =>
    buildOutcome(pullRequestId, state.outputs, status, error);

  let outcome: PrFixOutcome;
  let collisions: CollisionGroup[] | undefined;
  try {
    await runPipeline({
      stages,
      state,
      context: {
        config,
        logger,
        abortFlag: deps.abortFlag ?? { aborted: false },
        signal: new AbortController().signal,
        now,
      },
      store: deps.store,
      ...(deps.onProgress ? { onProgress: deps.onProgress } : {}),
    });
    if (state.cancelled && state.outputs.pushed === true) {
      logger.warn(`fix-pr: cancelled after the rebased branch was pushed; reporting PR ${pullRequestId} as rebased`);
      outcome = build('rebased', null);
    } else if (state.cancelled) {
      outcome = build('cancelled', 'cancelled');
    } else if (hold && state.outputs.pushed !== true) {
      outcome = { ...build('awaiting-approval', null), review: await buildReview(deps, state.outputs) };
    } else {
      outcome = build('rebased', null);
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

  if (outcome.status === 'awaiting-approval') {
    if (await deleteEnvironment(deps, state.outputs)) state.outputs[ENV_DELETED_KEY] = now().toISOString();
    state.outputs[AWAITING_APPROVAL_KEY] = now().toISOString();
    deps.store.save(state);
    logger.info(`fix-pr: PR ${pullRequestId} awaits approval; keeping worktree and reserved IDs`);
    return outcome;
  }
  await postFailureComment(deps, state.outputs.prFixInput as Partial<PrFixInput>, outcome, collisions);
  await cleanUp(deps, state.outputs, outcome);
  return outcome;
}

/**
 * What the approver sees. Throws when the green run left no rebase or
 * worktree to review (the caller reports that as an error); a failing diff
 * call only puts `(diff unavailable: ...)` in that field.
 */
async function buildReview(deps: FixPrDeps, outputs: Record<string, unknown>): Promise<PrFixReview> {
  const input = outputs.prFixInput as Partial<PrFixInput>;
  const rebase = outputs.rebase as RebaseOutput | undefined;
  const wt = outputs.worktree as WorktreeContext | undefined;
  if (!input.pr || !rebase || !wt) throw new Error('hold: the run left no rebase to review');
  const newHead = finalHeadSha(outputs) ?? rebase.newHeadSha;
  const diff = async (run: () => Promise<string>): Promise<string> => {
    try {
      return await run();
    } catch (err) {
      return `(diff unavailable: ${redactPat(messageOf(err), deps.prfix.app.pat)})`;
    }
  };
  const conflicts: PrFixReview['conflicts'] = [];
  for (const c of rebase.conflicts) {
    const diffs: { path: string; diff: string }[] = [];
    for (const file of c.files) {
      diffs.push({ path: file, diff: await diff(() => deps.git.fileDiff(wt.path, rebase.preRebaseSha, newHead, file)) });
    }
    conflicts.push({ ...c, diffs });
  }
  const verification = outputs.verification as VerificationOutput | undefined;
  return {
    preRebaseSha: rebase.preRebaseSha,
    targetSha: rebase.targetSha,
    targetRefName: input.pr.targetRefName,
    newHead,
    commitsReplayed: rebase.commitsReplayed,
    conflicts,
    renumbered: (outputs.renumber as RenumberOutput | undefined)?.renumbered ?? [],
    tests: verification
      ? { passed: verification.passed, codeunits: new Set(verification.testRuns.map((r) => r.codeunitId)).size }
      : null,
    rangeDiff: await diff(() => deps.git.rangeDiff(wt.path, rebase.targetSha, rebase.preRebaseSha, newHead)),
    costUsd: (outputs.cost as PipelineCostInfo | undefined)?.total ?? 0,
  };
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

/**
 * Deletes the run's environment unless keepEnv, a hold already deleted it, or
 * its name is not a fix-pr one. True when it was deleted here.
 */
async function deleteEnvironment(deps: FixPrDeps, outputs: Record<string, unknown>): Promise<boolean> {
  const { logger, pullRequestId } = deps;
  const env = outputs.environment as EnvironmentOutput | undefined;
  const wt = outputs.worktree as WorktreeContext | undefined;
  if (!env || typeof outputs[ENV_DELETED_KEY] === 'string') return false;
  if (deps.keepEnv) {
    logger.info(`fix-pr: keeping environment ${env.envId} (${env.url ?? 'no url'})`);
    return false;
  }
  if (!env.name.startsWith(`wi-${pullRequestId}-pr-`)) {
    logger.warn(`fix-pr: not deleting environment ${env.envId} — '${env.name}' is not a fix-pr name`);
    return false;
  }
  if (!deps.continiaCli) return false;
  try {
    await deps.continiaCli.deleteEnvironment(env.envId, { worktreePath: wt?.path ?? deps.prfix.app.targetRepoPath });
    logger.info(`fix-pr: deleted environment ${env.envId}`);
    return true;
  } catch (err) {
    logger.warn(`fix-pr: could not delete environment ${env.envId} :: ${messageOf(err)}`);
    return false;
  }
}

async function cleanUp(deps: FixPrDeps, outputs: Record<string, unknown>, outcome: PrFixOutcome): Promise<void> {
  const { logger } = deps;
  const wt = outputs.worktree as WorktreeContext | undefined;

  // Before the worktree goes: Ninja resolves each ID's app from its file.
  if (outputs.pushed !== true) await releaseReservedIds(deps, outputs.renumber as RenumberOutput | undefined);

  await deleteEnvironment(deps, outputs);

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
