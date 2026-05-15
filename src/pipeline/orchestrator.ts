import type { Stage, PipelineContext } from './stage.ts';
import { PipelinePauseError, PipelineRejectError } from './stage.ts';
import type { PipelineState, StageHistoryEntry } from '../types/index.ts';
import type { PipelineStateStore } from '../state/state-store.ts';

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
    attempts: {},
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

export async function runPipeline(opts: RunPipelineOptions): Promise<PipelineState> {
  const { stages, context, store } = opts;
  let state = opts.state;

  if (state.currentStage == null) {
    state.currentStage = stages[0]?.name ?? null;
  }

  while (state.currentStage != null && !context.abortFlag.aborted) {
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

    try {
      state = await stage.execute(state, context);
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
      state.attempts[stage.name] = (state.attempts[stage.name] ?? 0) + 1;
      store.save(state);
    } catch (err) {
      const endedAt = context.now().toISOString();
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
      const message = err instanceof Error ? err.message : String(err);
      state.terminalError = { stage: stage.name, message, at: endedAt };
      appendHistory(state, {
        stage: stage.name,
        startedAt,
        endedAt,
        outcome: 'failure',
        message,
      });
      store.save(state);
      throw err;
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
