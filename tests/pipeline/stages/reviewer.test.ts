/**
 * Tests for createReviewerStage (Plan 5 real reviewer).
 *
 * Coverage map:
 *  T1 — stage.name === 'reviewer', canRun always true
 *  T2 — exactly 6 runner.run calls in parallel (one per axis)
 *  T3 — each axis call's systemPromptAppend = sharedPromptTemplate + '\n\n' + axisPrompt
 *  T4 — each axis call has correct tools/disallowedTools/cwd
 *  T5 — maxTurns defaults to 30; honours deps.maxTurnsPerAxis override
 *  T6 — findings from multiple axes are aggregated (aggregateReviewerFindings)
 *  T7 — approved is true when no blocking/critical findings
 *  T8 — approved is false when any finding is 'blocking'
 *  T9 — approved is false when any finding is 'critical'
 * T10 — attempts counter increments (1 on first run, 2 on second)
 * T11 — Promise.all fail-fast: throws if any axis runner.run rejects
 * T12 — buildReviewerUserPrompt renders expected sections; test-author absent when undefined
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
  AppConfig,
  CoderOutput,
  Finding,
  PipelineState,
  ReviewerOutput,
  TestAuthorOutput,
  WorktreeContext,
} from '../../../src/types/index.ts';
import type { WorkItemContext } from '../../../src/services/wi-context.ts';
import type { AnalyzerOutput } from '../../../src/pipeline/stages/analyzer.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseConfig: AppConfig = {
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
    attempts: {},
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

/** A runner that returns empty findings for every axis call. */
function makeRunner(
  resultFn?: (args: AgentRunArgs<unknown>) => Promise<unknown>,
): AgentRunner & { calls: AgentRunArgs<unknown>[] } {
  const calls: AgentRunArgs<unknown>[] = [];
  return {
    calls,
    run: mock(async (args: AgentRunArgs<unknown>) => {
      calls.push(args);
      if (resultFn) return await resultFn(args);
      return { findings: [] };
    }) as AgentRunner['run'],
  };
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
    await stage.execute(makeState(), makeCtx());
    expect(runner.calls).toHaveLength(6);
  });

  // -------------------------------------------------------------------------
  // T3 — systemPromptAppend = shared + '\n\n' + axisPrompt
  // -------------------------------------------------------------------------

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
      expect(call.disallowedTools).toEqual(['Edit', 'Write', 'NotebookEdit']);
      expect(call.cwd).toBe(sampleWorktree.path);
    }
  });

  // -------------------------------------------------------------------------
  // T5 — maxTurns default + override
  // -------------------------------------------------------------------------

  it('T5a: maxTurns defaults to 30 when deps.maxTurnsPerAxis is unset', async () => {
    const runner = makeRunner();
    const stage = createReviewerStage(makeDeps(runner));
    await stage.execute(makeState(), makeCtx());
    for (const call of runner.calls) {
      expect(call.maxTurns).toBe(30);
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
    // aggregateReviewerFindings should merge them.
    let callIdx = 0;
    const runner = makeRunner(async () => {
      const idx = callIdx++;
      if (idx === 0) {
        return {
          findings: [
            {
              severity: 'major',
              file: 'src/login.ts',
              line: 42,
              title: 'Issue A',
              description: 'Desc A',
              axis: REVIEW_AXES[0]!,
            } satisfies Finding,
          ],
        };
      }
      if (idx === 1) {
        return {
          findings: [
            {
              severity: 'critical',
              file: 'src/login.ts',
              line: 42,
              title: 'Issue B',
              description: 'Desc B',
              axis: REVIEW_AXES[1]!,
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
    expect(merged.axis).toContain(REVIEW_AXES[0]!);
    expect(merged.axis).toContain(REVIEW_AXES[1]!);
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
    let callIdx = 0;
    const runner = makeRunner(async () => {
      const idx = callIdx++;
      if (idx === 2) {
        return {
          findings: [
            {
              severity: 'critical',
              file: 'src/b.ts',
              title: 'Critical',
              description: 'Very bad',
              axis: 'performance',
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
  // T11 — fail-fast: Promise.all throws if one axis rejects
  // -------------------------------------------------------------------------

  it('T11: throws if any axis runner.run rejects (Promise.all fail-fast)', async () => {
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
});
