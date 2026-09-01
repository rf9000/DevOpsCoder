import type { AppConfig } from '../types/index.ts';

/**
 * One LLM-calling step of the pipeline. Not the same set as `Stage.name`: the
 * coder and test-author each split into a plan step and a write step, the
 * test-fixer runs nested inside `build-and-test`, and `pr-message` runs nested
 * inside `draft-pr-creator`. These strings are the keys of
 * `config.stepModel`, the cost-ledger keys, and the runner log labels.
 */
export type PipelineStep =
  | 'analyzer'
  | 'coder-plan'
  | 'coder'
  | 'reviewer'
  | 'test-author-plan'
  | 'test-author'
  | 'test-fixer'
  | 'pr-message';

/** Steps whose model, when configured, turns on a plan-then-write split. */
export type PlanStep = 'coder-plan' | 'test-author-plan';

/** Turn budget for a plan call. Read-only work, so far below the coder's 80. */
export const DEFAULT_PLAN_MAX_TURNS = 30;

/**
 * Which model a step runs on: its own override, else the global `CLAUDE_MODEL`.
 * Every LLM call site goes through this rather than reading `config.claudeModel`
 * directly, so a per-step override is impossible to forget at one call site.
 */
export function modelFor(config: AppConfig, step: PipelineStep): string {
  return config.stepModel?.[step] ?? config.claudeModel;
}

/**
 * The model for a plan step, or `undefined` when no plan model is configured.
 *
 * Undefined is the OFF switch: the plan-then-write split exists only when an
 * operator names a model for it (`CLAUDE_MODEL_CODER_PLAN`,
 * `CLAUDE_MODEL_TEST_AUTHOR_PLAN`, or `CLAUDE_MODEL_PLANNING` for both).
 * Deriving the gate from the model — rather than a separate boolean — keeps
 * "which model plans" and "is there a plan step" from disagreeing, and leaves
 * existing deployments on the single-call behaviour until they opt in.
 * Planning on the same model as the writing step is still a valid ask: name
 * that model explicitly.
 */
export function planModelFor(config: AppConfig, step: PlanStep): string | undefined {
  return config.stepModel?.[step];
}

export function planMaxTurns(config: AppConfig): number {
  return config.planMaxTurns ?? DEFAULT_PLAN_MAX_TURNS;
}
