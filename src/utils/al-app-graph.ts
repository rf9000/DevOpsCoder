import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, resolve } from 'path';

export interface AlApp {
  /** Worktree-relative directory holding this app's app.json, POSIX separators. */
  dir: string;
  /** `name` from app.json — how other apps refer to it in `dependencies`. */
  name: string;
  /** `name` of each entry in app.json `dependencies` (internal AND external). */
  dependencies: string[];
  /** `application` from app.json — the minimum BC application version this app needs. */
  application?: string;
  /** `platform` from app.json — the minimum BC platform version this app needs. */
  platform?: string;
}

/** Directories never worth descending into when looking for app.json. */
const SKIP_DIRS = new Set(['.git', '.alpackages', 'node_modules', '.vscode', '.claude']);

/** How deep below the worktree root an app.json can sit (e.g. `Banking/Cloud`). */
const MAX_APP_DEPTH = 3;

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Find every AL app in the worktree by locating app.json files.
 *
 * Does not descend into a directory that already has an app.json — an app does
 * not contain other apps, and its subfolders are its own source.
 */
export function discoverAlApps(worktreePath: string): AlApp[] {
  const apps: AlApp[] = [];

  const walk = (absDir: string, depth: number): void => {
    if (depth > MAX_APP_DEPTH) return;

    const manifest = join(absDir, 'app.json');
    if (existsSync(manifest)) {
      try {
        const raw = JSON.parse(readFileSync(manifest, 'utf-8')) as {
          name?: unknown;
          dependencies?: unknown;
          application?: unknown;
          platform?: unknown;
        };
        if (typeof raw.name === 'string') {
          const dependencies = Array.isArray(raw.dependencies)
            ? raw.dependencies
                .map((d) => (d as { name?: unknown })?.name)
                .filter((n): n is string => typeof n === 'string')
            : [];
          apps.push({
            dir: toPosix(relative(worktreePath, absDir)),
            name: raw.name,
            dependencies,
            application: typeof raw.application === 'string' ? raw.application : undefined,
            platform: typeof raw.platform === 'string' ? raw.platform : undefined,
          });
          return; // an app contains no nested apps
        }
      } catch {
        // Malformed app.json: not a usable app, but keep scanning siblings.
      }
    }

    let entries: string[];
    try {
      entries = readdirSync(absDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      const abs = join(absDir, entry);
      try {
        if (statSync(abs).isDirectory()) walk(abs, depth + 1);
      } catch {
        // vanished mid-scan — ignore
      }
    }
  };

  walk(resolve(worktreePath), 0);
  return apps.sort((a, b) => a.dir.localeCompare(b.dir));
}

/**
 * The app that owns a worktree-relative file path, by longest directory match.
 * Longest wins so a nested app beats its parent directory.
 */
export function ownerAppOf(relPath: string, apps: AlApp[]): AlApp | undefined {
  const p = toPosix(relPath).toLowerCase();
  let best: AlApp | undefined;
  for (const app of apps) {
    const prefix = `${app.dir.toLowerCase()}/`;
    if (!p.startsWith(prefix)) continue;
    if (!best || app.dir.length > best.dir.length) best = app;
  }
  return best;
}

/**
 * Expand seed app directories to everything that must be deployed with them,
 * in dependency-first order.
 *
 * Only dependencies that resolve to an app inside this repo are followed —
 * externals (Continia Core, Test Runner, Library Assert, …) come from
 * `continia deps install`, not from us.
 *
 * Ordering is a depth-first post-order walk, which yields a valid topological
 * order for a DAG. A dependency cycle (illegal in AL, but cheap to guard) is
 * broken by the in-progress set rather than recursing forever.
 */
export function resolveDeployOrder(apps: AlApp[], seedDirs: string[]): string[] {
  const byName = new Map(apps.map((a) => [a.name, a]));
  const byDir = new Map(apps.map((a) => [a.dir, a]));

  const ordered: string[] = [];
  const done = new Set<string>();
  const inProgress = new Set<string>();

  const visit = (app: AlApp): void => {
    if (done.has(app.dir) || inProgress.has(app.dir)) return;
    inProgress.add(app.dir);
    for (const depName of app.dependencies) {
      const dep = byName.get(depName);
      if (dep) visit(dep); // internal only; externals are deps-installed
    }
    inProgress.delete(app.dir);
    done.add(app.dir);
    ordered.push(app.dir);
  };

  for (const dir of seedDirs) {
    const app = byDir.get(toPosix(dir));
    if (app) visit(app);
  }
  return ordered;
}
