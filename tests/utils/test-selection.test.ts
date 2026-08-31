import { describe, it, expect } from 'bun:test';
import {
  extractAlObjectNames,
  selectTestCodeunits,
} from '../../src/utils/test-selection.ts';
import type { DiscoveredTestCodeunit } from '../../src/utils/al-test-discovery.ts';

const WT = '/wt';

/** Discovered codeunit whose `file` is absolute, as the real discovery returns. */
function cu(id: number, name: string, relFile: string): DiscoveredTestCodeunit {
  return { id, name, file: `${WT}/${relFile}` };
}

const BANK_TABLE = `
table 71553577 "CTS-CB Bank"
{
    fields { field(16; AgreementNo; Text[100]) { } }
}
`;

const TEST_TOUCHING_BANK = `
codeunit 71553900 "CTS-CB Bank Tests"
{
    Subtype = Test;
    procedure T1() begin Bank: Record "CTS-CB Bank"; end;
}
`;

const TEST_UNRELATED = `
codeunit 71553901 "CTS-CB Payment Tests"
{
    Subtype = Test;
    procedure T2() begin Rec: Record "CTS-CB Payment"; end;
}
`;

const ALL = [
  cu(71553900, 'CTS-CB Bank Tests', 'Test/BankTests.al'),
  cu(71553901, 'CTS-CB Payment Tests', 'Test/PaymentTests.al'),
];

/**
 * Key paths by a platform-neutral form. `resolve('/wt', 'a.al')` yields
 * `C:\wt\a.al` on Windows but `/wt/a.al` on Linux, and discovered `file` values
 * keep whatever form the caller built — so strip any drive letter, normalise
 * separators, and lowercase before comparing.
 */
function normKey(p: string): string {
  return p.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '').toLowerCase();
}

function fakeRead(map: Record<string, string>) {
  const byKey = new Map(Object.entries(map).map(([k, v]) => [normKey(k), v]));
  return (abs: string) => {
    const content = byKey.get(normKey(abs));
    if (content === undefined) throw new Error(`ENOENT ${abs}`);
    return content;
  };
}

describe('extractAlObjectNames', () => {
  it('extracts quoted and bare object names', () => {
    expect(extractAlObjectNames('table 71553577 "CTS-CB Bank"\n{}')).toEqual(['CTS-CB Bank']);
    expect(extractAlObjectNames('codeunit 50100 MyHelper\n{}')).toEqual(['MyHelper']);
  });

  it('matches extension objects as their own kind, not the base kind', () => {
    expect(extractAlObjectNames('tableextension 50101 "Bank Ext" extends "CTS-CB Bank"'))
      .toEqual(['Bank Ext']);
  });

  it('handles objects declared without an id', () => {
    expect(extractAlObjectNames('interface "IBank Provider"\n{}')).toEqual(['IBank Provider']);
  });
});

describe('selectTestCodeunits', () => {
  it('mode=all returns everything discovered', () => {
    const out = selectTestCodeunits({
      discovered: ALL,
      changedFiles: [],
      worktreePath: WT,
      mode: 'all',
      maxCodeunits: 0,
    });
    expect(out.selected).toHaveLength(2);
  });

  it('mode=changed returns only codeunits declared in changed files', () => {
    const out = selectTestCodeunits({
      discovered: ALL,
      changedFiles: ['Test/BankTests.al'],
      worktreePath: WT,
      mode: 'changed',
      maxCodeunits: 0,
    });
    expect(out.selected.map((c) => c.id)).toEqual([71553900]);
  });

  it('mode=related adds tests referencing an object declared in a changed source file', () => {
    // Only Bank.Table.al changed — no test file did — yet the bank test must run.
    const out = selectTestCodeunits({
      discovered: ALL,
      changedFiles: ['Bank/Tables/Bank.Table.al'],
      worktreePath: WT,
      mode: 'related',
      maxCodeunits: 0,
      readFile: fakeRead({
        '/wt/Bank/Tables/Bank.Table.al': BANK_TABLE,
        '/wt/Test/BankTests.al': TEST_TOUCHING_BANK,
        '/wt/Test/PaymentTests.al': TEST_UNRELATED,
      }),
    });
    expect(out.selected.map((c) => c.id)).toEqual([71553900]);
  });

  it('mode=related still includes a changed test file that references nothing changed', () => {
    const out = selectTestCodeunits({
      discovered: ALL,
      changedFiles: ['Test/PaymentTests.al'],
      worktreePath: WT,
      mode: 'related',
      maxCodeunits: 0,
      readFile: fakeRead({
        '/wt/Test/PaymentTests.al': TEST_UNRELATED,
        '/wt/Test/BankTests.al': TEST_TOUCHING_BANK,
      }),
    });
    expect(out.selected.map((c) => c.id)).toEqual([71553901]);
  });

  it('mode=related does not pull in every test via a changed TEST file\'s own object name', () => {
    // A changed test helper should contribute itself, not drag in every test
    // codeunit that references it.
    const helper = `codeunit 71553800 "CTS-CB Test Helper" { Subtype = Test; }`;
    const usesHelper = `codeunit 71553901 "CTS-CB Payment Tests" { Subtype = Test;
      procedure T() begin H: Codeunit "CTS-CB Test Helper"; end; }`;
    const out = selectTestCodeunits({
      discovered: [
        cu(71553800, 'CTS-CB Test Helper', 'Test/Helper.al'),
        cu(71553901, 'CTS-CB Payment Tests', 'Test/PaymentTests.al'),
      ],
      changedFiles: ['Test/Helper.al'],
      worktreePath: WT,
      mode: 'related',
      maxCodeunits: 0,
      readFile: fakeRead({
        '/wt/Test/Helper.al': helper,
        '/wt/Test/PaymentTests.al': usesHelper,
      }),
    });
    expect(out.selected.map((c) => c.id)).toEqual([71553800]);
  });

  it('ignores non-AL changed files', () => {
    const out = selectTestCodeunits({
      discovered: ALL,
      changedFiles: ['README.md', 'app.json'],
      worktreePath: WT,
      mode: 'related',
      maxCodeunits: 0,
      readFile: fakeRead({}),
    });
    expect(out.selected).toHaveLength(0);
  });

  it('tolerates a changed file that no longer exists (deleted in this change)', () => {
    const out = selectTestCodeunits({
      discovered: ALL,
      changedFiles: ['Bank/Gone.al'],
      worktreePath: WT,
      mode: 'related',
      maxCodeunits: 0,
      readFile: fakeRead({}),
    });
    expect(out.selected).toHaveLength(0);
  });

  it('caps the selection and reports how many were dropped', () => {
    const many = Array.from({ length: 10 }, (_, i) => cu(100 + i, `T${i}`, `Test/T${i}.al`));
    const out = selectTestCodeunits({
      discovered: many,
      changedFiles: [],
      worktreePath: WT,
      mode: 'all',
      maxCodeunits: 3,
    });
    expect(out.selected).toHaveLength(3);
    expect(out.droppedByCap).toBe(7);
    expect(out.reason).toContain('capped at 3');
  });

  it('maxCodeunits=0 means unlimited', () => {
    const many = Array.from({ length: 10 }, (_, i) => cu(100 + i, `T${i}`, `Test/T${i}.al`));
    const out = selectTestCodeunits({
      discovered: many,
      changedFiles: [],
      worktreePath: WT,
      mode: 'all',
      maxCodeunits: 0,
    });
    expect(out.selected).toHaveLength(10);
    expect(out.droppedByCap).toBe(0);
  });

  it('matches changed paths regardless of separator style', () => {
    const out = selectTestCodeunits({
      discovered: ALL,
      changedFiles: ['Test\\BankTests.al'],
      worktreePath: WT,
      mode: 'changed',
      maxCodeunits: 0,
    });
    expect(out.selected.map((c) => c.id)).toEqual([71553900]);
  });

  it('does not match a bare name as a substring of a longer identifier', () => {
    const src = `codeunit 50100 Bank { }`;
    const test = `codeunit 50200 "T" { Subtype = Test; procedure P() begin BankAccount.Init(); end; }`;
    const out = selectTestCodeunits({
      discovered: [cu(50200, 'T', 'Test/T.al')],
      changedFiles: ['Src/Bank.al'],
      worktreePath: WT,
      mode: 'related',
      maxCodeunits: 0,
      readFile: fakeRead({ '/wt/Src/Bank.al': src, '/wt/Test/T.al': test }),
    });
    expect(out.selected).toHaveLength(0);
  });
});
