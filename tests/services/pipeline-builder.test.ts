import { describe, it, expect } from 'bun:test';
import { buildPipeline } from '../../src/services/pipeline-builder.ts';
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
  };
}

function makeWorktreeManager(): WorktreeManager {
  return {
    ensureWorktree: async () => sampleWorktree,
    removeWorktree: async () => {},
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

describe('buildPipeline (Plan 4 full chain)', () => {
  it('returns the 4-stage pipeline in order: analyzer → worktree-setup → revision-loop → test-author', () => {
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
    });
    expect(stages).toHaveLength(4);
    expect(stages.map((s) => s.name)).toEqual([
      'analyzer',
      'worktree-setup',
      'revision-loop',
      'test-author',
    ]);
  });

  it('end-to-end happy path: analyzer proceeds → coder commits → reviewer (stub) approves → test-author commits', async () => {
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
      return {};
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
      getCurrentHeadSha: async () => 'deadbeef',
      resetWorktree: async () => {},
    });
    let state = makeState();
    const ctx = makeCtx();
    for (const stage of stages) {
      state = await stage.execute(state, ctx);
    }
    expect(runner.calls).toHaveLength(3); // analyzer + coder + test-author (reviewer is stub)
    expect(state.outputs.analyzer).toBeDefined();
    expect(state.outputs.worktree).toEqual(sampleWorktree);
    expect(state.outputs.coder).toEqual({
      summary: 'coded',
      filesChanged: ['x.ts'],
      commits: ['abc'],
    });
    expect(state.outputs.reviewer).toEqual({ approved: true, feedback: [] });
    expect(state.outputs.testAuthor).toEqual({
      summary: 'tested',
      testFilesChanged: ['x.test.ts'],
      commits: ['def'],
    });
  });

  it('revisionLoop with stub reviewer runs exactly one iteration', async () => {
    const runner = makeRecordingRunner(() => ({
      summary: 's',
      filesChanged: [],
      commits: [],
    }));
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
    expect(result.outputs.reviewer).toEqual({ approved: true, feedback: [] });
    expect(runner.calls).toHaveLength(1);
  });
});
