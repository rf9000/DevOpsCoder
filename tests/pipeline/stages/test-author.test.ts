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
} from '../../../src/pipeline/agent-stage.ts';
import type {
  AppConfig,
  CoderOutput,
  PipelineState,
  TestAuthorOutput,
  WorktreeContext,
} from '../../../src/types/index.ts';
import type { WorkItemContext } from '../../../src/services/wi-context.ts';
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
    attempts: {},
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
    const runner = makeRunner(successOutput);
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
