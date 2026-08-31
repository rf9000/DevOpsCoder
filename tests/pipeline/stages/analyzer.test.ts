import { describe, it, expect } from 'bun:test';
import {
  createAnalyzerStage,
  buildAnalyzerUserPrompt,
  type AnalyzerOutput,
} from '../../../src/pipeline/stages/analyzer.ts';
import { PipelineRejectError } from '../../../src/pipeline/stage.ts';
import { createLogger } from '../../../src/utils/logger.ts';
import type { AgentRunArgs, AgentRunner } from '../../../src/pipeline/agent-stage.ts';
import type { AdoClient } from '../../../src/sdk/azure-devops-client.ts';
import type { AppConfig, PipelineCostInfo, PipelineState } from '../../../src/types/index.ts';
import type { WorkItemContext } from '../../../src/services/wi-context.ts';
import type { DiscoveredSkill } from '../../../src/services/skill-loader.ts';

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
  stateDir: '.state',
  assignedToFilter: [],
  continiaCliPath: '.tools/continia.exe', continiaEnvProfileId: 'prof-1', continiaApiToken: 'tok', continiaAppPaths: ['App'], continiaTestAppPaths: ['App'], maxTestFixAttempts: 2, continiaTestTimeoutS: 600, dryRun: false, skipBuildTest: false,
};

function makeWiContext(): WorkItemContext {
  return {
    id: 101,
    title: 'Fix login',
    workItemType: 'Bug',
    state: 'Active',
    description: 'The login button is broken',
    reproSteps: '1. Click button\n2. Nothing happens',
    acceptanceCriteria: 'Button works',
    images: [],
    comments: [],
  };
}

function makeMockAdo(): AdoClient {
  return {
    queryWorkItemsByTag: async () => [],
    getWorkItem: async () => ({ id: 101, fields: {} }),
    getWorkItemComments: async () => [],
    getWorkItemUpdates: async () => [],
    addTagToWorkItem: async () => {},
    removeTagFromWorkItem: async () => {},
    addWorkItemComment: async () => {},
    createPullRequest: async () => ({ id: 0, url: '', sourceRefName: '', targetRefName: '' }),
  };
}

interface RecordingRunner extends AgentRunner {
  calls: AgentRunArgs<unknown>[];
}

function makeRunner(
  result: AnalyzerOutput | (() => Promise<AnalyzerOutput>),
  costUsd = 0.42,
  toolUsage: Record<string, number> = {},
): RecordingRunner {
  const calls: AgentRunArgs<unknown>[] = [];
  return {
    calls,
    async run<T>(args: AgentRunArgs<T>): Promise<{ value: T; costUsd: number; toolUsage: Record<string, number> }> {
      calls.push(args as AgentRunArgs<unknown>);
      const out = typeof result === 'function' ? await result() : result;
      return { value: out as unknown as T, costUsd, toolUsage };
    },
  };
}

function makeState(): PipelineState {
  return {
    workItemId: 101,
    slug: 'fix-login',
    startedAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    currentStage: 'analyzer',
    history: [],
    outputs: {},
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

describe('buildAnalyzerUserPrompt', () => {
  it('renders all sections of a fully-populated WI', () => {
    const prompt = buildAnalyzerUserPrompt(makeWiContext(), []);
    expect(prompt).toContain('# Work Item 101: Fix login');
    expect(prompt).toContain('**Type:** Bug');
    expect(prompt).toContain('**State:** Active');
    expect(prompt).toContain('## Description');
    expect(prompt).toContain('The login button is broken');
    expect(prompt).toContain('## Reproduction Steps');
    expect(prompt).toContain('Click button');
    expect(prompt).toContain('## Acceptance Criteria');
    expect(prompt).toContain('Button works');
  });

  it('handles a sparse WI without optional sections', () => {
    const wi: WorkItemContext = {
      id: 42,
      title: 'Sparse',
      workItemType: '',
      state: '',
      description: '',
      reproSteps: '',
      acceptanceCriteria: '',
      images: [],
      comments: [],
    };
    const prompt = buildAnalyzerUserPrompt(wi, []);
    expect(prompt).toContain('# Work Item 42: Sparse');
    expect(prompt).toContain('**Type:** unspecified');
    expect(prompt).toContain('_(empty)_');
    expect(prompt).not.toContain('## Reproduction Steps');
    expect(prompt).not.toContain('## Acceptance Criteria');
    expect(prompt).not.toContain('## Attached images');
    expect(prompt).not.toContain('## Comment history');
    expect(prompt).not.toContain('## Available Invocable Skills');
  });

  it('includes the skill list when discoveredSkills is non-empty', () => {
    const skills: DiscoveredSkill[] = [
      { name: 'al-formatter', description: 'Formats AL' },
      { name: 'field-mappings', description: 'AL→online mappings' },
    ];
    const prompt = buildAnalyzerUserPrompt(makeWiContext(), skills);
    expect(prompt).toContain('## Available Invocable Skills');
    expect(prompt).toContain('- **al-formatter**: Formats AL');
    expect(prompt).toContain('- **field-mappings**: AL→online mappings');
  });
});

describe('createAnalyzerStage', () => {
  it('proceed: stores AnalyzerOutput in state.outputs.analyzer and returns state', async () => {
    const runner = makeRunner(
      {
        verdict: 'proceed',
        summary: 'WI is ready',
        reasons: [],
      },
      0.42,
      { Edit: 2, Bash: 1 },
    );
    const stage = createAnalyzerStage({
      config: baseConfig,
      ado: makeMockAdo(),
      runner,
      discoveredSkills: [],
      promptTemplate: 'analyzer system prompt body',
      fetchWiContext: async () => makeWiContext(),
    });
    const result = await stage.execute(makeState(), makeCtx());
    expect(result.outputs.analyzer).toEqual({
      verdict: 'proceed',
      summary: 'WI is ready',
      reasons: [],
    });
    // Cost tracking: analyzer records costUsd returned by the runner
    expect((result.outputs.cost as PipelineCostInfo).total).toBeCloseTo(0.42, 4);
    expect((result.outputs.cost as PipelineCostInfo).perStage['analyzer']).toBeCloseTo(0.42, 4);
    // Tool-usage tracking: analyzer records toolUsage returned by the runner
    expect(result.outputs.toolUsage).toEqual({ Edit: 2, Bash: 1 });
  });

  it('reject: throws PipelineRejectError carrying reasons + summary + questions', async () => {
    const runner = makeRunner({
      verdict: 'reject',
      summary: 'Description is too vague',
      reasons: ['no AC', 'no clarity'],
      questions: ['What UI?', 'Which env?'],
    });
    const stage = createAnalyzerStage({
      config: baseConfig,
      ado: makeMockAdo(),
      runner,
      discoveredSkills: [],
      promptTemplate: 'x',
      fetchWiContext: async () => makeWiContext(),
    });
    let caught: unknown;
    try {
      await stage.execute(makeState(), makeCtx());
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PipelineRejectError);
    if (caught instanceof PipelineRejectError) {
      expect(caught.payload.summary).toBe('Description is too vague');
      expect(caught.payload.reasons).toEqual(['no AC', 'no clarity']);
      expect(caught.payload.questions).toEqual(['What UI?', 'Which env?']);
    }
  });

  it('forwards correct runner options (cwd, tools, disallowedTools, settingSources, systemPromptAppend, maxTurns)', async () => {
    const runner = makeRunner({ verdict: 'proceed', summary: 's', reasons: [] });
    const stage = createAnalyzerStage({
      config: baseConfig,
      ado: makeMockAdo(),
      runner,
      discoveredSkills: [],
      promptTemplate: 'PROMPT_BODY',
      fetchWiContext: async () => makeWiContext(),
    });
    await stage.execute(makeState(), makeCtx());
    expect(runner.calls).toHaveLength(1);
    const args = runner.calls[0]!;
    expect(args.tools).toEqual(['Read', 'Grep', 'Glob', 'Bash', 'Skill']);
    expect(args.disallowedTools).toEqual(['Edit', 'Write', 'NotebookEdit']);
    expect(args.cwd).toBe('/repos/target');
    expect(args.systemPromptAppend).toBe('PROMPT_BODY');
    expect(args.settingSources).toEqual(['project']);
    expect(args.maxTurns).toBe(20);
  });

  it('propagates non-reject runner errors as terminal failures', async () => {
    const runner = makeRunner(async () => {
      throw new Error('runner exploded');
    });
    const stage = createAnalyzerStage({
      config: baseConfig,
      ado: makeMockAdo(),
      runner,
      discoveredSkills: [],
      promptTemplate: 'x',
      fetchWiContext: async () => makeWiContext(),
    });
    await expect(stage.execute(makeState(), makeCtx())).rejects.toThrow(
      'runner exploded',
    );
  });

  it('persists wiContext to state.outputs.wiContext on proceed (so coder can read it)', async () => {
    const runner = makeRunner({ verdict: 'proceed', summary: 's', reasons: [] });
    const wiContext = makeWiContext();
    const stage = createAnalyzerStage({
      config: baseConfig,
      ado: makeMockAdo(),
      runner,
      discoveredSkills: [],
      promptTemplate: 'x',
      fetchWiContext: async () => wiContext,
    });
    const result = await stage.execute(makeState(), makeCtx());
    expect(result.outputs.wiContext).toEqual(wiContext);
  });

  describe('default read-only Bash allowlist (no canUseTool override)', () => {
    async function capturedCanUseTool() {
      const runner = makeRunner({ verdict: 'proceed', summary: 's', reasons: [] });
      const stage = createAnalyzerStage({
        config: baseConfig,
        ado: makeMockAdo(),
        runner,
        discoveredSkills: [],
        promptTemplate: 'x',
        fetchWiContext: async () => makeWiContext(),
      });
      await stage.execute(makeState(), makeCtx());
      const canUseTool = runner.calls[0]?.canUseTool;
      expect(canUseTool).toBeDefined();
      return canUseTool!;
    }

    it('installs a canUseTool filter when none is injected', async () => {
      await capturedCanUseTool();
    });

    it('allows read-only commands (git log, ls)', async () => {
      const filter = await capturedCanUseTool();
      expect((await filter('Bash', { command: 'git log --oneline' })).behavior).toBe('allow');
      expect((await filter('Bash', { command: 'ls src' })).behavior).toBe('allow');
    });

    it('denies mutating commands (git commit, git push, rm)', async () => {
      const filter = await capturedCanUseTool();
      expect((await filter('Bash', { command: 'git commit -m "x"' })).behavior).toBe('deny');
      expect((await filter('Bash', { command: 'git push origin main' })).behavior).toBe('deny');
      expect((await filter('Bash', { command: 'rm -rf src' })).behavior).toBe('deny');
    });

    it('an injected canUseTool still takes precedence', async () => {
      const runner = makeRunner({ verdict: 'proceed', summary: 's', reasons: [] });
      const injected = async () => ({ behavior: 'allow' as const });
      const stage = createAnalyzerStage({
        config: baseConfig,
        ado: makeMockAdo(),
        runner,
        discoveredSkills: [],
        promptTemplate: 'x',
        canUseTool: injected,
        fetchWiContext: async () => makeWiContext(),
      });
      await stage.execute(makeState(), makeCtx());
      expect(runner.calls[0]?.canUseTool).toBe(injected);
    });
  });
});
