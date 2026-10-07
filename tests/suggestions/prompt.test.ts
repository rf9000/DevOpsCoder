import { describe, it, expect } from 'bun:test';
import { buildApplySuggestionPrompt } from '../../src/suggestions/prompt.ts';
import { suggestionToFinding } from '../../src/suggestions/input.ts';
import { makeInput } from '../helpers/suggestion-input.ts';

const worktree = { path: '/wt/mutant-pr-12345-abc1234', branch: 'mutant/pr-12345-abc1234', baseSha: 'abc' };

function render(line: number | undefined) {
  const s = { ...makeInput().suggestions[0]! };
  if (line === undefined) delete (s as { line?: number }).line;
  return buildApplySuggestionPrompt({
    findings: [suggestionToFinding(s)], diff: '', worktree, workItemId: 12345,
    workItemTitle: 'Mutation fixes for !12345 (run 1003)', skills: [], round: 1, maxRounds: 3,
  });
}

describe('buildApplySuggestionPrompt', () => {
  it('gives file, anchor line, rationale and the code verbatim', () => {
    const p = render(68);
    expect(p).toContain('Continia Banking/base-application-test/Auth/TestAuth.Codeunit.al');
    expect(p).toContain('after line 68');
    expect(p).toContain('Kills mutants: 140, 141');
    expect(p).toContain('        Assert.RecordIsEmpty(TempTarget);');
    expect(p).toContain('Do not push');
  });

  it('says to add a new procedure when there is no line', () => {
    expect(render(undefined)).toContain('new test procedure');
  });

  it('carries none of the reviewer framing', () => {
    const p = render(68);
    expect(p).not.toContain('rejected');
    expect(p).not.toContain('diff under review');
  });
});
