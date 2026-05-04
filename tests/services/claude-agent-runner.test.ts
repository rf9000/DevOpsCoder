import { describe, it, expect } from 'bun:test';
import { extractJson } from '../../src/services/claude-agent-runner.ts';

describe('extractJson', () => {
  it('returns input as-is when it is already a bare JSON object', () => {
    expect(extractJson('{"a":1}')).toBe('{"a":1}');
  });

  it('strips ```json fences', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('strips bare ``` fences without a language tag', () => {
    expect(extractJson('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('extracts the outermost JSON object when surrounded by prose', () => {
    expect(extractJson('Sure! {"verdict":"proceed"} that is the answer.'))
      .toBe('{"verdict":"proceed"}');
  });

  it('returns the trimmed input when no JSON object is found', () => {
    expect(extractJson('  no json here  ')).toBe('no json here');
  });
});
