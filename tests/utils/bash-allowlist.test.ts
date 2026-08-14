import { describe, it, expect } from 'bun:test';
import { createBashAllowlist } from '../../src/utils/bash-allowlist.ts';

describe('createBashAllowlist', () => {
  it('allows non-Bash tool calls unconditionally', async () => {
    const filter = createBashAllowlist({ allow: [], deny: [] });
    const result = await filter('Read', { file_path: '/x' });
    expect(result.behavior).toBe('allow');
  });

  it('allows a Bash command matching the allow list', async () => {
    const filter = createBashAllowlist({
      allow: [/^git status/, /^git diff/],
      deny: [],
    });
    const result = await filter('Bash', { command: 'git status' });
    expect(result.behavior).toBe('allow');
  });

  it('denies a Bash command matching the deny list', async () => {
    const filter = createBashAllowlist({
      allow: [/^git /],
      deny: [/^git push/, /^git reset --hard/],
    });
    const result = await filter('Bash', { command: 'git push origin main' });
    expect(result.behavior).toBe('deny');
    if (result.behavior === 'deny') {
      expect(result.message).toContain('denied');
    }
  });

  it('denies a Bash command matching no allow pattern (allowlist semantics)', async () => {
    const filter = createBashAllowlist({
      allow: [/^git status/],
      deny: [],
    });
    const result = await filter('Bash', { command: 'curl https://example.com' });
    expect(result.behavior).toBe('deny');
  });

  it('deny takes precedence over allow when both match', async () => {
    const filter = createBashAllowlist({
      allow: [/^git /],
      deny: [/^git push/],
    });
    const result = await filter('Bash', { command: 'git push' });
    expect(result.behavior).toBe('deny');
  });

  it('denies a Bash call with no command field', async () => {
    const filter = createBashAllowlist({
      allow: [/^.*/],
      deny: [],
    });
    const result = await filter('Bash', {});
    expect(result.behavior).toBe('deny');
  });

  it('real-world: coder allowlist permits commit but blocks push', async () => {
    const filter = createBashAllowlist({
      allow: [/^git (status|diff|log|show|blame|add\b|commit\b|rm\b|mv\b)/],
      deny: [
        /^git push/,
        /^git checkout/,
        /^git reset/,
        /^git rebase/,
        /^git merge/,
        /^cd\b/,
        /^rm /,
      ],
    });
    expect((await filter('Bash', { command: 'git commit -m "fix"' })).behavior).toBe('allow');
    expect((await filter('Bash', { command: 'git add src/foo.ts' })).behavior).toBe('allow');
    expect((await filter('Bash', { command: 'git status' })).behavior).toBe('allow');
    expect((await filter('Bash', { command: 'git push origin main' })).behavior).toBe('deny');
    expect((await filter('Bash', { command: 'git reset --hard HEAD~3' })).behavior).toBe('deny');
    expect((await filter('Bash', { command: 'cd ..' })).behavior).toBe('deny');
  });

  it('cd is denied even if the allowlist contains a permissive catch-all', async () => {
    const filter = createBashAllowlist({
      allow: [/.*/], // catch-all
      deny: [/^cd\b/],
    });
    const result = await filter('Bash', { command: 'cd /some/path' });
    expect(result.behavior).toBe('deny');
  });

  describe('shell composition (security-critical: anti-bypass)', () => {
    // The `^`-anchored allowlist scans only the start of the command string.
    // Without these guards, `git status && git push` would be allowed because
    // it starts with `git status`. Each test exercises one composition vector.

    const filter = createBashAllowlist({
      allow: [/^git status\b/, /^git add\b/, /^echo\b/, /^cat\b/, /^ls\b/],
      deny: [/^git push\b/, /^rm\b/],
    });

    it('denies `&&` composition (the classic bypass)', async () => {
      const result = await filter('Bash', {
        command: 'git status && git push origin main',
      });
      expect(result.behavior).toBe('deny');
      if (result.behavior === 'deny') {
        expect(result.message).toContain('shell composition');
      }
    });

    it('denies `||` composition', async () => {
      const result = await filter('Bash', {
        command: 'git add x || rm -rf /',
      });
      expect(result.behavior).toBe('deny');
    });

    it('denies `;` composition', async () => {
      const result = await filter('Bash', {
        command: 'echo hi; rm -rf /',
      });
      expect(result.behavior).toBe('deny');
    });

    it('denies pipe composition', async () => {
      const result = await filter('Bash', {
        command: 'cat foo.txt | head',
      });
      expect(result.behavior).toBe('deny');
    });

    it('denies command substitution `$(...)`', async () => {
      const result = await filter('Bash', {
        command: 'echo $(git rev-parse HEAD)',
      });
      expect(result.behavior).toBe('deny');
    });

    it('denies backtick command substitution', async () => {
      const result = await filter('Bash', {
        command: 'echo `whoami`',
      });
      expect(result.behavior).toBe('deny');
    });

    it('denies output redirection (> / >>)', async () => {
      expect((await filter('Bash', { command: 'cat foo > out.txt' })).behavior).toBe('deny');
      expect((await filter('Bash', { command: 'cat foo >> out.txt' })).behavior).toBe('deny');
    });

    it('denies input redirection (< / <<)', async () => {
      expect((await filter('Bash', { command: 'cat < foo.txt' })).behavior).toBe('deny');
    });

    it('denies newline composition (second command on a new line)', async () => {
      const result = await filter('Bash', {
        command: 'git status\ngit push origin main',
      });
      expect(result.behavior).toBe('deny');
      if (result.behavior === 'deny') {
        expect(result.message).toContain('shell composition');
      }
    });

    it('denies carriage-return composition', async () => {
      const result = await filter('Bash', {
        command: 'git status\r\ngit push origin main',
      });
      expect(result.behavior).toBe('deny');
    });

    it('still allows simple commands without composition', async () => {
      expect((await filter('Bash', { command: 'git status' })).behavior).toBe('allow');
      expect((await filter('Bash', { command: 'ls' })).behavior).toBe('allow');
    });

    it('accepts the false-positive on quoted shell metacharacters (e.g. commit messages)', async () => {
      // This is the known trade-off: a commit message containing `&&` is rejected.
      // The model can rephrase without those characters. Document the behavior.
      const filter2 = createBashAllowlist({
        allow: [/^git commit\b/],
        deny: [],
      });
      const result = await filter2('Bash', {
        command: 'git commit -m "feat: foo && bar"',
      });
      expect(result.behavior).toBe('deny');
    });
  });
});
