import { describe, it, expect, mock } from 'bun:test';
import {
  buildFixFindingsPrompt,
  fixFindingsOutputSchema,
  createFixFindingsStage,
} from '../../../src/pipeline/stages/fix-findings.ts';
import type { Finding, WorktreeContext } from '../../../src/types/index.ts';
import type { AgentRunner } from '../../../src/pipeline/agent-stage.ts';
import type { PipelineContext } from '../../../src/pipeline/stage.ts';
import type { AppConfig, PipelineState, ReviewerOutput } from '../../../src/types/index.ts';
import { AgentOutputParseError } from '../../../src/services/claude-agent-runner.ts';

const worktree: WorktreeContext = {
  path: '/w/wi-82205',
  branch: 'agent/wi-82205',
  baseSha: 'abc1234',
};

const findings: Finding[] = [
  {
    severity: 'minor', file: 'a/B.al', line: 9,
    title: 'Name could be clearer', description: 'Rename it.', axis: 'naming-style',
  },
  {
    severity: 'blocking', file: 'a/A.al', line: 69,
    title: '[TryFunction] performs a database Modify',
    description: 'Writes inside a try method are not rolled back.',
    suggestion: 'Move the Modify outside the try wrapper.',
    axis: 'safety-correctness',
  },
];

function prompt(overrides: Partial<Parameters<typeof buildFixFindingsPrompt>[0]> = {}): string {
  return buildFixFindingsPrompt({
    findings,
    diff: 'diff --git a/A.al b/A.al\n+Rec.Modify();',
    worktree,
    workItemId: 82205,
    workItemTitle: 'Reconciliation telemetry',
    skills: [],
    round: 2,
    maxRounds: 3,
    ...overrides,
  });
}

describe('buildFixFindingsPrompt', () => {
  it('renders findings severity-descending with location, axis and suggestion', () => {
    const p = prompt();
    expect(p.indexOf('a/A.al:69')).toBeLessThan(p.indexOf('a/B.al:9'));
    expect(p).toContain('### blocking findings');
    expect(p).toContain('(safety-correctness)');
    expect(p).toContain('Move the Modify outside the try wrapper.');
  });

  // A transposition inside SEVERITY_ORDER would silently reorder findings
  // without failing the two-severity test above — exercise all five.
  it('orders all five severities blocking > critical > major > minor > nit', () => {
    const allSeverities: Finding[] = [
      { severity: 'nit', file: 'f-nit.al', title: 'nit', description: 'd', axis: 'naming-style' },
      { severity: 'minor', file: 'f-minor.al', title: 'minor', description: 'd', axis: 'naming-style' },
      { severity: 'major', file: 'f-major.al', title: 'major', description: 'd', axis: 'performance' },
      { severity: 'critical', file: 'f-critical.al', title: 'critical', description: 'd', axis: 'integration' },
      { severity: 'blocking', file: 'f-blocking.al', title: 'blocking', description: 'd', axis: 'security' },
    ];
    const p = prompt({ findings: allSeverities });
    const idx = {
      blocking: p.indexOf('### blocking findings'),
      critical: p.indexOf('### critical findings'),
      major: p.indexOf('### major findings'),
      minor: p.indexOf('### minor findings'),
      nit: p.indexOf('### nit findings'),
    };
    expect(idx.blocking).toBeGreaterThanOrEqual(0);
    expect(idx.critical).toBeGreaterThanOrEqual(0);
    expect(idx.major).toBeGreaterThanOrEqual(0);
    expect(idx.minor).toBeGreaterThanOrEqual(0);
    expect(idx.nit).toBeGreaterThanOrEqual(0);
    expect(idx.blocking).toBeLessThan(idx.critical);
    expect(idx.critical).toBeLessThan(idx.major);
    expect(idx.major).toBeLessThan(idx.minor);
    expect(idx.minor).toBeLessThan(idx.nit);
  });

  it('renders a file-level finding (no line) using the bare file path', () => {
    const fileLevel: Finding = {
      severity: 'major', file: 'a/WholeFile.al',
      title: 'File-level concern', description: 'Applies to the whole file.',
      axis: 'code-structure',
    };
    const p = prompt({ findings: [fileLevel] });
    expect(p).toContain('**a/WholeFile.al** (code-structure): File-level concern');
    expect(p).not.toContain('a/WholeFile.al:');
  });

  it('includes the diff and the round counter', () => {
    const p = prompt();
    expect(p).toContain('+Rec.Modify();');
    expect(p).toContain('round 2 of 3');
  });

  it('includes the approved plan when one is stored', () => {
    const p = prompt({
      plan: {
        approach: 'Emit telemetry from a subscriber',
        steps: ['Add subscriber'],
        filesToTouch: ['a/A.al'],
        risks: [],
      },
    });
    expect(p).toContain('Emit telemetry from a subscriber');
    expect(p).toContain('Add subscriber');
  });

  // THE regression test for this plan: a revision round must not be handed the
  // material that turns it back into a re-implementation. This checks only
  // the section HEADINGS a leak would arrive under — a renamed heading would
  // silently void it. It cannot check the actual body text (a WI description,
  // repro steps, etc.) because `BuildFixFindingsPromptArgs` has no parameter
  // that could carry it — `prompt()` above only ever passes `workItemId` /
  // `workItemTitle`. The body-leak proof — with SENTINEL_* text asserted
  // absent from the rendered prompt — lives in `createFixFindingsStage`'s
  // 'does not leak WI description, repro steps, acceptance criteria or
  // comments into the prompt' test below, which exercises the full
  // WorkItemContext the stage actually holds.
  it('omits the work item description, repro steps, AC, comments and analyzer framing', () => {
    const p = prompt();
    expect(p).not.toContain('Reproduction Steps');
    expect(p).not.toContain('Acceptance Criteria');
    expect(p).not.toContain('Comment history');
    expect(p).not.toContain('Analyzer framing');
    expect(p).not.toContain('## Description');
  });

  it('carries the WI id and title, and nothing else from the work item', () => {
    const p = prompt();
    expect(p).toContain('82205');
    expect(p).toContain('Reconciliation telemetry');
  });
});

describe('fixFindingsOutputSchema', () => {
  it('accepts a coder-shaped output with findingsAddressed', () => {
    const parsed = fixFindingsOutputSchema.parse({
      summary: 's', filesChanged: ['a/A.al'], commits: ['deadbee'],
      findingsAddressed: [
        { file: 'a/A.al', line: 69, action: 'fixed', reason: 'moved the Modify out' },
      ],
    });
    expect(parsed.findingsAddressed?.[0]?.action).toBe('fixed');
  });

  it('accepts output without findingsAddressed', () => {
    expect(fixFindingsOutputSchema.parse({ summary: 's', filesChanged: [], commits: [] })
      .findingsAddressed).toBeUndefined();
  });

  it('rejects an action outside fixed/declined', () => {
    expect(() => fixFindingsOutputSchema.parse({
      summary: 's', filesChanged: [], commits: [],
      findingsAddressed: [{ file: 'a/A.al', action: 'ignored', reason: 'r' }],
    })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// createFixFindingsStage
// ---------------------------------------------------------------------------

const FIXED_NOW = new Date('2026-05-04T12:00:00.000Z');

function mockContext(overrides: Partial<PipelineContext> = {}): PipelineContext {
  const config: AppConfig = {
    orgUrl: 'https://dev.azure.com/o', project: 'p', pat: 't',
    repositoryName: 'test-repo',
    targetRepoPath: '/r', worktreeBase: '/w',
    triggerTag: 'agent implement', blockedTag: 'agent-blocked', needInputTag: 'need-input',
    pollIntervalMinutes: 5, concurrency: 1, maxRevisions: 3, maxRejectCycles: 3,
    coderMaxTurns: 80, reviewerMaxTurns: 50, testAuthorMaxTurns: 50,
    maxCostUsdPerWi: 5.00, stageTimeoutMs: {},
    claudeModel: 'm', stateDir: '.state', logDir: 'logs', assignedToFilter: [], continiaCliPath: '.tools/continia.exe', continiaEnvProfileId: 'prof-1', continiaEnvLocalization: 'base', continiaApiToken: 'tok', continiaAppPaths: ['App'], continiaTestAppPaths: ['App'], maxTestFixAttempts: 2, continiaTestTimeoutS: 600, dryRun: false, skipBuildTest: false, testSelection: 'all', maxTestCodeunits: 0, costLogPath: '.state/cost-ledger.jsonl',
  };
  return {
    config,
    logger: { info: mock(() => {}), warn: mock(() => {}), error: mock(() => {}) },
    abortFlag: { aborted: false },
    signal: new AbortController().signal,
    now: () => FIXED_NOW,
    ...overrides,
  };
}

function mockState(): PipelineState {
  return {
    workItemId: 101,
    slug: 'wi-101',
    startedAt: FIXED_NOW.toISOString(),
    updatedAt: FIXED_NOW.toISOString(),
    currentStage: null,
    history: [],
    outputs: {},
  };
}

function stateWithFindings(): PipelineState {
  const s = mockState();
  s.outputs.worktree = worktree;
  s.outputs.wiContext = { id: 82205, title: 'Reconciliation telemetry' };
  s.outputs.reviewer = { approved: false, findings, attempts: 1 } satisfies ReviewerOutput;
  return s;
}

function okRunner(captured: { prompt?: string; model?: string; maxTurns?: number }): AgentRunner {
  return {
    run: mock(async (opts: any) => {
      captured.prompt = opts.prompt;
      captured.model = opts.model;
      captured.maxTurns = opts.maxTurns;
      return {
        value: {
          summary: 'fixed it', filesChanged: ['a/A.al'], commits: ['deadbee'],
          findingsAddressed: [{ file: 'a/A.al', line: 69, action: 'fixed', reason: 'moved it' }],
        },
        costUsd: 0.5,
        toolUsage: { Edit: 2 },
        usage: {
          inputTokens: 1, outputTokens: 2,
          cacheCreationInputTokens: 3, cacheReadInputTokens: 4, turns: 5,
          model: 'claude-sonnet-5',
        },
      };
    }),
  } as unknown as AgentRunner;
}

describe('createFixFindingsStage', () => {
  it('writes coder output and findingsAddressed, and bills the fix-findings key', async () => {
    const captured: { prompt?: string } = {};
    const stage = createFixFindingsStage({
      config: mockContext().config,
      runner: okRunner(captured),
      promptTemplate: 'SYSTEM',
      discoveredSkills: [],
      getCurrentHeadSha: async () => 'head1',
      resetWorktree: async () => {},
      getDiff: async () => 'THE DIFF',
    });
    const out = await stage.execute(stateWithFindings(), mockContext());

    expect((out.outputs.coder as any).summary).toBe('fixed it');
    expect((out.outputs.findingsAddressed as any[])[0].action).toBe('fixed');
    expect((out.outputs.cost as any).perStage['fix-findings'].usd).toBeCloseTo(0.5);
    expect((out.outputs.toolUsage as any).Edit).toBe(2);
    expect(captured.prompt).toContain('THE DIFF');
  });

  it('uses the fix-findings model and turn budget', async () => {
    const captured: { model?: string; maxTurns?: number } = {};
    const ctx = mockContext();
    const config: AppConfig = {
      ...ctx.config,
      claudeModel: 'fallback',
      stepModel: { 'fix-findings': 'claude-opus-5' },
      fixFindingsMaxTurns: 42,
    };
    const stage = createFixFindingsStage({
      config, runner: okRunner(captured), promptTemplate: 'S',
      discoveredSkills: [], getCurrentHeadSha: async () => 'h',
      resetWorktree: async () => {}, getDiff: async () => 'd',
    });
    await stage.execute(stateWithFindings(), { ...ctx, config });

    expect(captured.model).toBe('claude-opus-5');
    expect(captured.maxTurns).toBe(42);
  });

  it('resets to baseline and retries once on a parse error, then rethrows', async () => {
    const reset = mock(async (_worktreePath: string, _baselineSha: string) => {});
    let calls = 0;
    const runner = {
      run: mock(async () => {
        calls++;
        throw new AgentOutputParseError('not json', 'output did not parse');
      }),
    } as unknown as AgentRunner;

    const stage = createFixFindingsStage({
      config: mockContext().config, runner, promptTemplate: 'S',
      discoveredSkills: [], getCurrentHeadSha: async () => 'base1',
      resetWorktree: reset, getDiff: async () => 'd',
    });

    await expect(stage.execute(stateWithFindings(), mockContext())).rejects.toThrow();
    expect(calls).toBe(3); // 1 + MAX_TRANSIENT_RETRIES
    expect(reset).toHaveBeenCalledTimes(3);
    expect(reset.mock.calls[0]?.[1]).toBe('base1');
  });

  it('throws when upstream state is missing', async () => {
    const stage = createFixFindingsStage({
      config: mockContext().config, runner: okRunner({}), promptTemplate: 'S',
      discoveredSkills: [], getCurrentHeadSha: async () => 'h',
      resetWorktree: async () => {}, getDiff: async () => 'd',
    });
    await expect(stage.execute(mockState(), mockContext())).rejects.toThrow(/requires/);
  });

  // Fix round 1 regression: findingsAddressed is optional in the schema, so a
  // round that omits it must not leave a PRIOR round's array sitting in
  // state — the reviewer prompt (Task 7) renders this key as describing the
  // round that just ran, and a stale entry would misreport an untouched
  // finding as addressed.
  it('clears findingsAddressed when a later round omits it, rather than keeping the earlier round\'s entries', async () => {
    let call = 0;
    const runner = {
      run: mock(async () => {
        call++;
        if (call === 1) {
          return {
            value: {
              summary: 'round 1 fix', filesChanged: ['a/A.al'], commits: ['sha1'],
              findingsAddressed: [{ file: 'a/A.al', line: 69, action: 'fixed', reason: 'round 1' }],
            },
            costUsd: 0.1,
            toolUsage: {},
            usage: {
              inputTokens: 1, outputTokens: 1,
              cacheCreationInputTokens: 0, cacheReadInputTokens: 0, turns: 1,
              model: 'claude-sonnet-5',
            },
          };
        }
        // Round 2's model omits findingsAddressed entirely (schema allows it).
        return {
          value: {
            summary: 'round 2 fix', filesChanged: ['a/B.al'], commits: ['sha2'],
          },
          costUsd: 0.1,
          toolUsage: {},
          usage: {
            inputTokens: 1, outputTokens: 1,
            cacheCreationInputTokens: 0, cacheReadInputTokens: 0, turns: 1,
            model: 'claude-sonnet-5',
          },
        };
      }),
    } as unknown as AgentRunner;

    const stage = createFixFindingsStage({
      config: mockContext().config, runner, promptTemplate: 'S',
      discoveredSkills: [], getCurrentHeadSha: async () => 'h',
      resetWorktree: async () => {}, getDiff: async () => 'd',
    });

    const state = stateWithFindings();
    const afterRound1 = await stage.execute(state, mockContext());
    expect((afterRound1.outputs.findingsAddressed as any[]).length).toBe(1);

    const afterRound2 = await stage.execute(afterRound1, mockContext());
    expect(afterRound2.outputs.findingsAddressed).toEqual([]);
  });

  // THE regression test for this plan, at the layer that can actually leak:
  // the stage holds the full WorkItemContext and chooses what reaches the
  // prompt. buildFixFindingsPrompt's own args have no parameter that could
  // carry this material, so a test on the builder alone cannot catch a stage
  // that widens what it passes through.
  it('does not leak WI description, repro steps, acceptance criteria or comments into the prompt', async () => {
    const captured: { prompt?: string } = {};
    const state = stateWithFindings();
    state.outputs.wiContext = {
      id: 82205,
      title: 'Reconciliation telemetry',
      workItemType: 'Bug',
      state: 'Active',
      description: 'SENTINEL_DESCRIPTION_TEXT should never reach the fixer.',
      reproSteps: 'SENTINEL_REPRO_STEPS_TEXT: click here then there.',
      acceptanceCriteria: 'SENTINEL_ACCEPTANCE_CRITERIA_TEXT must hold.',
      images: [],
      comments: [
        { author: 'someone', createdDate: '2026-01-01', text: 'SENTINEL_COMMENT_TEXT from a human.' },
      ],
    };

    const stage = createFixFindingsStage({
      config: mockContext().config,
      runner: okRunner(captured),
      promptTemplate: 'SYSTEM',
      discoveredSkills: [],
      getCurrentHeadSha: async () => 'head1',
      resetWorktree: async () => {},
      getDiff: async () => 'THE DIFF',
    });
    await stage.execute(state, mockContext());

    expect(captured.prompt).not.toContain('SENTINEL_DESCRIPTION_TEXT');
    expect(captured.prompt).not.toContain('SENTINEL_REPRO_STEPS_TEXT');
    expect(captured.prompt).not.toContain('SENTINEL_ACCEPTANCE_CRITERIA_TEXT');
    expect(captured.prompt).not.toContain('SENTINEL_COMMENT_TEXT');
    expect(captured.prompt).toContain('82205');
    expect(captured.prompt).toContain('Reconciliation telemetry');
  });
});
