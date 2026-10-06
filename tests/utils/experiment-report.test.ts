import { describe, it, expect } from 'bun:test';
import type { RunResult } from '../../src/services/experiment-runner.ts';
import { emptySeverityCounts } from '../../src/services/experiment-runner.ts';
import {
  isWin,
  verdictBlocker,
  renderExperimentReport,
  summarizeVariant,
} from '../../src/utils/experiment-report.ts';
import { makeSpend } from '../helpers/agent-usage.ts';

function run(overrides: Partial<RunResult>): RunResult {
  return {
    wiId: 1,
    variant: 'baseline',
    rep: 1,
    startedAt: '2026-10-01T00:00:00Z',
    endedAt: '2026-10-01T01:00:00Z',
    wallMs: 3_600_000,
    outcome: 'completed',
    costUsd: 10,
    totalTokens: 1_000_000,
    perStage: { coder: makeSpend({ usd: 6 }), 'reviewer:security': makeSpend({ usd: 1 }), 'reviewer:performance': makeSpend({ usd: 1 }) },
    stageMs: {},
    verification: { finalGate: true, compiled: true, passed: true, skipped: false, attempts: 0, testsPassed: 3, testsFailed: 0 },
    reviewer: { approved: true, rounds: 1, findings: emptySeverityCounts() },
    referee: { costUsd: 2, totalTokens: 1, findings: emptySeverityCounts(), items: [] },
    diff: { files: 1, insertions: 1, deletions: 0 },
    ...overrides,
  };
}

describe('summarizeVariant', () => {
  it('excludes rate-limited runs and collapses reviewer axes', () => {
    const s = summarizeVariant('baseline', [run({}), run({ outcome: 'rate-limited', costUsd: 999 })]);
    expect(s.scored).toBe(1);
    expect(s.meanUsd).toBe(10);
    expect(s.perStepUsd).toEqual({ coder: 6, reviewer: 2 });
  });

  it('does not count a skipped gate as a pass', () => {
    const s = summarizeVariant('baseline', [
      run({ verification: { finalGate: true, compiled: false, passed: false, skipped: true, attempts: 0, testsPassed: 0, testsFailed: 0 } }),
    ]);
    expect(s.passed).toBe(0);
    expect(s.gateSkipped).toBe(1);
  });
});

describe('isWin', () => {
  const base = summarizeVariant('baseline', [run({}), run({ rep: 2 })]);
  const two = (o: Partial<RunResult>) => [run({ ...o }), run({ ...o, rep: 2 })];

  it('fewer tokens, same pass rate, no worse referee → win', () => {
    expect(isWin(summarizeVariant('cheap', two({ variant: 'cheap', totalTokens: 500_000 })), base)).toBe(true);
  });

  it('cheaper but failing the gate → not a win', () => {
    const v = summarizeVariant(
      'cheap',
      two({ variant: 'cheap', totalTokens: 500_000, verification: { finalGate: true, compiled: true, passed: false, skipped: false, attempts: 2, testsPassed: 1, testsFailed: 2 } }),
    );
    expect(isWin(v, base)).toBe(false);
  });

  it('cheaper but more severe referee findings → not a win', () => {
    const v = summarizeVariant(
      'cheap',
      two({ variant: 'cheap', totalTokens: 500_000, referee: { costUsd: 2, totalTokens: 1, findings: { ...emptySeverityCounts(), critical: 1 }, items: [] } }),
    );
    expect(isWin(v, base)).toBe(false);
  });
});

describe('verdictBlocker', () => {
  it('a single run each gives no verdict, however large the saving', () => {
    const base = summarizeVariant('baseline', [run({})]);
    const v = summarizeVariant('cheap', [run({ variant: 'cheap', totalTokens: 1 })]);
    expect(verdictBlocker(v, base)).toMatch(/insufficient runs/);
    expect(isWin(v, base)).toBe(false);
  });

  it('runs without a gate result give no verdict (SKIP_BUILD_TEST smoke runs)', () => {
    const noGate = { verification: undefined };
    const base = summarizeVariant('baseline', [run(noGate), run({ ...noGate, rep: 2 })]);
    const v = summarizeVariant('cheap', [run({ ...noGate, variant: 'cheap', totalTokens: 1 }), run({ ...noGate, variant: 'cheap', rep: 2, totalTokens: 1 })]);
    expect(verdictBlocker(v, base)).toBe('no gate result');
    expect(isWin(v, base)).toBe(false);
  });
});

describe('renderExperimentReport', () => {
  it('flags the winner and lists every run', () => {
    const md = renderExperimentReport({
      runId: 'r1',
      results: [
        run({}),
        run({ rep: 2 }),
        run({ variant: 'cheap', totalTokens: 400_000, costUsd: 4 }),
        run({ variant: 'cheap', rep: 2, totalTokens: 400_000, costUsd: 4 }),
      ],
      variants: ['baseline', 'cheap'],
      overheadUsd: 4,
      skippedForBudget: 1,
    });
    expect(md).toContain('| cheap | 2 | 2 | 2/2 | 0 | 0.40M | 0.40M–0.40M | -60% | $4.00 | -60% |');
    expect(md).toContain('**cheaper, no quality loss**');
    expect(md).toContain('1 run(s) not started: budget reached.');
    expect(md).toContain('| reviewer | $2.00 | $2.00 |');
  });
});
