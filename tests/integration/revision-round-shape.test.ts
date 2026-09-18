import { describe, it, expect, mock } from 'bun:test';
import { buildPipeline, type PipelineBuilderDeps } from '../../src/services/pipeline-builder.ts';
import { REVIEW_AXES } from '../../src/pipeline/stages/reviewer.ts';
import { createLogger } from '../../src/utils/logger.ts';
import { makeGreenContiniaCli, greenCodeunits } from './_continia-fake.ts';
import type { AdoClient } from '../../src/sdk/azure-devops-client.ts';
import type {
  AppConfig,
  EnvironmentOutput,
  PipelineState,
  PlanOutput,
  WorktreeContext,
} from '../../src/types/index.ts';
import type {
  AgentRunner,
  AgentRunResult,
} from '../../src/pipeline/agent-stage.ts';
import type { PipelineContext } from '../../src/pipeline/stage.ts';
import type { WorktreeManager } from '../../src/services/worktree-manager.ts';
import { TEST_USAGE } from '../helpers/agent-usage.ts';

/**
 * Proves Task 8's wiring end to end: the revision loop's `initialProducer` /
 * `reviseProducer` / `verify` slots are actually connected, not merely
 * type-compatible. This is the defect the whole plan addresses — a real work
 * item spent $3.90 and 147 turns across rounds 2 and 3 re-planning and
 * re-implementing from the coder's full analyzer-framed prompt instead of
 * fixing seven targeted findings.
 */

const sampleWorktree: WorktreeContext = {
  path: '/w/wi-101-fix-login',
  branch: 'agent/wi-101-fix-login',
  baseSha: 'abc123',
};

const sampleEnvironment: EnvironmentOutput = {
  envId: 'env-9',
  name: 'wi-101-fix-login',
  url: 'https://bc/env-9',
  status: 'Running',
  createdAt: '2026-01-01T00:00:00Z',
};

/** A `stepModel` naming a `coder-plan` model — the on-switch for the plan step. */
const planningConfig: AppConfig = {
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
  reviewerMaxTurns: 50,
  testAuthorMaxTurns: 50,
  maxCostUsdPerWi: 5.0,
  stageTimeoutMs: {},
  claudeModel: 'claude-opus-4-7',
  stepModel: { 'coder-plan': 'm' },
  stateDir: '.state',
  logDir: 'logs',
  assignedToFilter: [],
  continiaCliPath: '.tools/continia.exe',
  continiaEnvProfileId: 'prof-1',
  continiaEnvLocalization: 'base',
  continiaApiToken: 'tok',
  continiaAppPaths: ['App'],
  continiaTestAppPaths: ['App'],
  maxTestFixAttempts: 2,
  continiaTestTimeoutS: 600,
  dryRun: false,
  skipBuildTest: false,
  testSelection: 'all',
  maxTestCodeunits: 0,
  costLogPath: '.state/cost-ledger.jsonl',
};

function makeAdo(): AdoClient {
  return {
    queryWorkItemsByTag: async () => [],
    getWorkItem: async () => ({
      id: 101,
      fields: { 'System.Title': 'WI', 'System.State': 'Active' },
    }),
    getWorkItemComments: async () => [],
    getWorkItemUpdates: async () => [],
    createPullRequestThread: async () => {},
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

/** Everything the revision loop needs already populated by upstream stages. */
function readyState(): PipelineState {
  return {
    workItemId: 101,
    slug: 'fix-login',
    startedAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    currentStage: 'revision-loop',
    history: [],
    outputs: {
      analyzer: { verdict: 'proceed', summary: 'ready', reasons: [] },
      wiContext: {
        id: 101,
        title: 'Fix login',
        workItemType: 'Bug',
        state: 'Active',
        description: 'The login button is broken',
        reproSteps: '',
        acceptanceCriteria: '',
        images: [],
        comments: [],
      },
      worktree: sampleWorktree,
      environment: sampleEnvironment,
    },
  };
}

function mockContext(): PipelineContext {
  return {
    config: planningConfig,
    logger: createLogger(),
    abortFlag: { aborted: false },
    signal: new AbortController().signal,
    now: () => new Date(),
  };
}

function agentResult<T>(value: T): AgentRunResult<T> {
  return { value, costUsd: 0.01, toolUsage: {}, usage: TEST_USAGE };
}

function planValue(): PlanOutput {
  return { approach: 'Read auth.ts, fix the null check', steps: ['fix it'], filesToTouch: ['a/A.al'], risks: [] };
}

const deps: PipelineBuilderDeps = {
  config: planningConfig,
  logger: createLogger(),
  ado: makeAdo(),
  worktreeManager: makeWorktreeManager(),
  continiaCli: makeGreenContiniaCli(),
  discoveredSkills: [],
  analyzerPromptTemplate: 'A',
  coderPromptTemplate: 'C',
  coderPlannerPromptTemplate: 'CP',
  fixFindingsPromptTemplate: 'FF',
  testAuthorPromptTemplate: 'T',
  testPlannerPromptTemplate: 'TP',
  testFixerPromptTemplate: 'F',
  reviewerSharedPromptTemplate: 'R',
  reviewerAxisPromptTemplates: Object.fromEntries(
    REVIEW_AXES.map((a) => [a, a]),
  ) as Record<typeof REVIEW_AXES[number], string>,
  prDescriptionTemplate: 'D',
  prMessagePromptTemplate: 'P',
  pushBranch: mock(async () => {}),
  getCurrentHeadSha: async () => 'deadbeef',
  resetWorktree: async () => {},
  discoverTestCodeunits: greenCodeunits,
};

describe('revision loop round shape (Task 8 — fix-findings + verify wiring)', () => {
  it('plans once, fixes on round 2, and hands the round-1 findings to the fixer', async () => {
    const labels: string[] = [];
    const prompts: Record<string, string> = {};
    let axisCalls = 0;

    const runner = {
      run: mock(async (opts: any) => {
        labels.push(opts.label);
        prompts[opts.label] = opts.prompt;
        if (opts.label.startsWith('reviewer:')) {
          axisCalls++;
          // 6 axes per round: calls 1-6 are round 1, 7-12 are round 2.
          const inRoundOne = axisCalls <= REVIEW_AXES.length;
          const blocking = inRoundOne && opts.label === 'reviewer:safety-correctness';
          return agentResult({
            findings: blocking
              ? [{ severity: 'blocking', file: 'a/A.al', line: 69,
                   title: 'TRYFUNC MODIFY', description: 'd', axis: 'safety-correctness' }]
              : [],
          });
        }
        if (opts.label.startsWith('coder:plan')) return agentResult(planValue());
        return agentResult({ summary: 's', filesChanged: ['a/A.al'], commits: ['sha'] });
      }),
    } as unknown as AgentRunner;

    const stages = buildPipeline({ ...deps, runner, config: planningConfig });
    const loop = stages.find((s) => s.name === 'revision-loop')!;
    const result = await loop.execute(readyState(), mockContext());

    // Reviewer approved on round 2 — the loop did not exhaust maxRevisions.
    expect((result.outputs.reviewer as { approved: boolean; attempts: number })).toMatchObject({
      approved: true,
      attempts: 2,
    });

    // The whole defect this plan addresses: re-planning and re-implementing
    // on every revision round instead of fixing findings. Exactly one plan
    // call across both rounds.
    expect(labels.filter((l) => l.startsWith('coder:plan'))).toHaveLength(1);
    // Round 1 runs the coder exactly once...
    expect(labels.filter((l) => l.startsWith('coder (attempt'))).toHaveLength(1);
    // ...round 2 runs fix-findings, NOT the coder again.
    expect(labels.filter((l) => l.startsWith('fix-findings'))).toHaveLength(1);

    // The fix-findings call carries round 1's finding...
    expect(prompts['fix-findings (attempt 1)']).toContain('TRYFUNC MODIFY');
    // ...and omits the analyzer framing the coder's prompt carries — the
    // narrowness that keeps a revision round from re-implementing the WI
    // from scratch.
    expect(prompts['fix-findings (attempt 1)']).not.toContain('Analyzer framing');

    // The verify gate actually ran each round (green throughout, via the
    // fake ContiniaCli) — it is wired into the loop, not merely typed in.
    expect(result.outputs.verification).toMatchObject({ passed: true });
  });
});
