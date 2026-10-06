import type { Stage } from '../stage.ts';
import {
  CostExceededError,
  type AppConfig,
  type FinalReviewOutput,
  type FindingAddressed,
  type ReviewerOutput,
  type WorktreeContext,
} from '../../types/index.ts';
import { assertWithinCostCap } from '../../utils/cost-tracker.ts';
import { defaultGetCurrentHeadSha, defaultResetWorktree, isAbortError } from './_stage-helpers.ts';

/** Insertions + deletions of `git diff --shortstat <base>..HEAD`. 0 when git fails. */
export async function defaultGetDiffLines(worktreePath: string, baseSha: string): Promise<number> {
  try {
    const proc = Bun.spawn(['git', 'diff', '--shortstat', `${baseSha}..HEAD`], {
      cwd: worktreePath,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const out = await new Response(proc.stdout as ReadableStream).text();
    if ((await proc.exited) !== 0) return 0;
    return parseShortstatLines(out);
  } catch {
    return 0;
  }
}

/** `" 3 files changed, 120 insertions(+), 4 deletions(-)"` → 124. */
export function parseShortstatLines(shortstat: string): number {
  const ins = /(\d+) insertions?\(\+\)/.exec(shortstat);
  const del = /(\d+) deletions?\(-\)/.exec(shortstat);
  return Number(ins?.[1] ?? 0) + Number(del?.[1] ?? 0);
}

export interface FinalReviewStageDeps {
  config: AppConfig;
  /** The six-axis reviewer, built with `label: 'final-review'`. */
  reviewer: Stage;
  /** Fixes the blockers. Reads `outputs.reviewer`, so the stage hands it a synthetic one. */
  fixFindings: Stage;
  /** The final gate. Absent under SKIP_BUILD_TEST: then no fix is attempted. */
  buildAndTest?: Stage;
  getDiffLines?: (worktreePath: string, baseSha: string) => Promise<number>;
  getCurrentHeadSha?: (worktreePath: string) => Promise<string>;
  resetWorktree?: (worktreePath: string, sha: string) => Promise<void>;
}

function rethrowIfFatal(err: unknown): void {
  if (isAbortError(err) || err instanceof CostExceededError) throw err;
}

/**
 * One fresh review of the whole final diff, after the tests exist and the gate
 * is green, then at most one fix round on what it finds blocking or critical.
 *
 * Why it exists: on WI 82605 a replay referee — the same six axes and config —
 * found three blocking/critical bugs (a 409 path overwriting the stored
 * password, credential storage wiped across companies) in diffs the in-loop
 * reviewer had approved. The in-loop review reads the coder's diff before the
 * tests exist and is anchored on its own earlier rounds; this one reads the
 * finished change cold. It runs only above `finalReviewMinLines`, because the
 * small WIs replayed never produced anything above minor.
 *
 * It never costs the WI its PR. A fix that turns the gate red (or throws) is
 * reset to the last verified commit and the gate is re-run to put the
 * environment back in step with the branch; the findings then go to the PR
 * description for the human reviewer. Only an abort or the cost cap escapes.
 */
export function createFinalReviewStage(deps: FinalReviewStageDeps): Stage {
  const diffLinesOf = deps.getDiffLines ?? defaultGetDiffLines;
  const getHead = deps.getCurrentHeadSha ?? defaultGetCurrentHeadSha;
  const reset = deps.resetWorktree ?? defaultResetWorktree;

  return {
    name: 'final-review',
    canRun: () => true,
    async execute(state, ctx) {
      const { config } = deps;
      const worktree = state.outputs.worktree as WorktreeContext | undefined;
      if (!worktree) throw new Error('final-review requires state.outputs.worktree');

      const skip = (diffLines: number, skipReason: string): typeof state => {
        ctx.logger.info(`final-review: skipped — ${skipReason}`);
        state.outputs.finalReview = {
          ran: false,
          skipReason,
          diffLines,
          findings: [],
          fix: 'none',
        } satisfies FinalReviewOutput;
        return state;
      };

      if (config.finalReviewMinLines === undefined) return skip(0, 'disabled (FINAL_REVIEW=false)');
      const diffLines = await diffLinesOf(worktree.path, worktree.baseSha);
      if (diffLines < config.finalReviewMinLines) {
        return skip(diffLines, `diff is ${diffLines} lines, below FINAL_REVIEW_MIN_LINES=${config.finalReviewMinLines}`);
      }

      // The loop's review state is hidden from the final review: it must read
      // the change cold, not be told what earlier rounds found and what the
      // fixer said it did about them.
      const loopReview = state.outputs.reviewer;
      const loopAddressed = state.outputs.findingsAddressed;
      const restoreLoopState = (): void => {
        state.outputs.reviewer = loopReview;
        state.outputs.findingsAddressed = loopAddressed;
      };

      assertWithinCostCap(state, config.maxCostUsdPerWi, 'final-review');
      let review: ReviewerOutput;
      try {
        delete state.outputs.reviewer;
        delete state.outputs.findingsAddressed;
        await deps.reviewer.execute(state, ctx);
        review = state.outputs.reviewer as ReviewerOutput;
      } catch (err) {
        restoreLoopState();
        rethrowIfFatal(err);
        return skip(diffLines, `review failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      restoreLoopState();

      const output: FinalReviewOutput = { ran: true, diffLines, findings: review.findings, fix: 'none' };
      state.outputs.finalReview = output;
      const blockers = review.findings.filter((f) => f.severity === 'blocking' || f.severity === 'critical');
      if (blockers.length === 0) return state;

      if (!deps.buildAndTest) {
        ctx.logger.warn(
          `final-review: ${blockers.length} blocking/critical finding(s), not fixed — no verification gate to check a fix against`,
        );
        output.fix = 'skipped';
        return state;
      }

      assertWithinCostCap(state, config.maxCostUsdPerWi, 'final-review');
      const verifiedSha = await getHead(worktree.path);
      const verifiedCoder = state.outputs.coder;
      const verifiedVerification = state.outputs.verification;
      ctx.logger.info(`final-review: ${blockers.length} blocking/critical finding(s) — one fix round`);
      try {
        state.outputs.reviewer = {
          approved: false,
          findings: blockers,
          // fix-findings titles its prompt "round attempts+1 of maxRevisions";
          // this makes it read as the last round, which it is.
          attempts: Math.max(0, config.maxRevisions - 1),
          byAxis: {},
        } satisfies ReviewerOutput;
        await deps.fixFindings.execute(state, ctx);
        output.findingsAddressed = (state.outputs.findingsAddressed as FindingAddressed[] | undefined) ?? [];
        restoreLoopState();
        if (ctx.abortFlag.aborted) return state;
        await deps.buildAndTest.execute(state, ctx);
        output.fix = 'verified';
        ctx.logger.info('final-review: fix verified');
        return state;
      } catch (err) {
        restoreLoopState();
        rethrowIfFatal(err);
        const message = err instanceof Error ? err.message : String(err);
        ctx.logger.warn(`final-review: fix reverted to ${verifiedSha.slice(0, 9)} — ${message}`);
        await reset(worktree.path, verifiedSha);
        state.outputs.coder = verifiedCoder;
        state.outputs.verification = verifiedVerification;
        output.fix = 'reverted';
        output.fixError = message;
        // The environment now runs the fix's build. Put it back in step with
        // the branch the PR will point at; the commit was green before, so this
        // is a redeploy, not a new judgement — and a failure here is real.
        await deps.buildAndTest.execute(state, ctx);
        return state;
      }
    },
  };
}
