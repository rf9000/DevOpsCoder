import { isAbsolute, resolve } from 'path';
import { z } from 'zod';
import type { AppConfig, DeployAppResult, TestCaseResult } from '../types/index.ts';

/**
 * Env-var name the spawned Continia CLI reads its DemoPortal token from.
 * Confirmed against ADONewDirectCombuilder: headless runs authenticate from
 * CONTINIA_API_TOKEN in the process environment (the interactive CLI falls
 * back to the VS Code setting `environment-explorer.api-token`).
 */
export const CONTINIA_TOKEN_ENV_VAR = 'CONTINIA_API_TOKEN';

/** Per-`test run` --timeout (seconds). The stage wall-clock is the real backstop. */
export const DEFAULT_TEST_RUN_TIMEOUT_S = 600;

export class ContiniaCliError extends Error {
  override readonly name = 'ContiniaCliError';
  constructor(
    message: string,
    public readonly command: string[],
    public readonly exitCode: number,
    public readonly stdout: string,
    public readonly stderr: string,
  ) {
    super(message);
  }
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type ExecFn = (
  argv: string[],
  opts: { cwd: string; env: Record<string, string | undefined>; signal?: AbortSignal },
) => Promise<ExecResult>;

export interface EnvironmentInfo {
  id: string;
  name?: string;
  status: string;
  url?: string;
}

export interface TestRunResult {
  status: string;
  passed: boolean;
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    durationSeconds?: number;
    codeunitName?: string;
  };
  tests: TestCaseResult[];
}

export interface ContiniaCallOpts {
  /** Per-WI worktree; relative continiaCliPath and app paths resolve against it. */
  worktreePath: string;
  signal?: AbortSignal;
}

export interface ContiniaCli {
  createEnvironment(name: string, profileId: string, opts: ContiniaCallOpts): Promise<EnvironmentInfo>;
  startEnvironment(envId: string, opts: ContiniaCallOpts): Promise<void>;
  getEnvironment(envId: string, opts: ContiniaCallOpts): Promise<EnvironmentInfo>;
  waitForRunning(
    envId: string,
    opts: ContiniaCallOpts & { pollIntervalMs?: number; maxWaitMs?: number },
  ): Promise<EnvironmentInfo>;
  installDependencies(envId: string, appPathRel: string, opts: ContiniaCallOpts): Promise<void>;
  downloadSymbols(envId: string, appPathRel: string, opts: ContiniaCallOpts): Promise<void>;
  deployApp(envId: string, appPathRel: string, opts: ContiniaCallOpts): Promise<DeployAppResult[]>;
  runTests(
    envId: string,
    codeunitId: number,
    opts: ContiniaCallOpts & { timeoutSeconds?: number },
  ): Promise<TestRunResult>;
}

export interface ContiniaCliDeps {
  config: AppConfig;
  /** Test override; default wraps Bun.spawn. */
  exec?: ExecFn;
  /** Test override for waitForRunning's poll delay. */
  sleep?: (ms: number) => Promise<void>;
}

// Lenient schemas: unknown CLI fields must never break us — the exact JSON
// field names are confirmed against the real exe on the first smoke run.
const environmentInfoSchema = z
  .object({
    id: z.string().optional(),
    envId: z.string().optional(),
    environmentId: z.string().optional(),
    name: z.string().optional(),
    status: z.string().optional(),
    url: z.string().optional(),
    webUrl: z.string().optional(),
  })
  .passthrough();

const deployResultSchema = z.array(
  z
    .object({
      app: z.string().default('(unknown app)'),
      compiled: z.boolean().default(false),
      published: z.boolean().default(false),
      error: z.string().optional(),
    })
    .passthrough(),
);

const testRunSchema = z
  .object({
    status: z.string().default('unknown'),
    summary: z
      .object({
        total: z.number().default(0),
        passed: z.number().default(0),
        failed: z.number().default(0),
        skipped: z.number().default(0),
        durationSeconds: z.number().optional(),
        codeunitName: z.string().optional(),
      })
      .passthrough(),
    tests: z
      .array(
        z
          .object({
            name: z.string().default('(unnamed test)'),
            fullName: z.string().optional(),
            result: z.string().default('unknown'),
            durationSeconds: z.number().optional(),
            errorMessage: z.string().optional(),
            stackTrace: z.string().optional(),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();

async function defaultExec(
  argv: string[],
  opts: { cwd: string; env: Record<string, string | undefined>; signal?: AbortSignal },
): Promise<ExecResult> {
  const proc = Bun.spawn(argv, {
    cwd: opts.cwd,
    env: opts.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const onAbort = () => proc.kill();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createContiniaCli(deps: ContiniaCliDeps): ContiniaCli {
  const exec = deps.exec ?? defaultExec;
  const sleep = deps.sleep ?? defaultSleep;
  const { config } = deps;

  function resolveExe(worktreePath: string): string {
    return isAbsolute(config.continiaCliPath)
      ? config.continiaCliPath
      : resolve(worktreePath, config.continiaCliPath);
  }

  async function run(
    args: string[],
    opts: ContiniaCallOpts,
    cwd?: string,
  ): Promise<ExecResult & { argv: string[] }> {
    const argv = [resolveExe(opts.worktreePath), ...args];
    try {
      const result = await exec(argv, {
        cwd: cwd ?? opts.worktreePath,
        env: { ...process.env, [CONTINIA_TOKEN_ENV_VAR]: config.continiaApiToken },
        signal: opts.signal,
      });
      return { ...result, argv };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ContiniaCliError(
        `continia ${args.join(' ')} failed (spawn error): ${message}`,
        argv,
        -1,
        '',
        '',
      );
    }
  }

  function assertZeroExit(args: string[], result: ExecResult & { argv: string[] }): void {
    if (result.exitCode !== 0) {
      throw new ContiniaCliError(
        `continia ${args.join(' ')} failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`,
        result.argv,
        result.exitCode,
        result.stdout,
        result.stderr,
      );
    }
  }

  function parseJson(args: string[], result: ExecResult & { argv: string[] }): unknown {
    try {
      return JSON.parse(result.stdout);
    } catch {
      throw new ContiniaCliError(
        `continia ${args.join(' ')} returned invalid JSON: ${result.stdout.slice(0, 500)}`,
        result.argv,
        result.exitCode,
        result.stdout,
        result.stderr,
      );
    }
  }

  function toEnvironmentInfo(args: string[], raw: unknown, result: ExecResult & { argv: string[] }): EnvironmentInfo {
    const parsed = environmentInfoSchema.parse(raw ?? {});
    const id = parsed.id ?? parsed.envId ?? parsed.environmentId;
    if (!id) {
      throw new ContiniaCliError(
        `continia ${args.join(' ')} returned no environment id: ${result.stdout.slice(0, 500)}`,
        result.argv,
        result.exitCode,
        result.stdout,
        result.stderr,
      );
    }
    return {
      id,
      name: parsed.name,
      status: parsed.status ?? 'unknown',
      url: parsed.url ?? parsed.webUrl,
    };
  }

  async function runJson(args: string[], opts: ContiniaCallOpts, cwd?: string): Promise<unknown> {
    const result = await run(args, opts, cwd);
    assertZeroExit(args, result);
    return parseJson(args, result);
  }

  return {
    async createEnvironment(name, profileId, opts) {
      const args = ['env', 'create', '--name', name, '--profile', profileId, '--json'];
      const result = await run(args, opts);
      assertZeroExit(args, result);
      return toEnvironmentInfo(args, parseJson(args, result), result);
    },

    async startEnvironment(envId, opts) {
      const args = ['env', 'start', envId];
      const result = await run(args, opts);
      assertZeroExit(args, result);
    },

    async getEnvironment(envId, opts) {
      const args = ['env', 'get', envId, '--json'];
      const result = await run(args, opts);
      assertZeroExit(args, result);
      return toEnvironmentInfo(args, parseJson(args, result), result);
    },

    async waitForRunning(envId, opts) {
      const pollIntervalMs = opts.pollIntervalMs ?? 10_000;
      const maxWaitMs = opts.maxWaitMs ?? 600_000;
      let waitedMs = 0;
      // First check is immediate; the poll delay accrues between checks.
      for (;;) {
        if (opts.signal?.aborted) {
          throw new ContiniaCliError(
            `continia env get ${envId} aborted while waiting for Running`,
            [],
            -1,
            '',
            '',
          );
        }
        const env = await this.getEnvironment(envId, opts);
        if (env.status === 'Running') return env;
        if (env.status === 'Failed') {
          throw new ContiniaCliError(
            `environment ${envId} entered status Failed while waiting for Running`,
            [],
            -1,
            '',
            '',
          );
        }
        if (waitedMs >= maxWaitMs) {
          throw new ContiniaCliError(
            `environment ${envId} did not reach Running within ${maxWaitMs}ms (last status: ${env.status})`,
            [],
            -1,
            '',
            '',
          );
        }
        await sleep(pollIntervalMs);
        waitedMs += pollIntervalMs;
      }
    },

    async installDependencies(envId, appPathRel, opts) {
      await runJson(['deps', 'install', envId, appPathRel, '--json'], opts);
    },

    async downloadSymbols(envId, appPathRel, opts) {
      await runJson(['deps', 'download', envId, appPathRel, '--json'], opts);
    },

    async deployApp(envId, appPathRel, opts) {
      // Invocation contract per the sibling's continia-deploy skill:
      // --workspace-root scopes app discovery to the app itself so sibling
      // dependency source dirs are not recompiled; --allow-downgrade lets a
      // branch build (e.g. 29.0.0.0) replace a higher CI baseline, which BC
      // otherwise refuses (conflict: "higher-version-installed").
      // --with-deps is deliberately NOT used: it recompiles dependency apps
      // from source — slow, and it fails when their own deps aren't staged.
      const args = [
        'deploy', envId, appPathRel,
        '--workspace-root', appPathRel,
        '--allow-downgrade', '--json',
      ];
      const raw = await runJson(args, opts);
      return deployResultSchema.parse(raw) as DeployAppResult[];
    },

    async runTests(envId, codeunitId, opts) {
      const timeoutSeconds = opts.timeoutSeconds ?? DEFAULT_TEST_RUN_TIMEOUT_S;
      const args = [
        'test', 'run', envId, String(codeunitId),
        '--timeout', String(timeoutSeconds), '--json',
      ];
      const result = await run(args, opts);
      // The CLI exits 1 when tests FAIL — a red run is a valid result, not an
      // infra error. Try to parse stdout first; only fall back to the exit-code
      // error path when there is no parseable JSON.
      let raw: unknown;
      try {
        raw = JSON.parse(result.stdout);
      } catch {
        assertZeroExit(args, result);
        throw new ContiniaCliError(
          `continia ${args.join(' ')} returned invalid JSON: ${result.stdout.slice(0, 500)}`,
          result.argv,
          result.exitCode,
          result.stdout,
          result.stderr,
        );
      }
      const parsed = testRunSchema.parse(raw);
      return {
        status: parsed.status,
        // Derived, not trusted from the CLI: green means zero failures.
        passed: parsed.summary.failed === 0,
        summary: parsed.summary,
        tests: parsed.tests,
      };
    },
  };
}
