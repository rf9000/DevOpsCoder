import type { z } from 'zod';
import type { Stage, PipelineContext } from './stage.ts';
import type { PipelineState } from '../types/index.ts';

export type CanUseToolFn = (
  toolName: string,
  input: Record<string, unknown>,
) => Promise<{ behavior: 'allow' } | { behavior: 'deny'; message: string }>;

export type SettingSource = 'user' | 'project' | 'local';

export interface AgentRunArgs<T> {
  prompt: string;
  schema: z.ZodSchema<T>;
  tools?: string[];
  disallowedTools?: string[];
  model?: string;
  maxTurns?: number;
  cwd?: string;
  systemPromptAppend?: string;
  settingSources?: SettingSource[];
  canUseTool?: CanUseToolFn;
  /** Optional AbortSignal. When aborted, the runner throws an AbortError. */
  signal?: AbortSignal;
}

export interface AgentRunResult<T> {
  value: T;
  /** Cumulative cost (USD) reported by the SDK for this single run. May be 0 if the SDK didn't return a cost (e.g., during a failure or a non-result message). */
  costUsd: number;
}

export interface AgentRunner {
  run<T>(args: AgentRunArgs<T>): Promise<AgentRunResult<T>>;
}

export interface AgentStageConfig<T> {
  name: string;
  buildPrompt: (state: PipelineState, ctx: PipelineContext) => string;
  schema: z.ZodSchema<T>;
  tools?: string[];
  disallowedTools?: string[];
  model?: string;
  maxTurns?: number;
  cwd?: string;
  systemPromptAppend?: string;
  settingSources?: SettingSource[];
  canUseTool?: CanUseToolFn;
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
      const { value: output } = await runner.run<T>({
        prompt,
        schema: cfg.schema,
        tools: cfg.tools,
        disallowedTools: cfg.disallowedTools,
        model: cfg.model,
        maxTurns: cfg.maxTurns,
        cwd: cfg.cwd,
        systemPromptAppend: cfg.systemPromptAppend,
        settingSources: cfg.settingSources,
        canUseTool: cfg.canUseTool,
      });
      return cfg.applyOutput(state, output);
    },
  };
}
