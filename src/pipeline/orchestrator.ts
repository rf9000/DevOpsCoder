import type { Stage, PipelineContext } from './stage.ts';
import { PipelinePauseError, PipelineRejectError } from './stage.ts';
import type { PipelineState, StageHistoryEntry, PipelineCostInfo } from '../types/index.ts';
import { CostExceededError, StageTimeoutError } from '../types/index.ts';
import type { PipelineStateStore } from '../state/state-store.ts';

/**
 * Fallback per-stage timeout for stages not in config.stageTimeoutMs (e.g.
 * revision-loop). Exported so the processor's timeout-comment renderer reports
 * the same fallback the orchestrator actually enforced.
 */
export const DEFAULT_STAGE_TIMEOUT_MS = 120_000;

export interface RunPipelineOptions {
  stages: Stage[];
  state: PipelineState;
  context: PipelineContext;
  store: PipelineStateStore;
}

export class StageNotFoundError extends Error {
  override readonly name = 'StageNotFoundError';
}

export function createInitialState(
  workItemId: number,
  slug: string,
  now: Date = new Date(),
): PipelineState {
  const ts = now.toISOString();
  return {
    workItemId,
    slug,
    startedAt: ts,
    updatedAt: ts,
    currentStage: null,
    history: [],
    outputs: {},
  };
}

function findStageIndex(stages: Stage[], name: string | null): number {
  if (name == null) return -1;
  return stages.findIndex((s) => s.name === name);
}

function appendHistory(state: PipelineState, entry: StageHistoryEntry): void {
  state.history.push(entry);
}

/**
 * Record a stage failure on state, append a 'failure' history entry, save, and
 * throw the error. Used by the cost-cap pre-check, the timeout branch, and the
 * fall-through terminal-error path — keeps the three error-routing sites in sync.
 */
function recordTerminalAndThrow(
  state: PipelineState,
  store: PipelineStateStore,
  stageName: string,
  err: Error,
  startedAt: string,
  endedAt: string,
): never {
  state.terminalError = { stage: stageName, message: err.message, at: endedAt };
  appendHistory(state, {
    stage: stageName,
    startedAt,
    endedAt,
    outcome: 'failure',
    message: err.message,
  });
  store.save(state);
  throw err;
}

export async function runPipeline(opts: RunPipelineOptions): Promise<PipelineState> {
  const { stages, context, store } = opts;
  let state = opts.state;

  if (state.currentStage == null) {
    state.currentStage = stages[0]?.name ?? null;
  }

  while (state.currentStage != null) {
    // Pre-stage gate 1: external abort BEFORE the stage starts.
    if (context.abortFlag.aborted) {
      state.cancelled = true;
      store.save(state);
      return state;
    }

    // Pre-stage gate 2: cost cap accumulated from prior stages.
    const cost = state.outputs.cost as PipelineCostInfo | undefined;
    const totalCost = cost?.total ?? 0;
    if (totalCost > context.config.maxCostUsdPerWi) {
      const stageName = state.currentStage;
      const costErr = new CostExceededError(totalCost, context.config.maxCostUsdPerWi, stageName);
      const costNow = context.now().toISOString();
      recordTerminalAndThrow(state, store, stageName, costErr, costNow, costNow);
    }

    const idx = findStageIndex(stages, state.currentStage);
    if (idx < 0) {
      throw new StageNotFoundError(
        `Stage "${state.currentStage}" not found in pipeline`,
      );
    }
    const stage = stages[idx]!;
    const startedAt = context.now().toISOString();

    if (!stage.canRun(state)) {
      appendHistory(state, {
        stage: stage.name,
        startedAt,
        endedAt: context.now().toISOString(),
        outcome: 'skip',
      });
      state.currentStage = stages[idx + 1]?.name ?? null;
      store.save(state);
      continue;
    }

    // Per-stage AbortController: external abort + per-stage timeout.
    const ctrl = new AbortController();
    const timeoutMs = context.config.stageTimeoutMs[stage.name] ?? DEFAULT_STAGE_TIMEOUT_MS;
    // Poll abortFlag at 100ms. Implementer may swap for direct event coupling
    // if AbortFlag is later promoted to wrap an AbortController.
    const abortFlagWatcher = setInterval(() => {
      if (context.abortFlag.aborted && !ctrl.signal.aborted) {
        ctrl.abort('external');
      }
    }, 100);
    const timer = setTimeout(() => {
      if (!ctrl.signal.aborted) ctrl.abort('timeout');
    }, timeoutMs);

    const stageCtx: PipelineContext = { ...context, signal: ctrl.signal };

    try {
      state = await stage.execute(state, stageCtx);
      const endedAt = context.now().toISOString();
      if (state.currentStage === stage.name) {
        state.currentStage = stages[idx + 1]?.name ?? null;
      }
      appendHistory(state, {
        stage: stage.name,
        startedAt,
        endedAt,
        outcome: 'success',
      });
      store.save(state);
    } catch (err) {
      const endedAt = context.now().toISOString();

      // Plan 6: distinguish timeout vs external abort BEFORE existing branches.
      if (ctrl.signal.aborted) {
        const reason = ctrl.signal.reason as unknown;
        if (reason === 'timeout') {
          const timeoutErr = new StageTimeoutError(stage.name, timeoutMs);
          recordTerminalAndThrow(state, store, stage.name, timeoutErr, startedAt, endedAt);
        }
        if (reason === 'external') {
          // SIGINT / external shutdown: mark cancelled, return cleanly (no throw).
          state.cancelled = true;
          store.save(state);
          return state;
        }
        // Other abort reasons fall through to existing branches.
      }

      if (err instanceof PipelinePauseError) {
        appendHistory(state, {
          stage: stage.name,
          startedAt,
          endedAt,
          outcome: 'pause',
          message: err.reason,
        });
        store.save(state);
        return state;
      }
      if (err instanceof PipelineRejectError) {
        state.rejection = {
          reasons: err.payload.reasons,
          summary: err.payload.summary,
          questions: err.payload.questions,
          stage: stage.name,
          at: endedAt,
        };
        appendHistory(state, {
          stage: stage.name,
          startedAt,
          endedAt,
          outcome: 'reject',
          message: err.payload.summary,
        });
        store.save(state);
        return state;
      }
      const errAsError = err instanceof Error ? err : new Error(String(err));
      recordTerminalAndThrow(state, store, stage.name, errAsError, startedAt, endedAt);
    } finally {
      clearTimeout(timer);
      clearInterval(abortFlagWatcher);
    }
  }

  if (
    state.currentStage == null &&
    !state.completedAt &&
    !state.terminalError &&
    !context.abortFlag.aborted
  ) {
    state.completedAt = context.now().toISOString();
    store.save(state);
  }
  return state;
}
