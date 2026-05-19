import type { PipelineCostInfo, PipelineState } from '../types/index.ts';

export interface CostTracker {
  /** Add `usd` to the accumulator for `stage` and the running total. */
  add(stage: string, usd: number): void;
  /** Cumulative cost across all stages (in USD). */
  total(): number;
  /** Defensive shallow copy of the per-stage breakdown. */
  perStage(): Record<string, number>;
}

/**
 * Idempotent cost accumulator. On first call for a pipeline, initializes
 * `state.outputs.cost = { total: 0, perStage: {} }`. On subsequent calls
 * (e.g. after a resume), reads the existing PipelineCostInfo and continues
 * to add to it. Always writes through to `state.outputs.cost` so the
 * orchestrator's cap check (task-05) reads the live total.
 *
 * Pure: no I/O, no logging, no thrown errors. Callers may pass `usd = 0`
 * (no-op on totals but stage key still touched).
 */
export function createCostTracker(state: PipelineState): CostTracker {
  // Initialize if missing; otherwise reuse the existing PipelineCostInfo.
  let cost = state.outputs.cost as PipelineCostInfo | undefined;
  if (!cost) {
    cost = { total: 0, perStage: {} };
    state.outputs.cost = cost;
  }
  // Type narrowing inside the closure.
  const c = cost;

  return {
    add(stage, usd) {
      c.total += usd;
      c.perStage[stage] = (c.perStage[stage] ?? 0) + usd;
    },
    total() {
      return c.total;
    },
    perStage() {
      return { ...c.perStage };
    },
  };
}
