import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { wireOrchestratorSkills } from '../../src/services/skill-wiring.ts';

async function runGit(args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  if ((await proc.exited) !== 0) throw new Error(`git ${args.join(' ')} failed: ${stderr || stdout}`);
  return stdout;
}

describe('wireOrchestratorSkills', () => {
  let root: string;
  let sourceDir: string;   // plays the role of SKILLS_SOURCE_DIR (a ".claude"-like dir)
  let repoPath: string;
  let worktreePath: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'skillwire-'));
    sourceDir = join(root, 'orchestrator-claude');
    mkdirSync(join(sourceDir, 'skills', 'continia-deploy'), { recursive: true });
    writeFileSync(
      join(sourceDir, 'skills', 'continia-deploy', 'SKILL.md'),
      '---\ndescription: Deploy AL code.\n---\nbody\n',
      'utf-8',
    );
    repoPath = join(root, 'repo');
    mkdirSync(repoPath, { recursive: true });
    await runGit(['init', '--initial-branch=main'], repoPath);
    await runGit(['config', 'user.email', 't@example.com'], repoPath);
    await runGit(['config', 'user.name', 'T'], repoPath);
    writeFileSync(join(repoPath, 'README.md'), '# r\n', 'utf-8');
    await runGit(['add', '.'], repoPath);
    await runGit(['commit', '-m', 'seed'], repoPath);
    worktreePath = join(root, 'wt');
    await runGit(['worktree', 'add', worktreePath, '-b', 'test-branch'], repoPath);
  }, 30000);

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  }, 30000);

  it('symlinks each skill directory (link, not copy — source edits show through)', () => {
    wireOrchestratorSkills(sourceDir, worktreePath);
    const linked = join(worktreePath, '.claude', 'skills', 'continia-deploy');
    expect(lstatSync(linked).isSymbolicLink()).toBe(true);
    writeFileSync(
      join(sourceDir, 'skills', 'continia-deploy', 'SKILL.md'),
      '---\ndescription: EDITED.\n---\n',
      'utf-8',
    );
    expect(readFileSync(join(linked, 'SKILL.md'), 'utf-8')).toContain('EDITED');
  });

  it('never clobbers a skill the target repo ships itself', () => {
    const theirs = join(worktreePath, '.claude', 'skills', 'continia-deploy');
    mkdirSync(theirs, { recursive: true });
    writeFileSync(join(theirs, 'SKILL.md'), 'THEIRS\n', 'utf-8');
    wireOrchestratorSkills(sourceDir, worktreePath);
    expect(lstatSync(theirs).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(theirs, 'SKILL.md'), 'utf-8')).toBe('THEIRS\n');
  });

  it('is idempotent', () => {
    wireOrchestratorSkills(sourceDir, worktreePath);
    wireOrchestratorSkills(sourceDir, worktreePath);
    expect(lstatSync(join(worktreePath, '.claude', 'skills', 'continia-deploy')).isSymbolicLink()).toBe(true);
  });

  it('registers /.claude/ in the COMMON git dir info/exclude so links never reach a diff', async () => {
    wireOrchestratorSkills(sourceDir, worktreePath);
    // A linked worktree's own gitdir info/exclude is inert; git reads the
    // main repo's .git/info/exclude (the common dir).
    const exclude = readFileSync(join(repoPath, '.git', 'info', 'exclude'), 'utf-8');
    expect(exclude).toContain('/.claude/');
    const status = await runGit(['status', '--porcelain'], worktreePath);
    expect(status.trim()).toBe('');
  });

  it('is a no-op when the source has no skills/ dir', () => {
    wireOrchestratorSkills(join(root, 'nowhere'), worktreePath);
    expect(existsSync(join(worktreePath, '.claude'))).toBe(false);
  });
});
