/**
 * Tests for createReviewerStage (Plan 5 real reviewer).
 *
 * Coverage map:
 *  T1 — stage.name === 'reviewer', canRun always true
 *  T2 — exactly 6 runner.run calls in parallel (one per axis)
 *  T3 — each axis call's systemPromptAppend = sharedPromptTemplate + '\n\n' + axisPrompt
 *  T4 — each axis call has correct tools/disallowedTools/cwd
 *  T5 — maxTurns falls back to 50; honours deps.maxTurnsPerAxis override
 *  T6 — findings from multiple axes are aggregated (aggregateReviewerFindings)
 *  T7 — approved is true when no blocking/critical findings
 *  T8 — approved is false when any finding is 'blocking'
 *  T9 — approved is false when any finding is 'critical'
 * T10 — attempts counter increments (1 on first run, 2 on second)
 * T11 — throws if any axis runner.run rejects
 * T12 — buildReviewerUserPrompt renders expected sections; test-author absent when undefined
 * T13 — toolUsage from all 6 axes is merged into state.outputs.toolUsage
 * T14 — a malformed axis reply is retried, and gives up after MAX_TRANSIENT_RETRIES
 * T15 — spend of the surviving axes, and of failed attempts, outlives a failing axis
 * T16 — a failing axis cancels its siblings, and the real cause is what surfaces
 * T17 — per-axis severity ceilings clamp before aggregation
 */
import { describe, it, expect, mock } from 'bun:test';
import {
  createReviewerStage,
  buildReviewerUserPrompt,
  REVIEW_AXES,
} from '../../../src/pipeline/stages/reviewer.ts';
import { createLogger } from '../../../src/utils/logger.ts';
import type {
  AgentRunArgs,
  AgentRunner,
} from '../../../src/pipeline/agent-stage.ts';
import type {
  AgentUsage,
  AppConfig,
  CoderOutput,
  Finding,
  PipelineCostInfo,
  PipelineState,
  ReviewerOutput,
  TestAuthorOutput,
  WorktreeContext,
} from '../../../src/types/index.ts';
import type { WorkItemContext } from '../../../src/services/wi-context.ts';
import type { AnalyzerOutput } from '../../../src/pipeline/stages/analyzer.ts';
import { TEST_USAGE } from '../../helpers/agent-usage.ts';
import { AgentOutputParseError } from '../../../src/services/claude-agent-runner.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseConfig: AppConfig = {
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
  coderMaxTurns: 80, reviewerMaxTurns: 50,
  testAuthorMaxTurns: 50,
  maxCostUsdPerWi: 5.00,
  stageTimeoutMs: {},
  claudeModel: 'claude-opus-4-7',
  stateDir: '.state', logDir: 'logs',
  assignedToFilter: [],
  continiaCliPath: '.tools/continia.exe', continiaEnvProfileId: 'prof-1', continiaEnvLocalization: 'base', continiaApiToken: 'tok', continiaAppPaths: ['App'], continiaTestAppPaths: ['App'], maxTestFixAttempts: 2, continiaTestTimeoutS: 600, dryRun: false, skipBuildTest: false, testSelection: 'all', maxTestCodeunits: 0, costLogPath: '.state/cost-ledger.jsonl',
};

const sampleWiCtx: WorkItemContext = {
  id: 101,
  title: 'Fix login button',
  workItemType: 'Bug',
  state: 'Active',
  description: 'The login button does nothing.',
  reproSteps: '1. Click login\n2. Nothing',
  acceptanceCriteria: 'Button submits form.',
  images: [],
  comments: [],
};

const sampleAnalyzer: AnalyzerOutput = {
  verdict: 'proceed',
  summary: 'Proceed with the fix.',
  reasons: [],
};

const sampleCoder: CoderOutput = {
  summary: 'Fixed the button.',
  filesChanged: ['src/login.ts'],
  commits: ['deadbeef'],
};

const sampleTestAuthor: TestAuthorOutput = {
  summary: 'Added login tests.',
  testFilesChanged: ['tests/login.test.ts'],
  commits: ['cafebabe'],
};

const sampleWorktree: WorktreeContext = {
  path: '/repos/.worktrees/wi-101-fix-login',
  branch: 'agent/wi-101-fix-login',
  baseSha: 'abc123',
};

function makeState(overrides: Partial<PipelineState> = {}): PipelineState {
  return {
    workItemId: 101,
    slug: 'fix-login',
    startedAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    currentStage: 'reviewer',
    history: [],
    outputs: {
      wiContext: sampleWiCtx,
      analyzer: sampleAnalyzer,
      coder: sampleCoder,
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

/** Build deps with sentinel prompt strings and a configurable runner. */
function makeDeps(
  runner: AgentRunner,
  overrides: { maxTurnsPerAxis?: number } = {},
) {
  const axisPromptTemplates = Object.fromEntries(
    REVIEW_AXES.map((axis) => [axis, `AXIS_PROMPT_${axis.toUpperCase()}`]),
  ) as Record<(typeof REVIEW_AXES)[number], string>;

  return {
    config: baseConfig,
    runner,
    sharedPromptTemplate: 'SHARED_PROMPT_HEAD',
    axisPromptTemplates,
    ...overrides,
  };
}

/** A runner that returns empty findings for every axis call (wrapped in {value, costUsd, toolUsage}). */
function makeRunner(
  resultFn?: (args: AgentRunArgs<unknown>) => Promise<unknown>,
  costUsdPerCall = 0.10,
  toolUsagePerCall?: Record<string, number>[],
): AgentRunner & { calls: AgentRunArgs<unknown>[] } {
  const calls: AgentRunArgs<unknown>[] = [];
  let callIdx = 0;
  return {
    calls,
    run: mock(async (args: AgentRunArgs<unknown>) => {
      const idx = callIdx++;
      calls.push(args);
      const value = resultFn ? await resultFn(args) : { findings: [] };
      return { value, costUsd: costUsdPerCall, toolUsage: toolUsagePerCall?.[idx] ?? {}, usage: TEST_USAGE };
    }) as AgentRunner['run'],
  };
}

/** Args for buildReviewerUserPrompt shared by the carry-forward tests below. */
const basePromptArgs = {
  wiCtx: sampleWiCtx,
  analyzer: sampleAnalyzer,
  coder: sampleCoder,
  testAuthor: undefined,
  worktree: sampleWorktree,
  attempts: 1,
  maxAttempts: 3,
};

/** Default deps for the carry-forward tests below; each test overrides `runner`. */
const deps = makeDeps(makeRunner());

/** A fresh PipelineState with no prior reviewer output (first review round). */
function readyState(): PipelineState {
  return makeState();
}

/**
 * A PipelineState as if a previous reviewer round already ran, carrying the
 * given ReviewerOutput overrides (e.g. `byAxis`) into `state.outputs.reviewer`.
 */
function stateWithPriorReview(overrides: Partial<ReviewerOutput> = {}): PipelineState {
  return makeState({
    outputs: {
      wiContext: sampleWiCtx,
      analyzer: sampleAnalyzer,
      coder: sampleCoder,
      worktree: sampleWorktree,
      reviewer: { approved: false, findings: [], attempts: 1, ...overrides },
    },
  });
}

/**
 * An AgentRunResult<{findings}> shape for runner mocks that bypass makeRunner's
 * wrapping and return directly from `run`.
 */
function emptyFindingsResult(): {
  value: { findings: Finding[] };
  costUsd: number;
  toolUsage: Record<string, number>;
  usage: AgentUsage;
} {
  return { value: { findings: [] }, costUsd: 0.1, toolUsage: {}, usage: TEST_USAGE };
}

function findingsResult(findings: Finding[]): {
  value: { findings: Finding[] };
  costUsd: number;
  toolUsage: Record<string, number>;
  usage: AgentUsage;
} {
  return { value: { findings }, costUsd: 0.1, toolUsage: {}, usage: TEST_USAGE };
}

function mockContext() {
  return makeCtx();
}

// ---------------------------------------------------------------------------
// T1 — identity
// ---------------------------------------------------------------------------

describe('createReviewerStage', () => {
  it('T1: stage.name is "reviewer" and canRun always returns true', () => {
    const runner = makeRunner();
    const stage = createReviewerStage(makeDeps(runner));
    expect(stage.name).toBe('reviewer');
    expect(stage.canRun(makeState())).toBe(true);
  });

  // -------------------------------------------------------------------------
  // T2 — exactly 6 parallel axis calls
  // -------------------------------------------------------------------------

  it('T2: runs exactly 6 runner.run calls (one per axis)', async () => {
    const runner = makeRunner();
    const stage = createReviewerStage(makeDeps(runner));
    const result = await stage.execute(makeState(), makeCtx());
    expect(runner.calls).toHaveLength(6);
    // 6 axes × $0.10 each
    expect((result.outputs.cost as PipelineCostInfo).total).toBeCloseTo(0.60, 4);
  });

  // One `reviewer` number hides which axis is expensive, and the axes are the
  // reviewer's whole cost — six full-context reads of the same diff.
  it('bills each axis to its own step key rather than one lump reviewer entry', async () => {
    const runner = makeRunner();
    const stage = createReviewerStage(makeDeps(runner));
    const result = await stage.execute(makeState(), makeCtx());
    const perStage = (result.outputs.cost as PipelineCostInfo).perStage;
    expect(Object.keys(perStage).sort()).toEqual(REVIEW_AXES.map((a) => `reviewer:${a}`).sort());
    expect(perStage['reviewer:security']!.usd).toBeCloseTo(0.10, 4);
  });

  it('records the model each axis ran on', async () => {
    const runner = makeRunner();
    const stage = createReviewerStage(makeDeps(runner));
    const result = await stage.execute(makeState(), makeCtx());
    const perStage = (result.outputs.cost as PipelineCostInfo).perStage;
    expect(perStage['reviewer:security']!.models).toEqual(['test-model']);
  });

  // -------------------------------------------------------------------------
  // T3 — systemPromptAppend = shared + '\n\n' + axisPrompt
  // -------------------------------------------------------------------------

  it('each axis labels its runner call so the six parallel cost lines stay distinguishable', async () => {
    const runner = makeRunner();
    const stage = createReviewerStage(makeDeps(runner));
    await stage.execute(makeState(), makeCtx());
    expect(runner.calls.map((c) => c.label).sort()).toEqual(
      [...REVIEW_AXES].map((a) => `reviewer:${a}`).sort(),
    );
  });

  it('T3: each axis call has systemPromptAppend = sharedPrompt + "\\n\\n" + axisPrompt', async () => {
    const runner = makeRunner();
    const deps = makeDeps(runner);
    const stage = createReviewerStage(deps);
    await stage.execute(makeState(), makeCtx());

    for (let i = 0; i < REVIEW_AXES.length; i++) {
      const axis = REVIEW_AXES[i]!;
      const call = runner.calls[i]!;
      const expected = `SHARED_PROMPT_HEAD\n\nAXIS_PROMPT_${axis.toUpperCase()}`;
      expect(call.systemPromptAppend).toBe(expected);
    }
  });

  // -------------------------------------------------------------------------
  // T4 — tools / disallowedTools / cwd
  // -------------------------------------------------------------------------

  it('T4: each axis call has correct tools, disallowedTools, and cwd', async () => {
    const runner = makeRunner();
    const stage = createReviewerStage(makeDeps(runner));
    await stage.execute(makeState(), makeCtx());

    for (const call of runner.calls) {
      expect(call.tools).toEqual(['Read', 'Grep', 'Glob', 'Bash']);
      expect(call.disallowedTools).toEqual([
        'Edit',
        'Write',
        'NotebookEdit',
        'ReportFindings',
      ]);
      expect(call.cwd).toBe(sampleWorktree.path);
    }
  });

  // -------------------------------------------------------------------------
  // T5 — maxTurns default + override
  // -------------------------------------------------------------------------

  it('T5a: maxTurns falls back to 50 when deps.maxTurnsPerAxis is unset', async () => {
    const runner = makeRunner();
    const stage = createReviewerStage(makeDeps(runner));
    await stage.execute(makeState(), makeCtx());
    for (const call of runner.calls) {
      expect(call.maxTurns).toBe(50);
    }
  });

  it('T5b: maxTurns uses deps.maxTurnsPerAxis override when set', async () => {
    const runner = makeRunner();
    const stage = createReviewerStage(makeDeps(runner, { maxTurnsPerAxis: 15 }));
    await stage.execute(makeState(), makeCtx());
    for (const call of runner.calls) {
      expect(call.maxTurns).toBe(15);
    }
  });

  // -------------------------------------------------------------------------
  // T6 — aggregation (same file:line from two axes → merged)
  // -------------------------------------------------------------------------

  it('T6: aggregates findings across axes (same file:line merges axes, keeps higher severity)', async () => {
    // Two axes return a finding on the same file:line with different severities.
    // aggregateReviewerFindings should merge them. Both axes here have a
    // ceiling of at least `critical`, so the merge is what decides the result
    // rather than the clamp — see T17c for the interaction between the two.
    const runner = makeRunner(async (args) => {
      if (args.label === 'reviewer:safety-correctness') {
        return {
          findings: [
            {
              severity: 'major',
              file: 'src/login.ts',
              line: 42,
              title: 'Issue A',
              description: 'Desc A',
              axis: 'safety-correctness',
            } satisfies Finding,
          ],
        };
      }
      if (args.label === 'reviewer:security') {
        return {
          findings: [
            {
              severity: 'critical',
              file: 'src/login.ts',
              line: 42,
              title: 'Issue B',
              description: 'Desc B',
              axis: 'security',
            } satisfies Finding,
          ],
        };
      }
      return { findings: [] };
    });
    const stage = createReviewerStage(makeDeps(runner));
    const result = await stage.execute(makeState(), makeCtx());
    const output = result.outputs.reviewer as ReviewerOutput;
    // Should have collapsed to 1 finding
    expect(output.findings).toHaveLength(1);
    const merged = output.findings[0]!;
    // Higher severity wins
    expect(merged.severity).toBe('critical');
    // Axis is a combined label
    expect(merged.axis).toContain('safety-correctness');
    expect(merged.axis).toContain('security');
  });

  // -------------------------------------------------------------------------
  // T7 — approved true when no blocking/critical
  // -------------------------------------------------------------------------

  it('T7: approved is true when all findings are major/minor/nit', async () => {
    const runner = makeRunner(async () => ({
      findings: [
        {
          severity: 'major',
          file: 'f.ts',
          title: 'T',
          description: 'D',
          axis: 'safety-correctness',
        } satisfies Finding,
      ],
    }));
    const stage = createReviewerStage(makeDeps(runner));
    const result = await stage.execute(makeState(), makeCtx());
    const output = result.outputs.reviewer as ReviewerOutput;
    expect(output.approved).toBe(true);
  });

  // -------------------------------------------------------------------------
  // T8 — approved false on blocking
  // -------------------------------------------------------------------------

  it('T8: approved is false when any finding is blocking', async () => {
    let callIdx = 0;
    const runner = makeRunner(async () => {
      const idx = callIdx++;
      if (idx === 0) {
        return {
          findings: [
            {
              severity: 'blocking',
              file: 'src/a.ts',
              title: 'Blocker',
              description: 'Bad',
              axis: 'security',
            } satisfies Finding,
          ],
        };
      }
      return { findings: [] };
    });
    const stage = createReviewerStage(makeDeps(runner));
    const result = await stage.execute(makeState(), makeCtx());
    const output = result.outputs.reviewer as ReviewerOutput;
    expect(output.approved).toBe(false);
  });

  // -------------------------------------------------------------------------
  // T9 — approved false on critical
  // -------------------------------------------------------------------------

  it('T9: approved is false when any finding is critical', async () => {
    // `integration` is used rather than `performance`: its ceiling is
    // `critical`, so the severity survives to exercise the approval rule.
    const runner = makeRunner(async (args) => {
      if (args.label === 'reviewer:integration') {
        return {
          findings: [
            {
              severity: 'critical',
              file: 'src/b.ts',
              title: 'Critical',
              description: 'Very bad',
              axis: 'integration',
            } satisfies Finding,
          ],
        };
      }
      return { findings: [] };
    });
    const stage = createReviewerStage(makeDeps(runner));
    const result = await stage.execute(makeState(), makeCtx());
    const output = result.outputs.reviewer as ReviewerOutput;
    expect(output.approved).toBe(false);
  });

  // -------------------------------------------------------------------------
  // T10 — attempts increments
  // -------------------------------------------------------------------------

  it('T10: attempts is 1 on first run, and increments on subsequent calls', async () => {
    const runner = makeRunner();
    const deps = makeDeps(runner);
    const stage = createReviewerStage(deps);

    // First run: no prior reviewer output
    const state1 = makeState();
    const result1 = await stage.execute(state1, makeCtx());
    const out1 = result1.outputs.reviewer as ReviewerOutput;
    expect(out1.attempts).toBe(1);

    // Second run: state already has reviewer.attempts === 1
    const state2 = makeState({ outputs: { ...result1.outputs } });
    const result2 = await stage.execute(state2, makeCtx());
    const out2 = result2.outputs.reviewer as ReviewerOutput;
    expect(out2.attempts).toBe(2);
  });

  // -------------------------------------------------------------------------
  // T11 — one failing axis still fails the stage
  // -------------------------------------------------------------------------

  it('T11: throws if any axis runner.run rejects', async () => {
    let callIdx = 0;
    const runner = makeRunner(async () => {
      const idx = callIdx++;
      if (idx === 3) throw new Error('axis-failure');
      return { findings: [] };
    });
    const stage = createReviewerStage(makeDeps(runner));
    await expect(stage.execute(makeState(), makeCtx())).rejects.toThrow('axis-failure');
  });

  // -------------------------------------------------------------------------
  // T14 — per-axis retry on a malformed reply
  // -------------------------------------------------------------------------

  it('T14a: retries an axis that answers with unparseable output, then succeeds', async () => {
    let parseFailures = 0;
    const runner = makeRunner(async (args) => {
      if (args.label === 'reviewer:security' && parseFailures === 0) {
        parseFailures++;
        throw new AgentOutputParseError('Reported 3 findings.', 'Failed to parse JSON');
      }
      return { findings: [] };
    });
    const stage = createReviewerStage(makeDeps(runner));
    const result = await stage.execute(makeState(), makeCtx());
    // 6 axes + 1 retry of the axis that failed
    expect(runner.calls).toHaveLength(7);
    expect((result.outputs.reviewer as ReviewerOutput).approved).toBe(true);
  });

  it('T14b: gives up on an axis after MAX_TRANSIENT_RETRIES and fails the stage', async () => {
    const runner = makeRunner(async (args) => {
      if (args.label === 'reviewer:security') {
        throw new AgentOutputParseError('Reported 3 findings.', 'Failed to parse JSON');
      }
      return { findings: [] };
    });
    const stage = createReviewerStage(makeDeps(runner));
    await expect(stage.execute(makeState(), makeCtx())).rejects.toThrow(
      'Failed to parse JSON',
    );
    // 5 clean axes + 3 attempts on the failing one
    expect(runner.calls).toHaveLength(8);
  });

  // -------------------------------------------------------------------------
  // T15 — spend survives a failing axis
  // -------------------------------------------------------------------------

  it('T15a: keeps the spend of the axes that succeeded when another axis fails', async () => {
    const runner = makeRunner(async (args) => {
      if (args.label === 'reviewer:security') throw new Error('axis-failure');
      return { findings: [] };
    });
    const state = makeState();
    const stage = createReviewerStage(makeDeps(runner));
    await expect(stage.execute(state, makeCtx())).rejects.toThrow('axis-failure');

    // The five axes that resolved are billed even though the stage threw —
    // this is the $3.55 the old post-Promise.all accounting discarded.
    const cost = state.outputs.cost as PipelineCostInfo;
    expect(cost.total).toBeCloseTo(0.50, 4);
    expect(Object.keys(cost.perStage)).not.toContain('reviewer:security');
    expect(cost.perStage['reviewer:performance']!.usd).toBeCloseTo(0.10, 4);
  });

  it('T15b: bills an attempt whose output failed to parse', async () => {
    const runner = makeRunner(async (args) => {
      if (args.label === 'reviewer:security') {
        throw new AgentOutputParseError('Reported 3 findings.', 'Failed to parse JSON', {
          costUsd: 0.67,
          toolUsage: { ReportFindings: 1 },
          usage: TEST_USAGE,
        });
      }
      return { findings: [] };
    });
    const state = makeState();
    const stage = createReviewerStage(makeDeps(runner));
    await expect(stage.execute(state, makeCtx())).rejects.toThrow('Failed to parse JSON');

    // Three attempts at $0.67, all paid for, plus the five clean axes at $0.10.
    const cost = state.outputs.cost as PipelineCostInfo;
    expect(cost.perStage['reviewer:security']!.usd).toBeCloseTo(2.01, 4);
    expect(cost.perStage['reviewer:security']!.calls).toBe(3);
    expect(cost.total).toBeCloseTo(2.51, 4);
    expect((state.outputs.toolUsage as Record<string, number>).ReportFindings).toBe(3);
  });

  // -------------------------------------------------------------------------
  // T16 — a failing axis cancels its siblings
  // -------------------------------------------------------------------------

  it('T16a: aborts the sibling axes when one axis fails', async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const runner = makeRunner(async (args) => {
      signals.push(args.signal);
      if (args.label === 'reviewer:security') throw new Error('axis-failure');
      return { findings: [] };
    });
    const stage = createReviewerStage(makeDeps(runner));
    await expect(stage.execute(makeState(), makeCtx())).rejects.toThrow('axis-failure');

    expect(signals).toHaveLength(6);
    // Every axis shares the fan-out signal, so the survivors stop paying the
    // moment the stage is doomed instead of running on unbilled.
    for (const signal of signals) {
      expect(signal?.aborted).toBe(true);
    }
  });

  it('T16b: reports the real failure, not a sibling cancellation', async () => {
    const runner = makeRunner(async (args) => {
      // 'integration' is the last axis, so its rejection lands after the
      // earlier axes have already been cancelled by it.
      if (args.label === 'reviewer:integration') throw new Error('the-real-cause');
      const abortErr = new Error('aborted');
      abortErr.name = 'AbortError';
      throw abortErr;
    });
    const stage = createReviewerStage(makeDeps(runner));
    await expect(stage.execute(makeState(), makeCtx())).rejects.toThrow('the-real-cause');
  });

  it('T16c: an already-aborted stage signal reaches every axis', async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const runner = makeRunner(async (args) => {
      signals.push(args.signal);
      return { findings: [] };
    });
    const controller = new AbortController();
    controller.abort();
    const stage = createReviewerStage(makeDeps(runner));
    await stage.execute(makeState(), { ...makeCtx(), signal: controller.signal });
    for (const signal of signals) {
      expect(signal?.aborted).toBe(true);
    }
  });

  // -------------------------------------------------------------------------
  // T17 — per-axis severity ceilings
  // -------------------------------------------------------------------------

  // WI 82205: three rounds, $23.95, killed by one `critical` reading
  // "diverging from established codebase idiom" that naming-style helped raise.
  it('T17a: clamps a finding to its axis ceiling, so naming-style cannot block', async () => {
    const runner = makeRunner(async (args) => {
      if (args.label === 'reviewer:naming-style') {
        return {
          findings: [
            {
              severity: 'critical',
              file: 'src/a.al',
              line: 95,
              title: 'Diverges from established codebase idiom',
              description: 'D',
              axis: 'naming-style',
            } satisfies Finding,
          ],
        };
      }
      return { findings: [] };
    });
    const stage = createReviewerStage(makeDeps(runner));
    const result = await stage.execute(makeState(), makeCtx());
    const output = result.outputs.reviewer as ReviewerOutput;
    expect(output.findings[0]!.severity).toBe('minor');
    expect(output.approved).toBe(true);
  });

  it('T17b: leaves a finding already at or below its ceiling untouched', async () => {
    const runner = makeRunner(async (args) => {
      if (args.label === 'reviewer:security') {
        return {
          findings: [
            {
              severity: 'blocking',
              file: 'src/a.al',
              title: 'Secret written to the log',
              description: 'D',
              axis: 'security',
            } satisfies Finding,
          ],
        };
      }
      return { findings: [] };
    });
    const stage = createReviewerStage(makeDeps(runner));
    const result = await stage.execute(makeState(), makeCtx());
    const output = result.outputs.reviewer as ReviewerOutput;
    expect(output.findings[0]!.severity).toBe('blocking');
    expect(output.approved).toBe(false);
  });

  // The merge keeps a group's highest severity, so clamping after aggregation
  // would let a co-located finding re-breach a ceiling that had been applied.
  it('T17c: clamps before aggregation, so a merge cannot re-promote past a ceiling', async () => {
    const at95 = (severity: Finding['severity'], axis: string): Finding => ({
      severity,
      file: 'src/a.al',
      line: 95,
      title: `From ${axis}`,
      description: 'D',
      axis,
    });
    const runner = makeRunner(async (args) => {
      if (args.label === 'reviewer:naming-style') return { findings: [at95('critical', 'naming-style')] };
      if (args.label === 'reviewer:performance') return { findings: [at95('critical', 'performance')] };
      return { findings: [] };
    });
    const stage = createReviewerStage(makeDeps(runner));
    const result = await stage.execute(makeState(), makeCtx());
    const output = result.outputs.reviewer as ReviewerOutput;
    // Both clamped first (minor, major), then merged — the group keeps `major`.
    expect(output.findings).toHaveLength(1);
    expect(output.findings[0]!.severity).toBe('major');
    expect(output.approved).toBe(true);
  });

  it('T17d: keys the ceiling on the axis that ran, not the model-supplied axis field', async () => {
    const runner = makeRunner(async (args) => {
      if (args.label === 'reviewer:naming-style') {
        return {
          findings: [
            {
              severity: 'blocking',
              file: 'src/a.al',
              title: 'Mislabelled',
              description: 'D',
              // Claims to be the axis with the highest ceiling.
              axis: 'security',
            } satisfies Finding,
          ],
        };
      }
      return { findings: [] };
    });
    const stage = createReviewerStage(makeDeps(runner));
    const result = await stage.execute(makeState(), makeCtx());
    expect((result.outputs.reviewer as ReviewerOutput).findings[0]!.severity).toBe('minor');
  });

  // -------------------------------------------------------------------------
  // T12 — buildReviewerUserPrompt section rendering
  // -------------------------------------------------------------------------

  it('T12a: buildReviewerUserPrompt includes work item, analyzer, coder, worktree and attempt sections', () => {
    const prompt = buildReviewerUserPrompt({
      wiCtx: sampleWiCtx,
      analyzer: sampleAnalyzer,
      coder: sampleCoder,
      testAuthor: undefined,
      worktree: sampleWorktree,
      attempts: 1,
      maxAttempts: 3,
    });
    // Work item section
    expect(prompt).toContain('## Work item');
    expect(prompt).toContain('101');
    expect(prompt).toContain('Fix login button');
    expect(prompt).toContain('Bug');
    // Analyzer section
    expect(prompt).toContain('## Analyzer framing');
    expect(prompt).toContain('Proceed with the fix.');
    // Coder section
    expect(prompt).toContain('## Coder summary');
    expect(prompt).toContain('Fixed the button.');
    expect(prompt).toContain('src/login.ts');
    // Worktree section
    expect(prompt).toContain('## Worktree');
    expect(prompt).toContain(sampleWorktree.path);
    expect(prompt).toContain(sampleWorktree.branch);
    expect(prompt).toContain('abc123..HEAD');
    // Iteration
    expect(prompt).toContain('## Reviewer iteration');
    expect(prompt).toContain('Attempt 1 of 3');
    // Your job reminder
    expect(prompt).toContain('## Your job');
    // Test-author section absent
    expect(prompt).not.toContain('## Test-author summary');
  });

  it('T12b: buildReviewerUserPrompt includes test-author section when testAuthor is provided', () => {
    const prompt = buildReviewerUserPrompt({
      wiCtx: sampleWiCtx,
      analyzer: sampleAnalyzer,
      coder: sampleCoder,
      testAuthor: sampleTestAuthor,
      worktree: sampleWorktree,
      attempts: 2,
      maxAttempts: 3,
    });
    expect(prompt).toContain('## Test-author summary');
    expect(prompt).toContain('Added login tests.');
    expect(prompt).toContain('tests/login.test.ts');
  });

  // -------------------------------------------------------------------------
  // T13 — toolUsage merge across the 6 axis calls
  // -------------------------------------------------------------------------

  it('T13: merges toolUsage across all 6 axis calls into state.outputs.toolUsage', async () => {
    const runner = makeRunner(undefined, 0.10, [
      { Read: 1 },
      { Read: 1 },
      { Read: 1 },
      { Grep: 1 },
      { Grep: 1 },
      { Grep: 1 },
    ]);
    const stage = createReviewerStage(makeDeps(runner));
    const result = await stage.execute(makeState(), makeCtx());
    expect(result.outputs.toolUsage).toEqual({ Read: 3, Grep: 3 });
  });
});

describe('reviewer finding carry-forward', () => {
  it('renders this axis\'s prior findings with the coder\'s reported action', () => {
    const p = buildReviewerUserPrompt({
      ...basePromptArgs,
      previousFindings: [{
        severity: 'blocking', file: 'a/A.al', line: 69,
        title: '[TryFunction] performs a database Modify',
        description: 'd', axis: 'safety-correctness',
      }],
      findingsAddressed: [{ file: 'a/A.al', line: 69, action: 'fixed', reason: 'moved the Modify out' }],
    });
    expect(p).toContain('## Previously raised by this axis');
    expect(p).toContain('a/A.al:69');
    expect(p).toContain('moved the Modify out');
    expect(p).toContain('Re-raise only what the current diff still exhibits');
  });

  it('omits the section entirely on round 1', () => {
    expect(buildReviewerUserPrompt(basePromptArgs)).not.toContain('Previously raised');
  });

  it('gives each axis only its own prior findings', async () => {
    const prompts: Record<string, string> = {};
    const runner = {
      run: mock(async (opts: any) => {
        prompts[opts.label] = opts.prompt;
        return emptyFindingsResult();
      }),
    } as unknown as AgentRunner;

    const state = stateWithPriorReview({
      byAxis: {
        'safety-correctness': [{ severity: 'blocking', file: 'a/A.al', line: 69, title: 'TRYFUNC', description: 'd', axis: 'safety-correctness' }],
        'naming-style': [{ severity: 'minor', file: 'a/B.al', line: 9, title: 'NAMING', description: 'd', axis: 'naming-style' }],
      },
    });
    await createReviewerStage({ ...deps, runner }).execute(state, mockContext());

    expect(prompts['reviewer:safety-correctness']).toContain('TRYFUNC');
    expect(prompts['reviewer:safety-correctness']).not.toContain('NAMING');
    expect(prompts['reviewer:naming-style']).toContain('NAMING');
    expect(prompts['reviewer:naming-style']).not.toContain('TRYFUNC');
  });

  it('keys byAxis on the axis that ran, not the model-supplied axis field', async () => {
    const runner = {
      run: mock(async (opts: any) =>
        opts.label === 'reviewer:security'
          ? findingsResult([{ severity: 'minor', file: 'a/A.al', line: 1, title: 't', description: 'd', axis: 'i-am-lying' }])
          : emptyFindingsResult(),
      ),
    } as unknown as AgentRunner;

    const out = await createReviewerStage({ ...deps, runner }).execute(readyState(), mockContext());
    const byAxis = (out.outputs.reviewer as ReviewerOutput).byAxis!;
    expect(byAxis['security']).toHaveLength(1);
    expect(byAxis['i-am-lying']).toBeUndefined();
  });

  // Fix round 1: two distinct file-level findings on the same file both carry
  // `line: undefined`, so a naive `.find()` on {file, line} would attribute
  // the SECOND file-level finding's report to the FIRST one's reason. A wrong
  // report is worse than no report — ambiguous matches must render neutrally.
  it('does not attribute a file-level report when multiple reports match the same file', () => {
    const p = buildReviewerUserPrompt({
      ...basePromptArgs,
      previousFindings: [
        { severity: 'major', file: 'a/A.al', title: 'File-level concern one', description: 'd', axis: 'naming-style' },
        { severity: 'minor', file: 'a/A.al', title: 'File-level concern two', description: 'd', axis: 'naming-style' },
        { severity: 'blocking', file: 'a/A.al', line: 69, title: 'Line-level concern', description: 'd', axis: 'naming-style' },
      ],
      findingsAddressed: [
        { file: 'a/A.al', action: 'fixed', reason: 'first file-level fix' },
        { file: 'a/A.al', action: 'declined', reason: 'second file-level decline' },
        { file: 'a/A.al', line: 69, action: 'fixed', reason: 'line-level fix' },
      ],
    });
    // Neither file-level finding may be rendered with a specific action/reason
    // — which of the two ambiguous reports belongs to which finding cannot be
    // established, so neither is asserted.
    expect(p).not.toContain('first file-level fix');
    expect(p).not.toContain('second file-level decline');
    expect(p).toContain('2 file-level reports reference a/A.al');
    // The line-level finding disambiguates on `line` and still matches precisely.
    expect(p).toContain('fixed — line-level fix');
  });

  // Fix round 1 (ruling against the reviewer's suggestion to keep it raw):
  // byAxis must carry what actually stood from last round — the clamped
  // severity — not the axis's raw over-rated claim, or carry-forward would
  // re-anchor exactly the inflation the ceiling exists to suppress.
  it("byAxis carries the clamped severity, not the axis's raw claim", async () => {
    const runner = {
      run: mock(async (opts: any) =>
        opts.label === 'reviewer:naming-style'
          ? findingsResult([{
              severity: 'critical', file: 'src/a.al', line: 95,
              title: 'Diverges from established codebase idiom', description: 'd',
              axis: 'naming-style',
            }])
          : emptyFindingsResult(),
      ),
    } as unknown as AgentRunner;

    const out = await createReviewerStage({ ...deps, runner }).execute(readyState(), mockContext());
    const byAxis = (out.outputs.reviewer as ReviewerOutput).byAxis!;
    expect(byAxis['naming-style']).toHaveLength(1);
    // Ceiling for naming-style is 'minor' — the raw claim was 'critical'.
    expect(byAxis['naming-style']![0]!.severity).toBe('minor');
  });
});
