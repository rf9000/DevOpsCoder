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
  type WorktreeContext,
} from '../types/index.ts';
import { redactPat } from '../utils/git-auth.ts';
import type { Logger } from '../utils/logger.ts';
import type { PrFixConfig } from './config.ts';
import { renderFailureComment } from './comment.ts';
import type { PrFixGit } from './prfix-git.ts';
import {
  ConflictCapError,
  MergeCommitsError,
  PrUpToDateError,
  UnresolvedConflictError,
  type PrFixInput,
  type PrFixOutcome,
  type PrFixStatus,
  type RebaseOutput,
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
}

function statusOf(err: unknown): PrFixStatus {
  if (err instanceof PrUpToDateError) return 'up-to-date';
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
 * A failure comment is best-effort and never posted for up-to-date, a
 * cancelled run or a dry run. The environment is deleted unless keepEnv — dry
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
    return {
      ok: status === 'rebased' || status === 'up-to-date',
      status,
      pullRequestId,
      oldHead: input.pr?.headCommit ?? null,
      newHead: rebase?.newHeadSha ?? null,
      conflicts: rebase?.conflicts ?? [],
      costUsd: (state.outputs.cost as PipelineCostInfo | undefined)?.total ?? 0,
      error,
    };
  };

  let outcome: PrFixOutcome;
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
    outcome = state.cancelled ? build('cancelled', 'cancelled') : build('rebased', null);
  } catch (err) {
    const status = statusOf(err);
    const message = redactPat(messageOf(err), config.pat);
    if (status === 'up-to-date') {
      outcome = build(status, null);
    } else if (status === 'error') {
      const stage = state.terminalError?.stage ?? 'fix-pr';
      outcome = build(status, `${stage}: ${message}`);
    } else {
      outcome = build(status, message);
    }
  }

  await postFailureComment(deps, state.outputs.prFixInput as Partial<PrFixInput>, outcome);
  await cleanUp(deps, state.outputs, outcome);
  return outcome;
}

async function postFailureComment(deps: FixPrDeps, input: Partial<PrFixInput>, outcome: PrFixOutcome): Promise<void> {
  if (outcome.ok || outcome.status === 'cancelled' || deps.prfix.app.dryRun) return;
  // Without the PR (intake failed) there is no target branch to name, and
  // likely no PR to comment on.
  if (!input.pr) return;
  try {
    await deps.ado.createPullRequestThread({
      repositoryName: deps.prfix.app.repositoryName,
      pullRequestId: deps.pullRequestId,
      content: renderFailureComment({ pr: input.pr, outcome }),
    });
  } catch (err) {
    deps.logger.warn(`fix-pr: failure comment on PR ${deps.pullRequestId} not posted :: ${redactPat(messageOf(err), deps.prfix.app.pat)}`);
  }
}

async function cleanUp(deps: FixPrDeps, outputs: Record<string, unknown>, outcome: PrFixOutcome): Promise<void> {
  const { logger, pullRequestId } = deps;
  const env = outputs.environment as EnvironmentOutput | undefined;
  const wt = outputs.worktree as WorktreeContext | undefined;

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
