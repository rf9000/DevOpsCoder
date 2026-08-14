import { describe, it, expect } from 'bun:test';
import { buildGitAuthArgs, redactPat } from '../../src/utils/git-auth.ts';

describe('buildGitAuthArgs', () => {
  it('builds a per-invocation extraHeader with Basic base64(":"+pat)', () => {
    const args = buildGitAuthArgs('my-long-secret-pat');
    const basic = Buffer.from(':my-long-secret-pat').toString('base64');
    expect(args).toEqual(['-c', `http.extraHeader=Authorization: Basic ${basic}`]);
  });
});

describe('redactPat', () => {
  it('redacts both the raw PAT and its base64 basic-auth form', () => {
    const pat = 'super-secret-pat-1234';
    const basic = Buffer.from(`:${pat}`).toString('base64');
    const text = `push failed: header Basic ${basic} rejected for token ${pat}`;
    const out = redactPat(text, pat);
    expect(out).not.toContain(pat);
    expect(out).not.toContain(basic);
    expect(out).toContain('<redacted>');
  });

  it('does not mangle unrelated words when the PAT is a short string', () => {
    // Short test PATs like "pat" appear inside words like "path" — skip raw
    // replacement below 8 chars (real PATs are long random strings).
    expect(redactPat('the path is fine', 'pat')).toBe('the path is fine');
  });

  it('is a no-op for an empty pat', () => {
    expect(redactPat('anything', '')).toBe('anything');
  });
});
