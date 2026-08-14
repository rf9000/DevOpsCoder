import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { discoverTestCodeunits } from '../../src/utils/al-test-discovery.ts';

let worktree: string;

beforeEach(() => {
  worktree = mkdtempSync(join(tmpdir(), 'al-discovery-'));
});

afterEach(() => {
  rmSync(worktree, { recursive: true, force: true });
});

function writeAl(relPath: string, content: string): void {
  const abs = join(worktree, relPath);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

const TEST_CODEUNIT = `codeunit 148001 "CDO Setup Tests"
{
    Subtype = Test;

    [Test]
    procedure MyTest()
    begin
    end;
}
`;

const NORMAL_CODEUNIT = `codeunit 70001 "CDO Feature"
{
    procedure Calculate()
    begin
    end;
}
`;

describe('discoverTestCodeunits', () => {
  it('finds a test codeunit and extracts id, name, file', async () => {
    writeAl('App/Test/SetupTests.Codeunit.al', TEST_CODEUNIT);
    const found = await discoverTestCodeunits(worktree, ['App']);
    expect(found).toHaveLength(1);
    expect(found[0]?.id).toBe(148001);
    expect(found[0]?.name).toBe('CDO Setup Tests');
    expect(found[0]?.file).toContain('SetupTests.Codeunit.al');
  });

  it('ignores non-test codeunits', async () => {
    writeAl('App/Feature.Codeunit.al', NORMAL_CODEUNIT);
    writeAl('App/Test/SetupTests.Codeunit.al', TEST_CODEUNIT);
    const found = await discoverTestCodeunits(worktree, ['App']);
    expect(found.map((f) => f.id)).toEqual([148001]);
  });

  it('matches SubType with any casing', async () => {
    writeAl('App/T.al', TEST_CODEUNIT.replace('Subtype = Test', 'SubType=Test'));
    const found = await discoverTestCodeunits(worktree, ['App']);
    expect(found).toHaveLength(1);
  });

  it('skips .alpackages directories', async () => {
    writeAl('App/.alpackages/Vendored.al', TEST_CODEUNIT);
    const found = await discoverTestCodeunits(worktree, ['App']);
    expect(found).toEqual([]);
  });

  it('dedupes by id across files and sorts ascending', async () => {
    writeAl('App/B.al', TEST_CODEUNIT.replace('148001', '148002'));
    writeAl('App/A.al', TEST_CODEUNIT);
    writeAl('App/Sub/A-copy.al', TEST_CODEUNIT);
    const found = await discoverTestCodeunits(worktree, ['App']);
    expect(found.map((f) => f.id)).toEqual([148001, 148002]);
  });

  it('scans multiple app paths and ignores non-.al files', async () => {
    writeAl('Core/Test/CoreTests.al', TEST_CODEUNIT.replace('148001', '148100'));
    writeAl('Banking/Test/BankTests.al', TEST_CODEUNIT.replace('148001', '148200'));
    writeAl('Banking/Test/readme.md', TEST_CODEUNIT);
    const found = await discoverTestCodeunits(worktree, ['Core', 'Banking']);
    expect(found.map((f) => f.id)).toEqual([148100, 148200]);
  });

  it('returns empty for missing app paths instead of throwing', async () => {
    const found = await discoverTestCodeunits(worktree, ['DoesNotExist']);
    expect(found).toEqual([]);
  });

  it('handles unquoted codeunit names', async () => {
    writeAl('App/T.al', 'codeunit 148005 MyTests\n{\n    Subtype = Test;\n}\n');
    const found = await discoverTestCodeunits(worktree, ['App']);
    expect(found[0]?.id).toBe(148005);
    expect(found[0]?.name).toBe('MyTests');
  });
});
