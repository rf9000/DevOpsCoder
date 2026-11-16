import { describe, expect, test } from 'bun:test';
import {
  findCollisions,
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
  test('no PR members throw', () => {
    expect(() => planRenumbers(groups, () => false)).toThrow(IdCollisionError);
  });
  test('uses only the predicate (modified file at target can be the target)', () => {
    const plans = planRenumbers(groups, (x) => x.file === 'main.al');
    expect(plans[0]?.target).toBe(b);
  });
});
