import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { applyWorktreeOverlay } from '../../src/services/worktree-overlay.ts';

describe('applyWorktreeOverlay', () => {
  let root: string;
  let src: string;
  let wt: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ovl-'));
    src = join(root, 'overlay');
    wt = join(root, 'wt');
    mkdirSync(join(src, 'Banking Rulesets'), { recursive: true });
    mkdirSync(wt);
    writeFileSync(join(src, 'Banking Rulesets', '.cli-ruleset.json'), '{"rules":[]}');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('copies files keeping their relative paths, and overwrites on re-entry', () => {
    writeFileSync(join(wt, 'stale'), '');
    expect(applyWorktreeOverlay(src, wt, () => false, () => join(root, 'exclude'))).toEqual(['Banking Rulesets/.cli-ruleset.json']);
    writeFileSync(join(src, 'Banking Rulesets', '.cli-ruleset.json'), '{"rules":[1]}');
    applyWorktreeOverlay(src, wt, () => false, () => join(root, 'exclude'));
    expect(readFileSync(join(wt, 'Banking Rulesets', '.cli-ruleset.json'), 'utf-8')).toBe('{"rules":[1]}');
  });

  it('refuses to overwrite a tracked file — it would land in the PR diff', () => {
    expect(() => applyWorktreeOverlay(src, wt, (_w, rel) => rel.endsWith('.cli-ruleset.json'), () => join(root, 'exclude'))).toThrow(
      /refusing to overwrite tracked file Banking Rulesets\/.cli-ruleset.json/,
    );
  });

  it('adds each copied path to info/exclude exactly once', () => {
    const ex = join(root, 'exclude');
    writeFileSync(ex, '# existing\n*.tmp');
    applyWorktreeOverlay(src, wt, () => false, () => ex);
    applyWorktreeOverlay(src, wt, () => false, () => ex);
    const lines = readFileSync(ex, 'utf-8').split('\n');
    expect(lines.filter((l) => l === '/Banking Rulesets/.cli-ruleset.json')).toHaveLength(1);
    expect(lines[0]).toBe('# existing');
    expect(lines[1]).toBe('*.tmp');
  });
});
