import type { z } from 'zod';
import type { Stage, PipelineContext } from './stage.ts';
import type { PipelineState } from '../types/index.ts';

export interface AgentRunArgs<T> {
  prompt: string;
  schema: z.ZodSchema<T>;
  tools?: string[];
  model?: string;
}

export interface AgentRunner {
  run<T>(args: AgentRunArgs<T>): Promise<T>;
}

export interface AgentStageConfig<T> {
  name: string;
  buildPrompt: (state: PipelineState, ctx: PipelineContext) => string;
  schema: z.ZodSchema<T>;
  tools?: string[];
  model?: string;
  applyOutput: (state: PipelineState, output: T) => PipelineState;
  canRun?: (state: PipelineState) => boolean;
}

export function agentStage<T>(
  cfg: AgentStageConfig<T>,
  runner: AgentRunner,
): Stage {
  return {
    name: cfg.name,
    canRun: cfg.canRun ?? (() => true),
    async execute(state, ctx) {
      const prompt = cfg.buildPrompt(state, ctx);
      const output = await runner.run<T>({
        prompt,
        schema: cfg.schema,
        tools: cfg.tools,
        model: cfg.model,
      });
      return cfg.applyOutput(state, output);
    },
  };
}
