import { describe, it, expect } from 'bun:test';
import { slugify } from '../../src/utils/slug.ts';

describe('slugify', () => {
  it('lowercases and replaces non-alnum with hyphens', () => {
    expect(slugify('Fix Login Bug!')).toBe('fix-login-bug');
  });

  it('collapses runs of separators', () => {
    expect(slugify('  hello   world___foo  ')).toBe('hello-world-foo');
  });

  it('trims leading and trailing hyphens', () => {
    expect(slugify('---abc---')).toBe('abc');
  });

  it('truncates to maxLen and trims trailing hyphens after truncation', () => {
    const out = slugify('the-quick-brown-fox-jumps-over-the-lazy-dog', 20);
    expect(out.length).toBeLessThanOrEqual(20);
    expect(out).not.toMatch(/-$/);
  });

  it('returns "wi" when input has no alphanumerics', () => {
    expect(slugify('!!! ???')).toBe('wi');
  });

  it('handles unicode letters by stripping them (ASCII-only slugs)', () => {
    expect(slugify('café résumé')).toBe('caf-r-sum');
  });
});
