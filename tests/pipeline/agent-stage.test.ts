import { describe, it, expect, mock } from 'bun:test';
import { z } from 'zod';
import { agentStage } from '../../src/pipeline/agent-stage.ts';
import type { AgentRunner } from '../../src/pipeline/agent-stage.ts';
import type { PipelineContext } from '../../src/pipeline/stage.ts';
import type { AppConfig, PipelineState } from '../../src/types/index.ts';

const FIXED_NOW = new Date('2026-05-04T12:00:00.000Z');

function mockContext(): PipelineContext {
  const config: AppConfig = {
    org: 'o', orgUrl: 'https://dev.azure.com/o', project: 'p', pat: 't',
    repositoryName: 'test-repo',
    targetRepoPath: '/r', worktreeBase: '/w',
    triggerTag: 'agent implement', blockedTag: 'agent-blocked', needInputTag: 'need-input',
    pollIntervalMinutes: 5, concurrency: 1, maxRevisions: 3, maxRejectCycles: 3,
    coderMaxTurns: 80, testAuthorMaxTurns: 50,
    maxCostUsdPerWi: 5.00, stageTimeoutMs: {},
    claudeModel: 'claude-opus-4-7', stateDir: '.state', assignedToFilter: [], dryRun: false,
  };
  return {
    config,
    logger: { info: mock(() => {}), warn: mock(() => {}), error: mock(() => {}) },
    abortFlag: { aborted: false },
    now: () => FIXED_NOW,
  };
}

function mockState(): PipelineState {
  return {
    workItemId: 101,
    slug: 'wi-101',
    startedAt: FIXED_NOW.toISOString(),
    updatedAt: FIXED_NOW.toISOString(),
    currentStage: null,
    history: [],
    attempts: {},
    outputs: {},
  };
}

const VerdictSchema = z.object({
  verdict: z.enum(['proceed', 'reject']),
  taskSummary: z.string().optional(),
});

describe('agentStage', () => {
  it('passes the built prompt + schema + tools + model to the runner', async () => {
    const seenArgs: Array<{ prompt: string; schema: unknown; tools?: string[]; model?: string }> = [];
    const runner: AgentRunner = {
      run: mock(async (args) => {
        seenArgs.push(args as { prompt: string; schema: unknown; tools?: string[]; model?: string });
        return { verdict: 'proceed', taskSummary: 'do x' };
      }) as AgentRunner['run'],
    };
    const stage = agentStage(
      {
        name: 'analyzer',
        buildPrompt: (s) => `wi=${s.workItemId}`,
        schema: VerdictSchema,
        tools: ['Read'],
        model: 'claude-opus-4-7',
        applyOutput: (s, out) => ({ ...s, outputs: { ...s.outputs, analyzer: out } }),
      },
      runner,
    );

    const state = mockState();
    const ctx = mockContext();
    const next = await stage.execute(state, ctx);

    expect(seenArgs.length).toBe(1);
    expect(seenArgs[0]?.prompt).toBe('wi=101');
    expect(seenArgs[0]?.schema).toBe(VerdictSchema);
    expect(seenArgs[0]?.tools).toEqual(['Read']);
    expect(seenArgs[0]?.model).toBe('claude-opus-4-7');
    expect(next.outputs.analyzer).toEqual({ verdict: 'proceed', taskSummary: 'do x' });
  });

  it('uses canRun option when provided, defaulting to always-true', async () => {
    const runner: AgentRunner = { run: mock(async () => ({ verdict: 'proceed' })) as AgentRunner['run'] };
    const restricted = agentStage(
      {
        name: 'restricted',
        buildPrompt: () => '',
        schema: VerdictSchema,
        applyOutput: (s) => s,
        canRun: () => false,
      },
      runner,
    );
    expect(restricted.canRun(mockState())).toBe(false);

    const open = agentStage(
      {
        name: 'open',
        buildPrompt: () => '',
        schema: VerdictSchema,
        applyOutput: (s) => s,
      },
      runner,
    );
    expect(open.canRun(mockState())).toBe(true);
  });

  it('exposes the configured stage name', () => {
    const runner: AgentRunner = { run: mock(async () => ({ verdict: 'proceed' })) as AgentRunner['run'] };
    const stage = agentStage(
      {
        name: 'analyzer',
        buildPrompt: () => '',
        schema: VerdictSchema,
        applyOutput: (s) => s,
      },
      runner,
    );
    expect(stage.name).toBe('analyzer');
  });

  it('propagates errors thrown by the runner', async () => {
    const runner: AgentRunner = { run: mock(async () => { throw new Error('rate limited'); }) as AgentRunner['run'] };
    const stage = agentStage(
      {
        name: 'analyzer',
        buildPrompt: () => '',
        schema: VerdictSchema,
        applyOutput: (s) => s,
      },
      runner,
    );
    let caught: unknown;
    try { await stage.execute(mockState(), mockContext()); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('rate limited');
  });
});
