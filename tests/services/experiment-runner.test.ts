import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadConfig } from '../../src/config/index.ts';
import {
  SCHEMA_DOWNGRADE_ERROR,
  assertIsolatedTargetRepo,
  replayContext,
  runExperiment,
  runSlug,
  variantsSchema,
  type ExperimentDeps,
  type RunResult,
  type Variant,
} from '../../src/services/experiment-runner.ts';
import { createReadOnlyAdoClient } from '../../src/services/read-only-ado.ts';
import type { AdoClient } from '../../src/sdk/azure-devops-client.ts';
import { PipelineRejectError, type Stage } from '../../src/pipeline/stage.ts';
import type { AppConfig, PipelineState } from '../../src/types/index.ts';
import { createCostTracker } from '../../src/utils/cost-tracker.ts';
import type { Logger } from '../../src/utils/logger.ts';
import { TEST_USAGE } from '../helpers/agent-usage.ts';
import type { WorkItemContext } from '../../src/services/wi-context.ts';

const quiet: Logger = { info: () => {}, warn: () => {}, error: () => {} };

const baseEnv = {
  AZURE_DEVOPS_PAT: 'pat',
  AZURE_DEVOPS_ORG: 'org',
  AZURE_DEVOPS_PROJECT: 'proj',
  ADO_REPOSITORY_NAME: 'repo',
  TARGET_REPO_PATH: '/repo',
  WORKTREE_BASE: '/wt',
  MAX_COST_USD_PER_WI: '100',
  CONTINIA_API_TOKEN: 'tok',
};

// Every write method throws, so any stage that slips past the strip list fails loudly.
const ado = createReadOnlyAdoClient({
  getWorkItem: async () => ({ id: 1, fields: {} }),
} as unknown as AdoClient);

const wiContext: WorkItemContext = {
  id: 7,
  title: 'T',
  workItemType: 'Bug',
  state: 'Closed',
  description: '',
  reproSteps: '',
  acceptanceCriteria: '',
  images: [],
  comments: [
    { author: 'a', createdDate: '2026-09-01T00:00:00Z', text: 'repro' },
    { author: 'b', createdDate: '2026-09-10T00:00:00Z', text: 'fixed in PR !1' },
  ],
};

interface Harness {
  deps: ExperimentDeps;
  calls: { stage: string; variant: string; config: AppConfig }[];
  analyzerRuns: number;
  refereeRuns: number;
}

function makeHarness(
  outDir: string,
  wtDir: string,
  opts: {
    variants?: Variant[];
    coderFails?: (config: AppConfig) => string | undefined;
    analyzerRejects?: boolean;
    maxTotalUsd?: number;
    reps?: number;
  } = {},
): Harness {
  const h: Harness = { deps: undefined as unknown as ExperimentDeps, calls: [], analyzerRuns: 0, refereeRuns: 0 };
  const variantOf = (config: AppConfig): string => config.stateDir.split(/[\\/]/).at(-2) ?? '?';

  const stage = (name: string, run: (state: PipelineState, config: AppConfig) => void, config: AppConfig): Stage => ({
    name,
    canRun: () => true,
    async execute(state) {
      h.calls.push({ stage: name, variant: variantOf(config), config });
      run(state, config);
      return state;
    },
  });

  h.deps = {
    baseEnv,
    corpus: [{ wiId: 7, baseSha: 'abc1234', commentsBefore: '2026-09-05T00:00:00Z' }],
    variants: opts.variants ?? [
      { name: 'cheap', env: { CLAUDE_EFFORT_CODER: 'low' }, rerunAnalyzer: false },
      { name: 'baseline', env: {}, rerunAnalyzer: false },
    ],
    outDir,
    runId: 'run-1',
    reps: opts.reps ?? 1,
    ...(opts.maxTotalUsd !== undefined ? { maxTotalUsd: opts.maxTotalUsd } : {}),
    referee: true,
    logger: quiet,
    ado,
    abortFlag: { aborted: false },
    loadConfig,
    git: async (args) => (args[0] === 'diff' && args[1] === '--shortstat' ? ' 2 files changed, 5 insertions(+), 1 deletion(-)' : ''),
    createRunner: () => ({ run: async () => { throw new Error('no LLM in tests'); } }),
    createWorktreeManager: () => ({ ensureWorktree: async () => { throw new Error('unused'); }, removeWorktree: async () => {} }),
    runPrMessageStep: async () => ({
      message: { title: 't', bullets: ['b'] },
      costUsd: 0.1,
      toolUsage: {},
      usage: TEST_USAGE,
    }),
    createReferee: () => ({
      name: 'reviewer',
      canRun: () => true,
      async execute(state) {
        h.refereeRuns += 1;
        createCostTracker(state).add('reviewer:security', 2, TEST_USAGE);
        state.outputs.reviewer = {
          approved: false,
          attempts: 1,
          byAxis: {},
          findings: [{ severity: 'critical', file: 'a.al', title: 'x', description: 'd', axis: 'security' }],
        };
        return state;
      },
    }),
    fetchWiContext: async () => wiContext,
    prMessagePromptTemplate: 'tpl',
    buildPipeline: (bd) => {
      const config = bd.config;
      return [
        {
          name: 'analyzer',
          canRun: () => true,
          async execute(state) {
            h.analyzerRuns += 1;
            const ctx = await bd.fetchWiContext!(bd.ado, state.workItemId);
            createCostTracker(state).add('analyzer', 1, TEST_USAGE);
            state.outputs.wiContext = ctx;
            if (opts.analyzerRejects) throw new PipelineRejectError({ reasons: ['r'], summary: 'not ready' });
            state.outputs.analyzer = { verdict: 'proceed', targetRepoPath: config.targetRepoPath };
            return state;
          },
        },
        stage('worktree-setup', (state) => {
          state.outputs.worktree = { path: wtDir, branch: `agent/wi-7-${state.slug}`, baseSha: 'abc1234' };
        }, config),
        stage('revision-loop', (state, c) => {
          const msg = opts.coderFails?.(c);
          createCostTracker(state).add('coder', c.stepEffort?.coder === 'low' ? 1 : 5, TEST_USAGE);
          if (msg) throw new Error(msg);
          state.outputs.coder = { summary: 's', filesChanged: [], commits: [] };
          state.outputs.reviewer = { approved: true, attempts: 2, byAxis: {}, findings: [] };
        }, config),
        stage('build-and-test', (state) => {
          state.outputs.verification = {
            attempts: 1,
            compiled: true,
            passed: true,
            deploy: [],
            testRuns: [{ attempt: 1, codeunitId: 1, passed: true, summary: { total: 3, passed: 3, failed: 0, skipped: 0 }, tests: [] }],
          };
        }, config),
        stage('draft-pr-creator', () => { throw new Error('draft-pr-creator must never run in a replay'); }, config),
        stage('worktree-teardown', () => { throw new Error('teardown must never run in a replay'); }, config),
      ];
    },
  };
  return h;
}

describe('runExperiment', () => {
  let root: string;
  let outDir: string;
  let wtDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'exp-'));
    outDir = join(root, 'runs', 'run-1');
    wtDir = join(root, 'wt');
    mkdirSync(wtDir);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('runs baseline first, shares one analyzer, isolates state, and never runs PR or teardown stages', async () => {
    const h = makeHarness(outDir, wtDir);
    const summary = await runExperiment(h.deps);

    expect(summary.results.map((r) => [r.variant, r.outcome])).toEqual([
      ['baseline', 'completed'],
      ['cheap', 'completed'],
    ]);
    expect(h.analyzerRuns).toBe(1);
    expect(h.calls.map((c) => c.stage)).not.toContain('draft-pr-creator');
    expect(h.calls.map((c) => c.stage)).not.toContain('worktree-teardown');

    const coderCall = h.calls.find((c) => c.stage === 'revision-loop' && c.variant === 'cheap-1')!;
    expect(coderCall.config.worktreeBaseRef).toBe('abc1234');
    expect(coderCall.config.stateDir).toBe(join(outDir, '7', 'cheap-1', 'state'));
    expect(coderCall.config.stepEffort?.coder).toBe('low');

    const cheap = summary.results.find((r) => r.variant === 'cheap')!;
    // Variant pays coder + pr-message; analyzer and referee are overhead.
    expect(cheap.costUsd).toBeCloseTo(1.1);
    expect(cheap.perStage.analyzer).toBeUndefined();
    expect(cheap.verification).toMatchObject({ finalGate: true, passed: true, testsPassed: 3, testsFailed: 0 });
    expect(cheap.reviewer?.rounds).toBe(2);
    expect(cheap.referee?.findings.critical).toBe(1);
    expect(cheap.diff).toEqual({ files: 2, insertions: 5, deletions: 1 });
    expect(summary.overheadUsd).toBeCloseTo(1 + 2 * 2);
    expect(existsSync(join(outDir, '7', 'cheap-1', 'result.json'))).toBe(true);
  });

  it('feeds the analyzer a replayed context: comments after the cutoff dropped, state Active', async () => {
    const h = makeHarness(outDir, wtDir);
    await runExperiment(h.deps);
    const cached = JSON.parse(readFileSync(join(outDir, '7', 'analyzer.json'), 'utf-8')) as { wiContext: WorkItemContext };
    expect(cached.wiContext.state).toBe('Active');
    expect(cached.wiContext.comments.map((c) => c.text)).toEqual(['repro']);
  });

  it('skips finished runs on a second invocation', async () => {
    await runExperiment(makeHarness(outDir, wtDir).deps);
    const again = makeHarness(outDir, wtDir);
    const summary = await runExperiment(again.deps);
    expect(again.calls).toEqual([]);
    expect(again.analyzerRuns).toBe(0);
    expect(summary.results).toHaveLength(2);
  });

  it('stops starting runs once the budget is spent', async () => {
    const h = makeHarness(outDir, wtDir, { maxTotalUsd: 3 });
    const summary = await runExperiment(h.deps);
    expect(summary.results.map((r) => r.variant)).toEqual(['baseline']);
    expect(summary.skippedForBudget).toBe(1);
  });

  it('marks a rate-limited run unscored, writes no result.json, and resumes it next time', async () => {
    let limited = true;
    const h = makeHarness(outDir, wtDir, {
      coderFails: (c) => (limited && c.stepEffort?.coder === 'low' ? 'API Error: 429 rate_limit_error' : undefined),
    });
    const first = await runExperiment(h.deps);
    expect(first.results.find((r) => r.variant === 'cheap')?.outcome).toBe('rate-limited');
    expect(existsSync(join(outDir, '7', 'cheap-1', 'result.json'))).toBe(false);

    limited = false;
    const second = await runExperiment(makeHarness(outDir, wtDir, { coderFails: () => undefined }).deps);
    const cheap = second.results.find((r) => r.variant === 'cheap')!;
    expect(cheap.outcome).toBe('completed');
    // Resumed at the failed stage: the first attempt's coder spend is kept.
    expect(cheap.perStage.coder?.calls).toBe(2);
  });

  it('deletes only harness-named environments after each run', async () => {
    const h = makeHarness(outDir, wtDir);
    const deleted: string[] = [];
    h.deps.createContiniaCli = () => ({ deleteEnvironment: async (id: string) => { deleted.push(id); } });
    const inner = h.deps.buildPipeline!;
    h.deps.buildPipeline = (bd) =>
      inner(bd).map((st) =>
        st.name !== 'worktree-setup'
          ? st
          : {
              ...st,
              async execute(state, ctx) {
                const out = await st.execute(state, ctx);
                const harness = state.slug.includes('-cheap-');
                out.outputs.environment = {
                  envId: harness ? 'env-h' : 'env-x',
                  name: harness ? `wi-7-${state.slug}` : 'someone-elses-env',
                  status: 'Running',
                  createdAt: '2026-10-03T00:00:00Z',
                };
                return out;
              },
            },
      );
    await runExperiment(h.deps);
    expect(deleted).toEqual(['env-h']);
  });

  it('marks a run that never got an environment env-failed, unscored, and resumes it', async () => {
    const h = makeHarness(outDir, wtDir);
    const inner = h.deps.buildPipeline!;
    let quotaFull = true;
    h.deps.buildPipeline = (bd) => [
      ...inner(bd).slice(0, 2),
      {
        name: 'env-provision',
        canRun: () => true,
        async execute(state) {
          if (quotaFull) throw new Error('environment_create_error: You can only have 50 environments.');
          return state;
        },
      },
      ...inner(bd).slice(2),
    ];
    const first = await runExperiment(h.deps);
    expect(first.results.map((r) => r.outcome)).toEqual(['env-failed', 'env-failed']);
    expect(existsSync(join(outDir, '7', 'baseline-1', 'result.json'))).toBe(false);
    quotaFull = false;
    const second = await runExperiment(h.deps);
    expect(second.results.map((r) => r.outcome)).toEqual(['completed', 'completed']);
  });

  it('a resumed run whose worktree is gone goes back through worktree-setup', async () => {
    const h = makeHarness(outDir, wtDir, { variants: [{ name: 'baseline', env: {}, rerunAnalyzer: false }] });
    const inner = h.deps.buildPipeline!;
    let quotaFull = true;
    h.deps.buildPipeline = (bd) => {
      const stages = inner(bd);
      const setup = stages[1]!;
      return [
        stages[0]!,
        {
          ...setup,
          async execute(state, ctx) {
            await setup.execute(state, ctx);
            // A path that does not exist: as if an earlier invocation removed it.
            state.outputs.worktree = { path: join(root, 'gone'), branch: 'b', baseSha: 'abc1234' };
            return state;
          },
        },
        {
          name: 'env-provision',
          canRun: () => true,
          async execute(state) {
            if (quotaFull) throw new Error('quota');
            return state;
          },
        },
        ...stages.slice(2),
      ];
    };
    await runExperiment(h.deps);
    const before = h.calls.filter((c) => c.stage === 'worktree-setup').length;
    quotaFull = false;
    await runExperiment(h.deps);
    expect(h.calls.filter((c) => c.stage === 'worktree-setup').length).toBe(before + 1);
  });

  it('records an ordinary failure with its stage and scores it', async () => {
    const h = makeHarness(outDir, wtDir, { coderFails: () => 'reviewer rejected 3 times' });
    const summary = await runExperiment(h.deps);
    const r = summary.results[0] as RunResult;
    expect(r.outcome).toBe('failed');
    expect(r.error).toEqual({ stage: 'revision-loop', message: 'reviewer rejected 3 times' });
  });

  it('caches an analyzer rejection so no variant re-pays for it', async () => {
    const h = makeHarness(outDir, wtDir, { analyzerRejects: true });
    const summary = await runExperiment(h.deps);
    expect(summary.results).toEqual([]);
    expect(h.analyzerRuns).toBe(1);
  });

  it('skips every variant when the base does not compile, and caches the verdict', async () => {
    const h = makeHarness(outDir, wtDir);
    let checks = 0;
    h.deps.checkBase = async (e) => {
      checks += 1;
      return { wiId: e.wiId, status: 'compile-failed', redCodeunits: [], deployErrors: 'AA0139' };
    };
    const summary = await runExperiment(h.deps);
    expect(summary.results).toEqual([]);
    expect(summary.baseChecks.map((c) => c.status)).toEqual(['compile-failed']);
    expect(h.analyzerRuns).toBe(0);
    await runExperiment(h.deps);
    expect(checks).toBe(1);
  });

  it('skips every variant when the base is too old to publish on today\'s environment', async () => {
    const h = makeHarness(outDir, wtDir);
    h.deps.checkBase = async (e) => ({ wiId: e.wiId, status: 'base-too-old', redCodeunits: [] });
    const summary = await runExperiment(h.deps);
    expect(summary.results).toEqual([]);
    expect(existsSync(join(outDir, '7', 'base-check.json'))).toBe(true);
  });

  it('SCHEMA_DOWNGRADE_ERROR matches the BC publish refusal, not a compile error', () => {
    expect(SCHEMA_DOWNGRADE_ERROR.test("Table 71553575 CTS-CB Banking Setup :: The field 'Currency Provider ETag' cannot be located. Removing fields is not allowed.")).toBe(true);
    expect(SCHEMA_DOWNGRADE_ERROR.test('error AA0210: The table does not contain a key')).toBe(false);
  });

  it('runs variants on a base with red tests, but records them', async () => {
    const h = makeHarness(outDir, wtDir);
    h.deps.checkBase = async (e) => ({ wiId: e.wiId, status: 'tests-red', redCodeunits: [{ id: 95298, failed: 17 }] });
    const summary = await runExperiment(h.deps);
    expect(summary.results).toHaveLength(2);
    expect(summary.baseChecks[0]?.redCodeunits).toEqual([{ id: 95298, failed: 17 }]);
  });

  it('--base-check-only runs the checks and nothing else', async () => {
    const h = makeHarness(outDir, wtDir);
    h.deps.baseCheckOnly = true;
    h.deps.checkBase = async (e) => ({ wiId: e.wiId, status: 'green', redCodeunits: [] });
    const summary = await runExperiment(h.deps);
    expect(summary.baseChecks.map((c) => c.status)).toEqual(['green']);
    expect(summary.results).toEqual([]);
    expect(h.analyzerRuns).toBe(0);
    expect(h.calls).toEqual([]);
  });

  it('an env-blocked base check runs the variants and is not cached', async () => {
    const h = makeHarness(outDir, wtDir);
    h.deps.checkBase = async (e) => ({ wiId: e.wiId, status: 'env-blocked', redCodeunits: [], deployErrors: '503' });
    const summary = await runExperiment(h.deps);
    expect(summary.results).toHaveLength(2);
    expect(existsSync(join(outDir, '7', 'base-check.json'))).toBe(false);
  });

  it('a base check that throws does not block the experiment and is retried next time', async () => {
    const h = makeHarness(outDir, wtDir);
    h.deps.checkBase = async () => { throw new Error('demo portal down'); };
    const summary = await runExperiment(h.deps);
    expect(summary.baseChecks[0]).toMatchObject({ status: 'unchecked', reason: expect.stringContaining('demo portal down') });
    expect(summary.results).toHaveLength(2);
    expect(existsSync(join(outDir, '7', 'base-check.json'))).toBe(false);
  });

  it('slugs carry run and variant so two experiments never share a branch', () => {
    expect(runSlug('run-1', 'baseline', 1)).not.toBe(runSlug('run-2', 'baseline', 1));
    expect(runSlug('run-1', 'baseline', 1)).not.toBe(runSlug('run-1', 'cheap', 1));
  });
});

describe('assertIsolatedTargetRepo', () => {
  const fakeGit = (gitDir: string, worktrees: string[]) => async (args: string[]) => {
    if (args[1] === '--git-dir') return `${gitDir}\n`;
    if (args[1] === '--git-common-dir') return '/clone/.git\n';
    return worktrees.map((w) => `worktree ${w}\nHEAD abc\n`).join('\n');
  };

  it('accepts a main working tree whose only other worktrees live under the base', async () => {
    await assertIsolatedTargetRepo('/clone', '/wt', fakeGit('/clone/.git', ['/clone', '/wt/wi-1-xab12c-baseline-r1']));
  });

  it('rejects a linked worktree (it shares another clone\'s .git)', async () => {
    await expect(
      assertIsolatedTargetRepo('/clone', '/wt', fakeGit('/clone/.git/worktrees/session', ['/clone'])),
    ).rejects.toThrow(/linked worktree/);
  });

  it('rejects a clone with worktrees outside the base', async () => {
    await expect(
      assertIsolatedTargetRepo('/clone', '/wt', fakeGit('/clone/.git', ['/clone', '/elsewhere/bug-1'])),
    ).rejects.toThrow(/did not create/);
  });

  it('rejects a working clone whose own worktrees all sit under the base', async () => {
    await expect(
      assertIsolatedTargetRepo('/clone', '/wt', fakeGit('/clone/.git', ['/clone', '/wt/bug-82635-psd2', '/wt/wi-82205-telemetry'])),
    ).rejects.toThrow(/did not create/);
  });
});

describe('variantsSchema', () => {
  it('requires a baseline variant and unique names', () => {
    expect(variantsSchema.safeParse([{ name: 'a', env: {} }]).success).toBe(false);
    expect(variantsSchema.safeParse([{ name: 'baseline' }, { name: 'baseline' }]).success).toBe(false);
    expect(variantsSchema.safeParse([{ name: 'baseline' }]).success).toBe(true);
  });

  it('rejects names that would not survive the branch slug', () => {
    expect(variantsSchema.safeParse([{ name: 'baseline' }, { name: 'Has Space' }]).success).toBe(false);
  });
});

describe('replayContext', () => {
  it('keeps all comments when no cutoff is given', () => {
    expect(replayContext(wiContext, { wiId: 7, baseSha: 'abc1234' }).comments).toHaveLength(2);
  });
});
