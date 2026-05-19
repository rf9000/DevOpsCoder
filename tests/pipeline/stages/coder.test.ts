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
} from '../../../src/pipeline/agent-stage.ts';
import type {
  AppConfig,
  CoderOutput,
  Finding,
  PipelineState,
  ReviewerOutput,
  WorktreeContext,
} from '../../../src/types/index.ts';
import type { WorkItemContext } from '../../../src/services/wi-context.ts';
import type { DiscoveredSkill } from '../../../src/services/skill-loader.ts';
import type { AnalyzerOutput } from '../../../src/pipeline/stages/analyzer.ts';

const baseConfig: AppConfig = {
  org: 'o',
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
  dryRun: false,
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
    attempts: {},
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
    now: () => new Date(),
  };
}

interface RecordingRunner extends AgentRunner {
  calls: AgentRunArgs<unknown>[];
}

function makeRunner(
  result: CoderOutput | ((call: number) => Promise<CoderOutput>),
): RecordingRunner {
  const calls: AgentRunArgs<unknown>[] = [];
  let i = 0;
  return {
    calls,
    async run<T>(args: AgentRunArgs<T>): Promise<T> {
      calls.push(args as AgentRunArgs<unknown>);
      const out = typeof result === 'function' ? await result(i++) : result;
      return out as unknown as T;
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
      { name: 'al-formatter', description: 'Formats AL', skillDir: '/x' },
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
    const runner = makeRunner(successOutput);
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
