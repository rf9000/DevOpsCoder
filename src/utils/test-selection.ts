import { readFileSync } from 'fs';
import { relative, resolve } from 'path';
import type { DiscoveredTestCodeunit } from './al-test-discovery.ts';

/**
 * How much of the discovered test suite a verification round actually runs.
 *
 * `all` is the original behaviour and is almost never what you want on a large
 * AL codebase: test codeunits run strictly sequentially (BC forbids parallel
 * test jobs on one environment) with a per-codeunit timeout, so a few hundred
 * codeunits is hours of wall clock and a guaranteed stage timeout.
 */
export type TestSelectionMode = 'changed' | 'related' | 'all';

export const TEST_SELECTION_MODES: TestSelectionMode[] = ['changed', 'related', 'all'];

/**
 * AL object declarations. Extension kinds come first so `tableextension` is not
 * matched as `table` followed by garbage.
 */
const AL_OBJECT_DECL_RE =
  /^\s*(tableextension|pageextension|enumextension|reportextension|permissionsetextension|table|page|codeunit|report|query|xmlport|enum|interface|controladdin|permissionset|profile|pagecustomization|entitlement)\s+(?:\d+\s+)?(?:"([^"]+)"|([A-Za-z_]\w*))/gim;

const SUBTYPE_TEST_RE = /Subtype\s*=\s*Test\b/i;

/** Object names declared by an AL source file. */
export function extractAlObjectNames(content: string): string[] {
  const names: string[] = [];
  for (const m of content.matchAll(AL_OBJECT_DECL_RE)) {
    const name = m[2] ?? m[3];
    if (name) names.push(name);
  }
  return names;
}

/** Normalise for comparison: OS-independent separators, lowercase. */
function normalisePath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
}

/**
 * Does `haystack` reference the AL object `name`?
 *
 * Quoted form ("Payment Journal Mgt.") is how AL references any name with
 * spaces or punctuation, and is the overwhelmingly common case. Bare
 * identifiers get a word-boundary check so `Bank` does not match `BankAccount`.
 */
function referencesObject(haystack: string, name: string): boolean {
  if (haystack.includes(`"${name}"`)) return true;
  if (/^[A-Za-z_]\w*$/.test(name)) {
    return new RegExp(`\\b${name}\\b`).test(haystack);
  }
  return false;
}

export interface SelectTestCodeunitsOptions {
  discovered: DiscoveredTestCodeunit[];
  /** Worktree-relative paths changed since the baseline, from `git diff`. */
  changedFiles: string[];
  worktreePath: string;
  mode: TestSelectionMode;
  /** 0 = unlimited. Guards against a widely-referenced object selecting everything. */
  maxCodeunits: number;
  /** Injectable for tests. */
  readFile?: (absPath: string) => string;
}

export interface TestSelection {
  selected: DiscoveredTestCodeunit[];
  /** Selected before `maxCodeunits` truncation — 0 when nothing was dropped. */
  droppedByCap: number;
  /** Human-readable account of how the selection was reached, for the log. */
  reason: string;
}

/**
 * Narrow the discovered test codeunits to the ones this change actually needs.
 *
 * - `changed`  — test codeunits declared in files the pipeline itself touched.
 * - `related`  — those, plus test codeunits referencing an AL object declared
 *                in a changed non-test file.
 * - `all`      — no narrowing.
 *
 * `related` is a deliberate heuristic, not a dependency graph: it matches on
 * object-name references in test sources. It can miss a test that exercises
 * changed code only transitively, and it over-selects when a changed object is
 * widely referenced — which is what `maxCodeunits` is for. The trade is
 * accepted because the alternative, running everything, is not viable.
 */
export function selectTestCodeunits(opts: SelectTestCodeunitsOptions): TestSelection {
  const { discovered, changedFiles, worktreePath, mode, maxCodeunits } = opts;
  const read = opts.readFile ?? ((p: string) => readFileSync(p, 'utf-8'));

  if (mode === 'all') {
    return applyCap(discovered, maxCodeunits, `mode=all (${discovered.length} discovered)`);
  }

  const changedSet = new Set(changedFiles.map(normalisePath));
  const isChanged = (absFile: string): boolean =>
    changedSet.has(normalisePath(relative(worktreePath, absFile)));

  const direct = discovered.filter((cu) => isChanged(cu.file));

  if (mode === 'changed') {
    return applyCap(
      direct,
      maxCodeunits,
      `mode=changed — ${direct.length} of ${discovered.length} test codeunit(s) live in changed files`,
    );
  }

  // mode === 'related': add tests referencing objects declared in changed,
  // non-test AL sources. A changed test file contributes its own codeunit via
  // `direct`, not its object name — otherwise every test referencing a helper
  // test codeunit would be pulled in.
  const changedObjectNames = new Set<string>();
  for (const rel of changedFiles) {
    if (!rel.toLowerCase().endsWith('.al')) continue;
    let content: string;
    try {
      content = read(resolve(worktreePath, rel));
    } catch {
      continue; // deleted in this change — nothing to reference
    }
    if (SUBTYPE_TEST_RE.test(content)) continue;
    for (const name of extractAlObjectNames(content)) changedObjectNames.add(name);
  }

  const selected = new Map(direct.map((cu) => [cu.id, cu]));
  if (changedObjectNames.size > 0) {
    for (const cu of discovered) {
      if (selected.has(cu.id)) continue;
      let content: string;
      try {
        content = read(cu.file);
      } catch {
        continue;
      }
      for (const name of changedObjectNames) {
        if (referencesObject(content, name)) {
          selected.set(cu.id, cu);
          break;
        }
      }
    }
  }

  const ordered = [...selected.values()].sort((a, b) => a.id - b.id);
  return applyCap(
    ordered,
    maxCodeunits,
    `mode=related — ${direct.length} in changed file(s), ${ordered.length - direct.length} referencing ` +
      `${changedObjectNames.size} changed object(s), of ${discovered.length} discovered`,
  );
}

function applyCap(
  codeunits: DiscoveredTestCodeunit[],
  maxCodeunits: number,
  reason: string,
): TestSelection {
  if (maxCodeunits <= 0 || codeunits.length <= maxCodeunits) {
    return { selected: codeunits, droppedByCap: 0, reason };
  }
  return {
    selected: codeunits.slice(0, maxCodeunits),
    droppedByCap: codeunits.length - maxCodeunits,
    reason: `${reason}; capped at ${maxCodeunits}`,
  };
}
