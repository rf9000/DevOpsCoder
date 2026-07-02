import type { PipelineState } from '../types/index.ts';

export interface ToolUsageTracker {
  /** Merge `usage`'s counts into the accumulator for `stage`'s WI-wide total. */
  add(stage: string, usage: Record<string, number>): void;
  /** Defensive shallow copy of the accumulated tool-usage map. */
  total(): Record<string, number>;
}

/**
 * Idempotent tool-usage accumulator. On first call for a pipeline, initializes
 * `state.outputs.toolUsage = {}`. On subsequent calls (e.g. after a resume),
 * reads the existing map and continues to add to it. Flat map only — no
 * per-stage breakdown, unlike PipelineCostInfo.perStage (nothing renders a
 * per-stage tool breakdown, so there is nothing to keep it for).
 *
 * Pure: no I/O, no logging, no thrown errors.
 */
export function createToolUsageTracker(state: PipelineState): ToolUsageTracker {
  let usage = state.outputs.toolUsage as Record<string, number> | undefined;
  if (!usage) {
    usage = {};
    state.outputs.toolUsage = usage;
  }
  const u = usage;

  return {
    add(_stage, counts) {
      for (const [tool, count] of Object.entries(counts)) {
        u[tool] = (u[tool] ?? 0) + count;
      }
    },
    total() {
      return { ...u };
    },
  };
}

/** Sum tool-usage maps together (e.g. the reviewer's 6 parallel axis results). */
export function mergeToolUsage(maps: Record<string, number>[]): Record<string, number> {
  const merged: Record<string, number> = {};
  for (const map of maps) {
    for (const [tool, count] of Object.entries(map)) {
      merged[tool] = (merged[tool] ?? 0) + count;
    }
  }
  return merged;
}

/**
 * Format a tool-usage map for a log-line suffix. Sorted by count descending,
 * ties broken alphabetically. Returns '' (not ', tools: ') when empty so
 * callers can string-concat unconditionally.
 */
export function formatToolUsage(usage: Record<string, number>): string {
  const entries = Object.entries(usage);
  if (entries.length === 0) return '';
  entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return `, tools: ${entries.map(([tool, count]) => `${tool}×${count}`).join(', ')}`;
}
