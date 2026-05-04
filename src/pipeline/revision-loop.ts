import type { Stage, PipelineContext } from './stage.ts';
import type { PipelineState } from '../types/index.ts';

export interface RevisionLoopConfig {
  name: string;
  producer: Stage;
  reviewer: Stage;
  maxAttempts: number;
  isApproved: (state: PipelineState) => boolean;
  onExhausted?: (state: PipelineState, ctx: PipelineContext) => Promise<PipelineState>;
}

export function revisionLoop(cfg: RevisionLoopConfig): Stage {
  return {
    name: cfg.name,
    canRun: () => true,
    async execute(state, ctx) {
      let current = state;
      for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
        if (ctx.abortFlag.aborted) return current;
        current = await cfg.producer.execute(current, ctx);
        if (ctx.abortFlag.aborted) return current;
        current = await cfg.reviewer.execute(current, ctx);
        if (cfg.isApproved(current)) return current;
      }
      if (cfg.onExhausted) {
        current = await cfg.onExhausted(current, ctx);
      }
      return current;
    },
  };
}
