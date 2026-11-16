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

const DIRECTIVE_RE = /^[ \t]*#[ \t]*(if|elif|else|endif)\b(.*)$/i;
/**
 * A byte order mark at offset 0, as a decoded U+FEFF or as the three latin1
 * characters of its UTF-8 bytes: callers that keep it must still see a line-1
 * directive. It is skipped for directive detection only, and kept in the output.
 */
const LEADING_BOM_RE = /^(?:\uFEFF|\u00EF\u00BB\u00BF)/;
/** `X` or `not X`, optionally followed by a line comment; anything else is not evaluated. */
const SIMPLE_CONDITION_RE = /^[ \t]+(not[ \t]+)?([A-Za-z_]\w*)[ \t]*(?:\/\/.*)?$/i;

interface ConditionalFrame {
  /** Whether the enclosing code is active. */
  parentActive: boolean;
  /** A branch of this block was known to be true, so later branches are inactive. */
  taken: boolean;
  active: boolean;
}

/** true / false for `X` / `not X`; null for any other expression. */
function evaluateCondition(rest: string, symbols: ReadonlySet<string>): boolean | null {
  const m = SIMPLE_CONDITION_RE.exec(rest.replace(/\r$/, ''));
  if (!m) return null;
  const defined = symbols.has(m[2] as string);
  return m[1] ? !defined : defined;
}

/**
 * `text` with everything the AL compiler does not see replaced by spaces:
 * `/* … *\/` and `// …` comments (not inside a `'…'` string, where `''` is an
 * escaped quote, or a `"…"` quoted identifier), preprocessor directive lines,
 * and the lines of inactive `#if` / `#elif` / `#else` blocks. A condition is
 * evaluated only when it is a single symbol, optionally negated with `not`,
 * against `symbols` (the app's `preprocessorSymbols`, case-sensitive); any
 * other expression counts as active, and does not make a later `#elif` or
 * `#else` inactive either, so nothing the compiler might see is ever hidden.
 *
 * Length-preserving, and `\r` / `\n` are kept: an offset into the result is
 * the same offset into `text`, so a rewrite can work on the original.
 */
export function maskAl(text: string, symbols: ReadonlySet<string> = new Set()): string {
  const out = text.split('');
  const bomLength = LEADING_BOM_RE.exec(text)?.[0].length ?? 0;
  const blank = (from: number, to: number) => {
    for (let k = Math.max(from, bomLength); k < to; k++) if (out[k] !== '\r' && out[k] !== '\n') out[k] = ' ';
  };
  const stack: ConditionalFrame[] = [];
  const active = () => stack.length === 0 || (stack[stack.length - 1] as ConditionalFrame).active;
  let inBlock = false;
  let i = 0;
  while (i < text.length) {
    const nl = text.indexOf('\n', i);
    const end = nl === -1 ? text.length : nl;
    let line = text.slice(i, end).replace(/\r$/, '');
    if (i === 0) line = line.replace(LEADING_BOM_RE, '');
    const directive = inBlock ? null : DIRECTIVE_RE.exec(line);
    if (directive) {
      const kind = (directive[1] as string).toLowerCase();
      const top = stack[stack.length - 1];
      if (kind === 'if') {
        const cond = evaluateCondition(directive[2] as string, symbols);
        const parentActive = active();
        stack.push({ parentActive, taken: cond === true, active: parentActive && cond !== false });
      } else if (kind === 'elif' && top) {
        const cond = evaluateCondition(directive[2] as string, symbols);
        top.active = top.parentActive && !top.taken && cond !== false;
        top.taken ||= cond === true;
      } else if (kind === 'else' && top) {
        top.active = top.parentActive && !top.taken;
        top.taken = true;
      } else if (kind === 'endif') {
        stack.pop();
      }
      blank(i, end);
    } else if (!active()) {
      blank(i, end);
    } else {
      let inString = false;
      let inIdent = false;
      for (let j = i; j < end; j++) {
        const c = text[j];
        if (inBlock) {
          if (c === '*' && text[j + 1] === '/') {
            blank(j, j + 2);
            j++;
            inBlock = false;
          } else {
            blank(j, j + 1);
          }
        } else if (inString) {
          if (c === "'") {
            if (text[j + 1] === "'") j++;
            else inString = false;
          }
        } else if (inIdent) {
          if (c === '"') inIdent = false;
        } else if (c === "'") {
          inString = true;
        } else if (c === '"') {
          inIdent = true;
        } else if (c === '/' && text[j + 1] === '/') {
          blank(j, end);
          break;
        } else if (c === '/' && text[j + 1] === '*') {
          blank(j, j + 2);
          j++;
          inBlock = true;
        }
      }
    }
    i = end + 1;
  }
  return out.join('');
}

/**
 * First object declaration in an .al file's text that the compiler sees, or
 * null: declarations in comments and in inactive preprocessor blocks (per
 * `symbols`, the app's `preprocessorSymbols`) do not count.
 */
export function parseDeclaration(
  text: string,
  symbols?: ReadonlySet<string>,
): { type: string; id: number; name: string } | null {
  const m = DECLARATION_RE.exec(maskAl(text.replace(/^\uFEFF/, ''), symbols));
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
 * One plan per group with exactly one PR-introduced member. A group with no
 * PR-introduced member is the target's own state, not this PR's: it is passed
 * to `onIgnored` and skipped (verification catches a real one). Throws
 * IdCollisionError listing every group with two or more PR-introduced members.
 */
export function planRenumbers(
  groups: CollisionGroup[],
  isPrIntroduced: (d: AlDeclaration) => boolean,
  onIgnored?: (g: CollisionGroup) => void,
): RenumberPlan[] {
  const plans: RenumberPlan[] = [];
  const bad: CollisionGroup[] = [];
  for (const g of groups) {
    const mine = g.members.filter(isPrIntroduced);
    if (mine.length === 1) {
      const target = mine[0] as AlDeclaration;
      plans.push({ target, keep: g.members.filter((m) => m !== target) });
    } else if (mine.length === 0) {
      onIgnored?.(g);
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
      `object ID collision not safely renumberable (more than one PR-introduced member): ${desc}`,
    );
  }
  return plans;
}
