import { execFileSync } from 'child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'fs';
import { dirname, isAbsolute, join, relative } from 'path';

/** True when `relPath` is tracked by git in `worktreePath`. */
export type IsTrackedFn = (worktreePath: string, relPath: string) => boolean;

const defaultIsTracked: IsTrackedFn = (worktreePath, relPath) => {
  const out = execFileSync('git', ['ls-files', '--', relPath], {
    cwd: worktreePath,
    encoding: 'utf-8',
  });
  return out.trim().length > 0;
};

/**
 * Path of the repo's `info/exclude`, which for a linked worktree is the shared
 * one in the common `.git` — a per-clone ignore list that is never committed.
 */
export type ExcludePathFn = (worktreePath: string) => string;

const defaultExcludePath: ExcludePathFn = (worktreePath) => {
  const out = execFileSync('git', ['rev-parse', '--git-path', 'info/exclude'], {
    cwd: worktreePath,
    encoding: 'utf-8',
  }).trim();
  return isAbsolute(out) ? out : join(worktreePath, out);
};

/** Append each path to `info/exclude` once, as an anchored literal pattern. */
function excludePaths(excludeFile: string, rels: string[]): void {
  mkdirSync(dirname(excludeFile), { recursive: true });
  const existing = existsSync(excludeFile) ? readFileSync(excludeFile, 'utf-8').split(/\r?\n/) : [];
  const missing = rels.map((r) => `/${r}`).filter((line) => !existing.includes(line));
  if (missing.length === 0) return;
  const prefix = existing.length > 0 && existing[existing.length - 1] !== '' ? '\n' : '';
  appendFileSync(excludeFile, `${prefix}# DevOpsCoder worktree overlay\n${missing.join('\n')}\n`);
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

/**
 * Copy an orchestrator-owned file tree into a worktree, preserving relative
 * paths. Used for the build files a developer keeps locally but the repo does
 * not track — the Banking `.cli-ruleset.json` and the
 * `continia.appsource.ruleset.json` it includes — so the agent compiles with
 * the rules the team builds with rather than the stricter committed ones.
 *
 * Refuses to overwrite a *tracked* file: a changed tracked file is a diff the
 * coder could commit into the PR. Every copied path is also added to the
 * clone's `info/exclude`. The repo's own `.gitignore` does not list these
 * files (a developer's local edit did), and an untracked-but-not-ignored file
 * is both stageable and deleted by the pipeline's `git clean -fd` reset —
 * after which `deploy --ruleset` would point at a missing file, a hard error.
 *
 * Returns the worktree-relative paths written.
 */
export function applyWorktreeOverlay(
  sourceDir: string,
  worktreePath: string,
  isTracked: IsTrackedFn = defaultIsTracked,
  excludePath: ExcludePathFn = defaultExcludePath,
): string[] {
  const written: string[] = [];
  for (const file of listFiles(sourceDir)) {
    const rel = relative(sourceDir, file).replace(/\\/g, '/');
    if (isTracked(worktreePath, rel)) {
      throw new Error(
        `worktree overlay: refusing to overwrite tracked file ${rel} — it would show up in the PR diff. Remove it from ${sourceDir}.`,
      );
    }
    const target = join(worktreePath, rel);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(file, target);
    written.push(rel);
  }
  if (written.length > 0) excludePaths(excludePath(worktreePath), written);
  return written;
}
