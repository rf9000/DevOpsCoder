import type { Stage, PipelineContext } from './stage.ts';
import type { PipelineState } from '../types/index.ts';
import { assertWithinCostCap } from '../utils/cost-tracker.ts';

export interface RevisionLoopConfig {
  name: string;
  /** Round 1's producer — writes the change from nothing. */
  initialProducer: Stage;
  /**
   * Rounds 2+. Absent ⇒ `initialProducer` runs every round, which is the
   * pre-Plan-14 behaviour and is what an unconfigured deployment gets.
   */
  reviseProducer?: Stage;
  /**
   * Runs after the producer and before the reviewer, every round. Absent ⇒ no
   * in-loop verification. Never throws for an environment-class problem — see
   * `_verify-gate.ts`.
   */
  verify?: Stage;
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
        // Checked before each part of the round, not once per round: the
        // producer, the verify gate (which contains test-fixer calls) and the
        // six-way reviewer fan-out are each large enough to clear the cap on
        // their own, and the orchestrator's gate does not run again until this
        // whole stage returns.
        assertWithinCostCap(current, ctx.config.maxCostUsdPerWi, cfg.name);
        const producer = attempt === 1 ? cfg.initialProducer : (cfg.reviseProducer ?? cfg.initialProducer);
        current = await producer.execute(current, ctx);
        if (ctx.abortFlag.aborted) return current;

        if (cfg.verify) {
          assertWithinCostCap(current, ctx.config.maxCostUsdPerWi, cfg.name);
          current = await cfg.verify.execute(current, ctx);
          if (ctx.abortFlag.aborted) return current;
        }

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
