import { describe, expect, test } from 'bun:test';
import {
  findCollisions,
  maskAl,
  parseDeclaration,
  planRenumbers,
  type AlDeclaration,
} from '../../src/prfix/al-objects.ts';
import { IdCollisionError } from '../../src/prfix/types.ts';

const d = (type: string, id: number, file: string, app = 'app'): AlDeclaration => ({
  type,
  id,
  name: file,
  file,
  app,
});

describe('parseDeclaration', () => {
  test('codeunit with implements tail', () => {
    expect(
      parseDeclaration('codeunit 72918753 "CTS-CB Ponto Feature" implements "X"\n{'),
    ).toEqual({ type: 'codeunit', id: 72918753, name: 'CTS-CB Ponto Feature' });
  });
  test('tableextension with extends tail', () => {
    expect(parseDeclaration('tableextension 71553600 "A" extends "Customer"')?.type).toBe(
      'tableextension',
    );
  });
  test('parses a BOM + CRLF declaration', () => {
    expect(parseDeclaration('\uFEFF// c\r\n\r\npage 5 MyPage\r\n{')).toEqual({
      type: 'page',
      id: 5,
      name: 'MyPage',
    });
  });
  test('no declaration returns null', () => {
    expect(parseDeclaration('// nothing here\n')).toBeNull();
  });
  test('Codeunit.Run(5) in a body is not a declaration', () => {
    expect(parseDeclaration('    Codeunit.Run(5);\n')).toBeNull();
  });
});

describe('parseDeclaration: comments', () => {
  test('a declaration inside a block comment that starts on line 1 is ignored', () => {
    const text = '/* TODO: Check the errors coming up\ncodeunit 95285 "Copy Template UT"\n{\n}\n*/\n';
    expect(parseDeclaration(text)).toBeNull();
  });
  test('the declaration after a closed block comment is found', () => {
    expect(parseDeclaration('/*\ncodeunit 1 Old\n*/\ncodeunit 2 New\n{\n}\n')).toEqual({
      type: 'codeunit',
      id: 2,
      name: 'New',
    });
  });
  test('a declaration after // is ignored', () => {
    const text = 'x; // codeunit 5 Old\nok';
    expect(maskAl(text)).toBe(`x;${' '.repeat(text.indexOf('\n') - 2)}\nok`);
    expect(parseDeclaration('// codeunit 5 Old\n')).toBeNull();
    // A /* after // is comment text, not the start of a block comment.
    expect(parseDeclaration('// old /*\ncodeunit 5 New\n')?.id).toBe(5);
    expect(parseDeclaration('    // codeunit 5 Old\npage 6 P\n')).toEqual({ type: 'page', id: 6, name: 'P' });
  });
  test('/* inside a string literal does not start a comment', () => {
    const text = "x := 'a /* b';\ncodeunit 2 B\n{\n}\n";
    expect(maskAl(text)).toBe(text);
    expect(parseDeclaration(text)?.id).toBe(2);
  });
  test("an escaped '' quote keeps the string open", () => {
    const text = "x := 'it''s /* not a comment';\ncodeunit 3 C\n";
    expect(maskAl(text)).toBe(text);
    expect(parseDeclaration(text)?.id).toBe(3);
  });
  test('/* inside a quoted identifier does not start a comment', () => {
    const text = 'x := "A /* B";\ncodeunit 4 D\n{\n}\n';
    expect(maskAl(text)).toBe(text);
    expect(parseDeclaration(text)?.id).toBe(4);
  });
  test('the mask keeps length and newlines', () => {
    const text = 'a /* b\r\nc */ d // e\r\nf';
    const masked = maskAl(text);
    expect(masked.length).toBe(text.length);
    expect(masked).toBe('a     \r\n     d     \r\nf');
  });
});

describe('parseDeclaration: preprocessor', () => {
  const gated = '#if US64044\ncodeunit 71553834 "LLM User Prompt Log"\n{\n}\n#endif\n';
  test('#if X is skipped when X is not a preprocessor symbol', () => {
    expect(parseDeclaration(gated)).toBeNull();
    expect(parseDeclaration(gated, new Set(['RUNTIME17', 'RUNTIME18']))).toBeNull();
  });
  test('#if X is kept when the app defines X', () => {
    expect(parseDeclaration(gated, new Set(['US64044']))?.id).toBe(71553834);
  });
  test('symbols are case-sensitive', () => {
    expect(parseDeclaration(gated, new Set(['us64044']))).toBeNull();
  });
  test('#if not X / #else', () => {
    const text = '#if not CLEAN\ncodeunit 1 Old\n#else\ncodeunit 2 New\n#endif\n';
    expect(parseDeclaration(text)?.id).toBe(1);
    expect(parseDeclaration(text, new Set(['CLEAN']))?.id).toBe(2);
  });
  test('#elif picks the first true branch', () => {
    const text = '#if A\ncodeunit 1 One\n#elif B\ncodeunit 2 Two\n#else\ncodeunit 3 Three\n#endif\n';
    expect(parseDeclaration(text, new Set(['A', 'B']))?.id).toBe(1);
    expect(parseDeclaration(text, new Set(['B']))?.id).toBe(2);
    expect(parseDeclaration(text)?.id).toBe(3);
  });
  test('nested blocks inside an inactive block stay inactive', () => {
    const text = '#if A\n#if B\ncodeunit 1 One\n#else\ncodeunit 2 Two\n#endif\n#endif\ncodeunit 3 Three\n';
    expect(parseDeclaration(text, new Set(['B']))?.id).toBe(3);
  });
  test('a complex expression counts as active, and so does its #else', () => {
    expect(parseDeclaration('#if A and B\ncodeunit 1 One\n#endif\n')?.id).toBe(1);
    expect(parseDeclaration('#if (A)\ncodeunit 1 One\n#endif\n')?.id).toBe(1);
    expect(parseDeclaration('#if A or B\n#else\ncodeunit 2 Two\n#endif\n')?.id).toBe(2);
  });
  test('a #if inside a block comment is not a directive', () => {
    expect(parseDeclaration('/*\n#if X\n*/\ncodeunit 1 One\n')?.id).toBe(1);
  });
  test('inactive lines are masked length-preserving', () => {
    const text = '#if X\r\ncodeunit 1 A\r\n#endif\r\nok';
    const masked = maskAl(text);
    expect(masked.length).toBe(text.length);
    expect(masked.endsWith('\r\nok')).toBe(true);
    expect(masked).not.toContain('codeunit');
  });
  test.each([
    ['a decoded U+FEFF', '\uFEFF'],
    ['the latin1 view of its UTF-8 bytes', '\u00EF\u00BB\u00BF'],
  ])('a line-1 #if after %s is still a directive, and the BOM is kept', (_label, bom) => {
    const text = `${bom}#if X\r\ncodeunit 5 A\r\n#endif\r\n`;
    const masked = maskAl(text);
    expect(masked.length).toBe(text.length);
    expect(masked.startsWith(bom)).toBe(true);
    expect(masked).not.toContain('codeunit');
    expect(maskAl(text, new Set(['X']))).toContain('codeunit 5 A');
  });
});

describe('findCollisions', () => {
  test('same type and id in same app', () => {
    const g = findCollisions([d('table', 1, 'a'), d('table', 1, 'b')]);
    expect(g).toHaveLength(1);
    expect(g[0]?.members).toHaveLength(2);
  });
  test('different type no group', () => {
    expect(findCollisions([d('table', 1, 'a'), d('page', 1, 'b')])).toEqual([]);
  });
  test('different app no group', () => {
    expect(findCollisions([d('table', 1, 'a', 'x'), d('table', 1, 'b', 'y')])).toEqual([]);
  });
});

describe('planRenumbers', () => {
  const a = d('table', 1, 'pr.al');
  const b = d('table', 1, 'main.al');
  const groups = findCollisions([a, b]);
  test('one PR member is the target', () => {
    const plans = planRenumbers(groups, (x) => x === a);
    expect(plans).toHaveLength(1);
    expect(plans[0]?.target).toBe(a);
    expect(plans[0]?.keep).toEqual([b]);
  });
  test('two PR members throw', () => {
    expect(() => planRenumbers(groups, () => true)).toThrow(IdCollisionError);
  });
  test('no PR members: ignored, not refused, and reported', () => {
    const ignored: unknown[] = [];
    expect(planRenumbers(groups, () => false, (g) => ignored.push(g))).toEqual([]);
    expect(ignored).toEqual(groups);
  });
  test('an ignored group does not hide a refusable one', () => {
    const c = d('page', 2, 'p1.al');
    const e = d('page', 2, 'p2.al');
    const all = findCollisions([a, b, c, e]);
    expect(() => planRenumbers(all, (x) => x === c || x === e)).toThrow(IdCollisionError);
  });
  test('uses only the predicate (modified file at target can be the target)', () => {
    const plans = planRenumbers(groups, (x) => x.file === 'main.al');
    expect(plans[0]?.target).toBe(b);
  });
});
