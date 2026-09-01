import { describe, it, expect } from 'bun:test';
import { formatSpendLine, renderCostReport } from '../../src/utils/cost-report.ts';
import type { StepSpend } from '../../src/types/index.ts';

function spend(over: Partial<StepSpend> = {}): StepSpend {
  return {
    usd: 1,
    calls: 1,
    inputTokens: 0,
    outputTokens: 0,
    turns: 0,
    models: [],
    ...over,
  };
}

describe('formatSpendLine', () => {
  it('lists steps most-expensive first', () => {
    const line = formatSpendLine({
      analyzer: spend({ usd: 0.13 }),
      coder: spend({ usd: 8.21 }),
      reviewer: spend({ usd: 4.02 }),
    });
    expect(line).toBe('coder $8.21, reviewer $4.02, analyzer $0.13');
  });

  it('breaks ties on step name so the order is stable across runs', () => {
    const line = formatSpendLine({
      zeta: spend({ usd: 1 }),
      alpha: spend({ usd: 1 }),
    });
    expect(line).toBe('alpha $1.00, zeta $1.00');
  });

  it('returns an empty string when nothing was spent', () => {
    expect(formatSpendLine({})).toBe('');
  });

  // This runs on the watcher's logging path. A state file or outcome from an
  // older build with no breakdown must degrade to "no split", never take the
  // poll cycle down with it.
  it('returns an empty string rather than throwing when the map is missing', () => {
    expect(formatSpendLine(undefined)).toBe('');
  });

  it('keeps a step that ran but cost nothing, so a free step is not hidden', () => {
    expect(formatSpendLine({ analyzer: spend({ usd: 0 }) })).toBe('analyzer $0.00');
  });

  // Six reviewer axes as six entries push the line past useful — the point of
  // the split is that it fits on one line next to the outcome.
  it('collapses `prefix:sub` steps into one entry with a sub-step count', () => {
    const line = formatSpendLine({
      'reviewer:security': spend({ usd: 0.67 }),
      'reviewer:performance': spend({ usd: 0.67 }),
      'reviewer:naming-style': spend({ usd: 0.68 }),
      coder: spend({ usd: 8.21 }),
    });
    expect(line).toBe('coder $8.21, reviewer $2.02 ×3');
  });

  it('does not annotate a prefixed step that ran only once', () => {
    expect(formatSpendLine({ 'reviewer:security': spend({ usd: 0.67 }) })).toBe('reviewer $0.67');
  });

  it('orders a collapsed group by its summed spend, not its largest member', () => {
    const line = formatSpendLine({
      'reviewer:a': spend({ usd: 3 }),
      'reviewer:b': spend({ usd: 3 }),
      coder: spend({ usd: 5 }),
    });
    expect(line).toBe('reviewer $6.00 ×2, coder $5.00');
  });
});

describe('renderCostReport', () => {
  const base = {
    workItemId: 77843,
    outcome: 'completed',
    at: '2026-09-01T07:56:40.000Z',
    totalUsd: 10.5,
    perStage: {
      coder: spend({ usd: 8.21, calls: 3, inputTokens: 412033, outputTokens: 38120, turns: 96, models: ['claude-opus-5'] }),
      analyzer: spend({ usd: 2.29, calls: 1, inputTokens: 22000, outputTokens: 1000, turns: 4, models: ['claude-sonnet-5'] }),
    },
    toolUsage: { Bash: 286, Edit: 19 },
  };

  it('headlines the outcome, total and timestamp', () => {
    expect(renderCostReport(base)).toContain(
      '=== outcome: completed · cost $10.5000 · 2026-09-01T07:56:40.000Z ===',
    );
  });

  it('appends the PR reference to the headline when one was opened', () => {
    const out = renderCostReport({ ...base, prId: 4821, prUrl: 'https://dev.azure.com/pr/4821' });
    expect(out).toContain('· PR !4821 https://dev.azure.com/pr/4821 ===');
  });

  it('renders one row per step, most-expensive first', () => {
    const rows = renderCostReport(base)
      .split('\n')
      .filter((l) => l.startsWith('| ') && !l.startsWith('| step') && !l.startsWith('| **'));
    expect(rows[0]).toContain('coder');
    expect(rows[1]).toContain('analyzer');
  });

  it('renders usd, calls, model, grouped token counts and turns in the row', () => {
    const row = renderCostReport(base)
      .split('\n')
      .find((l) => l.startsWith('| coder '));
    expect(row).toBe('| coder | $8.2100 | 3 | claude-opus-5 | 412,033 / 38,120 | 96 |');
  });

  it('joins multiple models for a step that ran on more than one', () => {
    const out = renderCostReport({
      ...base,
      perStage: { coder: spend({ usd: 1, models: ['claude-opus-5', 'claude-sonnet-5'] }) },
    });
    expect(out).toContain('claude-opus-5, claude-sonnet-5');
  });

  it('totals usd and calls in a final row', () => {
    const row = renderCostReport(base)
      .split('\n')
      .find((l) => l.startsWith('| **Total**'));
    expect(row).toBe('| **Total** | **$10.5000** | **4** | | | |');
  });

  it('lists tool usage below the table', () => {
    expect(renderCostReport(base)).toContain('Tools: Bash×286, Edit×19');
  });

  it('omits the tools line entirely when no tools were used', () => {
    expect(renderCostReport({ ...base, toolUsage: {} })).not.toContain('Tools:');
  });

  it('still reports the headline and total when no step spend was recorded', () => {
    const out = renderCostReport({ ...base, perStage: {}, totalUsd: 0 });
    expect(out).toContain('=== outcome: completed · cost $0.0000');
    expect(out).toContain('(no per-step spend recorded)');
  });

  it('ends with a trailing newline so appends do not run together', () => {
    expect(renderCostReport(base).endsWith('\n')).toBe(true);
  });
});
