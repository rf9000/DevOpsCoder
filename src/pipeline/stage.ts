import type { AppConfig, PipelineState } from '../types/index.ts';
import type { Logger } from '../utils/logger.ts';

export interface AbortFlag {
  aborted: boolean;
}

export interface PipelineContext {
  config: AppConfig;
  logger: Logger;
  abortFlag: AbortFlag;
  /**
   * Per-stage abort signal. The orchestrator creates a fresh AbortController
   * per stage iteration and threads its signal here. Stages should pass this
   * to runner.run({ ..., signal: ctx.signal }) and to any other I/O calls
   * (e.g. ado.addWorkItemComment, ado.createPullRequest) that accept a signal.
   */
  signal: AbortSignal;
  now: () => Date;
  /**
   * Tell the dashboard what the running stage is doing (e.g. `round 2/3 · review`).
   * The orchestrator supplies it; contexts built elsewhere may not, so call it
   * as `ctx.reportProgress?.(...)`.
   */
  reportProgress?: (detail: string) => void;
}

export interface Stage {
  readonly name: string;
  /**
   * The stage spends no agent money, so the pre-stage cost gate does not
   * block it: work already paid for (commits made before the cap was hit)
   * can still be pushed.
   */
  readonly costFree?: boolean;
  canRun(state: PipelineState): boolean;
  execute(state: PipelineState, context: PipelineContext): Promise<PipelineState>;
}

export class PipelinePauseError extends Error {
  override readonly name = 'PipelinePauseError';
  constructor(public readonly reason: string) {
    super(`Pipeline paused: ${reason}`);
  }
}

export interface RejectionPayload {
  reasons: string[];
  summary: string;
  questions?: string[];
}

export class PipelineRejectError extends Error {
  override readonly name = 'PipelineRejectError';
  constructor(public readonly payload: RejectionPayload) {
    super(`Pipeline rejected: ${payload.summary}`);
  }
}
