import { describe, it, expect, mock } from 'bun:test';
import { buildPipeline } from '../../src/services/pipeline-builder.ts';
import { REVIEW_AXES } from '../../src/pipeline/stages/reviewer.ts';
import { createLogger } from '../../src/utils/logger.ts';
import type { AdoClient } from '../../src/sdk/azure-devops-client.ts';
import type {
  AppConfig,
  PipelineState,
  WorktreeContext,
} from '../../src/types/index.ts';
import type {
  AgentRunArgs,
  AgentRunner,
} from '../../src/pipeline/agent-stage.ts';
import type { WorktreeManager } from '../../src/services/worktree-manager.ts';

const config: AppConfig = {
  org: 'o',
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
  dryRun: false,
};

const sampleWorktree: WorktreeContext = {
  path: '/w/wi-101-fix-login',
  branch: 'agent/wi-101-fix-login',
  baseSha: 'abc123',
};

function makeAdo(): AdoClient {
  return {
    queryWorkItemsByTag: async () => [],
    getWorkItem: async () => ({
      id: 101,
      fields: { 'System.Title': 'WI', 'System.State': 'Active' },
    }),
    getWorkItemComments: async () => [],
    addTagToWorkItem: async () => {},
    removeTagFromWorkItem: async () => {},
    addWorkItemComment: async () => {},
    createPullRequest: async () => ({ id: 0, url: '', sourceRefName: '', targetRefName: '' }),
  };
}

function makeWorktreeManager(): WorktreeManager {
  return {
    ensureWorktree: async () => sampleWorktree,
    removeWorktree: mock(async () => {}),
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
    attempts: {},
    outputs: {},
  };
}

function makeCtx() {
  return {
    config,
    logger: createLogger(),
    abortFlag: { aborted: false },
    signal: new AbortController().signal,
    now: () => new Date(),
  };
}

interface RecordingRunner extends AgentRunner {
  calls: AgentRunArgs<unknown>[];
}

function makeRecordingRunner(
  responder: (args: AgentRunArgs<unknown>) => unknown,
): RecordingRunner {
  const calls: AgentRunArgs<unknown>[] = [];
  return {
    calls,
    async run<T>(args: AgentRunArgs<T>): Promise<T> {
      calls.push(args as AgentRunArgs<unknown>);
      return responder(args as AgentRunArgs<unknown>) as unknown as T;
    },
  };
}

describe('buildPipeline (Plan 5 full chain, legacy tests)', () => {
  it('returns the 6-stage pipeline in order: analyzer → worktree-setup → revision-loop → test-author → draft-pr-creator → worktree-teardown', () => {
    const stages = buildPipeline({
      config,
      logger: createLogger(),
      ado: makeAdo(),
      runner: makeRecordingRunner(() => ({})),
      worktreeManager: makeWorktreeManager(),
      discoveredSkills: [],
      analyzerPromptTemplate: 'A',
      coderPromptTemplate: 'C',
      testAuthorPromptTemplate: 'T',
      prDescriptionTemplate: 'D',
      pushBranch: mock(async () => {}),
    });
    expect(stages).toHaveLength(6);
    expect(stages.map((s) => s.name)).toEqual([
      'analyzer',
      'worktree-setup',
      'revision-loop',
      'test-author',
      'draft-pr-creator',
      'worktree-teardown',
    ]);
  });

  it('end-to-end happy path: analyzer proceeds → coder commits → reviewer approves → test-author commits → draft-pr-creator → worktree-teardown', async () => {
    const runner = makeRecordingRunner((args) => {
      const sysPrompt = args.systemPromptAppend ?? '';
      if (sysPrompt === 'A') {
        return { verdict: 'proceed', summary: 'ready', reasons: [] };
      }
      if (sysPrompt === 'C') {
        return { summary: 'coded', filesChanged: ['x.ts'], commits: ['abc'] };
      }
      if (sysPrompt === 'T') {
        return {
          summary: 'tested',
          testFilesChanged: ['x.test.ts'],
          commits: ['def'],
        };
      }
      if (sysPrompt.startsWith('R\n\n')) {
        return { findings: [] };
      }
      return {};
    });
    const worktreeManager = makeWorktreeManager();
    const ado = makeAdo();
    const pushBranch = mock(async () => {});
    const stages = buildPipeline({
      config,
      logger: createLogger(),
      ado,
      runner,
      worktreeManager,
      discoveredSkills: [],
      analyzerPromptTemplate: 'A',
      coderPromptTemplate: 'C',
      testAuthorPromptTemplate: 'T',
      reviewerSharedPromptTemplate: 'R',
      reviewerAxisPromptTemplates: Object.fromEntries(
        REVIEW_AXES.map((a) => [a, a]),
      ) as Record<typeof REVIEW_AXES[number], string>,
      prDescriptionTemplate: 'D',
      pushBranch,
      getCurrentHeadSha: async () => 'deadbeef',
      resetWorktree: async () => {},
    });
    let state = makeState();
    const ctx = makeCtx();
    for (const stage of stages) {
      state = await stage.execute(state, ctx);
    }
    // 9 = analyzer + coder + 6 reviewer axes + test-author
    expect(runner.calls).toHaveLength(9);
    expect(state.outputs.analyzer).toBeDefined();
    expect(state.outputs.worktree).toEqual(sampleWorktree);
    expect(state.outputs.coder).toEqual({
      summary: 'coded',
      filesChanged: ['x.ts'],
      commits: ['abc'],
    });
    expect(state.outputs.reviewer).toEqual({ approved: true, findings: [], attempts: 1 });
    expect(state.outputs.testAuthor).toEqual({
      summary: 'tested',
      testFilesChanged: ['x.test.ts'],
      commits: ['def'],
    });
    expect(state.outputs.draftPr).toMatchObject({ id: 0, url: '', branch: sampleWorktree.branch });
    expect(pushBranch).toHaveBeenCalledTimes(1);
    expect(worktreeManager.removeWorktree as ReturnType<typeof mock>).toHaveBeenCalledTimes(1);
  });

  it('revisionLoop runs exactly one iteration (coder + 6 reviewer axes)', async () => {
    const runner = makeRecordingRunner((args) => {
      const sysPrompt = args.systemPromptAppend ?? '';
      if (sysPrompt.startsWith('R\n\n')) {
        return { findings: [] };
      }
      // coder call
      return { summary: 's', filesChanged: [], commits: [] };
    });
    const stages = buildPipeline({
      config,
      logger: createLogger(),
      ado: makeAdo(),
      runner,
      worktreeManager: makeWorktreeManager(),
      discoveredSkills: [],
      analyzerPromptTemplate: 'A',
      coderPromptTemplate: 'C',
      testAuthorPromptTemplate: 'T',
      reviewerSharedPromptTemplate: 'R',
      reviewerAxisPromptTemplates: Object.fromEntries(
        REVIEW_AXES.map((a) => [a, a]),
      ) as Record<typeof REVIEW_AXES[number], string>,
      prDescriptionTemplate: 'D',
      pushBranch: mock(async () => {}),
      getCurrentHeadSha: async () => 'deadbeef',
      resetWorktree: async () => {},
    });
    const revisionLoopStage = stages[2]!;
    expect(revisionLoopStage.name).toBe('revision-loop');
    const state = makeState();
    state.outputs.analyzer = { verdict: 'proceed', summary: 's', reasons: [] };
    state.outputs.wiContext = {
      id: 101,
      title: 't',
      workItemType: '',
      state: '',
      description: '',
      reproSteps: '',
      acceptanceCriteria: '',
      images: [],
      comments: [],
    };
    state.outputs.worktree = sampleWorktree;
    const result = await revisionLoopStage.execute(state, makeCtx());
    expect(result.outputs.reviewer).toEqual({ approved: true, findings: [], attempts: 1 });
    // 7 = coder + 6 reviewer axes
    expect(runner.calls).toHaveLength(7);
  });
});

describe('buildPipeline (Plan 5 full chain)', () => {
  it('onExhausted throws when reviewer rejects maxRevisions times', async () => {
    const localConfig: AppConfig = { ...config, maxRevisions: 2 };
    const runner = makeRecordingRunner((args) => {
      const sys = args.systemPromptAppend ?? '';
      if (sys === 'C') {
        return { summary: 'coded', filesChanged: [], commits: [] };
      }
      if (sys.startsWith('R\n\n')) {
        // reviewer always blocks
        return { findings: [{ severity: 'blocking', title: 'Bad', file: 'x.ts' }] };
      }
      return {};
    });
    const stages = buildPipeline({
      config: localConfig,
      logger: createLogger(),
      ado: makeAdo(),
      runner,
      worktreeManager: makeWorktreeManager(),
      discoveredSkills: [],
      analyzerPromptTemplate: 'A',
      coderPromptTemplate: 'C',
      testAuthorPromptTemplate: 'T',
      reviewerSharedPromptTemplate: 'R',
      reviewerAxisPromptTemplates: Object.fromEntries(
        REVIEW_AXES.map((a) => [a, a]),
      ) as Record<typeof REVIEW_AXES[number], string>,
      prDescriptionTemplate: 'D',
      pushBranch: mock(async () => {}),
      getCurrentHeadSha: async () => 'deadbeef',
      resetWorktree: async () => {},
    });
    const revisionLoopStage = stages[2]!;
    expect(revisionLoopStage.name).toBe('revision-loop');

    const state = makeState();
    state.outputs.analyzer = { verdict: 'proceed', summary: 's', reasons: [] };
    state.outputs.wiContext = {
      id: 101,
      title: 't',
      workItemType: '',
      state: '',
      description: '',
      reproSteps: '',
      acceptanceCriteria: '',
      images: [],
      comments: [],
    };
    state.outputs.worktree = sampleWorktree;

    await expect(revisionLoopStage.execute(state, makeCtx())).rejects.toThrow(/exhausted/i);
  });

  it('injects prDescriptionTemplate override into the draft-PR creator stage', async () => {
    const capturedDescriptions: string[] = [];
    const ado: AdoClient = {
      ...makeAdo(),
      createPullRequest: mock(async (args) => {
        capturedDescriptions.push(args.description);
        return { id: 42, url: 'https://example.com/pr/42', sourceRefName: '', targetRefName: '' };
      }),
    };
    const pushBranch = mock(async () => {});

    const runner = makeRecordingRunner((args) => {
      const sys = args.systemPromptAppend ?? '';
      if (sys === 'A') return { verdict: 'proceed', summary: 'ready', reasons: [] };
      if (sys === 'C') return { summary: 'coded', filesChanged: ['x.ts'], commits: ['abc'] };
      if (sys === 'T') return { summary: 'tested', testFilesChanged: ['x.test.ts'], commits: ['def'] };
      if (sys.startsWith('R\n\n')) return { findings: [] };
      return {};
    });

    const stages = buildPipeline({
      config,
      logger: createLogger(),
      ado,
      runner,
      worktreeManager: makeWorktreeManager(),
      discoveredSkills: [],
      analyzerPromptTemplate: 'A',
      coderPromptTemplate: 'C',
      testAuthorPromptTemplate: 'T',
      reviewerSharedPromptTemplate: 'R',
      reviewerAxisPromptTemplates: Object.fromEntries(
        REVIEW_AXES.map((a) => [a, a]),
      ) as Record<typeof REVIEW_AXES[number], string>,
      prDescriptionTemplate: 'CUSTOM_TEMPLATE {{wi-id}}',
      pushBranch,
      getCurrentHeadSha: async () => 'deadbeef',
      resetWorktree: async () => {},
    });

    let state = makeState();
    state.outputs.wiContext = {
      id: 101,
      title: 'Fix Login',
      workItemType: 'Bug',
      state: 'Active',
      description: 'desc',
      reproSteps: '',
      acceptanceCriteria: '',
      images: [],
      comments: [],
    };
    const ctx = makeCtx();
    for (const stage of stages) {
      state = await stage.execute(state, ctx);
    }

    expect(capturedDescriptions).toHaveLength(1);
    expect(capturedDescriptions[0]).toContain('CUSTOM_TEMPLATE');
    expect(capturedDescriptions[0]).toContain('101');
    expect(state.outputs.draftPr).toMatchObject({ id: 42, url: 'https://example.com/pr/42' });
  });
});
