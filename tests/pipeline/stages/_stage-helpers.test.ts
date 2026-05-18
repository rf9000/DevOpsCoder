import { describe, it, expect } from 'bun:test';
import { aggregateReviewerFindings } from '../../../src/pipeline/stages/_stage-helpers.ts';
import type { Finding } from '../../../src/types/index.ts';

// ─── helpers ────────────────────────────────────────────────────────────────

function f(overrides: Partial<Finding> & Pick<Finding, 'severity' | 'file'>): Finding {
  return {
    line: undefined,
    title: 'Default title',
    description: 'Default description',
    suggestion: undefined,
    axis: 'style',
    ...overrides,
  };
}

// ─── tests ──────────────────────────────────────────────────────────────────

describe('aggregateReviewerFindings', () => {
  it('returns [] for empty input', () => {
    expect(aggregateReviewerFindings([])).toEqual([]);
  });

  it('returns a copy of a single finding, not the same object reference', () => {
    const input = f({ severity: 'major', file: 'app.al', line: 10, axis: 'style' });
    const result = aggregateReviewerFindings([input]);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(input);
    expect(result[0]).not.toBe(input); // must be a new object
  });

  it('deduplicates by file:line — keeps highest-severity finding and concatenates axes', () => {
    // Input order: security(critical) first, then style(minor) — so axis order is "security, style"
    const critical = f({ severity: 'critical', file: 'app.al', line: 42, axis: 'security', title: 'Critical title', description: 'Critical desc' });
    const minor = f({ severity: 'minor', file: 'app.al', line: 42, axis: 'style' });
    const result = aggregateReviewerFindings([critical, minor]);
    expect(result).toHaveLength(1);
    expect(result[0]!.severity).toBe('critical');
    expect(result[0]!.title).toBe('Critical title');
    expect(result[0]!.description).toBe('Critical desc');
    expect(result[0]!.axis).toBe('security, style');
  });

  it('deduplicates file-level findings (no line) against each other, but not against line-level findings', () => {
    // Two file-level findings on the same file — should merge (blocking first so axis order is "security, style")
    const blocking = f({ severity: 'blocking', file: 'app.al', axis: 'security' });
    const nit = f({ severity: 'nit', file: 'app.al', axis: 'style' });
    // A line-level finding on the same file — must NOT merge with the file-level ones
    const lineFinding = f({ severity: 'minor', file: 'app.al', line: 5, axis: 'performance' });

    const result = aggregateReviewerFindings([blocking, nit, lineFinding]);
    // Expected: 2 findings — one merged file-level (blocking) + one line-level
    expect(result).toHaveLength(2);
    const fileLevelResult = result.find(r => r.line === undefined);
    expect(fileLevelResult?.severity).toBe('blocking');
    expect(fileLevelResult?.axis).toBe('security, style');
    const lineLevelResult = result.find(r => r.line === 5);
    expect(lineLevelResult?.severity).toBe('minor');
  });

  it('sorts deduplicated output by severity descending — blocking first, nit last', () => {
    const input: Finding[] = [
      f({ severity: 'nit', file: 'a.al' }),
      f({ severity: 'blocking', file: 'b.al' }),
      f({ severity: 'major', file: 'c.al' }),
      f({ severity: 'critical', file: 'd.al' }),
      f({ severity: 'minor', file: 'e.al' }),
    ];
    const result = aggregateReviewerFindings(input);
    expect(result.map(r => r.severity)).toEqual(['blocking', 'critical', 'major', 'minor', 'nit']);
  });

  it('stable sort — preserves input order within the same severity', () => {
    const a = f({ severity: 'major', file: 'a.al', title: 'A' });
    const b = f({ severity: 'major', file: 'b.al', title: 'B' });
    const c = f({ severity: 'major', file: 'c.al', title: 'C' });
    const result = aggregateReviewerFindings([a, b, c]);
    expect(result.map(r => r.title)).toEqual(['A', 'B', 'C']);
  });

  it('axis deduplication — same axis name is not listed twice when multiple same-axis findings collapse', () => {
    const a = f({ severity: 'minor', file: 'app.al', line: 99, axis: 'style' });
    const b = f({ severity: 'major', file: 'app.al', line: 99, axis: 'style' });
    const result = aggregateReviewerFindings([a, b]);
    expect(result).toHaveLength(1);
    expect(result[0]!.axis).toBe('style'); // not "style, style"
  });
});
