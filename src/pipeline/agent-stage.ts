import type { z } from 'zod';

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
  /** Tally of tool invocations by tool name. Maps tool name (e.g., 'Edit', 'Bash') to the count of tool_use blocks in assistant messages. */
  toolUsage: Record<string, number>;
}

export interface AgentRunner {
  run<T>(args: AgentRunArgs<T>): Promise<AgentRunResult<T>>;
}
