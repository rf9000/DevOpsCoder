import { describe, it, expect, mock } from 'bun:test';
import { createEnvProvisionStage, resolveRequiredBcVersion } from '../../../src/pipeline/stages/env-provision.ts';
import { ContiniaCliError, type ContiniaCli, type EnvironmentInfo } from '../../../src/services/continia-cli.ts';
import { createLogger } from '../../../src/utils/logger.ts';
import type { AppConfig, EnvironmentOutput, PipelineState, WorktreeContext } from '../../../src/types/index.ts';
import type { AlApp } from '../../../src/utils/al-app-graph.ts';

const baseConfig: AppConfig = {
  orgUrl: 'https://x', project: 'p', pat: 't',
  repositoryName: 'test-repo',
  targetRepoPath: '/repos/target', worktreeBase: '/repos/.worktrees',
  triggerTag: 'agent implement', blockedTag: 'agent-blocked', needInputTag: 'need-input',
  pollIntervalMinutes: 5, concurrency: 1, maxRevisions: 3, maxRejectCycles: 3,
  coderMaxTurns: 80, testAuthorMaxTurns: 50,
  maxCostUsdPerWi: 5.00, stageTimeoutMs: {},
  claudeModel: 'm', stateDir: '.state', logDir: 'logs', assignedToFilter: [],
  continiaCliPath: '.tools/continia.exe',
  continiaEnvProfileId: 'prof-1',
  continiaEnvLocalization: 'base',
  continiaApiToken: 'tok',
  continiaAppPaths: ['App'],
  continiaTestAppPaths: ['App'],
  maxTestFixAttempts: 2,
  continiaTestTimeoutS: 600,
  dryRun: false,
  skipBuildTest: false, testSelection: 'all', maxTestCodeunits: 0, costLogPath: '.state/cost-ledger.jsonl',
};

const FIXED_NOW = new Date('2026-07-07T10:00:00.000Z');

const worktree: WorktreeContext = {
  path: '/repos/.worktrees/wi-101-fix-login',
  branch: 'agent/wi-101-fix-login',
  baseSha: 'abc123',
};

function makeState(overrides: Partial<PipelineState> = {}): PipelineState {
  return {
    workItemId: 101,
    slug: 'fix-login',
    startedAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    currentStage: 'env-provision',
    history: [],
    outputs: { worktree },
    ...overrides,
  };
}

function makeCtx() {
  return {
    config: baseConfig,
    logger: createLogger(),
    abortFlag: { aborted: false },
    signal: new AbortController().signal,
    now: () => FIXED_NOW,
  };
}

type CliMocks = {
  [K in keyof ContiniaCli]: ReturnType<typeof mock>;
};

function makeCli(overrides: Partial<Record<keyof ContiniaCli, unknown>> = {}): ContiniaCli & CliMocks {
  const created: EnvironmentInfo = { id: 'env-9', name: 'wi-101-fix-login', status: 'Draft', url: 'https://bc/env-9' };
  const cli = {
    createEnvironment: mock(async () => created),
    listProfileVersions: mock(async () => ['16.0.0.0', '28.1.0.0', '28.5.0.0', '29.0.0.0']),
    listProfiles: mock(async () => [
      { id: 'prof-29-base', bcVersion: '29.0.0.0', localization: 'base', description: 'BASE BC 29.0', isEnabled: true },
      { id: 'prof-29-dk', bcVersion: '29.0.0.0', localization: 'dk', description: 'DK BC 29.0', isEnabled: true },
    ]),
    startEnvironment: mock(async () => {}),
    getEnvironment: mock(async () => created),
    waitForRunning: mock(async () => ({ ...created, status: 'Running' })),
    installDependencies: mock(async () => ({ skippedCount: 0, symbolsMissingCount: 0 })),
    installAppById: mock(async () => {}),
    downloadSymbols: mock(async () => {}),
    deployApp: mock(async () => []),
    runTests: mock(async () => ({ status: 'completed', passed: true, summary: { total: 0, passed: 0, failed: 0, skipped: 0 }, tests: [] })),
    ...overrides,
  };
  return cli as unknown as ContiniaCli & CliMocks;
}

const appsAt = (...versions: string[]): (() => AlApp[]) =>
  () => versions.map((v, i) => ({ dir: `app${i}`, name: `App${i}`, dependencies: [], application: v, platform: v }));

describe('createEnvProvisionStage', () => {
  it('fresh run: creates + starts the env, persists outputs.environment, never polls', async () => {
    const cli = makeCli();
    const stage = createEnvProvisionStage({
      config: baseConfig, continiaCli: cli, logger: createLogger(), discoverAlApps: () => [],
    });
    const result = await stage.execute(makeState(), makeCtx());

    expect(cli.createEnvironment).toHaveBeenCalledTimes(1);
    const [name, profileId] = cli.createEnvironment.mock.calls[0] as unknown as [string, string];
    expect(name).toBe('wi-101-fix-login');
    expect(profileId).toBe('prof-1');
    expect(cli.startEnvironment).toHaveBeenCalledTimes(1);
    expect(cli.waitForRunning).not.toHaveBeenCalled();

    const env = result.outputs.environment as EnvironmentOutput;
    expect(env.envId).toBe('env-9');
    expect(env.name).toBe('wi-101-fix-login');
    expect(env.url).toBe('https://bc/env-9');
    expect(env.createdAt).toBe(FIXED_NOW.toISOString());
  });

  it('truncates the env name to 40 chars for very long slugs', async () => {
    const cli = makeCli();
    const stage = createEnvProvisionStage({
      config: baseConfig, continiaCli: cli, logger: createLogger(), discoverAlApps: () => [],
    });
    await stage.execute(
      makeState({ slug: 'a-very-long-slug-that-goes-on-and-on-and-on-forever' }),
      makeCtx(),
    );
    const [name] = cli.createEnvironment.mock.calls[0] as unknown as [string];
    expect(name.length).toBeLessThanOrEqual(40);
    expect(name.startsWith('wi-101-')).toBe(true);
  });

  it('reuses a persisted env that still exists; refreshes status/url; no create', async () => {
    const persisted: EnvironmentOutput = {
      envId: 'env-9', name: 'wi-101-fix-login', status: 'Starting', createdAt: '2026-07-06T00:00:00Z',
    };
    const cli = makeCli({
      getEnvironment: mock(async () => ({ id: 'env-9', status: 'Running', url: 'https://bc/env-9' })),
    });
    const stage = createEnvProvisionStage({
      config: baseConfig, continiaCli: cli, logger: createLogger(), discoverAlApps: () => [],
    });
    const state = makeState({ outputs: { worktree, environment: persisted } });
    const result = await stage.execute(state, makeCtx());

    expect(cli.createEnvironment).not.toHaveBeenCalled();
    expect(cli.startEnvironment).not.toHaveBeenCalled(); // already Running
    const env = result.outputs.environment as EnvironmentOutput;
    expect(env.envId).toBe('env-9');
    expect(env.status).toBe('Running');
    expect(env.url).toBe('https://bc/env-9');
  });

  it('starts a reused env that is not yet started (Draft/Stopped)', async () => {
    const persisted: EnvironmentOutput = {
      envId: 'env-9', name: 'n', status: 'Draft', createdAt: '2026-07-06T00:00:00Z',
    };
    const cli = makeCli({
      getEnvironment: mock(async () => ({ id: 'env-9', status: 'Stopped' })),
    });
    const stage = createEnvProvisionStage({
      config: baseConfig, continiaCli: cli, logger: createLogger(), discoverAlApps: () => [],
    });
    await stage.execute(makeState({ outputs: { worktree, environment: persisted } }), makeCtx());
    expect(cli.startEnvironment).toHaveBeenCalledTimes(1);
  });

  it('recreates when the persisted env no longer resolves', async () => {
    const persisted: EnvironmentOutput = {
      envId: 'env-gone', name: 'n', status: 'Running', createdAt: '2026-07-06T00:00:00Z',
    };
    const cli = makeCli({
      getEnvironment: mock(async () => {
        throw new ContiniaCliError('no such environment', [], 3, '', 'no such environment');
      }),
    });
    const stage = createEnvProvisionStage({
      config: baseConfig, continiaCli: cli, logger: createLogger(), discoverAlApps: () => [],
    });
    const result = await stage.execute(makeState({ outputs: { worktree, environment: persisted } }), makeCtx());

    expect(cli.createEnvironment).toHaveBeenCalledTimes(1);
    expect((result.outputs.environment as EnvironmentOutput).envId).toBe('env-9');
  });

  it('throws when the worktree output is missing', async () => {
    const stage = createEnvProvisionStage({ config: baseConfig, continiaCli: makeCli(), logger: createLogger() });
    await expect(stage.execute(makeState({ outputs: {} }), makeCtx())).rejects.toThrow(/worktree/);
  });
});

describe('createEnvProvisionStage — BC profile derivation', () => {
  const derivingConfig: AppConfig = { ...baseConfig, continiaEnvProfileId: '', continiaEnvLocalization: 'base' };

  it('derives the profile from the worktree app.json versions', async () => {
    const cli = makeCli();
    const stage = createEnvProvisionStage({
      config: derivingConfig, continiaCli: cli, logger: createLogger(),
      discoverAlApps: appsAt('29.0.0.0'),
    });

    await stage.execute(makeState(), makeCtx());

    expect(cli.listProfiles).toHaveBeenCalledWith('29.0.0.0', expect.anything());
    const [, profileId] = cli.createEnvironment.mock.calls[0] as unknown as [string, string];
    expect(profileId).toBe('prof-29-base');
  });

  it('takes the highest version declared across all apps', async () => {
    const cli = makeCli();
    const stage = createEnvProvisionStage({
      config: derivingConfig, continiaCli: cli, logger: createLogger(),
      discoverAlApps: appsAt('28.1.0.0', '29.0.0.0', '28.5.0.0'),
    });

    await stage.execute(makeState(), makeCtx());

    expect(cli.listProfiles).toHaveBeenCalledWith('29.0.0.0', expect.anything());
  });

  it('picks the lowest published version that satisfies when there is no exact match', async () => {
    const cli = makeCli({ listProfileVersions: mock(async () => ['28.5.0.0', '29.1.0.0', '30.0.0.0']) });
    const stage = createEnvProvisionStage({
      config: derivingConfig, continiaCli: cli, logger: createLogger(),
      discoverAlApps: appsAt('29.0.0.0'),
    });

    await stage.execute(makeState(), makeCtx());

    expect(cli.listProfiles).toHaveBeenCalledWith('29.1.0.0', expect.anything());
  });

  it('honours CONTINIA_ENV_LOCALIZATION', async () => {
    const cli = makeCli();
    const stage = createEnvProvisionStage({
      config: { ...derivingConfig, continiaEnvLocalization: 'dk' },
      continiaCli: cli, logger: createLogger(), discoverAlApps: appsAt('29.0.0.0'),
    });

    await stage.execute(makeState(), makeCtx());

    const [, profileId] = cli.createEnvironment.mock.calls[0] as unknown as [string, string];
    expect(profileId).toBe('prof-29-dk');
  });

  it('throws when no published version satisfies the requirement', async () => {
    const cli = makeCli({ listProfileVersions: mock(async () => ['28.1.0.0']) });
    const stage = createEnvProvisionStage({
      config: derivingConfig, continiaCli: cli, logger: createLogger(),
      discoverAlApps: appsAt('29.0.0.0'),
    });

    await expect(stage.execute(makeState(), makeCtx())).rejects.toThrow(/29\.0\.0\.0.*28\.1\.0\.0/s);
    expect(cli.createEnvironment).not.toHaveBeenCalled();
  });

  it('throws naming the available localizations when the configured one is absent', async () => {
    const cli = makeCli();
    const stage = createEnvProvisionStage({
      config: { ...derivingConfig, continiaEnvLocalization: 'cz' },
      continiaCli: cli, logger: createLogger(), discoverAlApps: appsAt('29.0.0.0'),
    });

    await expect(stage.execute(makeState(), makeCtx())).rejects.toThrow(/cz.*base, dk/s);
    expect(cli.createEnvironment).not.toHaveBeenCalled();
  });

  it('skips disabled profiles', async () => {
    const cli = makeCli({
      listProfiles: mock(async () => [
        { id: 'prof-off', bcVersion: '29.0.0.0', localization: 'base', isEnabled: false },
        { id: 'prof-on', bcVersion: '29.0.0.0', localization: 'base', isEnabled: true },
      ]),
    });
    const stage = createEnvProvisionStage({
      config: derivingConfig, continiaCli: cli, logger: createLogger(),
      discoverAlApps: appsAt('29.0.0.0'),
    });

    await stage.execute(makeState(), makeCtx());

    const [, profileId] = cli.createEnvironment.mock.calls[0] as unknown as [string, string];
    expect(profileId).toBe('prof-on');
  });

  it('throws when no manifest declares a version and no pin is set', async () => {
    const cli = makeCli();
    const stage = createEnvProvisionStage({
      config: derivingConfig, continiaCli: cli, logger: createLogger(),
      discoverAlApps: () => [],
    });

    await expect(stage.execute(makeState(), makeCtx())).rejects.toThrow(/application.*platform/s);
  });

  // The derived path is the DEFAULT path, so "correct by construction" is not
  // a thing it gets to claim: `--bc-version` is a server-side filter, and the
  // catalogue rows are the same third-party CLI output everything else here
  // re-checks.
  it('rejects catalogue rows whose bcVersion does not satisfy the requirement', async () => {
    const cli = makeCli({
      listProfiles: mock(async () => [
        // What an unfiltered / mis-filtered `--bc-version 29.0.0.0` looks like:
        // a 28.1 row in the requested localization, which the localization
        // match alone would happily pick.
        { id: 'prof-28-base', bcVersion: '28.1.0.0', localization: 'base', isEnabled: true },
        { id: 'prof-29-dk', bcVersion: '29.0.0.0', localization: 'dk', isEnabled: true },
      ]),
    });
    const stage = createEnvProvisionStage({
      config: derivingConfig, continiaCli: cli, logger: createLogger(),
      discoverAlApps: appsAt('29.0.0.0'),
    });

    await expect(stage.execute(makeState(), makeCtx())).rejects.toThrow(/base/);
    expect(cli.createEnvironment).not.toHaveBeenCalled();
  });

  it('rejects catalogue rows carrying no bcVersion at all', async () => {
    const cli = makeCli({
      listProfiles: mock(async () => [{ id: 'prof-mystery', localization: 'base', isEnabled: true }]),
    });
    const stage = createEnvProvisionStage({
      config: derivingConfig, continiaCli: cli, logger: createLogger(),
      discoverAlApps: appsAt('29.0.0.0'),
    });

    await expect(stage.execute(makeState(), makeCtx())).rejects.toThrow(/base/);
    expect(cli.createEnvironment).not.toHaveBeenCalled();
  });

  it('picks deterministically and warns when a version/localization pair publishes several profiles', async () => {
    const warnings: string[] = [];
    const logger = { ...createLogger(), warn: (m: string) => { warnings.push(m); } };
    const cli = makeCli({
      listProfiles: mock(async () => [
        { id: 'prof-zz', bcVersion: '29.0.0.0', localization: 'base', isEnabled: true },
        { id: 'prof-aa', bcVersion: '29.0.0.0', localization: 'base', isEnabled: true },
      ]),
    });
    const stage = createEnvProvisionStage({
      config: derivingConfig, continiaCli: cli, logger, discoverAlApps: appsAt('29.0.0.0'),
    });

    await stage.execute(makeState(), makeCtx());

    const [, profileId] = cli.createEnvironment.mock.calls[0] as unknown as [string, string];
    expect(profileId).toBe('prof-aa');
    expect(warnings.some((w) => /2 enabled 'base' profiles/.test(w))).toBe(true);
  });

  it('validates the environment the DERIVED profile produced, naming the profile', async () => {
    const cli = makeCli({
      getEnvironment: mock(async () => ({ id: 'env-9', status: 'Draft', bcVersion: '28.1.0.0' })),
    });
    const stage = createEnvProvisionStage({
      config: derivingConfig, continiaCli: cli, logger: createLogger(),
      discoverAlApps: appsAt('29.0.0.0'),
    });

    await expect(stage.execute(makeState(), makeCtx())).rejects.toThrow(
      /derived profile prof-29-base.*28\.1\.0\.0.*29\.0\.0\.0/s,
    );
    expect(cli.getEnvironment).toHaveBeenCalledTimes(1);
  });

  it('warns rather than silently passing when the created environment reports no BC version', async () => {
    const warnings: string[] = [];
    const logger = { ...createLogger(), warn: (m: string) => { warnings.push(m); } };
    const cli = makeCli();
    const stage = createEnvProvisionStage({
      config: derivingConfig, continiaCli: cli, logger, discoverAlApps: appsAt('29.0.0.0'),
    });

    await stage.execute(makeState(), makeCtx());

    expect(cli.getEnvironment).toHaveBeenCalledTimes(1);
    expect(warnings.some((w) => /reports no BC version/.test(w))).toBe(true);
  });
});

describe('createEnvProvisionStage — the pin as an override', () => {
  it('creates from the pin without querying profiles', async () => {
    const cli = makeCli({ getEnvironment: mock(async () => ({ id: 'env-9', status: 'Draft', bcVersion: '29.0.0.0' })) });
    const stage = createEnvProvisionStage({
      config: baseConfig, continiaCli: cli, logger: createLogger(),
      discoverAlApps: appsAt('29.0.0.0'),
    });

    await stage.execute(makeState(), makeCtx());

    expect(cli.listProfileVersions).not.toHaveBeenCalled();
    const [, profileId] = cli.createEnvironment.mock.calls[0] as unknown as [string, string];
    expect(profileId).toBe('prof-1');
  });

  it('throws when the pinned profile produces an environment below the requirement', async () => {
    const cli = makeCli({ getEnvironment: mock(async () => ({ id: 'env-9', status: 'Draft', bcVersion: '28.1.0.0' })) });
    const stage = createEnvProvisionStage({
      config: baseConfig, continiaCli: cli, logger: createLogger(),
      discoverAlApps: appsAt('29.0.0.0'),
    });

    await expect(stage.execute(makeState(), makeCtx())).rejects.toThrow(/28\.1\.0\.0.*29\.0\.0\.0.*CONTINIA_ENV_PROFILE_ID/s);
  });

  it('creates from the pin unvalidated when no manifest declares a version', async () => {
    const cli = makeCli();
    const stage = createEnvProvisionStage({
      config: baseConfig, continiaCli: cli, logger: createLogger(),
      discoverAlApps: () => [],
    });

    const result = await stage.execute(makeState(), makeCtx());

    expect((result.outputs.environment as EnvironmentOutput).envId).toBe('env-9');
    // "Unvalidated" is the claim in the title; this is what makes it an
    // assertion. The post-create check is the only thing that calls
    // `env get` on a freshly created environment.
    expect(cli.getEnvironment).not.toHaveBeenCalled();
  });
});

describe('createEnvProvisionStage — persisted environment validation', () => {
  const persisted: EnvironmentOutput = {
    envId: 'env-old', name: 'wi-101-fix-login', status: 'Stopped',
    url: 'https://bc/env-old', createdAt: '2026-01-01T00:00:00Z', bcVersion: '28.1.0.0',
  };

  it('recreates a persisted environment whose BC version no longer satisfies', async () => {
    // Per-id, because the post-create check now calls `env get` on the NEW
    // environment too: a flat mock would report the stale 28.1 for both.
    const cli = makeCli({
      getEnvironment: mock(async (envId: string) =>
        envId === 'env-old'
          ? { id: 'env-old', status: 'Stopped', bcVersion: '28.1.0.0' }
          : { id: envId, status: 'Draft', bcVersion: '29.0.0.0' },
      ),
    });
    const stage = createEnvProvisionStage({
      config: { ...baseConfig, continiaEnvProfileId: '' }, continiaCli: cli, logger: createLogger(),
      discoverAlApps: appsAt('29.0.0.0'),
    });

    const result = await stage.execute(makeState({ outputs: { worktree, environment: persisted } }), makeCtx());

    expect(cli.createEnvironment).toHaveBeenCalledTimes(1);
    expect((result.outputs.environment as EnvironmentOutput).envId).toBe('env-9');
  });

  it('reuses a persisted environment that still satisfies', async () => {
    const cli = makeCli({ getEnvironment: mock(async () => ({ id: 'env-old', status: 'Running', bcVersion: '29.0.0.0' })) });
    const stage = createEnvProvisionStage({
      config: { ...baseConfig, continiaEnvProfileId: '' }, continiaCli: cli, logger: createLogger(),
      discoverAlApps: appsAt('29.0.0.0'),
    });

    const result = await stage.execute(
      makeState({ outputs: { worktree, environment: { ...persisted, bcVersion: '29.0.0.0' } } }),
      makeCtx(),
    );

    expect(cli.createEnvironment).not.toHaveBeenCalled();
    expect((result.outputs.environment as EnvironmentOutput).envId).toBe('env-old');
  });

  // The path that can reproduce the original $33 defect with no new evidence:
  // `env get` omits bcVersion (Stopped/Draft envs, an older CLI, a renamed
  // field) and every state file written before this plan carries none either.
  // A comparison that cannot be made must not read as "reuse it".
  it('recreates when the persisted environment version cannot be established at all', async () => {
    const warnings: string[] = [];
    const logger = { ...createLogger(), warn: (m: string) => { warnings.push(m); } };
    const cli = makeCli({ getEnvironment: mock(async () => ({ id: 'env-old', status: 'Running' })) });
    const stage = createEnvProvisionStage({
      config: { ...baseConfig, continiaEnvProfileId: '' }, continiaCli: cli, logger,
      discoverAlApps: appsAt('29.0.0.0'),
    });

    const { bcVersion: _dropped, ...noVersion } = persisted;
    const result = await stage.execute(
      makeState({ outputs: { worktree, environment: noVersion } }),
      makeCtx(),
    );

    expect(cli.createEnvironment).toHaveBeenCalledTimes(1);
    expect((result.outputs.environment as EnvironmentOutput).envId).toBe('env-9');
    expect(warnings.some((w) => /could not be established/.test(w))).toBe(true);
  });

  it('falls back to the persisted bcVersion when env get omits it', async () => {
    const cli = makeCli({ getEnvironment: mock(async () => ({ id: 'env-old', status: 'Running' })) });
    const stage = createEnvProvisionStage({
      config: { ...baseConfig, continiaEnvProfileId: '' }, continiaCli: cli, logger: createLogger(),
      discoverAlApps: appsAt('29.0.0.0'),
    });

    const result = await stage.execute(
      makeState({ outputs: { worktree, environment: { ...persisted, bcVersion: '29.0.0.0' } } }),
      makeCtx(),
    );

    expect(cli.createEnvironment).not.toHaveBeenCalled();
    expect((result.outputs.environment as EnvironmentOutput).envId).toBe('env-old');
  });

  it('reuses unvalidated when the requirement cannot be derived', async () => {
    const cli = makeCli({ getEnvironment: mock(async () => ({ id: 'env-old', status: 'Running', bcVersion: '28.1.0.0' })) });
    const stage = createEnvProvisionStage({
      config: baseConfig, continiaCli: cli, logger: createLogger(), discoverAlApps: () => [],
    });

    const result = await stage.execute(makeState({ outputs: { worktree, environment: persisted } }), makeCtx());

    expect(cli.createEnvironment).not.toHaveBeenCalled();
    expect((result.outputs.environment as EnvironmentOutput).envId).toBe('env-old');
  });
});

describe('resolveRequiredBcVersion', () => {
  const app = (over: Partial<AlApp>): AlApp => ({ dir: 'a', name: 'A', dependencies: [], ...over });

  // The stage fixtures set application === platform, so these two asymmetric
  // cases are the only thing stopping an implementation that reads one field
  // and silently drops the other.
  it('takes platform when it outranks application', () => {
    expect(resolveRequiredBcVersion([app({ application: '28.1.0.0', platform: '29.0.0.0' })])).toBe('29.0.0.0');
  });

  it('takes application when it outranks platform', () => {
    expect(resolveRequiredBcVersion([app({ application: '29.0.0.0', platform: '28.1.0.0' })])).toBe('29.0.0.0');
  });

  it('spans both fields across several apps', () => {
    expect(
      resolveRequiredBcVersion([
        app({ dir: 'a', application: '28.1.0.0' }),
        app({ dir: 'b', platform: '29.2.0.0' }),
        app({ dir: 'c', application: '28.5.0.0', platform: '26.0.0.0' }),
      ]),
    ).toBe('29.2.0.0');
  });

  it('compares numerically, not lexically', () => {
    expect(resolveRequiredBcVersion([app({ application: '9.0.0.0', platform: '29.0.0.0' })])).toBe('29.0.0.0');
  });

  it('is undefined when nothing declares either field', () => {
    expect(resolveRequiredBcVersion([app({}), app({ dir: 'b' })])).toBeUndefined();
    expect(resolveRequiredBcVersion([])).toBeUndefined();
  });
});
