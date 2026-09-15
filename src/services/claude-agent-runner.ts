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

/**
 * Tools denied on every call, whatever the stage asked for.
 *
 * `AskUserQuestion` is unanswerable here — nothing is watching a container at
 * 03:00, so the call burns a turn and returns nothing useful. `ToolSearch`
 * loads schemas for deferred tools that this pipeline does not configure. Both
 * showed up in a real WI's tool tally (`AskUserQuestion×1, ToolSearch×1`)
 * despite appearing in no stage's `tools` list, because a deny rule is the only
 * thing the SDK enforces once permissions are bypassed.
 */
export const ALWAYS_DENIED_TOOLS = ['AskUserQuestion', 'ToolSearch'] as const;

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
    // A stage that supplies `canUseTool` is asking for its filters to decide.
    // `bypassPermissions` auto-approves every call BEFORE the callback is
    // consulted — the SDK says so itself, once per call:
    //
    //   Warning: canUseTool will not be invoked: permissionMode
    //   'bypassPermissions' auto-approves every tool call (except explicit
    //   deny rules) before the callback is consulted.
    //
    // which silently disabled the coder's Bash allowlist and its path-escape
    // filter — the whole of the worktree containment — leaving `disallowedTools`
    // as the only rule with teeth. 'default' routes those decisions back
    // through `canUseTool`, which is what every stage already passes.
    permissionMode: args.canUseTool ? 'default' : 'bypassPermissions',
    systemPrompt: { type: 'preset', preset: 'claude_code', append: fullAppend },
  };

  // Only meaningful for — and only accepted alongside — 'bypassPermissions'.
  if (args.canUseTool === undefined) opts.allowDangerouslySkipPermissions = true;

  // The SDK draws three distinct lines and we were only using one of them:
  //
  //   tools           the base set of built-in tools that EXIST for this call
  //   allowedTools    tools auto-approved WITHOUT consulting canUseTool
  //   disallowedTools removed from the model's context entirely
  //
  // Every stage's tool list was passed as `allowedTools`, which restricted
  // nothing and auto-approved everything. That is why ReportFindings,
  // AskUserQuestion and ToolSearch were all reachable from stages that never
  // listed them, and why the SDK kept warning that canUseTool would not be
  // invoked for Read, Grep, Glob and Bash - the coder's Bash allowlist among
  // them. The list belongs on `tools`.
  //
  // Only set it when the stage actually passed one: `tools: []` disables every
  // built-in tool, whereas the old `allowedTools: []` harmlessly auto-approved
  // nothing.
  if (args.tools !== undefined) opts.tools = args.tools;

  // No `allowedTools` when a filter is present: anything auto-approved here is
  // a tool the filter never sees. Without a filter there is nothing to shadow,
  // so the stage's own list is the auto-approve set as before.
  if (args.canUseTool === undefined && args.tools !== undefined) {
    opts.allowedTools = args.tools;
  }

  // Without this the SDK probes for its own bundled native binary. Under Bun on
  // a glibc image that probe resolves to the *-linux-x64-musl package and throws
  // "Claude Code native binary not found", so the Docker image pins the path to
  // the natively-installed CLI.
  if (deps.config.claudeCodeExecutablePath !== undefined) {
    opts.pathToClaudeCodeExecutable = deps.config.claudeCodeExecutablePath;
  }

  // Merged centrally rather than per stage: a deny rule is the one control that
  // works in every permission mode, and a baseline that each of the eight call
  // sites has to remember is a baseline that will be forgotten.
  opts.disallowedTools = [
    ...new Set([...ALWAYS_DENIED_TOOLS, ...(args.disallowedTools ?? [])]),
  ];
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
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
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
          // The cache counters are declared non-nullable on some SDK versions
          // and nullable on others; read them defensively so a null never
          // poisons the accumulator with NaN.
          const u = message.usage as {
            input_tokens?: number;
            output_tokens?: number;
            cache_creation_input_tokens?: number | null;
            cache_read_input_tokens?: number | null;
          };
          usage.inputTokens = u.input_tokens ?? 0;
          usage.outputTokens = u.output_tokens ?? 0;
          usage.cacheCreationInputTokens = u.cache_creation_input_tokens ?? 0;
          usage.cacheReadInputTokens = u.cache_read_input_tokens ?? 0;
          usage.turns = message.num_turns ?? 0;
          deps.logger.info(
            `agent: $${costUsd.toFixed(4)} | ${usage.inputTokens} in ` +
              `(+${usage.cacheCreationInputTokens} cache write, ${usage.cacheReadInputTokens} cache read) ` +
              `/ ${usage.outputTokens} out | ${usage.turns} turns` +
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
