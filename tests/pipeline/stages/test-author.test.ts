import { describe, it, expect } from 'bun:test';
import {
  createTestAuthorStage,
  buildTestAuthorUserPrompt,
  MAX_TRANSIENT_RETRIES,
} from '../../../src/pipeline/stages/test-author.ts';
import { AgentOutputParseError } from '../../../src/services/claude-agent-runner.ts';
import { createLogger } from '../../../src/utils/logger.ts';
import type {
  AgentRunArgs,
  AgentRunner,
  AgentRunResult,
} from '../../../src/pipeline/agent-stage.ts';
import type {
  AppConfig,
  CoderOutput,
  PipelineCostInfo,
  PipelineState,
  PlanOutput,
  TestAuthorOutput,
  WorktreeContext,
} from '../../../src/types/index.ts';
import type { WorkItemContext } from '../../../src/services/wi-context.ts';
import type { AnalyzerOutput } from '../../../src/pipeline/stages/analyzer.ts';
import { TEST_USAGE } from '../../helpers/agent-usage.ts';

const baseConfig: AppConfig = {
  orgUrl: 'https://x',
  project: 'p',
  pat: 'pat',
  repositoryName: 'test-repo',
  targetRepoPath: '/repos/target',
  worktreeBase: '/repos/.worktrees',
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
  stateDir: '.state', logDir: 'logs',
  assignedToFilter: [],
  continiaCliPath: '.tools/continia.exe', continiaEnvProfileId: 'prof-1', continiaApiToken: 'tok', continiaAppPaths: ['App'], continiaTestAppPaths: ['App'], maxTestFixAttempts: 2, continiaTestTimeoutS: 600, dryRun: false, skipBuildTest: false, testSelection: 'all', maxTestCodeunits: 0, costLogPath: '.state/cost-ledger.jsonl',
};

const sampleAnalyzer: AnalyzerOutput = {
  verdict: 'proceed',
  summary: 'Fix login',
  reasons: [],
};

const sampleCoder: CoderOutput = {
  summary: 'Implemented the login fix',
  filesChanged: ['src/login.ts'],
  commits: ['abc1234'],
};

const sampleWiCtx: WorkItemContext = {
  id: 101,
  title: 'Fix login',
  workItemType: 'Bug',
  state: 'Active',
  description: 'Broken login button.',
  reproSteps: '1. Click button',
  acceptanceCriteria: 'Button submits the form.',
  images: [],
  comments: [],
};

const sampleWorktree: WorktreeContext = {
  path: '/repos/.worktrees/wi-101-fix-login',
  branch: 'agent/wi-101-fix-login',
  baseSha: 'baseline123',
};

function makeState(overrides: Partial<PipelineState> = {}): PipelineState {
  return {
    workItemId: 101,
    slug: 'fix-login',
    startedAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    currentStage: 'test-author',
    history: [],
    outputs: {
      analyzer: sampleAnalyzer,
      coder: sampleCoder,
      wiContext: sampleWiCtx,
      worktree: sampleWorktree,
    },
    ...overrides,
  };
}

function makeCtx() {
  return {
    config: baseConfig,
    logger: createLogger(),
    abortFlag: { aborted: false },
    signal: new AbortController().signal,
    now: () => new Date(),
  };
}

interface RecordingRunner extends AgentRunner {
  calls: AgentRunArgs<unknown>[];
}

function makeRunner(
  result: TestAuthorOutput | ((call: number) => Promise<TestAuthorOutput>),
  costUsd = 0.42,
  toolUsage: Record<string, number> = {},
): RecordingRunner {
  const calls: AgentRunArgs<unknown>[] = [];
  let i = 0;
  return {
    calls,
    async run<T>(args: AgentRunArgs<T>): Promise<AgentRunResult<T>> {
      calls.push(args as AgentRunArgs<unknown>);
      const out = typeof result === 'function' ? await result(i++) : result;
      return { value: out as unknown as T, costUsd, toolUsage, usage: TEST_USAGE };
    },
  };
}

const successOutput: TestAuthorOutput = {
  summary: 'Added 3 tests for the login fix',
  testFilesChanged: ['tests/login.test.ts'],
  commits: ['cafe1234cafe1234cafe1234cafe1234cafe1234'],
};

describe('buildTestAuthorUserPrompt', () => {
  it('includes coder summary and changed-files list', () => {
    const prompt = buildTestAuthorUserPrompt(
      sampleAnalyzer,
      sampleCoder,
      sampleWiCtx,
      sampleWorktree,
      [],
    );
    expect(prompt).toContain('# Writing tests for Work Item 101: Fix login');
    expect(prompt).toContain('Implemented the login fix');
    expect(prompt).toContain('- src/login.ts');
    expect(prompt).toContain('### Acceptance Criteria');
  });
});

describe('createTestAuthorStage', () => {
  it('happy path: stores TestAuthorOutput in state.outputs.testAuthor', async () => {
    const runner = makeRunner(successOutput, 0.42, { Write: 2, Bash: 1 });
    const stage = createTestAuthorStage({
      config: baseConfig,
      runner,
      promptTemplate: 'TA_PROMPT',
      discoveredSkills: [],
      getCurrentHeadSha: async () => 'sha',
      resetWorktree: async () => {},
    });
    const result = await stage.execute(makeState(), makeCtx());
    expect(result.outputs.testAuthor).toEqual(successOutput);
    // Cost tracking: test-author records costUsd returned by the runner
    expect((result.outputs.cost as PipelineCostInfo).total).toBeCloseTo(0.42, 4);
    expect((result.outputs.cost as PipelineCostInfo).perStage['test-author']!.usd).toBeCloseTo(0.42, 4);
    // Tool-usage tracking: test-author records toolUsage returned by the runner
    expect(result.outputs.toolUsage).toEqual({ Write: 2, Bash: 1 });
  });

  it('throws when state.outputs.coder is missing', async () => {
    const stage = createTestAuthorStage({
      config: baseConfig,
      runner: makeRunner(successOutput),
      promptTemplate: 'x',
      discoveredSkills: [],
      getCurrentHeadSha: async () => 'sha',
      resetWorktree: async () => {},
    });
    const stateNoCoder = makeState({
      outputs: {
        analyzer: sampleAnalyzer,
        wiContext: sampleWiCtx,
        worktree: sampleWorktree,
      },
    });
    await expect(stage.execute(stateNoCoder, makeCtx())).rejects.toThrow(
      /test-author requires/,
    );
  });

  it('forwards correct runner options (cwd, maxTurns from testAuthorMaxTurns)', async () => {
    const runner = makeRunner(successOutput);
    const stage = createTestAuthorStage({
      config: baseConfig,
      runner,
      promptTemplate: 'TA_PROMPT',
      discoveredSkills: [],
      getCurrentHeadSha: async () => 'sha',
      resetWorktree: async () => {},
    });
    await stage.execute(makeState(), makeCtx());
    const args = runner.calls[0]!;
    expect(args.cwd).toBe(sampleWorktree.path);
    expect(args.systemPromptAppend).toBe('TA_PROMPT');
    expect(args.maxTurns).toBe(50);
    expect(args.tools).toContain('Edit');
    expect(args.disallowedTools).toContain('NotebookEdit');
  });

  it('retries on AgentOutputParseError up to MAX_TRANSIENT_RETRIES', async () => {
    let attempt = 0;
    const runner = makeRunner(async () => {
      attempt++;
      if (attempt <= 2) {
        throw new AgentOutputParseError('raw', 'bad json');
      }
      return successOutput;
    });
    const stage = createTestAuthorStage({
      config: baseConfig,
      runner,
      promptTemplate: 'x',
      discoveredSkills: [],
      getCurrentHeadSha: async () => 'baseline',
      resetWorktree: async () => {},
    });
    const result = await stage.execute(makeState(), makeCtx());
    expect(result.outputs.testAuthor).toEqual(successOutput);
    expect(runner.calls.length).toBe(3);
  });

  it('canUseTool allows `bun test` (test-runner allowlist) but denies `git push`', async () => {
    const runner = makeRunner(successOutput);
    const stage = createTestAuthorStage({
      config: baseConfig,
      runner,
      promptTemplate: 'x',
      discoveredSkills: [],
      getCurrentHeadSha: async () => 'sha',
      resetWorktree: async () => {},
    });
    await stage.execute(makeState(), makeCtx());
    const canUseTool = runner.calls[0]!.canUseTool!;
    expect((await canUseTool('Bash', { command: 'bun test' })).behavior).toBe('allow');
    expect((await canUseTool('Bash', { command: 'npm test' })).behavior).toBe('allow');
    expect((await canUseTool('Bash', { command: 'git push' })).behavior).toBe('deny');
    expect((await canUseTool('Bash', { command: 'rm src/login.ts' })).behavior).toBe('deny');
  });
});

describe('createTestAuthorStage — plan step', () => {
  const samplePlan: PlanOutput = {
    approach: 'Cover the submit handler and the double-submit guard',
    steps: ['test: submits once', 'test: ignores the second click'],
    filesToTouch: ['tests/login.test.ts'],
    risks: [],
  };

  function makeSplitRunner(): RecordingRunner {
    const calls: AgentRunArgs<unknown>[] = [];
    return {
      calls,
      async run<T>(
        args: AgentRunArgs<T>,
      ): Promise<AgentRunResult<T>> {
        calls.push(args as AgentRunArgs<unknown>);
        const isPlan = args.label === 'test-author:plan';
        return {
          value: (isPlan ? samplePlan : successOutput) as unknown as T,
          costUsd: isPlan ? 0.20 : 0.10,
          toolUsage: isPlan ? { Read: 3 } : { Write: 1 },
          usage: TEST_USAGE,
        };
      },
    };
  }

  const planConfig: AppConfig = {
    ...baseConfig,
    claudeModel: 'claude-sonnet-5',
    stepModel: { 'test-author-plan': 'claude-opus-5', 'test-author': 'claude-sonnet-5' },
    planMaxTurns: 20,
  };

  function makeStage(config: AppConfig, runner: RecordingRunner) {
    return createTestAuthorStage({
      config,
      runner,
      promptTemplate: 'TA_PROMPT',
      plannerPromptTemplate: 'TEST_PLANNER_PROMPT',
      discoveredSkills: [],
      getCurrentHeadSha: async () => 'sha',
      resetWorktree: async () => {},
    });
  }

  it('no plan model configured → single write call, as before', async () => {
    const runner = makeSplitRunner();
    await makeStage(baseConfig, runner).execute(makeState(), makeCtx());
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.label).toBe('test-author');
  });

  it('plan model configured → read-only plan call first, then the write call', async () => {
    const runner = makeSplitRunner();
    const state = await makeStage(planConfig, runner).execute(makeState(), makeCtx());

    expect(runner.calls).toHaveLength(2);
    const plan = runner.calls[0]!;
    expect(plan.label).toBe('test-author:plan');
    expect(plan.model).toBe('claude-opus-5');
    expect(plan.maxTurns).toBe(20);
    expect(plan.systemPromptAppend).toBe('TEST_PLANNER_PROMPT');
    expect(plan.tools).toEqual(['Read', 'Grep', 'Glob', 'Bash', 'Skill']);
    expect(plan.disallowedTools).toEqual(['Edit', 'Write', 'NotebookEdit']);

    const write = runner.calls[1]!;
    expect(write.model).toBe('claude-sonnet-5');
    expect(write.prompt).toContain('## Approved test plan');
    expect(write.prompt).toContain('test: ignores the second click');
    expect(state.outputs.testPlan).toEqual(samplePlan);

    const cost = state.outputs.cost as PipelineCostInfo;
    expect(cost.perStage['test-author-plan']!.usd).toBeCloseTo(0.20, 4);
    expect(cost.perStage['test-author']!.usd).toBeCloseTo(0.10, 4);
    expect(state.outputs.toolUsage).toEqual({ Read: 3, Write: 1 });
  });

  it('reuses a stored plan on re-entry', async () => {
    const runner = makeSplitRunner();
    const state = makeState();
    state.outputs.testPlan = samplePlan;
    await makeStage(planConfig, runner).execute(state, makeCtx());
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.prompt).toContain('## Approved test plan');
  });
});
