import { describe, it, expect } from 'bun:test';
import { resolve, join } from 'path';
import {
  createContiniaCli,
  ContiniaCliError,
  CONTINIA_TOKEN_ENV_VAR,
  DEFAULT_TEST_RUN_TIMEOUT_S,
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
  dryRun: false,
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

  describe('deployApp', () => {
    it('deploys with --workspace-root and --allow-downgrade from the worktree root; never --with-deps or --all', async () => {
      const { cli, calls } = makeCli([
        ok('[{"app":"Continia_Core","compiled":true,"published":true}]'),
      ]);
      const result = await cli.deployApp('env-1', 'Core/Cloud', opts);
      const call = calls[0]!;
      expect(call.cwd).toBe(WORKTREE);
      expect(call.argv.slice(1)).toEqual([
        'deploy', 'env-1', 'Core/Cloud', '--workspace-root', 'Core/Cloud', '--allow-downgrade', '--json',
      ]);
      expect(call.argv).not.toContain('--with-deps');
      expect(call.argv).not.toContain('--all');
      expect(result).toEqual([{ app: 'Continia_Core', compiled: true, published: true }]);
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
