import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { runPollCycle, createAbortFlag } from '../../src/services/watcher.ts';
import { createProcessor } from '../../src/services/processor.ts';
import { buildPipeline } from '../../src/services/pipeline-builder.ts';
import { REVIEW_AXES } from '../../src/pipeline/stages/reviewer.ts';
import { PipelineStateStore } from '../../src/state/state-store.ts';
import { createLogger } from '../../src/utils/logger.ts';
import type { AdoClient } from '../../src/sdk/azure-devops-client.ts';
import type { AppConfig, WorktreeContext } from '../../src/types/index.ts';
import type {
  AgentRunArgs,
  AgentRunner,
  AgentRunResult,
} from '../../src/pipeline/agent-stage.ts';
import type { WorktreeManager } from '../../src/services/worktree-manager.ts';
import type { PipelineBuilderDeps } from '../../src/services/pipeline-builder.ts';

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
  maxCostUsdPerWi: 0.50,
  stageTimeoutMs: {},
  claudeModel: 'claude-opus-4-7',
  stateDir: '',
  assignedToFilter: [],
  dryRun: false,
};

const sampleWorktree: WorktreeContext = {
  path: '/repos/.worktrees/wi-101-fix-login',
  branch: 'agent/wi-101-fix-login',
  baseSha: 'baselinesha123',
};

function makeAdo(
  taggedIds: number[],
  createPrImpl?: (args: unknown) => Promise<{ id: number; url: string; sourceRefName: string; targetRefName: string }>,
): AdoClient {
  return {
    queryWorkItemsByTag: mock(async () => taggedIds),
    getWorkItem: mock(async (id: number) => ({
      id,
      fields: {
        'System.Title': `WI ${id}`,
        'System.State': 'Active',
        'System.Tags': 'agent implement',
        'System.WorkItemType': 'Bug',
        'System.Description': '<p>desc</p>',
      },
    })),
    getWorkItemComments: mock(async () => []),
    addTagToWorkItem: mock(async () => {}),
    removeTagFromWorkItem: mock(async () => {}),
    addWorkItemComment: mock(async () => {}),
    createPullRequest: mock(
      createPrImpl ??
        (async () => ({
          id: 1,
          url: 'https://example.com/pr/1',
          sourceRefName: '',
          targetRefName: '',
        })),
    ),
  };
}

function makeWorktreeManager(): WorktreeManager {
  return {
    ensureWorktree: mock(async () => sampleWorktree),
    removeWorktree: mock(async () => {}),
  };
}

interface RecordingRunner extends AgentRunner {
  calls: AgentRunArgs<unknown>[];
}

/**
 * Slim makeStagedRunner for this file: the responder returns AgentRunResult<unknown>
 * directly (value + costUsd), so each call can carry its own costUsd for cost-cap
 * testing. Different from pr-e2e.ts which hard-codes costUsd:0 in the helper.
 */
function makeStagedRunner(
  responder: (args: AgentRunArgs<unknown>, callIndex: number) => AgentRunResult<unknown>,
): RecordingRunner {
  const calls: AgentRunArgs<unknown>[] = [];
  let i = 0;
  return {
    calls,
    async run<T>(args: AgentRunArgs<T>): Promise<AgentRunResult<T>> {
      calls.push(args as AgentRunArgs<unknown>);
      return responder(args as AgentRunArgs<unknown>, i++) as AgentRunResult<T>;
    },
  };
}

function makeBuildPipelineWrapper(
  runner: AgentRunner,
  worktreeManager: WorktreeManager,
  pushBranch: ((branch: string, cwd: string) => Promise<void>) | undefined = async () => {},
) {
  return (deps: PipelineBuilderDeps) =>
    buildPipeline({
      ...deps,
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
      getCurrentHeadSha: async () => sampleWorktree.baseSha,
      resetWorktree: async () => {},
      prDescriptionTemplate: 'D',
      pushBranch,
    });
}

describe('cost-cap e2e', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cost-cap-e2e-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('coder cost pushes cumulative past cap → reviewer completes revision-loop → cost check fires before test-author → blocked tag + cost comment + no PR + worktree retained', async () => {
    const config = { ...baseConfig, stateDir: dir, maxCostUsdPerWi: 0.50 };
    const store = new PipelineStateStore(dir);

    const ado = makeAdo([101]);
    const pushBranch = mock(async () => {});
    const worktreeManager = makeWorktreeManager();

    // Responder returns {value, costUsd} directly so each stage carries its own cost.
    // Flow:
    //   'A' (analyzer)   → costUsd 0.10, total 0.10 (under cap)
    //   'C' (coder)      → costUsd 0.45, total 0.55 (OVER cap — but check fires between stages)
    //   'R\n\naxis'      → costUsd 0     (reviewer axes; reviewer runs inside revision-loop
    //                                      before the between-stage cost check fires)
    // After revision-loop completes (coder + reviewer both succeed), orchestrator
    // advances currentStage to 'test-author'. The pre-stage cost check then reads
    // total=0.55 > cap=0.50 and throws CostExceededError with stage='test-author'.
    const runner = makeStagedRunner((args) => {
      const sys = args.systemPromptAppend ?? '';
      if (sys === 'A') {
        return { value: { verdict: 'proceed', summary: 'go', reasons: [] }, costUsd: 0.10, toolUsage: {} };
      }
      if (sys === 'C') {
        return { value: { summary: 'coded', filesChanged: ['x.ts'], commits: ['abc'] }, costUsd: 0.45, toolUsage: {} };
      }
      if (sys.startsWith('R\n\n')) {
        // Reviewer axis: return clean findings with zero cost.
        return { value: { findings: [] }, costUsd: 0, toolUsage: {} };
      }
      throw new Error(`unexpected stage prompt: ${sys}`);
    });

    const abortFlag = createAbortFlag();
    const processor = createProcessor({
      config,
      logger: createLogger(),
      ado,
      store,
      buildPipeline: makeBuildPipelineWrapper(runner, worktreeManager, pushBranch),
      abortFlag,
    });

    const stats = await runPollCycle({
      config,
      logger: createLogger(),
      ado,
      store,
      processor,
      abortFlag,
    });

    // --- Watcher stats ---
    expect(stats.failed).toBe(1);
    expect(stats.completed).toBe(0);

    // --- State has terminalError with cost-cap message ---
    const saved = store.load(101)!;
    expect(saved.terminalError).toBeDefined();
    expect(saved.terminalError?.message).toMatch(/cost cap/i);

    // --- Stage recorded on the terminalError ---
    // The cost-cap check fires BETWEEN top-level pipeline stages (in the orchestrator
    // loop). After revision-loop completes, currentStage advances to 'test-author'.
    // The pre-stage check then fires and records stage='test-author'.
    expect(saved.terminalError?.stage).toBe('test-author');

    // --- Runner call count ---
    // 1 analyzer + 1 coder + 6 reviewer axes (inside revision-loop, before
    // the between-stage check can fire) = 8 total. test-author never fires.
    expect(runner.calls).toHaveLength(8);

    // --- Cost comment posted ---
    expect((ado.addWorkItemComment as ReturnType<typeof mock>).mock.calls).toHaveLength(1);
    const html = (ado.addWorkItemComment as ReturnType<typeof mock>).mock.calls[0]?.[1] as string;
    expect(html).toMatch(/cost cap/i);
    expect(html).toContain('0.5000'); // the cap
    expect(html).toContain('0.5500'); // the cumulative total
    expect(html).toContain('analyzer');
    expect(html).toContain('coder');

    // --- Blocked tag added ---
    expect((ado.addTagToWorkItem as ReturnType<typeof mock>).mock.calls).toHaveLength(1);
    expect((ado.addTagToWorkItem as ReturnType<typeof mock>).mock.calls[0]).toEqual([101, 'agent-blocked']);

    // --- No PR ---
    expect(ado.createPullRequest).not.toHaveBeenCalled();

    // --- No push ---
    expect(pushBranch).not.toHaveBeenCalled();

    // --- Worktree retained — NOT removed ---
    expect(worktreeManager.removeWorktree).not.toHaveBeenCalled();
  });
});
