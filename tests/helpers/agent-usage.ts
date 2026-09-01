import type { AgentUsage } from '../../src/types/index.ts';

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
  turns: 1,
  model: 'test-model',
};
