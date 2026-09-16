import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  discoverAlApps,
  localizationAppDir,
  ownerAppOf,
  resolveDeployOrder,
  type AlApp,
} from '../../src/utils/al-app-graph.ts';

/** The real Continia Banking shape, trimmed to the apps that matter here. */
const APPS: AlApp[] = [
  { dir: 'permission-sets', name: 'Continia Banking - Permission Sets', dependencies: ['Continia System Application', 'Continia Core'] },
  { dir: 'approval', name: 'Continia Approval', dependencies: ['Continia Core', 'Continia Banking - Permission Sets'] },
  { dir: 'base-application', name: 'Continia Banking', dependencies: ['Continia System Application', 'Continia Core', 'Continia Approval', 'Continia Connector App', 'Continia Banking - Permission Sets'] },
  { dir: 'export', name: 'Continia Banking - Export', dependencies: ['Continia Banking', 'Continia Approval', 'Continia Banking - Permission Sets'] },
  { dir: 'import', name: 'Continia Banking - Import', dependencies: ['Continia Banking', 'Bank Account Reconciliation With AI', 'Continia Banking - Permission Sets'] },
  { dir: 'base-application-test', name: 'Continia Banking - Base App - Test Suite', dependencies: ['Continia Core', 'Continia Banking', 'Library Assert', 'Test Runner'] },
  { dir: 'export-test', name: 'Continia Banking - Export - Test Suite', dependencies: ['Continia Banking', 'Continia Banking - Export', 'Continia Banking - Base App - Test Suite', 'Library Assert'] },
];

describe('ownerAppOf', () => {
  it('maps a changed file to the app directory containing it', () => {
    expect(ownerAppOf('base-application/Bank/Tables/Bank.Table.al', APPS)?.dir)
      .toBe('base-application');
    expect(ownerAppOf('export/Codeunits/Export.Codeunit.al', APPS)?.dir).toBe('export');
  });

  it('prefers the longest match so a nested app beats its parent', () => {
    const nested: AlApp[] = [
      { dir: 'Banking', name: 'Parent', dependencies: [] },
      { dir: 'Banking/Cloud', name: 'Child', dependencies: [] },
    ];
    expect(ownerAppOf('Banking/Cloud/X.al', nested)?.name).toBe('Child');
    expect(ownerAppOf('Banking/Other/X.al', nested)?.name).toBe('Parent');
  });

  it('returns undefined for a file outside every app', () => {
    expect(ownerAppOf('README.md', APPS)).toBeUndefined();
    expect(ownerAppOf('.github/workflows/ci.yml', APPS)).toBeUndefined();
  });

  it('tolerates windows separators', () => {
    expect(ownerAppOf('base-application\\Bank\\Bank.Table.al', APPS)?.dir)
      .toBe('base-application');
  });
});

describe('resolveDeployOrder', () => {
  it('expands a seed to its internal dependencies, dependency-first', () => {
    const order = resolveDeployOrder(APPS, ['base-application']);
    expect(order).toEqual(['permission-sets', 'approval', 'base-application']);
  });

  it('orders a test app after everything it needs', () => {
    const order = resolveDeployOrder(APPS, ['export-test']);
    expect(order).toEqual([
      'permission-sets',
      'approval',
      'base-application',
      'export',
      'base-application-test',
      'export-test',
    ]);
    // Every dependency precedes its dependant.
    expect(order.indexOf('base-application')).toBeLessThan(order.indexOf('export'));
    expect(order.indexOf('export')).toBeLessThan(order.indexOf('export-test'));
  });

  it('never includes external dependencies — those come from deps install', () => {
    const order = resolveDeployOrder(APPS, ['base-application-test']);
    expect(order).not.toContain('Library Assert');
    expect(order).not.toContain('Continia Core');
    expect(order).not.toContain('Test Runner');
  });

  it('deduplicates when several seeds share dependencies', () => {
    const order = resolveDeployOrder(APPS, ['export', 'import']);
    expect(order.filter((d) => d === 'base-application')).toHaveLength(1);
    expect(order).toContain('export');
    expect(order).toContain('import');
  });

  it('returns [] for seeds that match no app', () => {
    expect(resolveDeployOrder(APPS, ['does-not-exist'])).toEqual([]);
    expect(resolveDeployOrder(APPS, [])).toEqual([]);
  });

  it('terminates on a dependency cycle instead of recursing forever', () => {
    const cyclic: AlApp[] = [
      { dir: 'a', name: 'A', dependencies: ['B'] },
      { dir: 'b', name: 'B', dependencies: ['A'] },
    ];
    const order = resolveDeployOrder(cyclic, ['a']);
    expect(order).toHaveLength(2);
    expect(new Set(order)).toEqual(new Set(['a', 'b']));
  });
});

describe('discoverAlApps', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'appgraph-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function app(
    rel: string,
    name: string,
    deps: string[] = [],
    extra: Record<string, unknown> = {},
  ): void {
    const abs = join(dir, rel);
    mkdirSync(abs, { recursive: true });
    writeFileSync(
      join(abs, 'app.json'),
      JSON.stringify({ id: '1', name, dependencies: deps.map((d) => ({ id: 'x', name: d })), ...extra }),
    );
  }

  it('finds apps and reads their names and dependency names', () => {
    app('base-application', 'Continia Banking', ['Continia Core']);
    app('export', 'Continia Banking - Export', ['Continia Banking']);
    const found = discoverAlApps(dir);
    expect(found.map((a) => a.dir).sort()).toEqual(['base-application', 'export']);
    expect(found.find((a) => a.dir === 'export')?.dependencies).toEqual(['Continia Banking']);
  });

  it('does not descend into an app looking for nested apps', () => {
    app('base-application', 'Continia Banking');
    mkdirSync(join(dir, 'base-application', 'sub'), { recursive: true });
    writeFileSync(join(dir, 'base-application', 'sub', 'app.json'), '{"name":"Nope"}');
    expect(discoverAlApps(dir).map((a) => a.name)).toEqual(['Continia Banking']);
  });

  it('finds apps nested one level down', () => {
    app('Banking/Cloud', 'Continia Banking');
    expect(discoverAlApps(dir).map((a) => a.dir)).toEqual(['Banking/Cloud']);
  });

  it('skips a malformed app.json without aborting the scan', () => {
    mkdirSync(join(dir, 'broken'), { recursive: true });
    writeFileSync(join(dir, 'broken', 'app.json'), '{ not json');
    app('ok', 'Good App');
    expect(discoverAlApps(dir).map((a) => a.name)).toEqual(['Good App']);
  });

  it('handles an app.json with no dependencies key', () => {
    mkdirSync(join(dir, 'solo'), { recursive: true });
    writeFileSync(join(dir, 'solo', 'app.json'), '{"name":"Solo"}');
    expect(discoverAlApps(dir)[0]?.dependencies).toEqual([]);
  });

  it('surfaces application and platform from app.json', () => {
    app('base-application', 'Continia Banking', [], { application: '29.0.0.0', platform: '29.0.0.0' });

    const found = discoverAlApps(dir);

    expect(found).toHaveLength(1);
    expect(found[0]?.application).toBe('29.0.0.0');
    expect(found[0]?.platform).toBe('29.0.0.0');
  });

  it('still discovers apps whose manifest omits both version fields', () => {
    app('base-application', 'Continia Banking');

    const found = discoverAlApps(dir);

    expect(found).toHaveLength(1);
    expect(found[0]?.name).toBe('Continia Banking');
    expect(found[0]?.application).toBeUndefined();
    expect(found[0]?.platform).toBeUndefined();
  });

  it('ignores non-string version fields rather than propagating them', () => {
    app('base-application', 'Continia Banking', [], { application: 29 });

    expect(discoverAlApps(dir)[0]?.application).toBeUndefined();
  });
});

describe('localizationAppDir', () => {
  const countryApps: AlApp[] = [
    { dir: 'banking-w1', name: 'Continia Banking (W1)', dependencies: [] },
    { dir: 'banking-dk', name: 'Continia Banking (DK)', dependencies: [] },
    { dir: 'base-application', name: 'Continia Banking', dependencies: [] },
  ];

  it("maps 'base' to the W1 app", () => {
    expect(localizationAppDir(countryApps, 'base')).toEqual({ dir: 'banking-w1', fellBack: false });
  });

  it('maps a country code to its own app', () => {
    expect(localizationAppDir(countryApps, 'dk')).toEqual({ dir: 'banking-dk', fellBack: false });
  });

  it('matches case-insensitively', () => {
    expect(localizationAppDir(countryApps, 'DK')).toEqual({ dir: 'banking-dk', fellBack: false });
  });

  it("accepts 'w1' spelled directly, without reporting a fallback", () => {
    expect(localizationAppDir(countryApps, 'w1')).toEqual({ dir: 'banking-w1', fellBack: false });
  });

  it('falls back to W1 when the localization has no app', () => {
    // Real case: BC 29 publishes au/ca/nz profiles and the repo has no
    // banking-au. Every country app declares Continia Finance, so W1 serves.
    expect(localizationAppDir(countryApps, 'au')).toEqual({ dir: 'banking-w1', fellBack: true });
  });

  it('returns undefined when not even W1 exists', () => {
    const noCountryApps: AlApp[] = [{ dir: 'base-application', name: 'Continia Banking', dependencies: [] }];
    expect(localizationAppDir(noCountryApps, 'dk')).toBeUndefined();
  });

  it('returns undefined for an empty app list', () => {
    expect(localizationAppDir([], 'base')).toBeUndefined();
  });

  it('treats a blank localization as base', () => {
    expect(localizationAppDir(countryApps, '  ')).toEqual({ dir: 'banking-w1', fellBack: false });
  });
});

describe('resolveDeployOrder — external/ is not walked into', () => {
  // The real collision: external/Continia Finance/00_Base_App declares
  // name "Continia Finance", which is exactly what banking-w1 depends on.
  const withVendored: AlApp[] = [
    { dir: 'banking-w1', name: 'Continia Banking (W1)', dependencies: ['Continia Banking', 'Continia Finance'] },
    { dir: 'base-application', name: 'Continia Banking', dependencies: [] },
    { dir: 'external/Continia Finance/00_Base_App', name: 'Continia Finance', dependencies: [] },
  ];

  it('does not pull a vendored app in through a dependency edge', () => {
    const order = resolveDeployOrder(withVendored, ['banking-w1']);
    expect(order).toEqual(['base-application', 'banking-w1']);
  });

  it('still follows the same dependency name when it resolves outside external/', () => {
    const inRepo: AlApp[] = [
      { dir: 'banking-w1', name: 'Continia Banking (W1)', dependencies: ['Continia Finance'] },
      { dir: 'finance', name: 'Continia Finance', dependencies: [] },
    ];
    expect(resolveDeployOrder(inRepo, ['banking-w1'])).toEqual(['finance', 'banking-w1']);
  });

  it('resolves a colliding name to the in-repo app, not the vendored copy', () => {
    // Both are in `apps`, and discoverAlApps sorts by directory: 'apps/…' sorts
    // before 'external/…', so a last-wins map hands the edge to the vendored
    // copy — which the guard then skips, silently dropping the REAL app out of
    // the deploy order. Directory order must not decide this either way.
    const collision: AlApp[] = [
      { dir: 'apps/Continia Finance', name: 'Continia Finance', dependencies: [] },
      { dir: 'banking-w1', name: 'Continia Banking (W1)', dependencies: ['Continia Finance'] },
      { dir: 'external/Continia Finance/00_Base_App', name: 'Continia Finance', dependencies: [] },
    ];
    expect(resolveDeployOrder(collision, ['banking-w1'])).toEqual([
      'apps/Continia Finance',
      'banking-w1',
    ]);
    // … and the reverse listing order resolves the same way.
    const reversed = [...collision].reverse();
    expect(resolveDeployOrder(reversed, ['banking-w1'])).toEqual([
      'apps/Continia Finance',
      'banking-w1',
    ]);
  });

  it('still builds a vendored app that was seeded directly', () => {
    // The guard stops the graph reaching into external/, not an operator
    // aiming at it: a WI that edits vendored source seeds it via ownerAppOf.
    expect(resolveDeployOrder(withVendored, ['external/Continia Finance/00_Base_App'])).toEqual([
      'external/Continia Finance/00_Base_App',
    ]);
  });
});
