import type { AgentRunner } from '../pipeline/agent-stage.ts';
import type { Stage } from '../pipeline/stage.ts';
import type { AdoClient } from '../sdk/azure-devops-client.ts';
import type { WorkItemContext } from '../services/wi-context.ts';
import type { EnvironmentOutput, VerificationOutput, WorktreeContext } from '../types/index.ts';
import { assertWithinCostCap } from '../utils/cost-tracker.ts';
import type { PrFixConfig } from './config.ts';
import { renderSuccessComment } from './comment.ts';
import type { PrFixGit, RebaseStep } from './prfix-git.ts';
import { resolveConflict } from './resolver.ts';
import {
  ConflictCapError,
  PrUpToDateError,
  UnresolvedConflictError,
  type ConflictResolution,
  type PrFixInput,
  type RebaseOutput,
} from './types.ts';

const REBASE_STAGE = 'rebase-onto-target';

function abortError(): Error {
  const err = new Error(`${REBASE_STAGE} aborted`);
  err.name = 'AbortError';
  return err;
}

/**
 * Rebase the PR branch onto its target, resolving each conflicting commit with
 * one capped resolver call.
 *
 * Every throw inside the loop — caps, cost cap, resolver failure, leftover
 * markers, abort, a failed `rebase --continue` — aborts the rebase first, so the
 * worktree is never left mid-rebase for the next stage (or a rerun) to trip on.
 * The abort is best-effort: if it fails too, that is logged and the original
 * error is what propagates.
 *
 * On success, `worktree.baseSha` becomes the target sha, so `build-and-test`'s
 * test selection diffs the PR's commits against the new base rather than the
 * PR's old head.
 */
export function createRebaseStage(deps: {
  git: PrFixGit;
  prfix: PrFixConfig;
  runner: AgentRunner;
  promptTemplate: string;
}): Stage {
  const { git, prfix } = deps;

  return {
    name: REBASE_STAGE,
    canRun: () => true,
    async execute(state, ctx) {
      const worktree = state.outputs.worktree as (WorktreeContext & { targetSha: string }) | undefined;
      const input = state.outputs.prFixInput as PrFixInput | undefined;
      if (!worktree || !input) {
        throw new Error(`${REBASE_STAGE} requires state.outputs.worktree and .prFixInput`);
      }
      const { path, targetSha } = worktree;

      const preRebaseSha = await git.headSha(path);
      const conflicts: ConflictResolution[] = [];
      let newHeadSha: string;

      try {
        // Inside the guard: startRebase can throw with a rebase in progress
        // (git stopped without conflicted files), and that must be aborted too.
        let step: RebaseStep = await git.startRebase(path, targetSha);
        while (step.kind === 'conflict') {
          if (ctx.signal.aborted) throw abortError();
          const current: Extract<RebaseStep, { kind: 'conflict' }> = step;

          if (conflicts.length + 1 > prfix.maxConflictCommits) {
            throw new ConflictCapError(
              `more than ${prfix.maxConflictCommits} conflicting commits (PRFIX_MAX_CONFLICT_COMMITS); ` +
                `stopped at ${current.commit.slice(0, 7)} "${current.subject}"`,
              current.files,
            );
          }
          if (current.files.length > prfix.maxConflictFiles) {
            throw new ConflictCapError(
              `commit ${current.commit.slice(0, 7)} "${current.subject}" conflicts in ${current.files.length} files, ` +
                `more than ${prfix.maxConflictFiles} (PRFIX_MAX_CONFLICT_FILES)`,
              current.files,
            );
          }
          assertWithinCostCap(state, prfix.app.maxCostUsdPerWi, REBASE_STAGE);

          ctx.reportProgress?.(`conflict ${conflicts.length + 1} · ${current.commit.slice(0, 7)}`);
          ctx.logger.info(
            `${REBASE_STAGE}: resolving ${current.files.length} file(s) in ${current.commit.slice(0, 7)} "${current.subject}"`,
          );
          const resolved = await resolveConflict({
            runner: deps.runner,
            config: prfix.app,
            promptTemplate: deps.promptTemplate,
            maxTurns: prfix.resolverMaxTurns,
            worktreePath: path,
            step: current,
            targetSha,
            prTitle: input.pr.title,
            state,
            signal: ctx.signal,
          });

          const remaining = await git.filesWithMarkers(path, current.files);
          if (remaining.length > 0) throw new UnresolvedConflictError(current.commit, remaining);

          conflicts.push({
            commit: current.commit,
            subject: current.subject,
            files: current.files,
            summary: resolved.summary,
            resolutions: resolved.files,
          });
          step = await git.continueRebase(path, current.files);
        }
        newHeadSha = step.head;
      } catch (err) {
        try {
          await git.abortRebase(path);
        } catch (abortErr) {
          const msg = abortErr instanceof Error ? abortErr.message : String(abortErr);
          ctx.logger.warn(`${REBASE_STAGE}: git rebase --abort failed after an error: ${msg}`);
        }
        throw err;
      }

      const commitsReplayed = await git.countCommits(path, targetSha);
      const rebase: RebaseOutput = {
        preRebaseSha,
        targetSha,
        newHeadSha,
        commitsReplayed,
        conflicts,
      };
      state.outputs.rebase = rebase;
      state.outputs.worktree = { ...worktree, baseSha: targetSha };
      return state;
    },
  };
}

function inputOf(state: { outputs: Record<string, unknown> }): PrFixInput {
  const input = state.outputs.prFixInput as PrFixInput | undefined;
  if (!input) throw new Error('fix-pr stages require state.outputs.prFixInput');
  return input;
}

/** Reads the PR, refuses one that is not an active, branch-to-branch PR. */
export function createPrIntakeStage(deps: { ado: AdoClient }): Stage {
  return {
    name: 'pr-intake',
    costFree: true,
    canRun: () => true,
    async execute(state, ctx) {
      const input = inputOf(state);
      const pr = await deps.ado.getPullRequest(input.repository, input.pullRequestId, { signal: ctx.signal });
      if (pr.status !== 'active') throw new Error(`PR ${input.pullRequestId} is ${pr.status}, not active`);
      if (!pr.sourceRefName || !pr.targetRefName) {
        throw new Error(`PR ${input.pullRequestId} has no source/target branch`);
      }
      state.outputs.prFixInput = { ...input, pr } satisfies PrFixInput;
      // build-and-test requires a wiContext; it reads only id and title.
      state.outputs.wiContext = {
        id: input.pullRequestId,
        title: pr.title,
        workItemType: 'Pull Request',
        state: pr.status,
        description: '',
        reproSteps: '',
        acceptanceCriteria: '',
        images: [],
        comments: [],
      } satisfies WorkItemContext;
      return state;
    },
  };
}

export function createPrWorktreeStage(deps: { git: PrFixGit }): Stage {
  return {
    name: 'pr-worktree',
    costFree: true,
    canRun: () => true,
    async execute(state) {
      const { pullRequestId, pr } = inputOf(state);
      const wt = await deps.git.createWorktree({
        pullRequestId,
        sourceRefName: pr.sourceRefName,
        targetRefName: pr.targetRefName,
        headCommit: pr.headCommit,
      });
      state.outputs.worktree = wt;
      if (await deps.git.isUpToDate(wt.path, wt.targetSha)) {
        throw new PrUpToDateError(`PR ${pullRequestId} already contains ${pr.targetRefName.replace(/^refs\/heads\//, '')}`);
      }
      return state;
    },
  };
}

/** Pushes the rebased head, leased on the head we rebased (a moved remote fails the push). */
export function createPushRebasedStage(deps: { git: PrFixGit }): Stage {
  return {
    name: 'push-rebased',
    costFree: true,
    canRun: () => true,
    async execute(state, ctx) {
      const { pr } = inputOf(state);
      const wt = state.outputs.worktree as WorktreeContext | undefined;
      const rebase = state.outputs.rebase as RebaseOutput | undefined;
      if (!wt || !rebase) throw new Error('push-rebased requires state.outputs.worktree and .rebase');
      state.outputs.pushedCommit = await deps.git.headSha(wt.path);
      if (ctx.config.dryRun) return state;
      await deps.git.push({ path: wt.path, sourceRefName: pr.sourceRefName, expectedRemoteSha: rebase.preRebaseSha });
      return state;
    },
  };
}

export function createPrCommentStage(deps: { ado: AdoClient }): Stage {
  return {
    name: 'pr-comment',
    costFree: true,
    canRun: () => true,
    async execute(state, ctx) {
      if (ctx.config.dryRun) return state;
      const input = inputOf(state);
      const rebase = state.outputs.rebase as RebaseOutput | undefined;
      if (!rebase) throw new Error('pr-comment requires state.outputs.rebase');
      const content = renderSuccessComment({
        pr: input.pr,
        rebase,
        verification: state.outputs.verification as VerificationOutput | undefined,
        environment: state.outputs.environment as EnvironmentOutput | undefined,
        skippedVerification: ctx.config.skipBuildTest,
      });
      await deps.ado.createPullRequestThread(
        { repositoryName: input.repository, pullRequestId: input.pullRequestId, content },
        { signal: ctx.signal },
      );
      return state;
    },
  };
}
