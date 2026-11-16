import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { createRenumberStage } from '../../src/prfix/stages.ts';
import type { PrFixGit } from '../../src/prfix/prfix-git.ts';
import type { PrFixConfig } from '../../src/prfix/config.ts';
import { NINJA_MAX_ASSIGN_ATTEMPTS, NinjaAssignRefusedError, type NinjaClient } from '../../src/prfix/ninja.ts';
import { IdCollisionError, type PrFixInput, type RenumberOutput } from '../../src/prfix/types.ts';
import type { PipelineContext } from '../../src/pipeline/stage.ts';
import type { PipelineState, WorktreeContext } from '../../src/types/index.ts';
import { makeTestConfig } from '../helpers/app-config.ts';

const TARGET = 'target0000';
const COMMIT = 'renum00000';

const APP_JSON = JSON.stringify({ name: 'Continia Banking', idRanges: [{ from: 72918625, to: 72918824 }] });
const EXPORT_HASH = 'base-application/src/Export/ExportFileHash.Codeunit.al';
const PONTO = 'base-application/src/Ponto/PontoFeature.Codeunit.al';
const OTHER = 'base-application/src/Other/Other.Codeunit.al';
const EXPORT_HASH_TEXT = 'codeunit 72918753 "CTS-CB Export File Hash"\n{\n}\n';
const PONTO_TEXT = 'codeunit 72918753 "CTS-CB Ponto Feature"\n{\n    procedure Run()\n    begin\n    end;\n}\n';
const OTHER_TEXT = 'codeunit 72918700 "CTS-CB Other"\n{\n}\n';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'renumber-stage-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function put(file: string, content: string | Buffer): void {
  const abs = join(root, file);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}
function read(file: string): string {
  return readFileSync(join(root, file), 'utf8');
}

/** Base fixture: main's ExportFileHash + Other, and the PR-added PontoFeature, all in base-application. */
function baseFixture(): void {
  put('base-application/app.json', APP_JSON);
  put(EXPORT_HASH, EXPORT_HASH_TEXT);
  put(OTHER, OTHER_TEXT);
  put(PONTO, PONTO_TEXT);
}

function walk(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const r = rel ? `${rel}/${name}` : name;
    if (statSync(abs).isDirectory()) out.push(...walk(abs, r));
    else out.push(r);
  }
  return out;
}

interface FakeGitOpts {
  changed?: { status: 'A' | 'M' | 'D'; file: string }[];
  /** File text at targetSha; a file absent here did not exist at the target. */
  atTarget?: Record<string, string>;
  commitThrows?: boolean;
}

function fakeGit(o: FakeGitOpts = {}) {
  const atTarget = o.atTarget ?? { [EXPORT_HASH]: EXPORT_HASH_TEXT, [OTHER]: OTHER_TEXT };
  const calls = {
    changedFiles: mock(async (_p: string, _from: string) => o.changed ?? [{ status: 'A' as const, file: PONTO }]),
    showFileAtRef: mock(async (_p: string, _ref: string, file: string) => atTarget[file] ?? null),
    listFiles: mock(async (p: string, pathspec: string) => {
      // git pathspec semantics without :(glob) magic: `*` also matches `/`.
      const re = new RegExp(`^${pathspec.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
      return walk(p).filter((f) => re.test(f));
    }),
    commitFiles: mock(async (_p: string, _files: string[], _message: string) => {
      if (o.commitThrows) throw new Error('commit failed');
      return COMMIT;
    }),
    headSha: mock(async (_p: string) => 'head000000'),
  };
  const git = {
    ...calls,
    createWorktree: mock(async () => {
      throw new Error('unused');
    }),
  } as unknown as PrFixGit;
  return { git, calls };
}

/** Each entry is the ID the next assign returns, or 'refuse' for a NinjaAssignRefusedError (range exhausted). */
function fakeNinja(ids: (number | 'refuse')[]) {
  const queue = [...ids];
  const calls = {
    assign: mock(async (_type: string, _file: string, _rangeName?: string) => {
      const next = queue.shift();
      if (next === undefined) throw new Error('no more ids');
      if (next === 'refuse') throw new NinjaAssignRefusedError('No more IDs available in range', 'ninja: No more IDs available in range');
      return next;
    }),
    unassign: mock(async (_type: string, _id: number, _file: string) => {}),
    close: mock(async () => {}),
  };
  const client = calls as unknown as NinjaClient;
  const factory = mock(() => client);
  return { factory, calls };
}

function prfixConfig(overrides: Partial<Omit<PrFixConfig, 'app'>> = {}): PrFixConfig {
  return {
    app: makeTestConfig(),
    maxConflictCommits: 3,
    maxConflictFiles: 10,
    resolverMaxTurns: 40,
    renumberCollisions: true,
    ninjaCommand: { command: 'npx', args: [] },
    ninjaCallTimeoutMs: 60_000,
    ...overrides,
  };
}

function makeState(): PipelineState {
  const worktree: WorktreeContext & { targetSha: string } = {
    path: root,
    branch: 'prfix/pr-42',
    baseSha: TARGET,
    targetSha: TARGET,
  };
  const prFixInput: PrFixInput = {
    pullRequestId: 42,
    repository: 'test-repo',
    pr: {
      id: 42,
      status: 'active',
      title: 'My PR',
      sourceRefName: 'refs/heads/feature',
      targetRefName: 'refs/heads/main',
      headCommit: 'prehead000',
      isDraft: false,
      url: 'https://example/pr/42',
    },
  };
  return {
    workItemId: 0,
    slug: 'pr-42',
    startedAt: '2026-11-16T00:00:00.000Z',
    updatedAt: '2026-11-16T00:00:00.000Z',
    currentStage: null,
    history: [],
    outputs: { worktree, prFixInput },
  };
}

function makeCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    config: makeTestConfig(),
    logger: { info: mock(() => {}), warn: mock(() => {}), error: mock(() => {}) },
    abortFlag: { aborted: false },
    signal: new AbortController().signal,
    now: () => new Date('2026-11-16T00:00:00.000Z'),
    ...overrides,
  };
}

function stage(git: PrFixGit, ninja: () => NinjaClient, prfix = prfixConfig()) {
  return createRenumberStage({ git, prfix, ninja });
}

describe('createRenumberStage', () => {
  it('is named renumber-collisions and cost-free', () => {
    const s = stage(fakeGit().git, fakeNinja([]).factory);
    expect(s.name).toBe('renumber-collisions');
    expect(s.costFree).toBe(true);
  });

  it('no collisions: no Ninja factory call, no commit', async () => {
    put('base-application/app.json', APP_JSON);
    put(EXPORT_HASH, EXPORT_HASH_TEXT);
    put(PONTO, PONTO_TEXT.replace('72918753', '72918760'));
    const { git, calls } = fakeGit();
    const n = fakeNinja([]);
    const out = await stage(git, n.factory).execute(makeState(), makeCtx());

    expect(n.factory).not.toHaveBeenCalled();
    expect(calls.commitFiles).not.toHaveBeenCalled();
    expect(out.outputs.renumber).toEqual({ commit: null, renumbered: [], reserved: [] });
  });

  it('renumbers only the PR-added codeunit and commits once', async () => {
    baseFixture();
    // external/** is never scanned, even when it collides.
    put('external/Continia Finance/app.json', APP_JSON);
    put('external/Continia Finance/src/Dup.Codeunit.al', 'codeunit 72918753 "Finance Dup"\n{\n}\n');
    const { git, calls } = fakeGit();
    const n = fakeNinja([72918790]);
    const progress: string[] = [];
    const out = await stage(git, n.factory).execute(makeState(), makeCtx({ reportProgress: (d) => progress.push(d) }));

    expect(read(PONTO)).toBe(PONTO_TEXT.replace('72918753', '72918790'));
    expect(read(EXPORT_HASH)).toBe(EXPORT_HASH_TEXT);
    expect(n.calls.assign).toHaveBeenCalledTimes(1);
    expect(n.calls.assign.mock.calls[0]).toEqual(['codeunit', join(root, PONTO)]);

    expect(calls.commitFiles).toHaveBeenCalledTimes(1);
    const [, files, message] = calls.commitFiles.mock.calls[0] as [string, string[], string];
    expect(files).toEqual([PONTO]);
    expect(message).toBe(
      'fix: renumber AL object IDs that collide with main\n\n' +
        `codeunit CTS-CB Ponto Feature 72918753 -> 72918790 (${PONTO})`,
    );

    const r = out.outputs.renumber as RenumberOutput;
    expect(r.commit).toBe(COMMIT);
    expect(r.renumbered).toEqual([
      { type: 'codeunit', name: 'CTS-CB Ponto Feature', file: PONTO, app: 'base-application', oldId: 72918753, newId: 72918790 },
    ]);
    expect(r.reserved).toEqual([{ type: 'codeunit', id: 72918790, file: join(root, PONTO), status: 'used' }]);
    expect(progress).toEqual(['renumber 1/1']);
  });

  it('a declaration line changed by the PR counts as PR-introduced', async () => {
    baseFixture();
    const { git } = fakeGit({
      changed: [{ status: 'M', file: PONTO }],
      atTarget: {
        [EXPORT_HASH]: EXPORT_HASH_TEXT,
        [OTHER]: OTHER_TEXT,
        [PONTO]: PONTO_TEXT.replace('72918753', '72918760'),
      },
    });
    const n = fakeNinja([72918790]);
    await stage(git, n.factory).execute(makeState(), makeCtx());
    expect(read(PONTO)).toBe(PONTO_TEXT.replace('72918753', '72918790'));
    expect(read(EXPORT_HASH)).toBe(EXPORT_HASH_TEXT);
  });

  it('retries when Ninja returns an ID declared in the app', async () => {
    baseFixture();
    const { git } = fakeGit();
    const n = fakeNinja([72918700, 72918790]);
    const out = await stage(git, n.factory).execute(makeState(), makeCtx());

    const r = out.outputs.renumber as RenumberOutput;
    expect(r.reserved.map((x) => [x.id, x.status])).toEqual([
      [72918700, 'rejected-in-use'],
      [72918790, 'used'],
    ]);
    expect(r.renumbered[0]?.newId).toBe(72918790);
    expect(n.calls.unassign).not.toHaveBeenCalled();
    expect(read(PONTO)).toContain('codeunit 72918790 "CTS-CB Ponto Feature"');
  });

  it('rejects an ID outside idRanges and retries', async () => {
    baseFixture();
    const { git } = fakeGit();
    const n = fakeNinja([50000, 72918790]);
    const out = await stage(git, n.factory).execute(makeState(), makeCtx());
    const r = out.outputs.renumber as RenumberOutput;
    expect(r.reserved.map((x) => [x.id, x.status])).toEqual([
      [50000, 'rejected-out-of-range'],
      [72918790, 'used'],
    ]);
    expect(r.renumbered[0]?.newId).toBe(72918790);
  });

  it('reads the singular idRange and an app.json with a BOM', async () => {
    baseFixture();
    put('base-application/app.json', '\uFEFF' + JSON.stringify({ idRange: { from: 72918625, to: 72918824 } }));
    const { git } = fakeGit();
    const n = fakeNinja([72918790]);
    const out = await stage(git, n.factory).execute(makeState(), makeCtx());
    expect((out.outputs.renumber as RenumberOutput).renumbered[0]?.newId).toBe(72918790);
  });

  it(`gives up after NINJA_MAX_ASSIGN_ATTEMPTS`, async () => {
    baseFixture();
    const { git, calls } = fakeGit();
    const n = fakeNinja(Array.from({ length: NINJA_MAX_ASSIGN_ATTEMPTS + 2 }, () => 72918700));
    const state = makeState();
    await expect(stage(git, n.factory).execute(state, makeCtx())).rejects.toThrow(
      `ninja: no usable codeunit ID for ${PONTO}`,
    );
    expect(n.calls.assign).toHaveBeenCalledTimes(NINJA_MAX_ASSIGN_ATTEMPTS);
    expect((state.outputs.renumber as RenumberOutput).reserved).toHaveLength(NINJA_MAX_ASSIGN_ATTEMPTS);
    expect(calls.commitFiles).not.toHaveBeenCalled();
    expect(read(PONTO)).toBe(PONTO_TEXT);
  });

  it('the give-up error names the app.json idRanges, the IDs Ninja offered and the .objidconfig hint', async () => {
    baseFixture();
    const offered = Array.from({ length: NINJA_MAX_ASSIGN_ATTEMPTS }, (_, i) => 50100 + i);
    const n = fakeNinja(offered);
    const err = (await stage(fakeGit().git, n.factory).execute(makeState(), makeCtx()).catch((e: unknown) => e)) as Error;
    expect(err.message).toStartWith(`ninja: no usable codeunit ID for ${PONTO}`);
    expect(err.message).toContain('base-application/app.json idRanges 72918625-72918824');
    expect(err.message).toContain(`Ninja offered ${offered.join(', ')}`);
    expect(err.message).toContain('check that .objidconfig ranges lie inside app.json idRanges');
  });

  it('an app with no ranges rejects every ID', async () => {
    baseFixture();
    put('base-application/app.json', JSON.stringify({ name: 'x' }));
    const { git } = fakeGit();
    const n = fakeNinja(Array.from({ length: NINJA_MAX_ASSIGN_ATTEMPTS }, () => 72918790));
    const err = (await stage(git, n.factory).execute(makeState(), makeCtx()).catch((e: unknown) => e)) as Error;
    expect(err.message).toStartWith('ninja: no usable codeunit ID');
    expect(err.message).toContain('base-application/app.json idRanges (none)');
  });

  it('both members PR-introduced → IdCollisionError, no Ninja call', async () => {
    baseFixture();
    const { git } = fakeGit({
      changed: [
        { status: 'A', file: PONTO },
        { status: 'A', file: EXPORT_HASH },
      ],
      atTarget: { [OTHER]: OTHER_TEXT },
    });
    const n = fakeNinja([72918790]);
    await expect(stage(git, n.factory).execute(makeState(), makeCtx())).rejects.toBeInstanceOf(IdCollisionError);
    expect(n.factory).not.toHaveBeenCalled();
  });

  it('old ID in a PR-modified file → IdCollisionError', async () => {
    baseFixture();
    const PERM = 'base-application/src/Permissions/Banking.PermissionSet.al';
    const permText = 'permissionset 72918625 "CTS-CB Banking"\n{\n    Permissions = codeunit 72918753 = X;\n}\n';
    put(PERM, permText + '// edited\n');
    const { git } = fakeGit({
      changed: [
        { status: 'A', file: PONTO },
        { status: 'M', file: PERM },
      ],
      atTarget: { [EXPORT_HASH]: EXPORT_HASH_TEXT, [OTHER]: OTHER_TEXT, [PERM]: permText },
    });
    const n = fakeNinja([72918790]);
    await expect(stage(git, n.factory).execute(makeState(), makeCtx())).rejects.toBeInstanceOf(IdCollisionError);
    expect(n.factory).not.toHaveBeenCalled();
    expect(read(PONTO)).toBe(PONTO_TEXT);
  });

  it('replaces the old ID in other PR-added files', async () => {
    baseFixture();
    const PERM = 'base-application/src/Permissions/Ponto.PermissionSet.al';
    put(PERM, 'permissionset 72918626 "CTS-CB Ponto"\n{\n    Permissions = codeunit 72918753 = X, codeunit 729187531 = X;\n}\n');
    const { git, calls } = fakeGit({
      changed: [
        { status: 'A', file: PERM },
        { status: 'A', file: PONTO },
      ],
    });
    const n = fakeNinja([72918790]);
    await stage(git, n.factory).execute(makeState(), makeCtx());

    expect(read(PERM)).toBe(
      'permissionset 72918626 "CTS-CB Ponto"\n{\n    Permissions = codeunit 72918790 = X, codeunit 729187531 = X;\n}\n',
    );
    const [, files] = calls.commitFiles.mock.calls[0] as [string, string[], string];
    expect([...files].sort()).toEqual([PERM, PONTO].sort());
  });

  it('renumber keeps CRLF and BOM', async () => {
    baseFixture();
    const original = Buffer.from('\uFEFF// header\r\n\r\ncodeunit 72918753 "CTS-CB Ponto Feature"\r\n{\r\n}\r\n', 'utf8');
    put(PONTO, original);
    const { git } = fakeGit();
    const n = fakeNinja([72918790]);
    await stage(git, n.factory).execute(makeState(), makeCtx());

    const after = readFileSync(join(root, PONTO));
    const expected = Buffer.from(original.toString('latin1').replace('72918753', '72918790'), 'latin1');
    expect(after.equals(expected)).toBe(true);
    expect([...after.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });

  it('renumberCollisions=false: no-op', async () => {
    baseFixture();
    const { git, calls } = fakeGit();
    const n = fakeNinja([72918790]);
    const out = await stage(git, n.factory, prfixConfig({ renumberCollisions: false })).execute(makeState(), makeCtx());
    expect(n.factory).not.toHaveBeenCalled();
    expect(calls.listFiles).not.toHaveBeenCalled();
    expect(out.outputs.renumber).toBeUndefined();
    expect(read(PONTO)).toBe(PONTO_TEXT);
  });

  it('reserved is recorded before a later failure', async () => {
    baseFixture();
    const { git } = fakeGit({ commitThrows: true });
    const n = fakeNinja([72918790]);
    const state = makeState();
    await expect(stage(git, n.factory).execute(state, makeCtx())).rejects.toThrow('commit failed');
    const r = state.outputs.renumber as RenumberOutput;
    expect(r.reserved).toEqual([{ type: 'codeunit', id: 72918790, file: join(root, PONTO), status: 'used' }]);
    expect(r.commit).toBeNull();
  });

  it('closes the Ninja client when it was created', async () => {
    baseFixture();
    const ok = fakeNinja([72918790]);
    await stage(fakeGit().git, ok.factory).execute(makeState(), makeCtx());
    expect(ok.calls.close).toHaveBeenCalledTimes(1);

    put(PONTO, PONTO_TEXT); // the first run renumbered it
    const failing = fakeNinja([72918790]);
    await expect(
      stage(fakeGit({ commitThrows: true }).git, failing.factory).execute(makeState(), makeCtx()),
    ).rejects.toThrow('commit failed');
    expect(failing.calls.close).toHaveBeenCalledTimes(1);
  });

  describe('type-qualified, app-scoped references', () => {
    const PAGE_MAIN = 'base-application/src/Pages/MainPage.Page.al';
    const PAGE_PR = 'base-application/src/Ponto/PontoPage.Page.al';
    const PERM = 'base-application/src/Permissions/Ponto.PermissionSet.al';

    it('two plans in one run: codeunit N and page N renumbered independently, one commit', async () => {
      baseFixture();
      put(PAGE_MAIN, 'page 72918753 "Main Page"\n{\n}\n');
      put(PAGE_PR, 'page 72918753 "Ponto Page"\n{\n}\n');
      put(PERM, 'permissionset 72918626 "P"\n{\n    Permissions = codeunit 72918753 = X,\n        page 72918753 = X;\n}\n');
      const { git, calls } = fakeGit({
        changed: [
          { status: 'A', file: PONTO },
          { status: 'A', file: PAGE_PR },
          { status: 'A', file: PERM },
        ],
        atTarget: { [EXPORT_HASH]: EXPORT_HASH_TEXT, [OTHER]: OTHER_TEXT, [PAGE_MAIN]: read(PAGE_MAIN) },
      });
      const n = fakeNinja([]);
      n.calls.assign.mockImplementation(async (type: string) => (type === 'codeunit' ? 72918790 : 72918791));
      const out = await stage(git, n.factory).execute(makeState(), makeCtx());

      expect(read(PONTO)).toBe(PONTO_TEXT.replace('72918753', '72918790'));
      expect(read(PAGE_PR)).toBe('page 72918791 "Ponto Page"\n{\n}\n');
      expect(read(PAGE_MAIN)).toBe('page 72918753 "Main Page"\n{\n}\n');
      expect(read(PERM)).toBe('permissionset 72918626 "P"\n{\n    Permissions = codeunit 72918790 = X,\n        page 72918791 = X;\n}\n');
      expect(calls.commitFiles).toHaveBeenCalledTimes(1);
      const [, files, message] = calls.commitFiles.mock.calls[0] as [string, string[], string];
      expect([...files].sort()).toEqual([PAGE_PR, PERM, PONTO].sort());
      const body = message.split('\n').slice(2).sort();
      expect(body).toEqual(
        [
          `codeunit CTS-CB Ponto Feature 72918753 -> 72918790 (${PONTO})`,
          `page Ponto Page 72918753 -> 72918791 (${PAGE_PR})`,
        ].sort(),
      );
      expect((out.outputs.renumber as RenumberOutput).renumbered).toHaveLength(2);
    });

    it('a PR-added, non-colliding page with the same number is untouched', async () => {
      baseFixture();
      const pageText = 'page 72918753 "Ponto Page"\n{\n    // shows page 72918753\n}\n';
      put(PAGE_PR, pageText);
      put(PERM, 'permissionset 72918626 "P"\n{\n    Permissions = codeunit 72918753 = X, page 72918753 = X;\n}\n');
      const { git, calls } = fakeGit({
        changed: [
          { status: 'A', file: PONTO },
          { status: 'A', file: PAGE_PR },
          { status: 'A', file: PERM },
        ],
      });
      const n = fakeNinja([72918790]);
      await stage(git, n.factory).execute(makeState(), makeCtx());

      expect(read(PAGE_PR)).toBe(pageText);
      expect(read(PERM)).toBe('permissionset 72918626 "P"\n{\n    Permissions = codeunit 72918790 = X, page 72918753 = X;\n}\n');
      expect(n.calls.assign).toHaveBeenCalledTimes(1);
      const [, files] = calls.commitFiles.mock.calls[0] as [string, string[], string];
      expect([...files].sort()).toEqual([PERM, PONTO].sort());
    });

    it('same type and number colliding in two apps: each app edited only for its own plan', async () => {
      baseFixture();
      put(PERM, 'permissionset 72918626 "P"\n{\n    Permissions = codeunit 72918753 = X;\n}\n');
      const T_MAIN = 'test-application/src/MainTest.Codeunit.al';
      const T_PR = 'test-application/src/PontoTest.Codeunit.al';
      const T_PERM = 'test-application/src/Test.PermissionSet.al';
      put('test-application/app.json', APP_JSON);
      put(T_MAIN, 'codeunit 72918753 "Main Test"\n{\n}\n');
      put(T_PR, 'codeunit 72918753 "Ponto Test"\n{\n}\n');
      put(T_PERM, 'permissionset 72918627 "T"\n{\n    Permissions = codeunit 72918753 = X;\n}\n');
      const { git } = fakeGit({
        changed: [
          { status: 'A', file: PONTO },
          { status: 'A', file: PERM },
          { status: 'A', file: T_PR },
          { status: 'A', file: T_PERM },
        ],
        atTarget: { [EXPORT_HASH]: EXPORT_HASH_TEXT, [OTHER]: OTHER_TEXT, [T_MAIN]: read(T_MAIN) },
      });
      const n = fakeNinja([]);
      n.calls.assign.mockImplementation(async (_t: string, file: string) =>
        file.includes('test-application') ? 72918791 : 72918790,
      );
      await stage(git, n.factory).execute(makeState(), makeCtx());

      expect(read(PONTO)).toContain('codeunit 72918790');
      expect(read(PERM)).toContain('codeunit 72918790 = X');
      expect(read(T_PR)).toBe('codeunit 72918791 "Ponto Test"\n{\n}\n');
      expect(read(T_PERM)).toContain('codeunit 72918791 = X');
      expect(read(T_MAIN)).toBe('codeunit 72918753 "Main Test"\n{\n}\n');
    });

    it('rewrites a type-qualified self-reference in the PR-added target', async () => {
      baseFixture();
      const text = 'codeunit 72918753 "CTS-CB Ponto Feature"\n{\n    var\n        Self: Codeunit 72918753;\n}\n';
      put(PONTO, text);
      const { git } = fakeGit();
      await stage(git, fakeNinja([72918790]).factory).execute(makeState(), makeCtx());
      expect(read(PONTO)).toBe(text.replaceAll('72918753', '72918790'));
    });

    it('a bare old ID in a PR-added file → IdCollisionError, no Ninja call', async () => {
      baseFixture();
      const RUNNER = 'base-application/src/Ponto/Runner.Codeunit.al';
      put(RUNNER, 'codeunit 72918627 "Runner"\n{\n    trigger OnRun()\n    begin\n        Codeunit.Run(72918753);\n    end;\n}\n');
      const { git } = fakeGit({
        changed: [
          { status: 'A', file: PONTO },
          { status: 'A', file: RUNNER },
        ],
      });
      const n = fakeNinja([72918790]);
      const err = await stage(git, n.factory).execute(makeState(), makeCtx()).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(IdCollisionError);
      expect((err as Error).message).toContain(`${RUNNER}:5`);
      expect(n.factory).not.toHaveBeenCalled();
      expect(read(PONTO)).toBe(PONTO_TEXT);
    });

    it('a PR-modified non-target file with page N (another type) is allowed', async () => {
      baseFixture();
      const MOD = 'base-application/src/Permissions/Banking.PermissionSet.al';
      const modText = 'permissionset 72918625 "B"\n{\n    Permissions = page 72918753 = X;\n}\n// edited\n';
      put(MOD, modText);
      const { git } = fakeGit({
        changed: [
          { status: 'A', file: PONTO },
          { status: 'M', file: MOD },
        ],
        atTarget: { [EXPORT_HASH]: EXPORT_HASH_TEXT, [OTHER]: OTHER_TEXT, [MOD]: 'permissionset 72918625 "B"\n{\n}\n' },
      });
      await stage(git, fakeNinja([72918790]).factory).execute(makeState(), makeCtx());
      expect(read(MOD)).toBe(modText);
      expect(read(PONTO)).toContain('codeunit 72918790');
    });

    it('a moved file (D old path + A new path, same declaration) is not PR-introduced', async () => {
      baseFixture();
      const OLD_PATH = 'base-application/src/Old/PontoFeature.Codeunit.al';
      const { git } = fakeGit({
        changed: [
          { status: 'D', file: OLD_PATH },
          { status: 'A', file: PONTO },
        ],
        atTarget: { [EXPORT_HASH]: EXPORT_HASH_TEXT, [OTHER]: OTHER_TEXT, [OLD_PATH]: PONTO_TEXT },
      });
      const n = fakeNinja([72918790]);
      // No PR-introduced member: the group is the target's own state, ignored rather than refused.
      const ctx = makeCtx();
      const out = await stage(git, n.factory).execute(makeState(), ctx);
      expect(out.outputs.renumber).toEqual({ commit: null, renumbered: [], reserved: [] });
      expect(ctx.logger.info).toHaveBeenCalledWith(
        'renumber-collisions: ignoring codeunit 72918753 in base-application — no PR-introduced member',
      );
      expect(n.factory).not.toHaveBeenCalled();
      expect(read(PONTO)).toBe(PONTO_TEXT);
    });

    describe('references from another app', () => {
      const T_PERM = 'test-application/src/Test.PermissionSet.al';
      const T_TEST = 'test-application/src/PontoTest.Codeunit.al';

      it('a PR-modified file in another app with codeunit N → IdCollisionError, no Ninja call', async () => {
        baseFixture();
        put('test-application/app.json', APP_JSON);
        const before = 'permissionset 72918627 "T"\n{\n}\n';
        put(T_PERM, 'permissionset 72918627 "T"\n{\n    Permissions = codeunit 72918753 = X;\n}\n');
        const { git } = fakeGit({
          changed: [
            { status: 'A', file: PONTO },
            { status: 'M', file: T_PERM },
          ],
          atTarget: { [EXPORT_HASH]: EXPORT_HASH_TEXT, [OTHER]: OTHER_TEXT, [T_PERM]: before },
        });
        const n = fakeNinja([72918790]);
        const err = await stage(git, n.factory).execute(makeState(), makeCtx()).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(IdCollisionError);
        expect((err as Error).message).toContain(`${T_PERM}:3`);
        expect(n.factory).not.toHaveBeenCalled();
        expect(read(PONTO)).toBe(PONTO_TEXT);
      });

      it('a PR-added test codeunit in another app with a Codeunit N variable → IdCollisionError', async () => {
        baseFixture();
        put('test-application/app.json', APP_JSON);
        put(T_TEST, 'codeunit 72918700 "Ponto Test"\n{\n    var\n        Sut: Codeunit 72918753;\n}\n');
        const { git } = fakeGit({
          changed: [
            { status: 'A', file: PONTO },
            { status: 'A', file: T_TEST },
          ],
        });
        const n = fakeNinja([72918790]);
        const err = await stage(git, n.factory).execute(makeState(), makeCtx()).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(IdCollisionError);
        expect((err as Error).message).toContain(`${T_TEST}:4`);
        expect(n.factory).not.toHaveBeenCalled();
      });

      it('a PR-added file in another app with page N (another type) is allowed and left alone', async () => {
        baseFixture();
        put('test-application/app.json', APP_JSON);
        const text = 'permissionset 72918627 "T"\n{\n    Permissions = page 72918753 = X;\n}\n';
        put(T_PERM, text);
        const { git } = fakeGit({
          changed: [
            { status: 'A', file: PONTO },
            { status: 'A', file: T_PERM },
          ],
        });
        await stage(git, fakeNinja([72918790]).factory).execute(makeState(), makeCtx());
        expect(read(T_PERM)).toBe(text);
        expect(read(PONTO)).toContain('codeunit 72918790');
      });

      it('a file under external/ is never scanned', async () => {
        baseFixture();
        const EXT = 'external/Continia Finance/src/Uses.Codeunit.al';
        put('external/Continia Finance/app.json', APP_JSON);
        put(EXT, 'codeunit 72918701 "Uses"\n{\n    var\n        X: Codeunit 72918753;\n}\n');
        const { git } = fakeGit({
          changed: [
            { status: 'A', file: PONTO },
            { status: 'M', file: EXT },
          ],
        });
        await stage(git, fakeNinja([72918790]).factory).execute(makeState(), makeCtx());
        expect(read(PONTO)).toContain('codeunit 72918790');
      });
    });

    it('factory throws → close not called, error propagates', async () => {
      baseFixture();
      const n = fakeNinja([]);
      n.factory.mockImplementation(() => {
        throw new Error('ninja spawn failed');
      });
      await expect(stage(fakeGit().git, n.factory).execute(makeState(), makeCtx())).rejects.toThrow('ninja spawn failed');
      expect(n.calls.close).not.toHaveBeenCalled();
    });
  });

  it('refuses a declaration line it cannot rewrite exactly once', async () => {
    baseFixture();
    // The declaration ID differs from what the scan saw: the rewrite must not guess.
    put(PONTO, 'codeunit 72918753 "CTS-CB Ponto Feature"\n{\n}\n');
    const { git } = fakeGit();
    const n = fakeNinja([72918790]);
    const s = stage(git, n.factory);
    // Mutate the file between scan and rewrite by making Ninja's assign do it.
    n.calls.assign.mockImplementationOnce(async () => {
      put(PONTO, 'codeunit 72918754 "CTS-CB Ponto Feature"\n{\n}\n');
      return 72918790;
    });
    await expect(s.execute(makeState(), makeCtx())).rejects.toThrow(/declaration/);
  });
});

describe('createRenumberStage: what the compiler does not see', () => {
  const LLM = 'base-application/Logging/Codeunits/LLMUserPromptLog.Codeunit.al';
  const LLM_TEXT = '#if US64044\ncodeunit 72918700 "CTS-CB LLM User Prompt Log"\n{\n}\n#endif\n';
  const COPY_UT = 'base-application/Templates/CopyTemplateUT.Codeunit.al';
  const COPY_UT_TEXT = '/* TODO: Check the errors coming up\ncodeunit 72918701 "CTS-CB Copy Template UT"\n{\n}\n*/\n';
  const TEMPLATE_UT = 'base-application/Templates/TemplateValuesUT.Codeunit.al';
  const TEMPLATE_UT_TEXT = 'codeunit 72918701 "CTS-CB Template Values UT"\n{\n}\n';
  const DUP_A = 'base-application/src/DupA.Codeunit.al';
  const DUP_B = 'base-application/src/DupB.Codeunit.al';

  const infoLines = (ctx: PipelineContext) =>
    (ctx.logger.info as ReturnType<typeof mock>).mock.calls.map((c) => String(c[0]));
  const ignoring = (ctx: PipelineContext) => infoLines(ctx).filter((l) => l.includes('ignoring'));

  /** PR 61400: one real collision, plus main-only duplicates that are gated, commented out, or active. */
  function pr61400Fixture(appJson = APP_JSON): void {
    baseFixture();
    put('base-application/app.json', appJson);
    put(LLM, LLM_TEXT);
    put(COPY_UT, COPY_UT_TEXT);
    put(TEMPLATE_UT, TEMPLATE_UT_TEXT);
    put(DUP_A, 'codeunit 72918710 "CTS-CB Dup A"\n{\n}\n');
    put(DUP_B, 'codeunit 72918710 "CTS-CB Dup B"\n{\n}\n');
  }

  it('PR 61400 shape: renumbers the one real collision and logs only the active main-only group', async () => {
    pr61400Fixture(JSON.stringify({ ...JSON.parse(APP_JSON), preprocessorSymbols: ['RUNTIME17', 'RUNTIME18'] }));
    const { git, calls } = fakeGit();
    const n = fakeNinja([72918790]);
    const ctx = makeCtx();
    const out = await stage(git, n.factory).execute(makeState(), ctx);

    const r = out.outputs.renumber as RenumberOutput;
    expect(r.renumbered.map((x) => [x.file, x.oldId, x.newId])).toEqual([[PONTO, 72918753, 72918790]]);
    expect(n.calls.assign).toHaveBeenCalledTimes(1);
    expect(calls.commitFiles).toHaveBeenCalledTimes(1);
    expect(read(LLM)).toBe(LLM_TEXT);
    expect(read(COPY_UT)).toBe(COPY_UT_TEXT);
    expect(ignoring(ctx)).toEqual([
      'renumber-collisions: ignoring codeunit 72918710 in base-application — no PR-introduced member',
    ]);
  });

  it("an #if-gated object counts when the app's preprocessorSymbols define the symbol", async () => {
    pr61400Fixture(JSON.stringify({ ...JSON.parse(APP_JSON), preprocessorSymbols: ['US64044'] }));
    const ctx = makeCtx();
    await stage(fakeGit().git, fakeNinja([72918790]).factory).execute(makeState(), ctx);
    expect(ignoring(ctx).sort()).toEqual([
      'renumber-collisions: ignoring codeunit 72918700 in base-application — no PR-introduced member',
      'renumber-collisions: ignoring codeunit 72918710 in base-application — no PR-introduced member',
    ]);
  });

  it('only main-only collisions: no refusal, no Ninja, no commit', async () => {
    put('base-application/app.json', APP_JSON);
    put(DUP_A, 'codeunit 72918710 "CTS-CB Dup A"\n{\n}\n');
    put(DUP_B, 'codeunit 72918710 "CTS-CB Dup B"\n{\n}\n');
    const { git, calls } = fakeGit({ changed: [] });
    const n = fakeNinja([]);
    const ctx = makeCtx();
    const out = await stage(git, n.factory).execute(makeState(), ctx);
    expect(n.factory).not.toHaveBeenCalled();
    expect(calls.commitFiles).not.toHaveBeenCalled();
    expect(out.outputs.renumber).toEqual({ commit: null, renumbered: [], reserved: [] });
    expect(ignoring(ctx)).toHaveLength(1);
  });

  it('a #if-gated object in the PR is not a collision', async () => {
    baseFixture();
    put(PONTO, `#if US64044\n${PONTO_TEXT}#endif\n`);
    const { git, calls } = fakeGit();
    const n = fakeNinja([]);
    await stage(git, n.factory).execute(makeState(), makeCtx());
    expect(n.factory).not.toHaveBeenCalled();
    expect(calls.commitFiles).not.toHaveBeenCalled();
  });

  it('byte-exact rewrite: the old ID inside comments is neither replaced nor refused', async () => {
    baseFixture();
    const text =
      'codeunit 72918753 "CTS-CB Ponto Feature"\r\n{\r\n' +
      '    // was codeunit 72918753 before the move\r\n' +
      '    /* Codeunit.Run(72918753);\r\n       codeunit 72918753 */\r\n' +
      '    procedure Run()\r\n    begin\r\n    end;\r\n}\r\n';
    put(PONTO, Buffer.from('\uFEFF' + text, 'utf8'));
    const { git } = fakeGit();
    await stage(git, fakeNinja([72918790]).factory).execute(makeState(), makeCtx());
    // Only the declaration changes; both comments keep the old ID.
    const expected = '\uFEFF' + text.replace('codeunit 72918753 "CTS', 'codeunit 72918790 "CTS');
    expect(readFileSync(join(root, PONTO)).equals(Buffer.from(expected, 'utf8'))).toBe(true);
  });

  it('a PR-modified file that mentions the old ID only in a comment does not refuse', async () => {
    baseFixture();
    const MOD = 'base-application/src/Mod.Codeunit.al';
    const modText = 'codeunit 72918702 "Mod"\n{\n    // calls codeunit 72918753\n    #if NEVER\n    var X: Codeunit 72918753;\n    #endif\n}\n';
    put(MOD, modText);
    const { git } = fakeGit({
      changed: [
        { status: 'A', file: PONTO },
        { status: 'M', file: MOD },
      ],
      atTarget: { [EXPORT_HASH]: EXPORT_HASH_TEXT, [OTHER]: OTHER_TEXT, [MOD]: 'codeunit 72918702 "Mod"\n{\n}\n' },
    });
    await stage(git, fakeNinja([72918790]).factory).execute(makeState(), makeCtx());
    expect(read(MOD)).toBe(modText);
    expect(read(PONTO)).toContain('codeunit 72918790');
  });

  it('a BOM-prefixed PR-modified file whose reference sits in a line-1 inactive #if does not refuse', async () => {
    baseFixture();
    const MOD = 'base-application/Logging/LLMUse.Codeunit.al';
    const modText = '\uFEFF#if US64044\r\ncodeunit 72918702 "LLM Use"\r\n{\r\n    var\r\n        X: Codeunit 72918753;\r\n}\r\n#endif\r\n';
    put(MOD, Buffer.from(modText, 'utf8'));
    const { git } = fakeGit({
      changed: [
        { status: 'A', file: PONTO },
        { status: 'M', file: MOD },
      ],
      atTarget: { [EXPORT_HASH]: EXPORT_HASH_TEXT, [OTHER]: OTHER_TEXT, [MOD]: '\uFEFF#if US64044\r\n#endif\r\n' },
    });
    await stage(git, fakeNinja([72918790]).factory).execute(makeState(), makeCtx());
    expect(readFileSync(join(root, MOD)).equals(Buffer.from(modText, 'utf8'))).toBe(true);
    expect(read(PONTO)).toContain('codeunit 72918790');
  });

  it('a malformed app.json in an app with nothing to renumber only warns', async () => {
    baseFixture();
    put('test-application/app.json', '{ not json');
    put('test-application/src/T.Codeunit.al', 'codeunit 72918799 "T"\n{\n}\n');
    const ctx = makeCtx();
    const out = await stage(fakeGit().git, fakeNinja([72918790]).factory).execute(makeState(), ctx);
    expect((out.outputs.renumber as RenumberOutput).renumbered).toHaveLength(1);
    const warns = (ctx.logger.warn as ReturnType<typeof mock>).mock.calls.map((c) => String(c[0]));
    expect(warns.some((w) => w.includes('cannot read test-application/app.json'))).toBe(true);
  });

  it("a malformed app.json in the target's app stays fatal, before Ninja starts", async () => {
    baseFixture();
    put('base-application/app.json', '{ not json');
    const n = fakeNinja([72918790]);
    await expect(stage(fakeGit().git, n.factory).execute(makeState(), makeCtx())).rejects.toThrow(
      'cannot read base-application/app.json',
    );
    expect(n.factory).not.toHaveBeenCalled();
    expect(read(PONTO)).toBe(PONTO_TEXT);
  });
});

describe('createRenumberStage: Ninja rangeName from .objidconfig', () => {
  const R1 = 'From 71553575 to 71553874';
  const R2 = 'From 72282325 to 72282424';
  const R3 = 'From 72918625 to 72918824';
  const OBJIDCONFIG = JSON.stringify({
    idRanges: [
      { from: 71553575, to: 71553874, description: R1 },
      { from: 72282325, to: 72282424, description: R2 },
      { from: 72918625, to: 72918824, description: R3 },
    ],
  });
  const APP_JSON_3 = JSON.stringify({
    name: 'Continia Banking',
    idRanges: [
      { from: 71553575, to: 71553874 },
      { from: 72282325, to: 72282424 },
      { from: 72918625, to: 72918824 },
    ],
  });

  function fixture(objIdConfig: string | null = OBJIDCONFIG): void {
    baseFixture();
    put('base-application/app.json', APP_JSON_3);
    if (objIdConfig !== null) put('base-application/.objidconfig', objIdConfig);
  }
  const rangeNames = (n: ReturnType<typeof fakeNinja>) => n.calls.assign.mock.calls.map((c) => c[2]);

  it("asks for the range that holds the old ID first", async () => {
    fixture();
    const n = fakeNinja([72918790]);
    await stage(fakeGit().git, n.factory).execute(makeState(), makeCtx());
    expect(n.calls.assign.mock.calls[0]).toEqual(['codeunit', join(root, PONTO), R3]);
  });

  it('an old ID outside every named range asks for the first range in file order', async () => {
    fixture();
    put(EXPORT_HASH, 'codeunit 50100 "CTS-CB Export File Hash"\n{\n}\n');
    put(PONTO, 'codeunit 50100 "CTS-CB Ponto Feature"\n{\n}\n');
    const n = fakeNinja([71553600]);
    await stage(fakeGit().git, n.factory).execute(makeState(), makeCtx());
    expect(rangeNames(n)).toEqual([R1]);
  });

  it('no .objidconfig: no rangeName, and a warning', async () => {
    fixture(null);
    const n = fakeNinja([72918790]);
    const ctx = makeCtx();
    await stage(fakeGit().git, n.factory).execute(makeState(), ctx);
    expect(n.calls.assign.mock.calls[0]).toEqual(['codeunit', join(root, PONTO)]);
    const warns = (ctx.logger.warn as ReturnType<typeof mock>).mock.calls.map((c) => String(c[0]));
    expect(warns.some((w) => w.includes('base-application/.objidconfig not found'))).toBe(true);
  });

  it('an unparsable .objidconfig: no rangeName, and a warning', async () => {
    fixture('{ nope');
    const n = fakeNinja([72918790]);
    const ctx = makeCtx();
    await stage(fakeGit().git, n.factory).execute(makeState(), ctx);
    expect(n.calls.assign.mock.calls[0]).toEqual(['codeunit', join(root, PONTO)]);
    const warns = (ctx.logger.warn as ReturnType<typeof mock>).mock.calls.map((c) => String(c[0]));
    expect(warns.some((w) => w.includes('base-application/.objidconfig cannot be read'))).toBe(true);
  });

  it('a BOM-prefixed .objidconfig is read', async () => {
    fixture('\uFEFF' + OBJIDCONFIG);
    const n = fakeNinja([72918790]);
    await stage(fakeGit().git, n.factory).execute(makeState(), makeCtx());
    expect(rangeNames(n)).toEqual([R3]);
  });

  it('an exhausted range moves on to the next named range in file order', async () => {
    fixture();
    const n = fakeNinja(['refuse', 71553600]);
    const out = await stage(fakeGit().git, n.factory).execute(makeState(), makeCtx());
    expect(rangeNames(n)).toEqual([R3, R1]);
    const r = out.outputs.renumber as RenumberOutput;
    expect(r.renumbered[0]?.newId).toBe(71553600);
    expect(r.reserved).toEqual([{ type: 'codeunit', id: 71553600, file: join(root, PONTO), status: 'used' }]);
  });

  it('a rejected ID retries the same range', async () => {
    fixture();
    const n = fakeNinja([72918700, 72918790]);
    await stage(fakeGit().git, n.factory).execute(makeState(), makeCtx());
    expect(rangeNames(n)).toEqual([R3, R3]);
  });

  it('objectRanges for the type take precedence over idRanges', async () => {
    fixture(
      JSON.stringify({
        ...JSON.parse(OBJIDCONFIG),
        objectRanges: { codeunit: [{ from: 72918780, to: 72918799, description: 'Codeunits' }] },
      }),
    );
    const n = fakeNinja([72918790]);
    await stage(fakeGit().git, n.factory).execute(makeState(), makeCtx());
    expect(rangeNames(n)).toEqual(['Codeunits']);
  });

  it('every range refused: the give-up error names the ranges tried', async () => {
    fixture();
    const n = fakeNinja(['refuse', 'refuse', 'refuse']);
    const err = (await stage(fakeGit().git, n.factory).execute(makeState(), makeCtx()).catch((e: unknown) => e)) as Error;
    expect(err.message).toStartWith(`ninja: no usable codeunit ID for ${PONTO}`);
    expect(err.message).toContain(`ranges tried: "${R3}", "${R1}", "${R2}"`);
    expect(err.message).toContain('No more IDs available in range');
    expect(n.calls.assign).toHaveBeenCalledTimes(3);
  });

  it('attempts across ranges count toward NINJA_MAX_ASSIGN_ATTEMPTS', async () => {
    fixture();
    const n = fakeNinja(['refuse', ...Array.from({ length: NINJA_MAX_ASSIGN_ATTEMPTS }, () => 72918700)]);
    const err = (await stage(fakeGit().git, n.factory).execute(makeState(), makeCtx()).catch((e: unknown) => e)) as Error;
    expect(n.calls.assign).toHaveBeenCalledTimes(NINJA_MAX_ASSIGN_ATTEMPTS);
    expect(err.message).toContain(`ranges tried: "${R3}", "${R1}"`);
  });
});
