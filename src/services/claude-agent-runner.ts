import { query } from '@anthropic-ai/claude-agent-sdk';
import type { AgentRunner, AgentRunArgs } from '../pipeline/agent-stage.ts';
import type { Logger } from '../utils/logger.ts';
import type { AppConfig } from '../types/index.ts';

const STRUCTURED_OUTPUT_INSTRUCTION =
  'Respond with ONLY a single valid JSON object that satisfies the schema described in the prompt. ' +
  'No prose, no markdown fences, no commentary. Output the JSON object and nothing else.';

export class AgentOutputParseError extends Error {
  override readonly name = 'AgentOutputParseError';
  constructor(public readonly raw: string, message: string) {
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

export function createClaudeAgentRunner(deps: ClaudeAgentRunnerDeps): AgentRunner {
  return {
    async run<T>(args: AgentRunArgs<T>): Promise<T> {
      let result: string | undefined;

      for await (const message of query({
        prompt: args.prompt,
        options: {
          model: args.model ?? deps.config.claudeModel,
          allowedTools: args.tools ?? [],
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          systemPrompt: STRUCTURED_OUTPUT_INSTRUCTION,
        },
      })) {
        if (message.type === 'result') {
          deps.logger.info(
            `agent: $${message.total_cost_usd.toFixed(4)} | ${message.usage.input_tokens ?? 0} in / ${message.usage.output_tokens ?? 0} out | ${message.num_turns} turns`,
          );
          if (message.subtype === 'success') {
            result = message.result;
          }
        }
      }

      if (result === undefined) {
        throw new Error('No result received from Claude Agent SDK');
      }

      const json = extractJson(result);
      let parsed: unknown;
      try {
        parsed = JSON.parse(json);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new AgentOutputParseError(result, `Failed to parse JSON: ${msg}`);
      }

      const validated = args.schema.safeParse(parsed);
      if (!validated.success) {
        const issues = validated.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ');
        throw new AgentOutputParseError(
          result,
          `Schema validation failed: ${issues}`,
        );
      }
      return validated.data;
    },
  };
}
