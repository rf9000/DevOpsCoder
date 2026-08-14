import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

/** A skill discovered in the target repo's .claude/skills/ directory. */
export interface DiscoveredSkill {
  name: string;
  description: string;
}

/**
 * Extract the `description` value from YAML frontmatter in a SKILL.md file.
 * Frontmatter is delimited by `---` lines at the top of the file.
 */
export function extractFrontmatterDescription(content: string): string {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') return '';

  let inFrontmatter = true;
  const fmLines: string[] = [];
  for (let i = 1; i < lines.length && inFrontmatter; i++) {
    if (lines[i]!.trim() === '---') {
      inFrontmatter = false;
    } else {
      fmLines.push(lines[i]!);
    }
  }

  // Simple YAML extraction: find `description:` line
  for (const line of fmLines) {
    const match = line.match(/^description:\s*"?(.+?)"?\s*$/);
    if (match) return match[1]!;
  }
  return '';
}

/** Scan a skills directory: each subdirectory containing a SKILL.md with a
 * frontmatter description is one invocable skill. */
export function discoverSkillsIn(skillsRoot: string): DiscoveredSkill[] {
  if (!existsSync(skillsRoot)) return [];

  const entries = readdirSync(skillsRoot);
  const discovered: DiscoveredSkill[] = [];

  for (const entry of entries) {
    const entryPath = join(skillsRoot, entry);
    if (!statSync(entryPath).isDirectory()) continue;

    const skillMdPath = join(entryPath, 'SKILL.md');
    if (!existsSync(skillMdPath)) continue;

    const content = readFileSync(skillMdPath, 'utf-8');
    const description = extractFrontmatterDescription(content);
    if (!description) continue;

    discovered.push({
      name: entry,
      description,
    });
  }

  return discovered;
}

/**
 * Scan the target repo's `.claude/skills/` directory for invocable skills.
 * Each subdirectory containing a `SKILL.md` is treated as a discoverable skill.
 * Returns name + description (from YAML frontmatter) for each.
 */
export function discoverTargetRepoSkills(targetRepoPath: string): DiscoveredSkill[] {
  return discoverSkillsIn(join(targetRepoPath, '.claude', 'skills'));
}

/** Union of target-repo and orchestrator-shipped skills; on a name collision
 * the target repo's skill wins (mirrors the no-clobber symlink rule). */
export function mergeSkills(
  targetRepo: DiscoveredSkill[],
  orchestrator: DiscoveredSkill[],
): DiscoveredSkill[] {
  const names = new Set(targetRepo.map((s) => s.name));
  return [...targetRepo, ...orchestrator.filter((s) => !names.has(s.name))];
}
