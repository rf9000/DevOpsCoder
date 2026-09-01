import { describe, it, expect, mock } from 'bun:test';
import { buildFixPrompt, createBuildAndTestStage } from '../../../src/pipeline/stages/build-and-test.ts';
import { AgentOutputParseError } from '../../../src/services/claude-agent-runner.ts';
import { createLogger } from '../../../src/utils/logger.ts';
import type { AgentRunArgs, AgentRunner } from '../../../src/pipeline/agent-stage.ts';
import type { ContiniaCli, TestRunResult } from '../../../src/services/continia-cli.ts';
import type {
  AppConfig,
  DeployAppResult,
  EnvironmentOutput,
  PipelineCostInfo,
  PipelineState,
  TestRunRecord,
  VerificationOutput,
  WorktreeContext,
} from '../../../src/types/index.ts';
import type { WorkItemContext } from '../../../src/services/wi-context.ts';
import type { DiscoveredSkill } from '../../../src/services/skill-loader.ts';
import type { AlApp } from '../../../src/utils/al-app-graph.ts';

const wiCtx: WorkItemContext = {
  id: 101,
  title: 'Fix login',
  workItemType: 'Bug',
  state: 'Active',
  description: 'The login button is broken',
  reproSteps: '',
  acceptanceCriteria: '',
  images: [],
  comments: [],
};

const worktree: WorktreeContext = {
  path: '/repos/.worktrees/wi-101-fix-login',
  branch: 'agent/wi-101-fix-login',
  baseSha: 'abc123',
};

const environment: EnvironmentOutput = {
  envId: 'env-9',
  name: 'wi-101-fix-login',
  url: 'https://bc/env-9',
  status: 'Running',
  createdAt: '2026-07-07T10:00:00Z',
};

describe('buildFixPrompt', () => {
  it('renders compile errors when the deploy round failed to compile', () => {
    const deploy: DeployAppResult[] = [
      { app: 'Continia Core', compiled: true, published: true },
      { app: 'Continia Banking', compiled: false, published: false, error: 'AL0118: missing symbol Foo' },
    ];
    const prompt = buildFixPrompt(
      { compiled: false, deploy, testRuns: [] },
      wiCtx, worktree, environment, 1, 2,
    );
    expect(prompt).toContain('Work Item 101: Fix login');
    expect(prompt).toContain('fix attempt 1 of 2');
    expect(prompt).toContain('Compile / deploy errors');
    expect(prompt).toContain('Continia Banking');
    expect(prompt).toContain('AL0118: missing symbol Foo');
    expect(prompt).not.toContain('## Failing tests');
    expect(prompt).toContain('env-9');
  });

  it('renders failing tests grouped by codeunit when compiled but red', () => {
    const testRuns: TestRunRecord[] = [
      {
        attempt: 0, codeunitId: 148001, codeunitName: 'CDO Setup Tests', passed: false,
        summary: { total: 3, passed: 2, failed: 1, skipped: 0 },
        tests: [
          { name: 'GreenTest', result: 'Pass' },
          { name: 'RedTest', result: 'Fail', errorMessage: 'Expected 1, got 0', stackTrace: '"CDO Feature"(Codeunit 70001).Calculate line 12' },
        ],
      },
      {
        attempt: 0, codeunitId: 148002, passed: true,
        summary: { total: 1, passed: 1, failed: 0, skipped: 0 },
        tests: [{ name: 'OtherGreen', result: 'Pass' }],
      },
    ];
    const prompt = buildFixPrompt(
      { compiled: true, deploy: [], testRuns },
      wiCtx, worktree, environment, 2, 2,
    );
    expect(prompt).toContain('fix attempt 2 of 2');
    expect(prompt).toContain('## Failing tests');
    expect(prompt).toContain('Codeunit 148001');
    expect(prompt).toContain('CDO Setup Tests');
    expect(prompt).toContain('RedTest');
    expect(prompt).toContain('Expected 1, got 0');
    expect(prompt).toContain('Codeunit 70001');
    // Green tests and green codeunits are noise — not rendered.
    expect(prompt).not.toContain('GreenTest');
    expect(prompt).not.toContain('148002');
    expect(prompt).not.toContain('Compile / deploy errors');
  });

  it('trims long stack traces to ~15 lines and ~1500 chars', () => {
    const longTrace = Array.from({ length: 60 }, (_, i) => `frame ${i} ${'x'.repeat(80)}`).join('\n');
    const testRuns: TestRunRecord[] = [{
      attempt: 0, codeunitId: 148001, passed: false,
      summary: { total: 1, passed: 0, failed: 1, skipped: 0 },
      tests: [{ name: 'T', result: 'Fail', errorMessage: 'e', stackTrace: longTrace }],
    }];
    const prompt = buildFixPrompt(
      { compiled: true, deploy: [], testRuns },
      wiCtx, worktree, environment, 1, 2,
    );
    expect(prompt).toContain('frame 0');
    expect(prompt).not.toContain('frame 20');
    expect(prompt).toContain('truncated');
  });

  it('mentions the do-not-weaken-tests rule', () => {
    const prompt = buildFixPrompt(
      { compiled: false, deploy: [{ app: 'A', compiled: false, published: false, error: 'x' }], testRuns: [] },
      wiCtx, worktree, environment, 1, 2,
    );
    expect(prompt.toLowerCase()).toContain('do not weaken');
  });

  it('advertises invocable skills when provided', () => {
    const prompt = buildFixPrompt(
      { compiled: false, deploy: [{ app: 'A', compiled: false, published: false, error: 'x' }], testRuns: [] },
      wiCtx, worktree, environment, 1, 2,
      [{ name: 'continia-deploy', description: 'Compile and deploy AL code to a BC environment.' }],
    );
    expect(prompt).toContain('## Available Invocable Skills');
    expect(prompt).toContain('**continia-deploy**: Compile and deploy AL code');
  });
});

// ---------------------------------------------------------------------------
// Stage behavior
// ---------------------------------------------------------------------------

const baseConfig: AppConfig = {
  orgUrl: 'https://x', project: 'p', pat: 't',
  repositoryName: 'test-repo',
  targetRepoPath: '/repos/target', worktreeBase: '/repos/.worktrees',
  triggerTag: 'agent implement', blockedTag: 'agent-blocked', needInputTag: 'need-input',
  pollIntervalMinutes: 5, concurrency: 1, maxRevisions: 3, maxRejectCycles: 3,
  coderMaxTurns: 80, testAuthorMaxTurns: 50,
  maxCostUsdPerWi: 5.00, stageTimeoutMs: {},
  claudeModel: 'm', stateDir: '.state', assignedToFilter: [],
  continiaCliPath: '.tools/continia.exe',
  continiaEnvProfileId: 'prof-1',
  continiaApiToken: 'tok',
  continiaAppPaths: ['Core/Cloud', 'Banking/Cloud'],
  continiaTestAppPaths: ['Banking/Test'],
  maxTestFixAttempts: 2,
  continiaTestTimeoutS: 600,
  dryRun: false,
  skipBuildTest: false, testSelection: 'all', maxTestCodeunits: 0, costLogPath: '.state/cost-ledger.jsonl',
};

const greenDeploy: DeployAppResult[] = [{ app: 'A', compiled: true, published: true }];
const redDeploy: DeployAppResult[] = [
  { app: 'A', compiled: false, published: false, code: 'compile-failed', error: 'AL0118: missing symbol' },
];
/** An environment problem, not a source problem — no AL edit can fix it. */
const infraDeploy: DeployAppResult[] = [
  {
    app: 'Continia Software_Continia Banking - Export',
    compiled: false,
    published: false,
    code: 'dependency-not-on-env',
    error: 'Continia Core is not installed on env-9',
  },
];

const greenRun: TestRunResult = {
  status: 'completed', passed: true,
  summary: { total: 2, passed: 2, failed: 0, skipped: 0 },
  tests: [{ name: 'T1', result: 'Pass' }, { name: 'T2', result: 'Pass' }],
};
const redRun: TestRunResult = {
  status: 'completed', passed: false,
  summary: { total: 2, passed: 1, failed: 1, skipped: 0 },
  tests: [
    { name: 'T1', result: 'Pass' },
    { name: 'T2', result: 'Fail', errorMessage: 'boom', stackTrace: 'Codeunit 70001 line 5' },
  ],
};

interface StageHarness {
  cli: ContiniaCli;
  callOrder: string[];
  runnerCalls: AgentRunArgs<unknown>[];
  resets: string[];
  testOpts: Array<number | undefined>;
}

function makeHarness(opts: {
  deployQueue?: DeployAppResult[][];
  testQueue?: TestRunResult[];
  runnerBehavior?: () => Promise<unknown>;
  codeunits?: Array<{ id: number; name: string; file: string }>;
  skills?: DiscoveredSkill[];
  config?: AppConfig;
  changedFiles?: string[];
  apps?: AlApp[];
} = {}) {
  const callOrder: string[] = [];
  const deployQueue = [...(opts.deployQueue ?? [greenDeploy])];
  const testQueue = [...(opts.testQueue ?? [])];
  const testOpts: Array<number | undefined> = [];
  const cli: ContiniaCli = {
    createEnvironment: mock(async () => ({ id: 'env-9', status: 'Draft' })),
    startEnvironment: mock(async () => {}),
    getEnvironment: mock(async () => ({ id: 'env-9', status: 'Running' })),
    waitForRunning: mock(async () => {
      callOrder.push('waitForRunning');
      return { id: 'env-9', status: 'Running', url: 'https://bc/env-9' };
    }),
    installAppById: mock(async (_e: string, appId: string) => {
      callOrder.push(`install-app:${appId}`);
    }),
    installDependencies: mock(async (_e: string, app: string) => {
      callOrder.push(`install:${app}`);
      return { skippedCount: 0, symbolsMissingCount: 0 };
    }),
    downloadSymbols: mock(async (_e: string, app: string) => {
      callOrder.push(`download:${app}`);
    }),
    deployApp: mock(async (_e: string, app: string) => {
      callOrder.push(`deploy:${app}`);
      return deployQueue.length > 1 ? deployQueue.shift()! : deployQueue[0]!;
    }),
    runTests: mock(async (_e: string, codeunitId: number, o: { timeoutSeconds?: number }) => {
      callOrder.push(`test:${codeunitId}`);
      testOpts.push(o.timeoutSeconds);
      if (testQueue.length === 0) return greenRun;
      return testQueue.length > 1 ? testQueue.shift()! : testQueue[0]!;
    }),
  } as unknown as ContiniaCli;

  const runnerCalls: AgentRunArgs<unknown>[] = [];
  const runner: AgentRunner = {
    async run<T>(args: AgentRunArgs<T>) {
      runnerCalls.push(args as AgentRunArgs<unknown>);
      callOrder.push('fix-call');
      if (opts.runnerBehavior) {
        const value = (await opts.runnerBehavior()) as T;
        return { value, costUsd: 0.5, toolUsage: { Edit: 1 } };
      }
      return {
        value: { summary: 'fixed', filesChanged: ['a.al'], commits: ['fix'] } as unknown as T,
        costUsd: 0.5,
        toolUsage: { Edit: 1 },
      };
    },
  };

  const resets: string[] = [];
  const stage = createBuildAndTestStage({
    config: opts.config ?? baseConfig,
    continiaCli: cli,
    runner,
    logger: createLogger(),
    fixerPromptTemplate: 'FIXER_PROMPT',
    discoveredSkills: opts.skills ?? [],
    getCurrentHeadSha: async () => 'base-sha',
    resetWorktree: async (_p, sha) => { resets.push(sha); },
    discoverTestCodeunits: async () =>
      opts.codeunits ?? [
        { id: 148001, name: 'Tests A', file: 'x.al' },
        { id: 148002, name: 'Tests B', file: 'y.al' },
      ],
    getChangedFiles: async () => opts.changedFiles ?? [],
    discoverAlApps: () => opts.apps ?? [],
  });

  return { stage, cli, callOrder, runnerCalls, resets, testOpts };
}

function makeStageState(): PipelineState {
  return {
    workItemId: 101,
    slug: 'fix-login',
    startedAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    currentStage: 'build-and-test',
    history: [],
    outputs: {
      worktree,
      environment,
      wiContext: wiCtx,
      coder: { summary: 's', filesChanged: [], commits: [] },
    },
  };
}

function makeStageCtx(overrides: Partial<{ aborted: boolean }> = {}) {
  return {
    config: baseConfig,
    logger: createLogger(),
    abortFlag: { aborted: overrides.aborted ?? false },
    signal: new AbortController().signal,
    now: () => new Date('2026-07-07T10:00:00Z'),
  };
}

describe('createBuildAndTestStage', () => {
  it('green first pass: waits, installs deps, downloads, deploys, tests sequentially — zero fix calls', async () => {
    const { stage, callOrder, runnerCalls } = makeHarness();
    const result = await stage.execute(makeStageState(), makeStageCtx());

    expect(callOrder).toEqual([
      'waitForRunning',
      'install-app:c3755ece-dab0-4d16-987d-040661f18522',
      'install:Core/Cloud', 'install:Banking/Cloud',
      'download:Core/Cloud', 'download:Banking/Cloud',
      'deploy:Core/Cloud', 'deploy:Banking/Cloud',
      'test:148001', 'test:148002',
    ]);
    expect(runnerCalls).toHaveLength(0);
    const verification = result.outputs.verification as VerificationOutput;
    expect(verification.passed).toBe(true);
    expect(verification.compiled).toBe(true);
    expect(verification.attempts).toBe(0);
    expect(verification.testRuns).toHaveLength(2);
  });

  it('compile failure → one fix call → redeploy green → passes with attempts=1 and cost tracked', async () => {
    const { stage, runnerCalls } = makeHarness({
      // First deploy round red (both apps' calls return red), then green.
      deployQueue: [redDeploy, redDeploy, greenDeploy],
    });
    const result = await stage.execute(makeStageState(), makeStageCtx());

    expect(runnerCalls).toHaveLength(1);
    const fixArgs = runnerCalls[0]!;
    expect(fixArgs.systemPromptAppend).toBe('FIXER_PROMPT');
    expect(fixArgs.prompt).toContain('AL0118');
    expect(fixArgs.prompt).toContain('fix attempt 1 of 2');
    expect(fixArgs.cwd).toBe(worktree.path);

    const verification = result.outputs.verification as VerificationOutput;
    expect(verification.passed).toBe(true);
    expect(verification.attempts).toBe(1);
    const cost = result.outputs.cost as PipelineCostInfo;
    expect(cost.perStage['build-and-test']).toBeCloseTo(0.5, 4);
    expect((result.outputs.toolUsage as Record<string, number>)['Edit']).toBe(1);
  });

  it('failing tests → fix call prompt contains the failure → re-run green', async () => {
    const { stage, runnerCalls } = makeHarness({
      testQueue: [redRun, greenRun, greenRun, greenRun],
    });
    const result = await stage.execute(makeStageState(), makeStageCtx());
    expect(runnerCalls).toHaveLength(1);
    expect(runnerCalls[0]!.prompt).toContain('T2');
    expect(runnerCalls[0]!.prompt).toContain('boom');
    expect((result.outputs.verification as VerificationOutput).passed).toBe(true);
  });

  it('still red after maxTestFixAttempts → throws VerificationFailedError', async () => {
    const { stage, runnerCalls } = makeHarness({ testQueue: [redRun] });
    let caught: unknown;
    try {
      await stage.execute(makeStageState(), makeStageCtx());
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/verification failed/);
    expect(runnerCalls).toHaveLength(2); // maxTestFixAttempts fix calls
  });

  it('persists a red verification output before throwing', async () => {
    const { stage } = makeHarness({ testQueue: [redRun] });
    const state = makeStageState();
    try {
      await stage.execute(state, makeStageCtx());
    } catch {
      // expected
    }
    const verification = state.outputs.verification as VerificationOutput;
    expect(verification.passed).toBe(false);
    expect(verification.testRuns[0]?.tests.some((t) => t.name === 'T2')).toBe(true);
  });

  it('zero discovered test codeunits → verification-failed throw', async () => {
    const { stage } = makeHarness({ codeunits: [] });
    await expect(stage.execute(makeStageState(), makeStageCtx())).rejects.toThrow(
      /verification failed.*no test codeunits/i,
    );
  });

  it('returns early without fix calls when abortFlag is set', async () => {
    const { stage, runnerCalls } = makeHarness({ testQueue: [redRun] });
    const ctx = makeStageCtx();
    // Abort as soon as the first red round completes.
    (ctx.abortFlag as { aborted: boolean }).aborted = true;
    const result = await stage.execute(makeStageState(), ctx);
    expect(runnerCalls).toHaveLength(0);
    expect(result.outputs.verification).toBeUndefined();
  });

  it('AgentOutputParseError in the fix call → reset + retry, then continue', async () => {
    let calls = 0;
    const { stage, resets, runnerCalls } = makeHarness({
      deployQueue: [redDeploy, redDeploy, greenDeploy],
      runnerBehavior: async () => {
        calls++;
        if (calls === 1) throw new AgentOutputParseError('bad json', 'raw');
        return { summary: 'fixed', filesChanged: [], commits: [] };
      },
    });
    const result = await stage.execute(makeStageState(), makeStageCtx());
    expect(runnerCalls).toHaveLength(2);
    expect(resets).toEqual(['base-sha']);
    expect((result.outputs.verification as VerificationOutput).passed).toBe(true);
  });

  it('hard runner error in the fix call → reset + rethrow', async () => {
    const { stage, resets } = makeHarness({
      deployQueue: [redDeploy],
      runnerBehavior: async () => { throw new Error('runner exploded'); },
    });
    await expect(stage.execute(makeStageState(), makeStageCtx())).rejects.toThrow('runner exploded');
    expect(resets).toEqual(['base-sha']);
  });

  // An unpublished dependency / stale symbol cache is an environment problem.
  // Feeding it to the test-fixer burns every fix attempt (and the money) on an
  // agent that cannot possibly fix it by editing AL, then reports the wrong
  // cause. Stop immediately with the CLI's own actionable message instead.
  it('an environment-level deploy failure stops immediately without a fix call', async () => {
    const { stage, runnerCalls } = makeHarness({ deployQueue: [infraDeploy] });
    const err: unknown = await stage
      .execute(makeStageState(), makeStageCtx())
      .then(() => undefined)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain('dependency-not-on-env');
    expect(message).toContain('Continia Core is not installed');
    // Not a verification failure: the change was never actually verified.
    expect(message).not.toContain('verification failed');
    expect(runnerCalls).toHaveLength(0);
  });

  it('a compile failure is still a red round that feeds the fix loop', async () => {
    const { stage, runnerCalls } = makeHarness({
      deployQueue: [redDeploy, redDeploy, greenDeploy],
    });
    await stage.execute(makeStageState(), makeStageCtx());
    expect(runnerCalls).toHaveLength(1);
    expect(runnerCalls[0]!.prompt).toContain('AL0118');
  });

  it('throws when required upstream outputs are missing', async () => {
    const { stage } = makeHarness();
    const state = makeStageState();
    delete state.outputs.environment;
    await expect(stage.execute(state, makeStageCtx())).rejects.toThrow(/environment/);
  });

  it('forwards config.continiaTestTimeoutS to every runTests call', async () => {
    const { stage, testOpts } = makeHarness();
    await stage.execute(makeStageState(), makeStageCtx());
    expect(testOpts).toEqual([600, 600]);
  });

  describe('test selection', () => {
    // Discovery returns absolute paths under the worktree; selection compares
    // them against git's worktree-relative diff output.
    const codeunits = [
      { id: 148001, name: 'Tests A', file: `${worktree.path}/Test/A.al` },
      { id: 148002, name: 'Tests B', file: `${worktree.path}/Test/B.al` },
    ];

    it('mode=changed runs only the test codeunits in changed files', async () => {
      const { stage, callOrder } = makeHarness({
        config: { ...baseConfig, testSelection: 'changed' },
        codeunits,
        changedFiles: ['Test/A.al'],
      });
      await stage.execute(makeStageState(), makeStageCtx());
      expect(callOrder.filter((c) => c.startsWith('test:'))).toEqual(['test:148001']);
    });

    it('the cap limits how many codeunits a round runs', async () => {
      const { stage, callOrder } = makeHarness({
        config: { ...baseConfig, testSelection: 'all', maxTestCodeunits: 1 },
        codeunits,
      });
      await stage.execute(makeStageState(), makeStageCtx());
      expect(callOrder.filter((c) => c.startsWith('test:'))).toEqual(['test:148001']);
    });

    it('derives the deploy set from changed files + selected tests, dependency-first', async () => {
      // No CONTINIA_APP_PATHS: a static list cannot be right for a repo where
      // one WI touches base-application and the next touches export.
      const apps: AlApp[] = [
        { dir: 'permission-sets', name: 'PS', dependencies: [] },
        { dir: 'base-application', name: 'Continia Banking', dependencies: ['PS'] },
        { dir: 'export', name: 'Continia Banking - Export', dependencies: ['Continia Banking'] },
        { dir: 'base-application-test', name: 'Base Test', dependencies: ['Continia Banking'] },
      ];
      const { stage, callOrder } = makeHarness({
        config: { ...baseConfig, continiaAppPaths: [], testSelection: 'changed' },
        apps,
        codeunits: [
          { id: 148001, name: 'Base Tests', file: `${worktree.path}/base-application-test/T.al` },
        ],
        changedFiles: ['base-application/Bank/Tables/Bank.Table.al', 'base-application-test/T.al'],
      });
      await stage.execute(makeStageState(), makeStageCtx());

      // export is untouched, so it is not deployed; permission-sets is pulled in
      // as a dependency and lands before the app that needs it.
      expect(callOrder.filter((c) => c.startsWith('deploy:'))).toEqual([
        'deploy:permission-sets',
        'deploy:base-application',
        'deploy:base-application-test',
      ]);
    });

    it('a change in export deploys export, not base-application-test', async () => {
      const apps: AlApp[] = [
        { dir: 'base-application', name: 'Continia Banking', dependencies: [] },
        { dir: 'export', name: 'Continia Banking - Export', dependencies: ['Continia Banking'] },
        { dir: 'export-test', name: 'Export Test', dependencies: ['Continia Banking - Export'] },
        { dir: 'base-application-test', name: 'Base Test', dependencies: ['Continia Banking'] },
      ];
      const { stage, callOrder } = makeHarness({
        config: { ...baseConfig, continiaAppPaths: [], testSelection: 'changed' },
        apps,
        codeunits: [
          { id: 148002, name: 'Export Tests', file: `${worktree.path}/export-test/T.al` },
        ],
        changedFiles: ['export/Codeunits/X.al', 'export-test/T.al'],
      });
      await stage.execute(makeStageState(), makeStageCtx());

      const deploys = callOrder.filter((c) => c.startsWith('deploy:'));
      expect(deploys).toEqual(['deploy:base-application', 'deploy:export', 'deploy:export-test']);
      expect(deploys).not.toContain('deploy:base-application-test');
    });

    it('fails loudly rather than passing when the selection is empty', async () => {
      // An empty selection means the change is unverified — the exact thing
      // this gate exists to catch. It must not read as green.
      const { stage, callOrder } = makeHarness({
        config: { ...baseConfig, testSelection: 'changed' },
        codeunits,
        changedFiles: ['docs/README.md'],
      });
      await expect(stage.execute(makeStageState(), makeStageCtx())).rejects.toThrow(
        /no test codeunits selected/,
      );
      expect(callOrder.filter((c) => c.startsWith('test:'))).toEqual([]);
    });
  });

  it('passes discoveredSkills through to the fix prompt', async () => {
    const { stage, runnerCalls } = makeHarness({
      deployQueue: [redDeploy, redDeploy, greenDeploy],
      skills: [{ name: 'continia-test', description: 'Run AL tests on a BC environment.' }],
    });
    await stage.execute(makeStageState(), makeStageCtx());
    expect(runnerCalls[0]!.prompt).toContain('**continia-test**');
  });
});
