import { describe, it, expect, mock } from 'bun:test';
import {
  createCoderStage,
  buildCoderUserPrompt,
  MAX_TRANSIENT_RETRIES,
} from '../../../src/pipeline/stages/coder.ts';
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
  Finding,
  PipelineCostInfo,
  PipelineState,
  PlanOutput,
  ReviewerOutput,
  WorktreeContext,
} from '../../../src/types/index.ts';
import type { WorkItemContext } from '../../../src/services/wi-context.ts';
import type { DiscoveredSkill } from '../../../src/services/skill-loader.ts';
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
  summary: 'Fix the login button so it submits the form',
  reasons: [],
};

const sampleWiCtx: WorkItemContext = {
  id: 101,
  title: 'Fix login',
  workItemType: 'Bug',
  state: 'Active',
  description: 'The login button is broken.',
  reproSteps: '1. Click the button\n2. Nothing happens',
  acceptanceCriteria: 'The button submits the form.',
  images: [],
  comments: [],
};

const sampleWorktree: WorktreeContext = {
  path: '/repos/.worktrees/wi-101-fix-login',
  branch: 'agent/wi-101-fix-login',
  baseSha: 'abc123abc123abc123abc123abc123abc123abcd',
};

function makeState(overrides: Partial<PipelineState> = {}): PipelineState {
  return {
    workItemId: 101,
    slug: 'fix-login',
    startedAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    currentStage: 'coder',
    history: [],
    outputs: {
      analyzer: sampleAnalyzer,
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
  result: CoderOutput | ((call: number) => Promise<CoderOutput>),
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

const successOutput: CoderOutput = {
  summary: 'Implemented the fix',
  filesChanged: ['src/login.ts'],
  commits: ['deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'],
};

describe('buildCoderUserPrompt', () => {
  it('includes analyzer summary, worktree info, and WI context sections', () => {
    const prompt = buildCoderUserPrompt(
      sampleAnalyzer,
      sampleWiCtx,
      sampleWorktree,
      [],
    );
    expect(prompt).toContain('# Implementing Work Item 101: Fix login');
    expect(prompt).toContain('Fix the login button so it submits the form');
    expect(prompt).toContain(sampleWorktree.path);
    expect(prompt).toContain(sampleWorktree.branch);
    expect(prompt).toContain('The login button is broken.');
    expect(prompt).toContain('### Acceptance Criteria');
    // no reviewer feedback passed — section must NOT appear
    expect(prompt).not.toContain('Previous reviewer findings');
  });

  it('includes skill list when discoveredSkills is non-empty', () => {
    const skills: DiscoveredSkill[] = [
      { name: 'al-formatter', description: 'Formats AL' },
    ];
    const prompt = buildCoderUserPrompt(
      sampleAnalyzer,
      sampleWiCtx,
      sampleWorktree,
      skills,
    );
    expect(prompt).toContain('## Available Invocable Skills');
    expect(prompt).toContain('- **al-formatter**: Formats AL');
  });

  it('renders "Previous reviewer findings" section when feedback is present', () => {
    const findings: Finding[] = [
      {
        severity: 'blocking',
        file: 'src/auth.ts',
        line: 42,
        title: 'SQL injection vulnerability',
        description: 'User input is concatenated directly into the query.',
        suggestion: 'Use parameterised queries.',
        axis: 'security',
      },
      {
        severity: 'major',
        file: 'src/utils.ts',
        title: 'Missing null check',
        description: 'Value can be undefined at this point.',
        axis: 'correctness',
      },
    ];
    const prompt = buildCoderUserPrompt(
      sampleAnalyzer,
      sampleWiCtx,
      sampleWorktree,
      [],
      findings,
    );
    expect(prompt).toContain('Previous reviewer findings');
    expect(prompt).toContain('SQL injection vulnerability');
    expect(prompt).toContain('Missing null check');
    expect(prompt).toContain('### blocking findings');
    expect(prompt).toContain('### major findings');
  });

  it('groups multiple findings by severity in descending order', () => {
    const findings: Finding[] = [
      {
        severity: 'major',
        file: 'src/a.ts',
        title: 'Major issue A',
        description: 'A description.',
        axis: 'style',
      },
      {
        severity: 'critical',
        file: 'src/b.ts',
        title: 'Critical issue B',
        description: 'B description.',
        axis: 'correctness',
      },
      {
        severity: 'nit',
        file: 'src/c.ts',
        title: 'Nit issue C',
        description: 'C description.',
        axis: 'style',
      },
      {
        severity: 'critical',
        file: 'src/d.ts',
        title: 'Critical issue D',
        description: 'D description.',
        axis: 'security',
      },
    ];
    const prompt = buildCoderUserPrompt(
      sampleAnalyzer,
      sampleWiCtx,
      sampleWorktree,
      [],
      findings,
    );
    expect(prompt).toContain('Previous reviewer findings');
    expect(prompt).toContain('Critical issue B');
    expect(prompt).toContain('Critical issue D');
    expect(prompt).toContain('Major issue A');
    expect(prompt).toContain('Nit issue C');
    // descending severity order: critical before major before nit
    expect(prompt.indexOf('### critical findings')).toBeLessThan(prompt.indexOf('### major findings'));
    expect(prompt.indexOf('### major findings')).toBeLessThan(prompt.indexOf('### nit findings'));
  });
});

describe('createCoderStage', () => {
  it('happy path: stores CoderOutput in state.outputs.coder and returns state', async () => {
    const runner = makeRunner(successOutput, 0.42, { Edit: 2, Bash: 1 });
    const stage = createCoderStage({
      config: baseConfig,
      runner,
      promptTemplate: 'CODER_PROMPT_BODY',
      discoveredSkills: [],
      getCurrentHeadSha: async () => 'baselinesha',
      resetWorktree: async () => {},
    });
    const result = await stage.execute(makeState(), makeCtx());
    expect(result.outputs.coder).toEqual(successOutput);
    expect(runner.calls).toHaveLength(1);
    // Cost tracking: coder records costUsd returned by the runner
    expect((result.outputs.cost as PipelineCostInfo).total).toBeCloseTo(0.42, 4);
    expect((result.outputs.cost as PipelineCostInfo).perStage['coder']!.usd).toBeCloseTo(0.42, 4);
    // Tool-usage tracking: coder records toolUsage returned by the runner
    expect(result.outputs.toolUsage).toEqual({ Edit: 2, Bash: 1 });
  });

  it('throws if upstream outputs missing (analyzer/wiContext/worktree)', async () => {
    const stage = createCoderStage({
      config: baseConfig,
      runner: makeRunner(successOutput),
      promptTemplate: 'x',
      discoveredSkills: [],
      getCurrentHeadSha: async () => 'sha',
      resetWorktree: async () => {},
    });
    const stateNoWorktree = makeState({ outputs: { analyzer: sampleAnalyzer, wiContext: sampleWiCtx } });
    await expect(stage.execute(stateNoWorktree, makeCtx())).rejects.toThrow(
      /coder requires/,
    );
  });

  it('forwards correct runner options (cwd, tools, disallowed, settingSources, systemPromptAppend, maxTurns)', async () => {
    const runner = makeRunner(successOutput);
    const stage = createCoderStage({
      config: baseConfig,
      runner,
      promptTemplate: 'CODER_PROMPT_BODY',
      discoveredSkills: [],
      getCurrentHeadSha: async () => 'sha',
      resetWorktree: async () => {},
    });
    await stage.execute(makeState(), makeCtx());
    const args = runner.calls[0]!;
    expect(args.cwd).toBe(sampleWorktree.path);
    expect(args.tools).toEqual(['Read', 'Grep', 'Glob', 'Bash', 'Skill', 'Edit', 'Write']);
    expect(args.disallowedTools).toEqual(['NotebookEdit']);
    expect(args.systemPromptAppend).toBe('CODER_PROMPT_BODY');
    expect(args.settingSources).toEqual(['project']);
    expect(args.maxTurns).toBe(80);
    expect(typeof args.canUseTool).toBe('function');
  });

  it('retries on AgentOutputParseError up to MAX_TRANSIENT_RETRIES (succeeds on retry)', async () => {
    let attempt = 0;
    const runner = makeRunner(async () => {
      attempt++;
      if (attempt <= 2) {
        throw new AgentOutputParseError('raw', 'bad json');
      }
      return successOutput;
    });
    const resetCalls: string[] = [];
    const stage = createCoderStage({
      config: baseConfig,
      runner,
      promptTemplate: 'x',
      discoveredSkills: [],
      getCurrentHeadSha: async () => 'baselinesha',
      resetWorktree: async (path, sha) => {
        resetCalls.push(`${path}|${sha}`);
      },
    });
    const result = await stage.execute(makeState(), makeCtx());
    expect(result.outputs.coder).toEqual(successOutput);
    expect(runner.calls.length).toBe(3); // 1 + 2 retries before succeeding on attempt 3
    expect(resetCalls.length).toBe(2); // reset between each failed attempt
    expect(resetCalls[0]).toBe(`${sampleWorktree.path}|baselinesha`);
  });

  it('throws after exhausting retry budget on persistent AgentOutputParseError', async () => {
    const runner = makeRunner(async () => {
      throw new AgentOutputParseError('raw', 'consistent failure');
    });
    let resetCalls = 0;
    const stage = createCoderStage({
      config: baseConfig,
      runner,
      promptTemplate: 'x',
      discoveredSkills: [],
      getCurrentHeadSha: async () => 'sha',
      resetWorktree: async () => {
        resetCalls++;
      },
    });
    await expect(stage.execute(makeState(), makeCtx())).rejects.toBeInstanceOf(
      AgentOutputParseError,
    );
    expect(runner.calls.length).toBe(MAX_TRANSIENT_RETRIES + 1); // initial + retries
    expect(resetCalls).toBe(MAX_TRANSIENT_RETRIES + 1);
  });

  it('does NOT retry on a hard (non-parse) error — resets and re-throws immediately', async () => {
    const runner = makeRunner(async () => {
      throw new Error('hard failure: network down');
    });
    let resetCalls = 0;
    const stage = createCoderStage({
      config: baseConfig,
      runner,
      promptTemplate: 'x',
      discoveredSkills: [],
      getCurrentHeadSha: async () => 'sha',
      resetWorktree: async () => {
        resetCalls++;
      },
    });
    await expect(stage.execute(makeState(), makeCtx())).rejects.toThrow(
      'hard failure: network down',
    );
    expect(runner.calls.length).toBe(1); // no retries
    expect(resetCalls).toBe(1); // reset still happens
  });

  it('canUseTool denies a destructive git command (git push)', async () => {
    const runner = makeRunner(successOutput);
    const stage = createCoderStage({
      config: baseConfig,
      runner,
      promptTemplate: 'x',
      discoveredSkills: [],
      getCurrentHeadSha: async () => 'sha',
      resetWorktree: async () => {},
    });
    await stage.execute(makeState(), makeCtx());
    const canUseTool = runner.calls[0]!.canUseTool!;
    const denied = await canUseTool('Bash', { command: 'git push origin main' });
    expect(denied.behavior).toBe('deny');
    const allowed = await canUseTool('Bash', { command: 'git commit -m "fix"' });
    expect(allowed.behavior).toBe('allow');
  });

  it('canUseTool denies Edit/Write outside the worktree path', async () => {
    const runner = makeRunner(successOutput);
    const stage = createCoderStage({
      config: baseConfig,
      runner,
      promptTemplate: 'x',
      discoveredSkills: [],
      getCurrentHeadSha: async () => 'sha',
      resetWorktree: async () => {},
    });
    await stage.execute(makeState(), makeCtx());
    const canUseTool = runner.calls[0]!.canUseTool!;
    const outsideWrite = await canUseTool('Write', { file_path: '/etc/passwd' });
    expect(outsideWrite.behavior).toBe('deny');
    const insideWrite = await canUseTool('Write', {
      file_path: `${sampleWorktree.path}/src/foo.ts`,
    });
    expect(insideWrite.behavior).toBe('allow');
  });
});

describe('createCoderStage — plan step', () => {
  const samplePlan: PlanOutput = {
    approach: 'Wire the submit handler to the form',
    steps: ['Add onSubmit', 'Guard double-submit'],
    filesToTouch: ['src/login.ts'],
    risks: ['Double-submit regression'],
  };

  /** Runner that answers the plan call with a PlanOutput and the write call with a CoderOutput. */
  function makeSplitRunner(): RecordingRunner {
    const calls: AgentRunArgs<unknown>[] = [];
    return {
      calls,
      async run<T>(
        args: AgentRunArgs<T>,
      ): Promise<AgentRunResult<T>> {
        calls.push(args as AgentRunArgs<unknown>);
        const isPlan = args.label === 'coder:plan';
        return {
          value: (isPlan ? samplePlan : successOutput) as unknown as T,
          costUsd: isPlan ? 0.30 : 0.12,
          toolUsage: isPlan ? { Read: 4 } : { Edit: 2 },
          usage: TEST_USAGE,
        };
      },
    };
  }

  const planConfig: AppConfig = {
    ...baseConfig,
    claudeModel: 'claude-sonnet-5',
    stepModel: { 'coder-plan': 'claude-opus-5', 'coder': 'claude-sonnet-5' },
    planMaxTurns: 25,
  };

  function makeStage(config: AppConfig, runner: RecordingRunner) {
    return createCoderStage({
      config,
      runner,
      promptTemplate: 'CODER_PROMPT_BODY',
      plannerPromptTemplate: 'PLANNER_PROMPT_BODY',
      discoveredSkills: [],
      getCurrentHeadSha: async () => 'baselinesha',
      resetWorktree: async () => {},
    });
  }

  it('no plan model configured → single write call, as before', async () => {
    const runner = makeSplitRunner();
    await makeStage(baseConfig, runner).execute(makeState(), makeCtx());
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.label).toBe('coder (attempt 1)');
    expect(runner.calls[0]?.prompt).not.toContain('## Approved plan');
  });

  it('plan model configured → read-only plan call on the plan model, then the write call', async () => {
    const runner = makeSplitRunner();
    const state = await makeStage(planConfig, runner).execute(makeState(), makeCtx());

    expect(runner.calls).toHaveLength(2);
    const plan = runner.calls[0]!;
    expect(plan.label).toBe('coder:plan');
    expect(plan.model).toBe('claude-opus-5');
    expect(plan.maxTurns).toBe(25);
    expect(plan.systemPromptAppend).toBe('PLANNER_PROMPT_BODY');
    expect(plan.cwd).toBe(sampleWorktree.path);
    // The planner must not be able to write: no Edit/Write in tools, and both
    // explicitly disallowed so a preset-provided tool cannot slip through.
    expect(plan.tools).toEqual(['Read', 'Grep', 'Glob', 'Bash', 'Skill']);
    expect(plan.disallowedTools).toEqual(['Edit', 'Write', 'NotebookEdit']);

    const write = runner.calls[1]!;
    expect(write.label).toBe('coder (attempt 1)');
    expect(write.model).toBe('claude-sonnet-5');
    expect(write.tools).toContain('Edit');
    expect(write.prompt).toContain('## Approved plan');
    expect(write.prompt).toContain('Wire the submit handler to the form');
    expect(write.prompt).toContain('Add onSubmit');
    expect(state.outputs.coderPlan).toEqual(samplePlan);
  });

  it('attributes plan spend and tool usage to the coder-plan step', async () => {
    const runner = makeSplitRunner();
    const state = await makeStage(planConfig, runner).execute(makeState(), makeCtx());
    const cost = state.outputs.cost as PipelineCostInfo;
    expect(cost.perStage['coder-plan']!.usd).toBeCloseTo(0.30, 4);
    expect(cost.perStage['coder']!.usd).toBeCloseTo(0.12, 4);
    expect(cost.total).toBeCloseTo(0.42, 4);
    expect(state.outputs.toolUsage).toEqual({ Read: 4, Edit: 2 });
  });

  it('reuses a stored plan instead of re-planning when nothing was rejected', async () => {
    const runner = makeSplitRunner();
    const state = makeState();
    state.outputs.coderPlan = samplePlan;
    await makeStage(planConfig, runner).execute(state, makeCtx());
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.label).toBe('coder (attempt 1)');
    expect(runner.calls[0]?.prompt).toContain('## Approved plan');
  });

  it('re-plans when the reviewer rejected the previous attempt', async () => {
    const runner = makeSplitRunner();
    const state = makeState();
    state.outputs.coderPlan = samplePlan;
    const reviewerOutput: ReviewerOutput = {
      approved: false,
      attempts: 1,
      findings: [
        {
          axis: 'safety-correctness',
          severity: 'blocking',
          file: 'src/login.ts',
          title: 'Unhandled null',
          description: 'boom',
        } as Finding,
      ],
    };
    state.outputs.reviewer = reviewerOutput;
    await makeStage(planConfig, runner).execute(state, makeCtx());
    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[0]?.label).toBe('coder:plan');
    // The planner sees the findings it has to plan around.
    expect(runner.calls[0]?.prompt).toContain('Unhandled null');
  });
});
