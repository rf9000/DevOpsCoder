import type { AppConfig, PipelineState } from '../types/index.ts';
import type { Logger } from '../utils/logger.ts';

export interface AbortFlag {
  aborted: boolean;
}

export interface PipelineContext {
  config: AppConfig;
  logger: Logger;
  abortFlag: AbortFlag;
  now: () => Date;
}

export interface Stage {
  readonly name: string;
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
