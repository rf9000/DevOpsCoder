import type { Stage, PipelineContext } from './stage.ts';
import { PipelinePauseError } from './stage.ts';
import type { PipelineState } from '../types/index.ts';

export interface CheckpointConfig {
  name: string;
  detect: (state: PipelineState, ctx: PipelineContext) => Promise<boolean>;
  rerunCommand?: string;
  timeoutHours?: number;
}

export function checkpoint(cfg: CheckpointConfig): Stage {
  return {
    name: cfg.name,
    canRun: () => true,
    async execute(state, ctx) {
      const cleared = await cfg.detect(state, ctx);
      if (!cleared) {
        state.currentStage = cfg.name;
        throw new PipelinePauseError(
          `checkpoint "${cfg.name}" not yet cleared`,
        );
      }
      return state;
    },
  };
}
