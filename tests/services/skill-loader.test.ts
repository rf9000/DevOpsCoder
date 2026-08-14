import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  extractFrontmatterDescription,
  discoverTargetRepoSkills,
  discoverSkillsIn,
  mergeSkills,
} from '../../src/services/skill-loader.ts';

describe('extractFrontmatterDescription', () => {
  it('extracts unquoted description value', () => {
    const md = `---
name: my-skill
description: A skill for doing things
---

# Body
`;
    expect(extractFrontmatterDescription(md)).toBe('A skill for doing things');
  });

  it('extracts double-quoted description value', () => {
    const md = `---
description: "Quoted description value"
---
`;
    expect(extractFrontmatterDescription(md)).toBe('Quoted description value');
  });

  it('returns empty string when no frontmatter present', () => {
    const md = `# Just a heading\n\nsome content`;
    expect(extractFrontmatterDescription(md)).toBe('');
  });

  it('returns empty string when frontmatter has no description field', () => {
    const md = `---
name: nameless
other: value
---
`;
    expect(extractFrontmatterDescription(md)).toBe('');
  });

  it('returns empty string for empty content', () => {
    expect(extractFrontmatterDescription('')).toBe('');
  });
});

describe('discoverTargetRepoSkills', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'skills-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns empty array when .claude/skills does not exist', () => {
    expect(discoverTargetRepoSkills(dir)).toEqual([]);
  });

  it('discovers a single skill with a SKILL.md and frontmatter', () => {
    const skillPath = join(dir, '.claude', 'skills', 'al-formatter');
    mkdirSync(skillPath, { recursive: true });
    writeFileSync(
      join(skillPath, 'SKILL.md'),
      `---
name: al-formatter
description: Formats AL code per Continia style
---

Body content.
`,
      'utf-8',
    );
    const skills = discoverTargetRepoSkills(dir);
    expect(skills).toHaveLength(1);
    expect(skills[0]?.name).toBe('al-formatter');
    expect(skills[0]?.description).toBe('Formats AL code per Continia style');
  });

  it('discovers multiple skills, alphabetically by directory entry order', () => {
    for (const name of ['skill-a', 'skill-b', 'skill-c']) {
      const path = join(dir, '.claude', 'skills', name);
      mkdirSync(path, { recursive: true });
      writeFileSync(
        join(path, 'SKILL.md'),
        `---\ndescription: desc for ${name}\n---\n`,
        'utf-8',
      );
    }
    const skills = discoverTargetRepoSkills(dir);
    expect(skills).toHaveLength(3);
    expect(skills.map((s) => s.name).sort()).toEqual(['skill-a', 'skill-b', 'skill-c']);
  });

  it('skips entries without SKILL.md', () => {
    const skillsRoot = join(dir, '.claude', 'skills');
    mkdirSync(skillsRoot, { recursive: true });
    mkdirSync(join(skillsRoot, 'real-skill'), { recursive: true });
    writeFileSync(
      join(skillsRoot, 'real-skill', 'SKILL.md'),
      `---\ndescription: present\n---\n`,
      'utf-8',
    );
    mkdirSync(join(skillsRoot, 'empty-dir'), { recursive: true });
    const skills = discoverTargetRepoSkills(dir);
    expect(skills).toHaveLength(1);
    expect(skills[0]?.name).toBe('real-skill');
  });

  it('skips skills whose SKILL.md has no description in frontmatter', () => {
    const skillsRoot = join(dir, '.claude', 'skills');
    const skillDir = join(skillsRoot, 'descriptionless');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---\nname: descriptionless\n---\n`,
      'utf-8',
    );
    const skills = discoverTargetRepoSkills(dir);
    expect(skills).toEqual([]);
  });
});

describe('discoverSkillsIn', () => {
  it('scans an arbitrary skills root (not just <repo>/.claude/skills)', () => {
    const root = mkdtempSync(join(tmpdir(), 'skills-'));
    try {
      mkdirSync(join(root, 'my-skill'), { recursive: true });
      writeFileSync(join(root, 'my-skill', 'SKILL.md'), '---\ndescription: Does things.\n---\n', 'utf-8');
      expect(discoverSkillsIn(root)).toEqual([{ name: 'my-skill', description: 'Does things.' }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('mergeSkills', () => {
  it('unions the lists; on a name collision the target repo wins', () => {
    const merged = mergeSkills(
      [{ name: 'continia-deploy', description: 'repo version' }],
      [
        { name: 'continia-deploy', description: 'orchestrator version' },
        { name: 'continia-test', description: 'orchestrator only' },
      ],
    );
    expect(merged).toEqual([
      { name: 'continia-deploy', description: 'repo version' },
      { name: 'continia-test', description: 'orchestrator only' },
    ]);
  });
});
