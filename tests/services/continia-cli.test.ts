import { describe, it, expect } from 'bun:test';
import { resolve, join } from 'path';
import {
  createContiniaCli,
  ContiniaCliError,
  CONTINIA_TOKEN_ENV_VAR,
  DEFAULT_TEST_RUN_TIMEOUT_S,
  ACTIVATION_APP_ID,
  pickAdminUser,
  type ExecFn,
  type ExecResult,
} from '../../src/services/continia-cli.ts';
import type { AppConfig } from '../../src/types/index.ts';

const baseConfig: AppConfig = {
  orgUrl: 'https://x', project: 'p', pat: 't',
  repositoryName: 'test-repo',
  targetRepoPath: '/repos/target', worktreeBase: '/repos/.worktrees',
  triggerTag: 'agent implement', blockedTag: 'agent-blocked', needInputTag: 'need-input',
  pollIntervalMinutes: 5, concurrency: 1, maxRevisions: 3, maxRejectCycles: 3,
  coderMaxTurns: 80, testAuthorMaxTurns: 50,
  maxCostUsdPerWi: 5.00, stageTimeoutMs: {},
  claudeModel: 'm', stateDir: '.state', assignedToFilter: [],
  continiaCliPath: '.tools/continia.exe',
  continiaEnvProfileId: 'prof-1',
  continiaApiToken: 'secret-token',
  continiaAppPaths: ['Core/Cloud'],
  continiaTestAppPaths: ['Core/Cloud'],
  maxTestFixAttempts: 2,
  continiaTestTimeoutS: 600,
  dryRun: false,
  skipBuildTest: false, testSelection: 'all', maxTestCodeunits: 0, costLogPath: '.state/cost-ledger.jsonl',
};

const WORKTREE = resolve('/repos/.worktrees/wi-101-fix');

interface RecordedCall {
  argv: string[];
  cwd: string;
  env: Record<string, string | undefined>;
}

/** Exec mock that pops queued results (or throws queued Errors) per call. */
function makeExec(results: Array<ExecResult | Error>) {
  const calls: RecordedCall[] = [];
  const exec: ExecFn = async (argv, opts) => {
    calls.push({ argv, cwd: opts.cwd, env: opts.env });
    const next = results.shift();
    if (next === undefined) throw new Error('exec mock exhausted');
    if (next instanceof Error) throw next;
    return next;
  };
  return { exec, calls };
}

const ok = (stdout: string): ExecResult => ({ exitCode: 0, stdout, stderr: '' });

function makeCli(results: Array<ExecResult | Error>, config: AppConfig = baseConfig) {
  const { exec, calls } = makeExec(results);
  const sleeps: number[] = [];
  const cli = createContiniaCli({
    config,
    exec,
    sleep: async (ms) => { sleeps.push(ms); },
  });
  return { cli, calls, sleeps };
}

const opts = { worktreePath: WORKTREE };

describe('createContiniaCli', () => {
  it('resolves a relative CONTINIA_CLI_PATH against the worktree', async () => {
    const { cli, calls } = makeCli([ok('{"id":"env-1","status":"Draft"}')]);
    await cli.createEnvironment('wi-101-fix', 'prof-1', opts);
    expect(calls[0]?.argv[0]).toBe(resolve(WORKTREE, '.tools/continia.exe'));
  });

  it('uses an absolute CONTINIA_CLI_PATH as-is', async () => {
    const abs = resolve('/opt/continia/continia.exe');
    const { cli, calls } = makeCli(
      [ok('{"id":"env-1","status":"Draft"}')],
      { ...baseConfig, continiaCliPath: abs },
    );
    await cli.createEnvironment('n', 'p', opts);
    expect(calls[0]?.argv[0]).toBe(abs);
  });

  it('forwards the API token into the spawned process env', async () => {
    const { cli, calls } = makeCli([ok('{"id":"env-1","status":"Draft"}')]);
    await cli.createEnvironment('n', 'p', opts);
    expect(calls[0]?.env[CONTINIA_TOKEN_ENV_VAR]).toBe('secret-token');
  });

  it('createEnvironment builds the right argv and parses id/name/status', async () => {
    const { cli, calls } = makeCli([
      ok('{"id":"env-9","name":"wi-101","status":"Draft","url":"https://bc/env-9"}'),
    ]);
    const env = await cli.createEnvironment('wi-101', 'prof-1', opts);
    expect(calls[0]?.argv.slice(1)).toEqual([
      'env', 'create', '--name', 'wi-101', '--profile', 'prof-1', '--json',
    ]);
    expect(calls[0]?.cwd).toBe(WORKTREE);
    expect(env).toEqual({ id: 'env-9', name: 'wi-101', status: 'Draft', url: 'https://bc/env-9' });
  });

  it('accepts envId as an alternative id field name (lenient parsing)', async () => {
    const { cli } = makeCli([ok('{"envId":"env-2","status":"Draft"}')]);
    const env = await cli.createEnvironment('n', 'p', opts);
    expect(env.id).toBe('env-2');
  });

  it('startEnvironment is fire-and-forget (no JSON parsing)', async () => {
    const { cli, calls } = makeCli([ok('Starting environment env-1...')]);
    await cli.startEnvironment('env-1', opts);
    expect(calls[0]?.argv.slice(1)).toEqual(['env', 'start', 'env-1']);
  });

  it('throws ContiniaCliError with stderr on non-zero exit of a non-test command', async () => {
    const { cli } = makeCli([{ exitCode: 3, stdout: '', stderr: 'no such environment' }]);
    let caught: unknown;
    try {
      await cli.getEnvironment('env-x', opts);
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(ContiniaCliError);
    expect((caught as ContiniaCliError).exitCode).toBe(3);
    expect((caught as ContiniaCliError).message).toContain('no such environment');
  });

  it('wraps a spawn failure as ContiniaCliError with exitCode -1', async () => {
    const { cli } = makeCli([new Error('ENOENT')]);
    let caught: unknown;
    try {
      await cli.getEnvironment('env-x', opts);
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(ContiniaCliError);
    expect((caught as ContiniaCliError).exitCode).toBe(-1);
    expect((caught as ContiniaCliError).message).toContain('ENOENT');
  });

  it('throws ContiniaCliError on invalid JSON from a JSON command', async () => {
    const { cli } = makeCli([ok('this is not json')]);
    await expect(cli.getEnvironment('env-x', opts)).rejects.toThrow(/invalid JSON/);
  });

  it('installDependencies and downloadSymbols use deps subcommands from the worktree', async () => {
    const { cli, calls } = makeCli([ok('{}'), ok('{}')]);
    await cli.installDependencies('env-1', 'Core/Cloud', opts);
    await cli.downloadSymbols('env-1', 'Core/Cloud', opts);
    expect(calls[0]?.argv.slice(1)).toEqual(['deps', 'install', 'env-1', 'Core/Cloud', '--json']);
    expect(calls[1]?.argv.slice(1)).toEqual(['deps', 'download', 'env-1', 'Core/Cloud', '--json']);
    expect(calls[0]?.cwd).toBe(WORKTREE);
  });

  it('installAppById uses deps install-by-id with the app GUID', async () => {
    const { cli, calls } = makeCli([ok('{}')]);
    await cli.installAppById('env-1', ACTIVATION_APP_ID, opts);
    expect(calls[0]?.argv.slice(1)).toEqual([
      'deps', 'install-by-id', 'env-1', ACTIVATION_APP_ID, '--json',
    ]);
  });

  it('installDependencies surfaces skipped deps and symbol gaps as counts', async () => {
    const { cli } = makeCli([
      ok('{"installed":["A"],"skipped":[{"id":"B"}],"symbolsMissing":["C","D"]}'),
    ]);
    const info = await cli.installDependencies('env-1', 'Core/Cloud', opts);
    expect(info).toEqual({ skippedCount: 1, symbolsMissingCount: 2 });
  });

  it('installDependencies returns zero counts when the CLI omits the arrays', async () => {
    const { cli } = makeCli([ok('{}')]);
    const info = await cli.installDependencies('env-1', 'Core/Cloud', opts);
    expect(info).toEqual({ skippedCount: 0, symbolsMissingCount: 0 });
  });

  describe('deployApp', () => {
    it('deploys one absolute app path with --allow-downgrade from the worktree root; never --workspace-root, --with-deps or --all', async () => {
      const { cli, calls } = makeCli([
        ok('[{"app":"Continia_Core","compiled":true,"published":true}]'),
      ]);
      const result = await cli.deployApp('env-1', 'Core/Cloud', opts);
      const call = calls[0]!;
      const absApp = resolve(WORKTREE, 'Core/Cloud');
      expect(call.cwd).toBe(WORKTREE);
      expect(call.argv.slice(1)).toEqual([
        'deploy', 'env-1', absApp, '--allow-downgrade', '--json',
      ]);
      expect(call.argv).not.toContain('--workspace-root');
      expect(call.argv).not.toContain('--with-deps');
      expect(call.argv).not.toContain('--all');
      expect(result).toEqual([{ app: 'Continia_Core', compiled: true, published: true }]);
    });

    // The CLI resolves the positional appPath against --workspace-root (default
    // cwd), so the same relative path in both slots was joined onto itself
    // ("permission-sets/permission-sets" -> "No app.json found").
    it('never emits a path whose app segment is doubled onto the workspace root', async () => {
      const { cli, calls } = makeCli([ok('[]')]);
      await cli.deployApp('env-1', 'permission-sets', opts);
      const argv = calls[0]!.argv;
      for (const arg of argv.slice(1)) {
        expect(arg).not.toContain(join('permission-sets', 'permission-sets'));
      }
      expect(argv).toContain(resolve(WORKTREE, 'permission-sets'));
    });

    it('passes an already-absolute app path through unchanged', async () => {
      const { cli, calls } = makeCli([ok('[]')]);
      const abs = resolve(WORKTREE, 'Core/Cloud');
      await cli.deployApp('env-1', abs, opts);
      expect(calls[0]!.argv.slice(1)).toEqual([
        'deploy', 'env-1', abs, '--allow-downgrade', '--json',
      ]);
    });

    it('a result entry with an error is a valid result, not an exception', async () => {
      const { cli } = makeCli([
        ok('[{"app":"X","compiled":false,"published":false,"error":"AL0118: missing symbol"}]'),
      ]);
      const result = await cli.deployApp('env-1', 'Core/Cloud', opts);
      expect(result[0]?.compiled).toBe(false);
      expect(result[0]?.error).toContain('AL0118');
    });
  });

  describe('runTests', () => {
    const redRun = JSON.stringify({
      status: 'completed',
      passed: false,
      summary: { total: 3, passed: 2, failed: 1, skipped: 0, codeunitName: 'CDO Tests' },
      tests: [
        { name: 'A', result: 'Pass' },
        { name: 'B', result: 'Pass' },
        { name: 'C', result: 'Fail', errorMessage: 'boom', stackTrace: 'Codeunit 70001 line 5' },
      ],
    });

    it('refuses to guess pass/fail when summary is missing (no silent green)', async () => {
      const { cli } = makeCli([ok('{"status":"completed","tests":[]}')]);
      await expect(cli.runTests('env-1', 148001, opts)).rejects.toThrow(
        /unexpected test-result shape/,
      );
    });

    it('refuses to guess pass/fail when summary.failed is missing', async () => {
      // A renamed counter field must be a hard error, not a default-0 pass.
      const { cli } = makeCli([
        ok('{"status":"completed","summary":{"total":2,"passed":1,"failures":1},"tests":[]}'),
      ]);
      await expect(cli.runTests('env-1', 148001, opts)).rejects.toThrow(
        /unexpected test-result shape/,
      );
    });

    it('refuses to guess when the tests array is missing', async () => {
      const { cli } = makeCli([
        ok('{"status":"completed","summary":{"total":1,"passed":0,"failed":1,"skipped":0}}'),
      ]);
      await expect(cli.runTests('env-1', 148001, opts)).rejects.toThrow(
        /unexpected test-result shape/,
      );
    });

    it('parses valid JSON even when the CLI exits 1 (red tests are results, not errors)', async () => {
      const { cli } = makeCli([{ exitCode: 1, stdout: redRun, stderr: '' }]);
      const run = await cli.runTests('env-1', 148001, opts);
      expect(run.passed).toBe(false);
      expect(run.summary.failed).toBe(1);
      expect(run.tests[2]?.errorMessage).toBe('boom');
    });

    it('derives passed from summary.failed, not the CLI passed field', async () => {
      const green = JSON.stringify({
        status: 'completed',
        summary: { total: 2, passed: 2, failed: 0, skipped: 0 },
        tests: [],
      });
      const { cli } = makeCli([ok(green)]);
      const run = await cli.runTests('env-1', 148001, opts);
      expect(run.passed).toBe(true);
    });

    it('includes the codeunit id and default --timeout in argv', async () => {
      const { cli, calls } = makeCli([ok('{"status":"completed","summary":{"total":0,"passed":0,"failed":0,"skipped":0},"tests":[]}')]);
      await cli.runTests('env-1', 148001, opts);
      expect(calls[0]?.argv.slice(1)).toEqual([
        'test', 'run', 'env-1', '148001', '--timeout', String(DEFAULT_TEST_RUN_TIMEOUT_S), '--json',
      ]);
    });

    it('non-JSON stdout on exit 1 is an error (infra failure, not a red run)', async () => {
      const { cli } = makeCli([{ exitCode: 1, stdout: 'connection refused', stderr: '' }]);
      await expect(cli.runTests('env-1', 148001, opts)).rejects.toThrow(ContiniaCliError);
    });
  });

  describe('waitForRunning', () => {
    const envJson = (status: string) => ok(`{"id":"env-1","status":"${status}"}`);

    it('polls until status is Running', async () => {
      const { cli, calls, sleeps } = makeCli([
        envJson('Starting'), envJson('Starting'), envJson('Running'),
      ]);
      const env = await cli.waitForRunning('env-1', { ...opts, pollIntervalMs: 10_000 });
      expect(env.status).toBe('Running');
      expect(calls).toHaveLength(3);
      expect(sleeps).toEqual([10_000, 10_000]);
    });

    it('throws when maxWaitMs elapses before Running', async () => {
      const results = Array.from({ length: 10 }, () => envJson('Starting'));
      const { cli } = makeCli(results);
      await expect(
        cli.waitForRunning('env-1', { ...opts, pollIntervalMs: 10_000, maxWaitMs: 25_000 }),
      ).rejects.toThrow(/did not reach Running/);
    });

    it('throws immediately on a Failed status', async () => {
      const { cli } = makeCli([envJson('Failed')]);
      await expect(cli.waitForRunning('env-1', opts)).rejects.toThrow(/Failed/);
    });

    it('throws when the abort signal fires', async () => {
      const ctrl = new AbortController();
      ctrl.abort('timeout');
      const { cli } = makeCli([envJson('Starting')]);
      await expect(
        cli.waitForRunning('env-1', { ...opts, signal: ctrl.signal }),
      ).rejects.toThrow(/abort/i);
    });
  });
});

describe('getEnvironmentUsers', () => {
  it('calls `env users <id> --json` and maps the rows', async () => {
    const { cli, calls } = makeCli([
      ok('[{"username":"Rf","password":"Rf1234!","role":"Admin"}]'),
    ]);
    const users = await cli.getEnvironmentUsers('env-9', opts);
    expect(calls[0]?.argv.slice(-4)).toEqual(['env', 'users', 'env-9', '--json']);
    expect(users).toEqual([{ username: 'Rf', password: 'Rf1234!', isAdmin: true }]);
  });

  it('accepts a { users: [...] } envelope as well as a bare array', async () => {
    const { cli } = makeCli([ok('{"users":[{"userName":"A","password":"p"}]}')]);
    expect((await cli.getEnvironmentUsers('env-9', opts))[0]?.username).toBe('A');
  });

  it('reads the username from whichever field the CLI populated', async () => {
    const { cli } = makeCli([
      ok('[{"name":"ByName"},{"email":"by@mail"},{"userName":"ByUserName"}]'),
    ]);
    const users = await cli.getEnvironmentUsers('env-9', opts);
    expect(users.map((u) => u.username)).toEqual(['ByName', 'by@mail', 'ByUserName']);
  });

  it('detects admin from any of the documented spellings', async () => {
    const { cli } = makeCli([
      ok(
        '[{"username":"a","role":"admin"},{"username":"b","isAdmin":true},' +
          '{"username":"c","admin":true},{"username":"d","permissions":["Admin","Read"]},' +
          '{"username":"e"}]',
      ),
    ]);
    const users = await cli.getEnvironmentUsers('env-9', opts);
    expect(users.map((u) => u.isAdmin)).toEqual([true, true, true, true, false]);
  });

  it('drops rows with no usable username rather than inventing one', async () => {
    const { cli } = makeCli([ok('[{"password":"orphan"},{"username":"ok"}]')]);
    const users = await cli.getEnvironmentUsers('env-9', opts);
    expect(users).toHaveLength(1);
    expect(users[0]?.username).toBe('ok');
  });

  it('returns [] for an unexpected shape — the env block is optional decoration', async () => {
    const { cli } = makeCli([ok('{"unexpected":true}')]);
    expect(await cli.getEnvironmentUsers('env-9', opts)).toEqual([]);
  });

  it('omits password when the CLI did not return one', async () => {
    const { cli } = makeCli([ok('[{"username":"NoPass"}]')]);
    const users = await cli.getEnvironmentUsers('env-9', opts);
    expect(users[0]).toEqual({ username: 'NoPass', isAdmin: false });
    expect('password' in (users[0] as object)).toBe(false);
  });
});

describe('pickAdminUser', () => {
  it('prefers an admin', () => {
    expect(
      pickAdminUser([
        { username: 'plain', isAdmin: false },
        { username: 'boss', isAdmin: true },
      ])?.username,
    ).toBe('boss');
  });

  it('falls back to the first user when no admin is identifiable', () => {
    expect(
      pickAdminUser([
        { username: 'first', isAdmin: false },
        { username: 'second', isAdmin: false },
      ])?.username,
    ).toBe('first');
  });

  it('returns undefined for an empty list', () => {
    expect(pickAdminUser([])).toBeUndefined();
  });
});
