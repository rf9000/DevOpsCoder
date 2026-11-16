import { IdCollisionError } from './types.ts';

export const AL_OBJECT_TYPES: readonly string[] = [
  'table',
  'tableextension',
  'page',
  'pageextension',
  'codeunit',
  'report',
  'reportextension',
  'query',
  'xmlport',
  'enum',
  'enumextension',
  'permissionset',
  'permissionsetextension',
];

export interface AlDeclaration {
  type: string;
  id: number;
  name: string;
  /** Repo-relative, forward slashes. */
  file: string;
  /** Repo-relative app directory. */
  app: string;
}

const TYPE_ALTERNATION = [...AL_OBJECT_TYPES].sort((a, b) => b.length - a.length).join('|');
const DECLARATION_RE = new RegExp(
  String.raw`^[ \t]*(${TYPE_ALTERNATION})[ \t]+(\d+)[ \t]+("[^"]+"|[A-Za-z_]\w*)`,
  'im',
);

/** First object declaration in an .al file's text, or null. */
export function parseDeclaration(
  text: string,
): { type: string; id: number; name: string } | null {
  const m = DECLARATION_RE.exec(text.replace(/^\uFEFF/, ''));
  if (!m) return null;
  const rawName = m[3] as string;
  return {
    type: (m[1] as string).toLowerCase(),
    id: Number(m[2]),
    name: rawName.startsWith('"') ? rawName.slice(1, -1) : rawName,
  };
}

export interface CollisionGroup {
  app: string;
  type: string;
  id: number;
  members: AlDeclaration[];
}

/** Groups of two or more declarations sharing app, type and id. */
export function findCollisions(decls: AlDeclaration[]): CollisionGroup[] {
  const map = new Map<string, CollisionGroup>();
  for (const decl of decls) {
    const key = `${decl.app}\0${decl.type}\0${decl.id}`;
    let g = map.get(key);
    if (!g) {
      g = { app: decl.app, type: decl.type, id: decl.id, members: [] };
      map.set(key, g);
    }
    g.members.push(decl);
  }
  return [...map.values()].filter((g) => g.members.length > 1);
}

export interface RenumberPlan {
  target: AlDeclaration;
  keep: AlDeclaration[];
}

/**
 * One plan per group with exactly one PR-introduced member. Throws
 * IdCollisionError listing every group that does not qualify.
 */
export function planRenumbers(
  groups: CollisionGroup[],
  isPrIntroduced: (d: AlDeclaration) => boolean,
): RenumberPlan[] {
  const plans: RenumberPlan[] = [];
  const bad: CollisionGroup[] = [];
  for (const g of groups) {
    const mine = g.members.filter(isPrIntroduced);
    if (mine.length === 1) {
      const target = mine[0] as AlDeclaration;
      plans.push({ target, keep: g.members.filter((m) => m !== target) });
    } else {
      bad.push(g);
    }
  }
  if (bad.length > 0) {
    const desc = bad
      .map((g) => `${g.type} ${g.id} in ${g.app} (${g.members.map((m) => m.file).join(', ')})`)
      .join('; ');
    throw new IdCollisionError(
      bad,
      `object ID collision not safely renumberable (needs exactly one PR-introduced member): ${desc}`,
    );
  }
  return plans;
}
