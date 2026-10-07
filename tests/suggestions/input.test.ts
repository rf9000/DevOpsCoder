import { describe, it, expect } from 'bun:test';
import {
  buildStackedPrDescription,
  commitMessage,
  mutantBranchName,
  parseSuggestionInput,
  stackedPrTitle,
  suggestionToFinding,
} from '../../src/suggestions/input.ts';
import { HEAD, makeInput } from '../helpers/suggestion-input.ts';

describe('parseSuggestionInput', () => {
  it('accepts the contract example', () => {
    const r = parseSuggestionInput(JSON.stringify(makeInput()));
    expect(r.ok).toBe(true);
  });

  it('accepts push mode and a suggestion without line', () => {
    const input = makeInput({ mode: 'push' });
    delete (input.suggestions[0] as { line?: number }).line;
    const r = parseSuggestionInput(JSON.stringify(input));
    expect(r.ok).toBe(true);
  });

  it.each([
    ['unknown mode', { mode: 'comment' }],
    ['short head commit', { headCommit: 'abc1234' }],
    ['source ref without refs/heads/', { sourceRefName: 'feature/foo' }],
    ['no suggestions', { suggestions: [] }],
  ])('rejects %s', (_name, patch) => {
    const r = parseSuggestionInput(JSON.stringify({ ...makeInput(), ...patch }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toStartWith('invalid-input:');
  });

  it('rejects duplicate fix ids', () => {
    const input = makeInput();
    input.suggestions.push({ ...input.suggestions[0]! });
    const r = parseSuggestionInput(JSON.stringify(input));
    expect(r.ok).toBe(false);
  });

  it.each(['../outside.al', '/abs/path.al', 'a\\b.al'])('rejects file path %s', (file) => {
    const input = makeInput();
    input.suggestions[0]!.file = file;
    expect(parseSuggestionInput(JSON.stringify(input)).ok).toBe(false);
  });

  it('rejects text that is not JSON', () => {
    const r = parseSuggestionInput('{nope');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toStartWith('invalid-input:');
  });
});

describe('mapping', () => {
  it('maps a suggestion to a critical mutation finding', () => {
    const s = makeInput().suggestions[0]!;
    expect(suggestionToFinding(s)).toEqual({
      severity: 'critical',
      file: s.file,
      line: 68,
      title: s.title,
      description: s.description,
      suggestion: s.code,
      axis: 'mutation',
    });
  });

  it('omits line for a new procedure', () => {
    const s = { ...makeInput().suggestions[0]! };
    delete (s as { line?: number }).line;
    expect('line' in suggestionToFinding(s)).toBe(false);
  });

  it('names the branch mutant/pr-<id>-<sha7>', () => {
    expect(mutantBranchName(12345, HEAD)).toBe('mutant/pr-12345-abc1234');
  });

  it('builds the contract commit message from the Kills mutants line', () => {
    const input = makeInput();
    expect(commitMessage(input, input.suggestions[0]!)).toBe(
      'test: F001 kill mutants 140, 141 (mutant-fixer run 1003)',
    );
  });

  it('drops the mutant list when the description has none', () => {
    const input = makeInput();
    input.suggestions[0]!.description = 'no list';
    expect(commitMessage(input, input.suggestions[0]!)).toBe('test: F001 (mutant-fixer run 1003)');
  });

  it('titles and describes the stacked PR', () => {
    const input = makeInput();
    expect(stackedPrTitle(input)).toBe('Mutation fixes for !12345 (run 1003)');
    const d = buildStackedPrDescription(input, ['F001']);
    expect(d).toContain(`[!12345](${input.parentPullRequestUrl})`);
    expect(d).toContain('- **F001** F001: add-assert in SomeTest: Assert the target is empty.');
    expect(d).not.toContain('Expected effect');
  });
});
