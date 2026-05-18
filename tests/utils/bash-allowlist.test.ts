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
});
