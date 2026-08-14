import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, resolve } from 'path';

export interface DiscoveredTestCodeunit {
  id: number;
  name: string;
  file: string;
}

const SUBTYPE_TEST_RE = /Subtype\s*=\s*Test\b/i;
const CODEUNIT_DECL_RE = /codeunit\s+(\d+)\s+("([^"]+)"|\w+)/i;

function collectAlFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (entry === '.alpackages') continue;
    const abs = join(dir, entry);
    const stat = statSync(abs);
    if (stat.isDirectory()) {
      collectAlFiles(abs, out);
    } else if (entry.toLowerCase().endsWith('.al')) {
      out.push(abs);
    }
  }
}

/**
 * Scan the given app directories (relative to the worktree) for AL test
 * codeunits: files declaring `Subtype = Test` (any casing/spacing). Returns
 * the codeunit ids to pass to `continia test run`, deduped and sorted.
 */
export async function discoverTestCodeunits(
  worktreePath: string,
  testAppPaths: string[],
): Promise<DiscoveredTestCodeunit[]> {
  const files: string[] = [];
  for (const rel of testAppPaths) {
    const root = resolve(worktreePath, rel);
    if (!existsSync(root)) continue;
    collectAlFiles(root, files);
  }

  const byId = new Map<number, DiscoveredTestCodeunit>();
  for (const file of files) {
    const content = readFileSync(file, 'utf-8');
    if (!SUBTYPE_TEST_RE.test(content)) continue;
    const decl = content.match(CODEUNIT_DECL_RE);
    if (!decl) continue;
    const id = Number(decl[1]);
    if (byId.has(id)) continue;
    byId.set(id, { id, name: decl[3] ?? decl[2]!, file });
  }

  return [...byId.values()].sort((a, b) => a.id - b.id);
}
