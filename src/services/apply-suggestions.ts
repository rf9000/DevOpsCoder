import { loadConfig } from '../config/index.ts';
import { createInitialState, runPipeline } from '../pipeline/orchestrator.ts';
import type { Stage } from '../pipeline/stage.ts';
import { FIX_BUDGET_FALLBACK_MS, NothingAppliedError } from '../pipeline/stages/suggestions.ts';
import type { PipelineStateStore } from '../state/state-store.ts';
import { mutantBranchName, sha7, type SuggestionInput } from '../suggestions/input.ts';
import { HeadMovedError, type SuggestionGit } from '../suggestions/suggestion-git.ts';
import type { AppConfig, PipelineCostInfo, WorktreeContext } from '../types/index.ts';
import { redactPat } from '../utils/git-auth.ts';
import type { Logger } from '../utils/logger.ts';

/** The JSON mutant-fixer reads from the last stdout line. */
export interface SuggestionOutcome {
  ok: boolean;
  branch: string | null;
  pushedCommit: string | null;
  pullRequestId: number | null;
  appliedIds: string[];
  skippedIds: string[];
  error: string | null;
  /** Agent spend of this run in USD (the pipeline's cost total); 0 when nothing ran. */
  costUsd: number;
}

/** One fix costs a single fix-findings call; 20 USD covers a large run. */
export const DEFAULT_SUGGESTION_COST_CAP_USD = 20;

export function failureOutcome(error: string, partial: Partial<SuggestionOutcome> = {}): SuggestionOutcome {
  return { ok: false, branch: null, pushedCommit: null, pullRequestId: null, appliedIds: [], skippedIds: [], costUsd: 0, ...partial, error };
}

/**
 * The full pipeline's config with the watcher-only parts filled in: the
 * repository comes from the input, build-and-test is off (al-mutation already
 * verified the fixes on BC), and the cost cap has a default.
 */
export function loadSuggestionConfig(env: Record<string, string | undefined>, input: SuggestionInput): AppConfig {
  const config = loadConfig({
    ...env,
    ADO_REPOSITORY_NAME: input.repository,
    SKIP_BUILD_TEST: 'true',
    MAX_COST_USD_PER_WI: env.MAX_COST_USD_PER_WI?.trim() || String(DEFAULT_SUGGESTION_COST_CAP_USD),
  });
  const missing = [
    ['BOT_GIT_NAME', config.botGitName],
    ['BOT_GIT_EMAIL', config.botGitEmail],
  ].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length > 0) {
    throw new Error(`Invalid configuration:\n${missing.map((k) => `  - ${k}: required for apply-suggestions`).join('\n')}`);
  }
  const fixBudget = config.stageTimeoutMs['fix-findings'] ?? FIX_BUDGET_FALLBACK_MS;
  config.stageTimeoutMs = {
    ...config.stageTimeoutMs,
    'suggestion-worktree': 300_000,
    // Each fix is capped at fixBudget inside the stage; the slack covers git.
    'apply-fixes': input.suggestions.length * fixBudget + 300_000,
    'push-suggestions': 300_000,
    'create-stacked-pr': 120_000,
  };
  return config;
}

export interface ApplySuggestionsDeps {
  config: AppConfig;
  logger: Logger;
  input: SuggestionInput;
  git: SuggestionGit;
  stages: Stage[];
  store: PipelineStateStore;
  now?: () => Date;
  /** Set by the CLI's SIGTERM/SIGINT handler: stop, then remove the worktree. */
  abortFlag?: { aborted: boolean };
}

export async function applySuggestions(deps: ApplySuggestionsDeps): Promise<SuggestionOutcome> {
  const { config, input } = deps;
  const now = deps.now ?? (() => new Date());
  const state = createInitialState(input.pullRequestId, `${input.mode}-${sha7(input.headCommit)}`, now());
  state.outputs.suggestionInput = input;
  const ids = () => ({
    appliedIds: (state.outputs.appliedIds as string[] | undefined) ?? [],
    skippedIds: (state.outputs.skippedIds as string[] | undefined) ?? [],
    costUsd: (state.outputs.cost as PipelineCostInfo | undefined)?.total ?? 0,
  });
  try {
    await runPipeline({
      stages: deps.stages,
      state,
      context: { config, logger: deps.logger, abortFlag: deps.abortFlag ?? { aborted: false }, signal: new AbortController().signal, now },
      store: deps.store,
    });
    if (state.cancelled) return failureOutcome('cancelled', ids());
    const pr = state.outputs.suggestionPr as { id: number } | undefined;
    return {
      ok: true,
      branch: input.mode === 'pr' ? `refs/heads/${mutantBranchName(input.pullRequestId, input.headCommit)}` : input.sourceRefName,
      pushedCommit: config.dryRun ? null : ((state.outputs.pushedCommit as string | undefined) ?? null),
      pullRequestId: config.dryRun ? null : (pr?.id ?? null),
      ...ids(),
      error: null,
    };
  } catch (err) {
    if (err instanceof HeadMovedError) return failureOutcome('head-moved', { costUsd: ids().costUsd });
    if (err instanceof NothingAppliedError) return failureOutcome('nothing-applied', ids());
    const stage = state.terminalError?.stage ?? 'apply-suggestions';
    const message = redactPat(err instanceof Error ? err.message : String(err), config.pat);
    return failureOutcome(`${stage}: ${message}`, ids());
  } finally {
    const wt = state.outputs.worktree as WorktreeContext | undefined;
    if (wt && !config.dryRun) {
      try {
        await deps.git.removeWorktree(wt);
      } catch (err) {
        deps.logger.warn(`apply-suggestions: worktree removal failed :: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}
