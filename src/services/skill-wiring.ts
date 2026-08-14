import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
} from 'fs';
import { join, resolve } from 'path';

/**
 * Symlink the orchestrator's own skills into a per-WI worktree's `.claude/`.
 * The Agent SDK loads `.claude/` relative to its cwd when
 * `settingSources: ['project']` is set (which every DevopsCoder stage does),
 * so this is what puts orchestrator-shipped skills in the agent's hands.
 * Symlinks, not copies: editing a skill takes effect on the next job.
 *
 * Ported from ADONewDirectCombuilder's wireSkills with two deliberate deltas:
 * only `skills/` is linked (we ship nothing else), and only DIRECTORY entries
 * are linked — 'junction' symlinks are directory-only on Windows, so file
 * entries would fail on the dev machine.
 */
export function wireOrchestratorSkills(skillsSourceDir: string, worktreePath: string): void {
  const sourceSkills = resolve(skillsSourceDir, 'skills');
  if (!existsSync(sourceSkills)) return;

  const destSkills = join(worktreePath, '.claude', 'skills');
  mkdirSync(destSkills, { recursive: true });

  for (const entry of readdirSync(sourceSkills)) {
    const sourceEntry = join(sourceSkills, entry);
    if (!statSync(sourceEntry).isDirectory()) continue;
    const dest = join(destSkills, entry);
    // Never clobber a skill the target repo ships itself — theirs wins.
    if (existsSync(dest) || isSymlink(dest)) continue;
    // 'junction' needs no admin/Developer Mode on Windows; ignored on Linux.
    // The target must be absolute for junctions — resolve() above guarantees it.
    symlinkSync(sourceEntry, dest, 'junction');
  }

  // Exclude the whole directory: whatever lands under .claude/ (links now,
  // SDK runtime files later) must never reach a commit or a PR diff. This
  // cannot hide files a repo genuinely tracks — info/exclude only affects
  // untracked files.
  addGitExclude(worktreePath, '/.claude/');
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Append one path to the repo's info/exclude, skipping if already present. */
function addGitExclude(worktree: string, pattern: string): void {
  const gitDir = resolveGitCommonDir(worktree);
  if (!gitDir) return;

  const infoDir = join(gitDir, 'info');
  mkdirSync(infoDir, { recursive: true });
  const excludeFile = join(infoDir, 'exclude');

  const existing = existsSync(excludeFile)
    ? readFileSync(excludeFile, 'utf-8').split(/\r?\n/)
    : [];
  if (existing.some((l) => l.trim() === pattern)) return;

  const header = existing.length === 0 ? '# added by DevopsCoder\n' : '';
  appendFileSync(excludeFile, `${header}${pattern}\n`, 'utf-8');
}

/**
 * Resolve the directory whose `info/exclude` git actually reads. In a linked
 * worktree `.git` is a FILE containing `gitdir: <path>`, and that per-worktree
 * gitdir is NOT where exclusions belong: git reads `info/exclude` from the
 * common dir, so anything written under `worktrees/<name>/info/` is silently
 * inert (this was a real, shipped bug in the sibling before it followed the
 * `commondir` file — mirror its fix).
 */
function resolveGitCommonDir(worktree: string): string | undefined {
  const dotGit = join(worktree, '.git');
  if (!existsSync(dotGit)) return undefined;

  let gitDir: string;
  if (lstatSync(dotGit).isDirectory()) {
    gitDir = dotGit;
  } else {
    const contents = readFileSync(dotGit, 'utf-8').trim();
    const match = /^gitdir:\s*(.+)$/.exec(contents);
    if (!match || !match[1]) return undefined;
    gitDir = resolve(worktree, match[1].trim());
  }

  const commonDirFile = join(gitDir, 'commondir');
  if (!existsSync(commonDirFile)) return gitDir;

  const commonDir = readFileSync(commonDirFile, 'utf-8').trim();
  if (commonDir === '') return gitDir;
  return resolve(gitDir, commonDir);
}
