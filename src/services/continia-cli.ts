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

/**
 * Continia Core Internal Activation App. Must be installed on a fresh
 * environment before agents can interact with it. `deps install-by-id` is
 * idempotent server-side (skips when already installed) and pulls a prebuilt
 * .app matching the env's BC version — no local compile.
 */
export const ACTIVATION_APP_ID = 'c3755ece-dab0-4d16-987d-040661f18522';

/** Counts from a `deps install` round. Catalogue misses land in `skipped`
 * with exit 0 — invisible unless surfaced; symbol gaps become compile errors. */
export interface DepsInstallInfo {
  skippedCount: number;
  symbolsMissingCount: number;
}

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

/**
 * One environment login returned by `continia env users --json`.
 *
 * These are short-lived DemoPortal sandbox credentials, shared knowledge on the
 * team — the PR description is where reviewers expect them (see the
 * `fw-create-pr` skill). They are still kept out of git history, the pipeline
 * state file, and every log line: fetched at PR-creation time and used once.
 */
export interface EnvironmentUser {
  username: string;
  password?: string;
  isAdmin: boolean;
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
  installDependencies(envId: string, appPathRel: string, opts: ContiniaCallOpts): Promise<DepsInstallInfo>;
  installAppById(envId: string, appId: string, opts: ContiniaCallOpts): Promise<void>;
  downloadSymbols(envId: string, appPathRel: string, opts: ContiniaCallOpts): Promise<void>;
  deployApp(envId: string, appPathRel: string, opts: ContiniaCallOpts): Promise<DeployAppResult[]>;
  runTests(
    envId: string,
    codeunitId: number,
    opts: ContiniaCallOpts & { timeoutSeconds?: number },
  ): Promise<TestRunResult>;
  /** Logins for an environment. Works regardless of environment status. */
  getEnvironmentUsers(envId: string, opts: ContiniaCallOpts): Promise<EnvironmentUser[]>;
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

/**
 * Deliberately permissive: the CLI's exact field names for users are not pinned
 * anywhere, so match every spelling the `fw-start` skill tells operators to try
 * rather than throwing on an unexpected shape.
 */
const environmentUserSchema = z
  .object({
    username: z.string().optional(),
    userName: z.string().optional(),
    name: z.string().optional(),
    email: z.string().optional(),
    password: z.string().optional(),
    role: z.string().optional(),
    isAdmin: z.boolean().optional(),
    admin: z.boolean().optional(),
    permissions: z.union([z.string(), z.array(z.string())]).optional(),
  })
  .passthrough();

const environmentUsersSchema = z.union([
  z.array(environmentUserSchema),
  z.object({ users: z.array(environmentUserSchema).default([]) }).passthrough(),
]);

const depsInstallSchema = z
  .object({
    skipped: z.array(z.unknown()).default([]),
    symbolsMissing: z.array(z.unknown()).default([]),
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

// `summary` and `tests` are REQUIRED, with required counters: lenient defaults
// here green-wash a red run (a renamed `summary.failed` would default to 0 and
// make `passed` come out true). Unknown EXTRA fields still pass through.
const testRunSchema = z
  .object({
    status: z.string().default('unknown'),
    summary: z
      .object({
        total: z.number(),
        passed: z.number(),
        failed: z.number(),
        skipped: z.number().default(0),
        durationSeconds: z.number().optional(),
        codeunitName: z.string().optional(),
      })
      .passthrough(),
    tests: z.array(
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
    ),
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
      const raw = await runJson(['deps', 'install', envId, appPathRel, '--json'], opts);
      const parsed = depsInstallSchema.parse(raw ?? {});
      return {
        skippedCount: parsed.skipped.length,
        symbolsMissingCount: parsed.symbolsMissing.length,
      };
    },

    async installAppById(envId, appId, opts) {
      await runJson(['deps', 'install-by-id', envId, appId, '--json'], opts);
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
      const shape = testRunSchema.safeParse(raw);
      if (!shape.success) {
        throw new ContiniaCliError(
          `continia ${args.join(' ')} returned an unexpected test-result shape ` +
            `(refusing to guess pass/fail): missing/invalid ${shape.error.issues
              .map((i) => i.path.join('.'))
              .join(', ')}`,
          result.argv,
          result.exitCode,
          result.stdout,
          result.stderr,
        );
      }
      const parsed = shape.data;
      return {
        status: parsed.status,
        // Derived, not trusted from the CLI: green means zero failures.
        passed: parsed.summary.failed === 0,
        summary: parsed.summary,
        tests: parsed.tests,
      };
    },

    async getEnvironmentUsers(envId, opts) {
      const args = ['env', 'users', envId, '--json'];
      const raw = await runJson(args, opts);
      const shape = environmentUsersSchema.safeParse(raw ?? []);
      // Never throw: the env block is optional decoration on a PR that already
      // exists. An unexpected shape degrades to "no credentials", not a failure.
      if (!shape.success) return [];
      const rows = Array.isArray(shape.data) ? shape.data : shape.data.users;

      return rows
        .map((u) => {
          const username = u.username ?? u.userName ?? u.name ?? u.email;
          if (!username) return undefined;
          const perms = Array.isArray(u.permissions)
            ? u.permissions.join(',')
            : (u.permissions ?? '');
          const isAdmin =
            u.isAdmin === true ||
            u.admin === true ||
            (u.role ?? '').toLowerCase() === 'admin' ||
            perms.toLowerCase().includes('admin');
          const out: EnvironmentUser = { username, isAdmin };
          if (u.password !== undefined) out.password = u.password;
          return out;
        })
        .filter((u): u is EnvironmentUser => u !== undefined);
    },
  };
}

/**
 * Pick the login to publish in a PR description: an admin if one is
 * identifiable, otherwise the first user (matching the `fw-start` skill's
 * documented fallback). Undefined when there is nothing usable.
 */
export function pickAdminUser(users: EnvironmentUser[]): EnvironmentUser | undefined {
  return users.find((u) => u.isAdmin) ?? users[0];
}
