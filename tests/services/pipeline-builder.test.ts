import { describe, it, expect } from 'bun:test';
import { buildPipeline } from '../../src/services/pipeline-builder.ts';
import { createLogger } from '../../src/utils/logger.ts';
import type { AdoClient } from '../../src/sdk/azure-devops-client.ts';
import type { AppConfig, PipelineState } from '../../src/types/index.ts';
import type {
  AgentRunArgs,
  AgentRunner,
} from '../../src/pipeline/agent-stage.ts';

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
  claudeModel: 'claude-opus-4-7',
  stateDir: '.state',
  assignedToFilter: [],
  dryRun: false,
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

function makeState(): PipelineState {
  return {
    workItemId: 101,
    slug: 'wi',
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

function makeRecordingRunner(): RecordingRunner {
  const calls: AgentRunArgs<unknown>[] = [];
  return {
    calls,
    async run<T>(args: AgentRunArgs<T>): Promise<T> {
      calls.push(args as AgentRunArgs<unknown>);
      return { verdict: 'proceed', summary: 'ok', reasons: [] } as unknown as T;
    },
  };
}

describe('buildPipeline', () => {
  it('returns a single-stage pipeline with the analyzer at index 0', () => {
    const stages = buildPipeline({
      config,
      logger: createLogger(),
      ado: makeAdo(),
      runner: makeRecordingRunner(),
      discoveredSkills: [],
      analyzerPromptTemplate: 'prompt body',
    });
    expect(stages).toHaveLength(1);
    expect(stages[0]?.name).toBe('analyzer');
  });

  it('forwards discoveredSkills and analyzerPromptTemplate into the analyzer call', async () => {
    const runner = makeRecordingRunner();
    const stages = buildPipeline({
      config,
      logger: createLogger(),
      ado: makeAdo(),
      runner,
      discoveredSkills: [
        { name: 'a-skill', description: 'A description', skillDir: '/d' },
      ],
      analyzerPromptTemplate: 'TEMPLATE_BODY',
    });
    await stages[0]!.execute(makeState(), makeCtx());
    expect(runner.calls).toHaveLength(1);
    const args = runner.calls[0]!;
    expect(args.systemPromptAppend).toBe('TEMPLATE_BODY');
    expect(args.prompt).toContain('- **a-skill**: A description');
  });
});
