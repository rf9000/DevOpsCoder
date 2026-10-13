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

  it('has no patchDirectory, patch or maxCostUsd when the input leaves them out', () => {
    const r = parseSuggestionInput(JSON.stringify(makeInput()));
    expect(r.ok && r.input.patchDirectory).toBeUndefined();
    expect(r.ok && r.input.maxCostUsd).toBeUndefined();
    expect(r.ok && r.input.suggestions[0]!.patch).toBeUndefined();
  });

  it('keeps patchDirectory and a CRLF patch byte-exact', () => {
    const patch = 'diff --git a/T.al b/T.al\n--- a/T.al\n+++ b/T.al\n@@ -1 +1,2 @@\n line1\r\n+line2\r\n';
    const input = makeInput({ patchDirectory: 'src/base-application-test' });
    input.suggestions[0]!.patch = patch;
    const r = parseSuggestionInput(JSON.stringify(input));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.input.patchDirectory).toBe('src/base-application-test');
      expect(r.input.suggestions[0]!.patch).toBe(patch);
    }
  });

  it.each(['../outside', '/abs', 'a\\b', 'C:/x', ''])('rejects patchDirectory %s', (patchDirectory) => {
    expect(parseSuggestionInput(JSON.stringify(makeInput({ patchDirectory }))).ok).toBe(false);
  });

  it('accepts a positive maxCostUsd and rejects zero or a negative one', () => {
    const r = parseSuggestionInput(JSON.stringify(makeInput({ maxCostUsd: 3.5 })));
    expect(r.ok && r.input.maxCostUsd).toBe(3.5);
    expect(parseSuggestionInput(JSON.stringify(makeInput({ maxCostUsd: 0 }))).ok).toBe(false);
    expect(parseSuggestionInput(JSON.stringify(makeInput({ maxCostUsd: -1 }))).ok).toBe(false);
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
    expect(d).toContain('- **F001** add-assert in SomeTest (kills mutants 140, 141)');
    expect(d).not.toContain('Assert the target is empty');
    expect(d).not.toContain('Expected effect');
  });

  it('keeps a title that does not start with the id, and leaves out a missing mutant list', () => {
    const input = makeInput();
    input.suggestions[0]!.title = 'new-test in OtherTest';
    input.suggestions[0]!.description = 'no list';
    expect(buildStackedPrDescription(input, ['F001'])).toEndWith('\n- **F001** new-test in OtherTest');
  });

  it('names the skipped fixes, and the cost cap when it was reached', () => {
    const input = makeInput();
    expect(buildStackedPrDescription(input, ['F001'], { skippedIds: [] })).not.toContain('not applied');
    expect(buildStackedPrDescription(input, ['F001'], { skippedIds: ['F002'] })).toContain('\n1 fix was not applied (F002).\n');
    const capped = buildStackedPrDescription(input, ['F001'], { skippedIds: ['F002', 'F003'], capReached: true });
    expect(capped).toContain('2 fixes were not applied (F002, F003). The agent cost cap was reached.');
  });

  it('stays within 4000 chars with many skipped fixes', () => {
    const input = makeInput();
    const base = input.suggestions[0]!;
    input.suggestions = Array.from({ length: 60 }, (_, i) => ({
      ...base,
      id: `F${String(i + 1).padStart(3, '0')}`,
      title: `F${String(i + 1).padStart(3, '0')}: new-test in ${'Test_'.padEnd(80, 'x')}`,
    }));
    const ids = input.suggestions.map((s) => s.id);
    const d = buildStackedPrDescription(input, ids.slice(0, 50), { skippedIds: ids.slice(50).concat(ids.slice(0, 40)), capReached: true });
    expect(d.length).toBeLessThanOrEqual(4000);
    expect(d).toContain('50 fixes were not applied (F051');
    expect(d).toContain(', …). The agent cost cap was reached.');
  });

  it('drops whole bullets over the 4000-char limit and says how many are left out', () => {
    const input = makeInput();
    const base = input.suggestions[0]!;
    input.suggestions = Array.from({ length: 60 }, (_, i) => ({
      ...base,
      id: `F${String(i + 1).padStart(3, '0')}`,
      title: `F${String(i + 1).padStart(3, '0')}: new-test in ${'Test_'.padEnd(80, 'x')}`,
    }));
    const d = buildStackedPrDescription(input, input.suggestions.map((s) => s.id));
    expect(d.length).toBeLessThanOrEqual(4000);
    const lines = d.split('\n');
    const bullets = lines.filter((l) => l.startsWith('- **F'));
    expect(bullets.length).toBeGreaterThan(0);
    expect(bullets.length).toBeLessThan(60);
    for (const b of bullets) expect(b).toEndWith('(kills mutants 140, 141)');
    expect(lines.at(-1)).toBe(`…and ${60 - bullets.length} more fixes; see the commits.`);
    expect(d).not.toContain('truncated');
  });
});
