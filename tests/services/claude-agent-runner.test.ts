import { describe, it, expect, mock, afterEach } from 'bun:test';
import { z } from 'zod';
import type { AgentRunArgs } from '../../src/pipeline/agent-stage.ts';
import type { AppConfig } from '../../src/types/index.ts';
import { createLogger } from '../../src/utils/logger.ts';

// ---------------------------------------------------------------------------
// Module mock — must be declared before the module under test is imported so
// Bun replaces the binding at load time.  We expose a `setQueryImpl` handle
// so individual tests can swap the fake implementation.
// ---------------------------------------------------------------------------
type QueryMessage =
  | { type: 'result'; subtype: 'success'; result: string; total_cost_usd?: number; usage: { input_tokens?: number; output_tokens?: number }; num_turns: number }
  | { type: 'result'; subtype: 'error_max_turns' | 'error_during_generation'; total_cost_usd?: number; usage: { input_tokens?: number; output_tokens?: number }; num_turns: number }
  | { type: 'text'; text: string }
  | { type: 'tool_use'; tool: string; input: unknown }
  | { type: 'assistant'; message: { content: Array<{ type: 'tool_use'; id: string; name: string; input: unknown } | { type: 'text'; text: string }> } };

let _queryImpl: (opts: unknown) => AsyncGenerator<QueryMessage> = async function* defaultImpl() {
  yield {
    type: 'result',
    subtype: 'success',
    result: '{"verdict":"proceed"}',
    total_cost_usd: 0,
    usage: { input_tokens: 10, output_tokens: 5 },
    num_turns: 1,
  };
};

function setQueryImpl(impl: (opts: unknown) => AsyncGenerator<QueryMessage>): void {
  _queryImpl = impl;
}

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (opts: unknown) => _queryImpl(opts),
}));

// Import AFTER mock.module so the mocked binding is used.
import {
  extractJson,
  buildQueryOptions,
  createClaudeAgentRunner,
  STRUCTURED_OUTPUT_INSTRUCTION,
} from '../../src/services/claude-agent-runner.ts';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------
const baseConfig = {
  orgUrl: 'https://x',
  project: 'p',
  pat: 'pat',
  repositoryName: 'test-repo',
  targetRepoPath: '/r',
  worktreeBase: '/w',
  triggerTag: 'agent implement',
  blockedTag: 'agent-blocked',
  needInputTag: 'need-input',
  pollIntervalMinutes: 5,
  concurrency: 1,
  maxRevisions: 3,
  maxRejectCycles: 3,
  coderMaxTurns: 80,
  testAuthorMaxTurns: 50,
  maxCostUsdPerWi: 5.00,
  stageTimeoutMs: {},
  claudeModel: 'claude-opus-4-7',
  stateDir: '.state',
  assignedToFilter: [],
  continiaCliPath: '.tools/continia.exe', continiaEnvProfileId: 'prof-1', continiaApiToken: 'tok', continiaAppPaths: ['App'], continiaTestAppPaths: ['App'], maxTestFixAttempts: 2, dryRun: false,
} satisfies AppConfig;

const deps = { config: baseConfig, logger: createLogger() };

const minimalArgs: AgentRunArgs<unknown> = {
  prompt: 'hi',
  schema: z.unknown(),
};

// ---------------------------------------------------------------------------
// extractJson
// ---------------------------------------------------------------------------
describe('extractJson', () => {
  it('returns input as-is when it is already a bare JSON object', () => {
    expect(extractJson('{"a":1}')).toBe('{"a":1}');
  });

  it('strips ```json fences', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('strips bare ``` fences without a language tag', () => {
    expect(extractJson('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('extracts the outermost JSON object when surrounded by prose', () => {
    expect(extractJson('Sure! {"verdict":"proceed"} that is the answer.'))
      .toBe('{"verdict":"proceed"}');
  });

  it('returns the trimmed input when no JSON object is found', () => {
    expect(extractJson('  no json here  ')).toBe('no json here');
  });
});

// ---------------------------------------------------------------------------
// buildQueryOptions
// ---------------------------------------------------------------------------
describe('buildQueryOptions', () => {
  it('uses deps.config.claudeModel when args.model is omitted', () => {
    const opts = buildQueryOptions(minimalArgs, deps);
    expect(opts.model).toBe('claude-opus-4-7');
  });

  it('args.model takes precedence over deps.config.claudeModel', () => {
    const opts = buildQueryOptions(
      { ...minimalArgs, model: 'claude-sonnet-4-6' },
      deps,
    );
    expect(opts.model).toBe('claude-sonnet-4-6');
  });

  it('systemPrompt uses claude_code preset with STRUCTURED_OUTPUT_INSTRUCTION when no append is given', () => {
    const opts = buildQueryOptions(minimalArgs, deps);
    const sp = opts.systemPrompt as { type: string; preset: string; append: string };
    expect(sp.type).toBe('preset');
    expect(sp.preset).toBe('claude_code');
    expect(sp.append).toBe(STRUCTURED_OUTPUT_INSTRUCTION);
  });

  it('combines STRUCTURED_OUTPUT_INSTRUCTION with caller-provided systemPromptAppend', () => {
    const opts = buildQueryOptions(
      { ...minimalArgs, systemPromptAppend: 'Analyzer-specific rules go here.' },
      deps,
    );
    const sp = opts.systemPrompt as { append: string };
    expect(sp.append).toBe(
      `${STRUCTURED_OUTPUT_INSTRUCTION}\n\nAnalyzer-specific rules go here.`,
    );
  });

  it('omits optional fields when undefined', () => {
    const opts = buildQueryOptions(minimalArgs, deps);
    expect(opts.disallowedTools).toBeUndefined();
    expect(opts.maxTurns).toBeUndefined();
    expect(opts.cwd).toBeUndefined();
    expect(opts.canUseTool).toBeUndefined();
    expect(opts.settingSources).toBeUndefined();
  });

  it('forwards all optional fields when provided', () => {
    const canUseTool = async () => ({ behavior: 'allow' as const });
    const opts = buildQueryOptions(
      {
        ...minimalArgs,
        tools: ['Read', 'Grep'],
        disallowedTools: ['Edit', 'Write'],
        maxTurns: 20,
        cwd: '/repos/continia-banking',
        canUseTool,
        settingSources: ['project'],
      },
      deps,
    );
    expect(opts.allowedTools).toEqual(['Read', 'Grep']);
    expect(opts.disallowedTools).toEqual(['Edit', 'Write']);
    expect(opts.maxTurns).toBe(20);
    expect(opts.cwd).toBe('/repos/continia-banking');
    expect(opts.canUseTool).toBe(canUseTool);
    expect(opts.settingSources).toEqual(['project']);
  });
});

// ---------------------------------------------------------------------------
// createClaudeAgentRunner — cost and AbortSignal tests
// ---------------------------------------------------------------------------
describe('createClaudeAgentRunner', () => {
  const VerdictSchema = z.object({ verdict: z.enum(['proceed', 'reject']) });

  afterEach(() => {
    setQueryImpl(async function* defaultImpl() {
      yield {
        type: 'result',
        subtype: 'success',
        result: '{"verdict":"proceed"}',
        total_cost_usd: 0,
        usage: { input_tokens: 10, output_tokens: 5 },
        num_turns: 1,
      };
    });
  });

  it('extracts total_cost_usd from a result message', async () => {
    setQueryImpl(async function* () {
      yield {
        type: 'result',
        subtype: 'success',
        result: '{"verdict":"proceed"}',
        total_cost_usd: 0.42,
        usage: { input_tokens: 10, output_tokens: 5 },
        num_turns: 1,
      };
    });

    const runner = createClaudeAgentRunner(deps);
    const res = await runner.run({ prompt: 'go', schema: VerdictSchema });
    expect(res.costUsd).toBe(0.42);
    expect(res.value).toEqual({ verdict: 'proceed' });
  });

  it('returns costUsd: 0 when total_cost_usd is absent from the result message', async () => {
    setQueryImpl(async function* () {
      yield {
        type: 'result',
        subtype: 'success',
        result: '{"verdict":"proceed"}',
        // total_cost_usd intentionally omitted
        usage: { input_tokens: 10, output_tokens: 5 },
        num_turns: 1,
      } as QueryMessage;
    });

    const runner = createClaudeAgentRunner(deps);
    const res = await runner.run({ prompt: 'go', schema: VerdictSchema });
    expect(res.costUsd).toBe(0);
    expect(res.value).toEqual({ verdict: 'proceed' });
  });

  it('throws AbortError when the provided signal is already aborted', async () => {
    setQueryImpl(async function* () {
      // Yield a few messages before settling so the loop has time to check abort
      yield { type: 'text', text: 'thinking...' };
      yield { type: 'text', text: 'still thinking...' };
      yield {
        type: 'result',
        subtype: 'success',
        result: '{"verdict":"proceed"}',
        total_cost_usd: 0.01,
        usage: { input_tokens: 5, output_tokens: 3 },
        num_turns: 2,
      };
    });

    const signal = AbortSignal.abort();
    const runner = createClaudeAgentRunner(deps);
    let caught: unknown;
    try {
      await runner.run({ prompt: 'go', schema: VerdictSchema, signal });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).name).toBe('AbortError');
  });

  it('passes args.signal through buildQueryOptions as opts.abortSignal', () => {
    const ctrl = new AbortController();
    const opts = buildQueryOptions(
      {
        prompt: 'p',
        schema: z.any(),
        signal: ctrl.signal,
      } as AgentRunArgs<unknown>,
      { config: baseConfig, logger: createLogger() },
    );
    expect(opts['abortSignal']).toBe(ctrl.signal);
  });

  it('tallies tool_use blocks from assistant messages', async () => {
    setQueryImpl(async function* () {
      yield {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: '1', name: 'Edit', input: {} },
            { type: 'tool_use', id: '2', name: 'Bash', input: {} },
          ],
        },
      };
      yield {
        type: 'result',
        subtype: 'success',
        result: '{"verdict":"proceed"}',
        total_cost_usd: 0.01,
        usage: { input_tokens: 10, output_tokens: 5 },
        num_turns: 1,
      };
    });

    const runner = createClaudeAgentRunner(deps);
    const res = await runner.run({ prompt: 'go', schema: VerdictSchema });
    expect(res.toolUsage).toEqual({ Edit: 1, Bash: 1 });
  });

  it('returns empty toolUsage when no tool_use blocks are present', async () => {
    setQueryImpl(async function* () {
      yield {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'thinking...' }],
        },
      };
      yield {
        type: 'result',
        subtype: 'success',
        result: '{"verdict":"proceed"}',
        total_cost_usd: 0.01,
        usage: { input_tokens: 10, output_tokens: 5 },
        num_turns: 1,
      };
    });

    const runner = createClaudeAgentRunner(deps);
    const res = await runner.run({ prompt: 'go', schema: VerdictSchema });
    expect(res.toolUsage).toEqual({});
  });
});
