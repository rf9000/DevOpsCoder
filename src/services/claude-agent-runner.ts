import { query } from '@anthropic-ai/claude-agent-sdk';
import type { AgentRunner, AgentRunArgs, AgentRunResult, AgentUsage } from '../pipeline/agent-stage.ts';
import type { Logger } from '../utils/logger.ts';
import type { AppConfig } from '../types/index.ts';

export const STRUCTURED_OUTPUT_INSTRUCTION =
  'Respond with ONLY a single valid JSON object that satisfies the schema described in the prompt. ' +
  'No prose, no markdown fences, no commentary. Output the JSON object and nothing else.';

/** What one runner call cost, carried on a parse failure so it survives the throw. */
export interface AgentSpend {
  costUsd: number;
  toolUsage: Record<string, number>;
  usage: AgentUsage;
}

export class AgentOutputParseError extends Error {
  override readonly name = 'AgentOutputParseError';
  constructor(
    public readonly raw: string,
    message: string,
    /**
     * The spend the SDK reported for the call whose output then failed to
     * parse. A malformed reply is not a free one — the tokens are bought by
     * the time the JSON is read — so the figure the runner has just logged has
     * to survive the throw. Without it a stage that retries twice pays for
     * three calls and bills for one, and the per-WI total silently understates
     * what the run actually cost.
     */
    public readonly spend?: AgentSpend,
  ) {
    super(message);
  }
}

/**
 * Strip ``` fences and surrounding prose from raw model output to recover the JSON body.
 * Pure helper — no side effects.
 */
export function extractJson(raw: string): string {
  const trimmed = raw.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenceMatch && fenceMatch[1] !== undefined) {
    return fenceMatch[1].trim();
  }
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }
  return trimmed;
}

export interface ClaudeAgentRunnerDeps {
  config: AppConfig;
  logger: Logger;
}

/**
 * Build the options object passed to the Claude Agent SDK's `query()`.
 * Pure helper — testable in isolation, no SDK call.
 */
export function buildQueryOptions<T>(
  args: AgentRunArgs<T>,
  deps: ClaudeAgentRunnerDeps,
): Record<string, unknown> {
  const baseAppend = STRUCTURED_OUTPUT_INSTRUCTION;
  const fullAppend = args.systemPromptAppend
    ? `${baseAppend}\n\n${args.systemPromptAppend}`
    : baseAppend;

  const opts: Record<string, unknown> = {
    model: args.model ?? deps.config.claudeModel,
    allowedTools: args.tools ?? [],
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    systemPrompt: { type: 'preset', preset: 'claude_code', append: fullAppend },
  };

  // Without this the SDK probes for its own bundled native binary. Under Bun on
  // a glibc image that probe resolves to the *-linux-x64-musl package and throws
  // "Claude Code native binary not found", so the Docker image pins the path to
  // the natively-installed CLI.
  if (deps.config.claudeCodeExecutablePath !== undefined) {
    opts.pathToClaudeCodeExecutable = deps.config.claudeCodeExecutablePath;
  }

  if (args.disallowedTools !== undefined) opts.disallowedTools = args.disallowedTools;
  if (args.maxTurns !== undefined) opts.maxTurns = args.maxTurns;
  if (args.cwd !== undefined) opts.cwd = args.cwd;
  if (args.canUseTool !== undefined) opts.canUseTool = args.canUseTool;
  if (args.settingSources !== undefined) opts.settingSources = args.settingSources;
  if (args.signal !== undefined) opts.abortSignal = args.signal;

  return opts;
}

export function createClaudeAgentRunner(deps: ClaudeAgentRunnerDeps): AgentRunner {
  return {
    async run<T>(args: AgentRunArgs<T>): Promise<AgentRunResult<T>> {
      let result: string | undefined;
      let costUsd = 0;
      const toolUsage: Record<string, number> = {};
      // Default to the config model: `model` is optional per call, and a usage
      // record that omits which model ran is the one thing that makes a spend
      // line unattributable once per-step overrides are in play.
      const usage: AgentUsage = {
        inputTokens: 0,
        outputTokens: 0,
        turns: 0,
        model: args.model ?? deps.config.claudeModel,
      };

      const options = buildQueryOptions(args, deps);

      for await (const message of query({
        prompt: args.prompt,
        options: options as Parameters<typeof query>[0]['options'],
      })) {
        // Defensive in-loop abort check — belt-and-suspenders fallback in case
        // the SDK does not honour the abortSignal option natively.
        if (args.signal?.aborted) {
          const err = new Error('aborted');
          err.name = 'AbortError';
          throw err;
        }

        if (message.type === 'result') {
          // The SDK declares total_cost_usd as `number` on the result message, but
          // the field is sometimes absent at runtime (e.g., on non-success subtypes
          // or during partial failures). Cast through `| undefined` and default to
          // 0 so a missing cost never breaks the orchestrator's cap arithmetic.
          costUsd = (message.total_cost_usd as number | undefined) ?? 0;
          usage.inputTokens = message.usage.input_tokens ?? 0;
          usage.outputTokens = message.usage.output_tokens ?? 0;
          usage.turns = message.num_turns ?? 0;
          deps.logger.info(
            `agent: $${costUsd.toFixed(4)} | ${message.usage.input_tokens ?? 0} in / ${message.usage.output_tokens ?? 0} out | ${message.num_turns} turns` +
              (args.label ? ` | ${args.label}` : ''),
          );
          if (message.subtype === 'success') {
            result = message.result;
          }
        }

        if (message.type === 'assistant') {
          for (const block of message.message.content) {
            if (block.type === 'tool_use') {
              toolUsage[block.name] = (toolUsage[block.name] ?? 0) + 1;
            }
          }
        }
      }

      if (result === undefined) {
        throw new Error('No result received from Claude Agent SDK');
      }

      const spend: AgentSpend = { costUsd, toolUsage, usage };

      const json = extractJson(result);
      let parsed: unknown;
      try {
        parsed = JSON.parse(json);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new AgentOutputParseError(result, `Failed to parse JSON: ${msg}`, spend);
      }

      const validated = args.schema.safeParse(parsed);
      if (!validated.success) {
        const issues = validated.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ');
        throw new AgentOutputParseError(
          result,
          `Schema validation failed: ${issues}`,
          spend,
        );
      }
      return { value: validated.data, costUsd, toolUsage, usage };
    },
  };
}
