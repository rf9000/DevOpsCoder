import type { Stage } from '../stage.ts';
import type { ReviewerOutput, WorktreeContext } from '../../types/index.ts';
import { CostExceededError } from '../../types/index.ts';
import type { AdoClient } from '../../sdk/azure-devops-client.ts';
import type { WorkItemContext } from '../../services/wi-context.ts';
import type { SuggestionGit } from '../../suggestions/suggestion-git.ts';
import {
  buildStackedPrDescription,
  commitMessage,
  mutantBranchName,
  stackedPrTitle,
  suggestionToFinding,
  type SuggestionInput,
} from '../../suggestions/input.ts';
import { assertWithinCostCap } from '../../utils/cost-tracker.ts';

/** No fix produced a change: nothing to push. Reported as ok:false, not a crash. */
export class NothingAppliedError extends Error {
  override readonly name = 'NothingAppliedError';
  constructor() {
    super('nothing-applied');
  }
}

function inputOf(state: { outputs: Record<string, unknown> }): SuggestionInput {
  const input = state.outputs.suggestionInput as SuggestionInput | undefined;
  if (!input) throw new Error('suggestion stages require state.outputs.suggestionInput');
  return input;
}

function worktreeOf(state: { outputs: Record<string, unknown> }): WorktreeContext {
  const wt = state.outputs.worktree as WorktreeContext | undefined;
  if (!wt) throw new Error('suggestion stages require state.outputs.worktree');
  return wt;
}

export function createSuggestionWorktreeStage(deps: { git: SuggestionGit }): Stage {
  return {
    name: 'suggestion-worktree',
    canRun: () => true,
    async execute(state) {
      const input = inputOf(state);
      const args = { pullRequestId: input.pullRequestId, headCommit: input.headCommit, sourceRefName: input.sourceRefName };
      state.outputs.worktree =
        input.mode === 'pr' ? await deps.git.createPrWorktree(args) : await deps.git.createPushWorktree(args);
      // fix-findings reads only id and title; the rest exists to satisfy the type.
      state.outputs.wiContext = {
        id: input.pullRequestId,
        title: stackedPrTitle(input),
        workItemType: 'Pull Request',
        state: 'active',
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

/**
 * One fix-findings run per fix id, then one commit per fix: the contract asks
 * for a commit per id with a fixed message, and the agent's own commits carry
 * neither. A fix the agent fails on or leaves unchanged is skipped and the
 * worktree reset, so one bad fix does not cost the others.
 */
export function createApplyFixesStage(deps: { git: SuggestionGit; fixFindings: Stage }): Stage {
  return {
    name: 'apply-fixes',
    canRun: () => true,
    async execute(state, ctx) {
      const input = inputOf(state);
      const wt = worktreeOf(state);
      const applied: string[] = [];
      const skipped: string[] = [];
      for (const s of input.suggestions) {
        const baseline = await deps.git.headSha(wt.path);
        state.outputs.reviewer = { approved: false, findings: [suggestionToFinding(s)], attempts: 0 } satisfies ReviewerOutput;
        let sha: string | null = null;
        try {
          await deps.fixFindings.execute(state, ctx);
          sha = await deps.git.commitFix({ path: wt.path, baselineSha: baseline, message: commitMessage(input, s) });
        } catch (err) {
          if (ctx.signal.aborted || err instanceof CostExceededError) throw err;
          ctx.logger.warn(`apply-suggestions: ${s.id} failed, skipping :: ${err instanceof Error ? err.message : String(err)}`);
          await deps.git.resetHard(wt.path, baseline);
        }
        (sha ? applied : skipped).push(s.id);
        assertWithinCostCap(state, ctx.config.maxCostUsdPerWi, 'apply-fixes');
      }
      delete state.outputs.reviewer;
      state.outputs.appliedIds = applied;
      state.outputs.skippedIds = skipped;
      return state;
    },
  };
}

export function createPushSuggestionsStage(deps: { git: SuggestionGit }): Stage {
  return {
    name: 'push-suggestions',
    canRun: () => true,
    async execute(state, ctx) {
      const input = inputOf(state);
      const wt = worktreeOf(state);
      if (((state.outputs.appliedIds as string[] | undefined) ?? []).length === 0) throw new NothingAppliedError();
      state.outputs.pushedCommit = await deps.git.headSha(wt.path);
      if (ctx.config.dryRun) return state;
      await deps.git.push({
        path: wt.path,
        mode: input.mode,
        remoteBranch: input.mode === 'pr' ? mutantBranchName(input.pullRequestId, input.headCommit) : input.sourceRefName.replace(/^refs\/heads\//, ''),
        headCommit: input.headCommit,
      });
      return state;
    },
  };
}

export function createStackedPrStage(deps: { ado: AdoClient }): Stage {
  return {
    name: 'create-stacked-pr',
    canRun: () => true,
    async execute(state, ctx) {
      if (ctx.config.dryRun) return state;
      const input = inputOf(state);
      const applied = (state.outputs.appliedIds as string[] | undefined) ?? [];
      const pr = await deps.ado.createPullRequest(
        {
          repositoryName: input.repository,
          sourceRefName: `refs/heads/${mutantBranchName(input.pullRequestId, input.headCommit)}`,
          targetRefName: input.sourceRefName,
          title: stackedPrTitle(input),
          description: buildStackedPrDescription(input, applied),
          isDraft: false,
          reviewers: [{ id: input.reviewerId }],
        },
        { signal: ctx.signal },
      );
      state.outputs.suggestionPr = { id: pr.id, url: pr.url };
      return state;
    },
  };
}
