import type { Stage, PipelineContext } from './stage.ts';
import type { PipelineState } from '../types/index.ts';
import { assertWithinCostCap } from '../utils/cost-tracker.ts';

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
        // Checked before each half of the round, not just once per round: the
        // producer and the six-way reviewer fan-out are each large enough to
        // clear the cap on their own, and the orchestrator's gate does not run
        // again until this whole stage returns.
        assertWithinCostCap(current, ctx.config.maxCostUsdPerWi, cfg.name);
        current = await cfg.producer.execute(current, ctx);
        if (ctx.abortFlag.aborted) return current;
        assertWithinCostCap(current, ctx.config.maxCostUsdPerWi, cfg.name);
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
