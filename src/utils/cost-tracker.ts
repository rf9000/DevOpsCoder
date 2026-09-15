import type { AgentUsage, PipelineCostInfo, PipelineState, StepSpend } from '../types/index.ts';
import { CostExceededError } from '../types/index.ts';

export interface CostTracker {
  /**
   * Fold one LLM call into `step`'s accumulator and the running total.
   * `usage` is optional so a call site with no usage data still records the
   * spend and the call count rather than dropping the step entirely.
   */
  add(step: string, usd: number, usage?: AgentUsage): void;
  /** Cumulative cost across all steps (in USD). */
  total(): number;
  /** Deep-enough copy of the per-step breakdown — entries are safe to mutate. */
  perStage(): Record<string, StepSpend>;
}

function emptySpend(): StepSpend {
  return {
    usd: 0,
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    turns: 0,
    models: [],
  };
}

function cloneSpend(s: StepSpend): StepSpend {
  return { ...s, models: [...s.models] };
}

/**
 * Widen a persisted `perStage` map to the current shape.
 *
 * State files written before per-step detail existed hold a bare USD number per
 * step. Resuming such a WI must neither crash on `entry.usd` nor discard the
 * spend already banked — a resumed run that forgets the first cycle's cost is
 * exactly the case that makes a total unattributable. Unrecognised entries are
 * dropped rather than guessed at.
 */
export function normalizePerStage(raw: unknown): Record<string, StepSpend> {
  const out: Record<string, StepSpend> = {};
  if (typeof raw !== 'object' || raw === null) return out;

  for (const [step, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof entry === 'number') {
      out[step] = { ...emptySpend(), usd: entry, calls: 1 };
      continue;
    }
    if (typeof entry === 'object' && entry !== null) {
      const e = entry as Partial<StepSpend>;
      out[step] = {
        usd: typeof e.usd === 'number' ? e.usd : 0,
        calls: typeof e.calls === 'number' ? e.calls : 0,
        inputTokens: typeof e.inputTokens === 'number' ? e.inputTokens : 0,
        outputTokens: typeof e.outputTokens === 'number' ? e.outputTokens : 0,
        // Absent from every state file written before cache accounting existed.
        // Zero is the honest widening: the tokens were real but unrecorded, and
        // inventing a figure would be worse than showing none.
        cacheCreationInputTokens:
          typeof e.cacheCreationInputTokens === 'number' ? e.cacheCreationInputTokens : 0,
        cacheReadInputTokens:
          typeof e.cacheReadInputTokens === 'number' ? e.cacheReadInputTokens : 0,
        turns: typeof e.turns === 'number' ? e.turns : 0,
        models: Array.isArray(e.models) ? [...e.models] : [],
      };
    }
  }
  return out;
}

/**
 * Idempotent cost accumulator. On first call for a pipeline, initializes
 * `state.outputs.cost = { total: 0, perStage: {} }`. On subsequent calls
 * (e.g. after a resume), reads the existing PipelineCostInfo and continues
 * to add to it. Always writes through to `state.outputs.cost` so the
 * orchestrator's cap check reads the live total.
 *
 * Pure: no I/O, no logging, no thrown errors. Callers may pass `usd = 0`
 * (no-op on totals but the step key is still touched, and the call counted).
 */
export function createCostTracker(state: PipelineState): CostTracker {
  // Initialize if missing; otherwise reuse the existing PipelineCostInfo,
  // normalizing a legacy bare-number breakdown in place so every later reader
  // — including ones that go straight to state.outputs.cost — sees one shape.
  let cost = state.outputs.cost as PipelineCostInfo | undefined;
  if (!cost) {
    cost = { total: 0, perStage: {} };
    state.outputs.cost = cost;
  } else {
    cost.perStage = normalizePerStage(cost.perStage);
  }
  const c = cost;

  return {
    add(step, usd, usage) {
      c.total += usd;
      const spend = c.perStage[step] ?? emptySpend();
      spend.usd += usd;
      spend.calls += 1;
      if (usage) {
        spend.inputTokens += usage.inputTokens;
        spend.outputTokens += usage.outputTokens;
        spend.cacheCreationInputTokens += usage.cacheCreationInputTokens;
        spend.cacheReadInputTokens += usage.cacheReadInputTokens;
        spend.turns += usage.turns;
        if (usage.model && !spend.models.includes(usage.model)) {
          spend.models.push(usage.model);
        }
      }
      c.perStage[step] = spend;
    },
    total() {
      return c.total;
    },
    perStage() {
      const out: Record<string, StepSpend> = {};
      for (const [step, spend] of Object.entries(c.perStage)) {
        out[step] = cloneSpend(spend);
      }
      return out;
    },
  };
}

/**
 * Throw `CostExceededError` if the WI has already spent more than the cap.
 *
 * The orchestrator gates on cost between top-level stages, which is no help
 * inside one: `revision-loop` alone can contain `MAX_REVISIONS × (1 plan +
 * coder retries + 6 reviewer axes × retries)` LLM calls, and nothing looked at
 * the running total until it handed control back. WI 82205 left that gate at
 * $0 and returned at $29.06 against a $20 cap — a 45% overshoot on a limit
 * documented as a hard kill.
 *
 * Long-running stages therefore call this between their own iterations. The
 * throw travels the same path as any other stage error, so the orchestrator
 * records it as a terminal error against the stage that was running and the
 * processor's `/cost cap/i` routing renders the usual comment.
 */
export function assertWithinCostCap(
  state: PipelineState,
  capUsd: number,
  stageName: string,
): void {
  const total = (state.outputs.cost as PipelineCostInfo | undefined)?.total ?? 0;
  if (total > capUsd) throw new CostExceededError(total, capUsd, stageName);
}
