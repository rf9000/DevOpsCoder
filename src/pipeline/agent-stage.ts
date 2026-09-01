import type { z } from 'zod';
import type { AgentUsage } from '../types/index.ts';

export type { AgentUsage };

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
  /**
   * Which pipeline step this call belongs to, appended to the runner's cost log
   * line. Without it every `agent: $x.xx ...` line is anonymous and a spend
   * spike cannot be attributed while tailing the container log. Reviewer axes
   * use `reviewer:<axis>` so the six parallel calls stay distinguishable.
   */
  label?: string;
}

export interface AgentRunResult<T> {
  value: T;
  /** Cumulative cost (USD) reported by the SDK for this single run. May be 0 if the SDK didn't return a cost (e.g., during a failure or a non-result message). */
  costUsd: number;
  /** Tally of tool invocations by tool name. Maps tool name (e.g., 'Edit', 'Bash') to the count of tool_use blocks in assistant messages. */
  toolUsage: Record<string, number>;
  /**
   * Tokens, turns and the model this call actually ran on. Cost alone cannot be
   * read back to a cause — the same dollar figure means something different on
   * opus than on sonnet — so every call reports what produced it, and the cost
   * tracker folds it into the step's `StepSpend`.
   */
  usage: AgentUsage;
}

export interface AgentRunner {
  run<T>(args: AgentRunArgs<T>): Promise<AgentRunResult<T>>;
}
