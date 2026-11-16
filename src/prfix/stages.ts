import type { AgentRunner } from '../pipeline/agent-stage.ts';
import type { Stage } from '../pipeline/stage.ts';
import type { WorktreeContext } from '../types/index.ts';
import { assertWithinCostCap } from '../utils/cost-tracker.ts';
import type { PrFixConfig } from './config.ts';
import type { PrFixGit, RebaseStep } from './prfix-git.ts';
import { resolveConflict } from './resolver.ts';
import {
  ConflictCapError,
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
          await resolveConflict({
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

          conflicts.push({ commit: current.commit, subject: current.subject, files: current.files });
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
