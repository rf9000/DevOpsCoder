import { describe, it, expect } from 'bun:test';
import { buildFixFindingsPrompt, fixFindingsOutputSchema } from '../../../src/pipeline/stages/fix-findings.ts';
import type { Finding, WorktreeContext } from '../../../src/types/index.ts';

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
  // material that turns it back into a re-implementation.
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
