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
 * The `base` DemoPortal localization corresponds to the W1 ("world") app —
 * there is no `banking-base`.
 */
const BASE_LOCALIZATION_APP_CC = 'w1';

export interface LocalizationAppMatch {
  /** Worktree-relative directory of the country app to deps-install. */
  dir: string;
  /** True when the requested localization had no app and W1 stood in. */
  fellBack: boolean;
}

/**
 * The country app whose dependencies must be installed on an environment of
 * this localization.
 *
 * Since v29 only the country apps declare `Continia Finance` — `base-application`
 * does not — so `deps install banking-<cc>` is the only thing that brings Finance
 * onto an environment. Every country app declares it, which is why falling back
 * to W1 is safe: the fallback still achieves the step's purpose. That path is
 * real, not defensive — BC 29 publishes `au`/`ca`/`nz` profiles for which this
 * repo has no app.
 *
 * Returns `undefined` when the repo has no country app at all; the caller logs
 * and skips rather than failing, because a repo without one is not Continia
 * Banking and the verification gate should not die over it.
 */
export function localizationAppDir(
  apps: AlApp[],
  localization: string,
): LocalizationAppMatch | undefined {
  const cc = localization.trim().toLowerCase();
  const wanted = cc === '' || cc === 'base' ? BASE_LOCALIZATION_APP_CC : cc;

  const byCc = (code: string): AlApp | undefined =>
    apps.find((a) => a.dir.toLowerCase() === `banking-${code}`);

  const exact = byCc(wanted);
  if (exact) return { dir: exact.dir, fellBack: false };

  const w1 = byCc(BASE_LOCALIZATION_APP_CC);
  if (w1) return { dir: w1.dir, fellBack: true };

  return undefined;
}

/**
 * Vendored third-party source. Its apps come from `continia deps install`, and
 * their app.json names collide with the real externals by design — the app in
 * `external/Continia Finance` is literally named `Continia Finance`. Following a
 * dependency edge into this directory therefore means compiling somebody else's
 * source (pinned to an older `application` version) against our environment.
 */
const EXTERNAL_DIR_PREFIX = 'external/';

function isVendored(app: AlApp): boolean {
  return app.dir.toLowerCase().startsWith(EXTERNAL_DIR_PREFIX);
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
      // Internal only; externals are deps-installed. Vendored apps are skipped
      // here but NOT at the seed: a WI that edits vendored source aims at it
      // deliberately and must still build.
      if (dep && !isVendored(dep)) visit(dep);
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
