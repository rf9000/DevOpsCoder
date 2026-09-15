import type { AgentUsage, StepSpend } from '../../src/types/index.ts';

/**
 * Stand-in per-call usage for AgentRunner fakes.
 *
 * Every `AgentRunResult` carries usage, but most stage tests care only about
 * the stage's behaviour, not its token accounting. Sharing one constant keeps
 * those fixtures readable; tests that assert on cost detail build their own.
 */
export const TEST_USAGE: AgentUsage = {
  inputTokens: 100,
  outputTokens: 10,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  turns: 1,
  model: 'test-model',
};

/**
 * A `StepSpend` with every counter zeroed, for fixtures that care about one or
 * two fields. Spread and override: `makeSpend({ usd: 1.5, calls: 2 })`. Keeps
 * the fixtures from having to grow a line each time the ledger learns a new
 * counter.
 */
export function makeSpend(overrides: Partial<StepSpend> = {}): StepSpend {
  return {
    usd: 0,
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    turns: 0,
    models: [],
    ...overrides,
  };
}
