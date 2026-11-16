import { z } from 'zod';
import { loadConfig } from '../config/index.ts';
import type { AppConfig } from '../types/index.ts';
import { NINJA_MAX_ASSIGN_ATTEMPTS, type NinjaGitIdentity } from './ninja.ts';

export interface PrFixConfig {
  app: AppConfig;
  maxConflictCommits: number;
  maxConflictFiles: number;
  resolverMaxTurns: number;
  /** Renumber AL object IDs that collide after the rebase (`PRFIX_RENUMBER_COLLISIONS`). */
  renumberCollisions: boolean;
  /** How to launch the Object ID Ninja MCP server (`NINJA_MCP_COMMAND`). */
  ninjaCommand: { command: string; args: string[] };
  /** Per-tool-call timeout for the Ninja MCP server (`NINJA_CALL_TIMEOUT_MS`). */
  ninjaCallTimeoutMs: number;
  /**
   * The git identity the Ninja server reports (`NINJA_GIT_EMAIL` /
   * `NINJA_GIT_NAME`); the backend authorizes by that email. Unset: the server
   * reads the git config it finds, as before.
   */
  ninjaGitIdentity?: NinjaGitIdentity;
}

const DEFAULT_NINJA_MCP_COMMAND = 'npx -y @vjeko.com/al-object-id-ninja-mcp@1.0.2';

// Same semantics as the app config's boolFlag: blank means the default.
const boolFlag = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v.trim() === '') return defaultValue;
      return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
    });

const knobSchema = z.object({
  PRFIX_MAX_CONFLICT_COMMITS: z.coerce.number().int().positive().default(3),
  PRFIX_MAX_CONFLICT_FILES: z.coerce.number().int().positive().default(10),
  REBASE_RESOLVER_MAX_TURNS: z.coerce.number().int().positive().default(40),
  PRFIX_RENUMBER_COLLISIONS: boolFlag(true),
  NINJA_MCP_COMMAND: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? DEFAULT_NINJA_MCP_COMMAND : v)),
  NINJA_CALL_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  NINJA_GIT_EMAIL: z.string().optional().transform((v) => v?.trim() || undefined),
  NINJA_GIT_NAME: z.string().optional().transform((v) => v?.trim() || undefined),
});

/**
 * Split `NINJA_MCP_COMMAND` on whitespace. On Windows `npx` is a `.cmd` shim
 * that a shell-less spawn cannot run, so the command goes through `cmd /c`.
 */
export function splitNinjaCommand(raw: string, platform: NodeJS.Platform): { command: string; args: string[] } {
  const parts = raw.trim().split(/\s+/).filter((p) => p !== '');
  const [command = '', ...args] = platform === 'win32' ? ['cmd', '/c', ...parts] : parts;
  return { command, args };
}

const REBASE_PER_COMMIT_BUDGET_MS = 1_800_000;
const RENUMBER_MIN_BUDGET_MS = 300_000;

function explicitMs(env: Record<string, string | undefined>, key: string): number | undefined {
  const raw = env[key]?.trim();
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * The full pipeline's config for `fix-pr`: no verification fix loop (the PR is
 * rebased, not rewritten), the bot identity required, and timeouts for the
 * fix-pr stages. Explicit STAGE_TIMEOUT_MS_* values win over these defaults.
 */
export function loadPrFixConfig(env: Record<string, string | undefined>): PrFixConfig {
  const app = loadConfig(env);
  const knobs = knobSchema.safeParse(env);
  if (!knobs.success) {
    const messages = knobs.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${messages}`);
  }
  const k = knobs.data;
  const missing = [
    ['BOT_GIT_NAME', app.botGitName],
    ['BOT_GIT_EMAIL', app.botGitEmail],
  ]
    .filter(([, v]) => !v)
    .map(([key]) => key);
  if (missing.length > 0) {
    throw new Error(`Invalid configuration:\n${missing.map((key) => `  - ${key}: required for fix-pr`).join('\n')}`);
  }
  if (k.NINJA_GIT_NAME && !k.NINJA_GIT_EMAIL) {
    throw new Error('Invalid configuration:\n  - NINJA_GIT_EMAIL: required when NINJA_GIT_NAME is set');
  }
  app.maxTestFixAttempts = 0;
  app.stageTimeoutMs = {
    ...app.stageTimeoutMs,
    'pr-intake': explicitMs(env, 'STAGE_TIMEOUT_MS_PR_INTAKE') ?? 120_000,
    'pr-worktree': explicitMs(env, 'STAGE_TIMEOUT_MS_PR_WORKTREE') ?? 300_000,
    'rebase-onto-target':
      explicitMs(env, 'STAGE_TIMEOUT_MS_REBASE_ONTO_TARGET') ??
      (k.PRFIX_MAX_CONFLICT_COMMITS + 1) * REBASE_PER_COMMIT_BUDGET_MS,
    // Every assign attempt may take a full call timeout, and the first `npx -y`
    // connect alone can take up to 120s; never less than 5 minutes.
    'renumber-collisions':
      explicitMs(env, 'STAGE_TIMEOUT_MS_RENUMBER_COLLISIONS') ??
      Math.max(RENUMBER_MIN_BUDGET_MS, 2 * k.NINJA_CALL_TIMEOUT_MS * NINJA_MAX_ASSIGN_ATTEMPTS),
    'push-rebased': explicitMs(env, 'STAGE_TIMEOUT_MS_PUSH_REBASED') ?? 300_000,
    'pr-comment': explicitMs(env, 'STAGE_TIMEOUT_MS_PR_COMMENT') ?? 120_000,
  };
  return {
    app,
    maxConflictCommits: k.PRFIX_MAX_CONFLICT_COMMITS,
    maxConflictFiles: k.PRFIX_MAX_CONFLICT_FILES,
    resolverMaxTurns: k.REBASE_RESOLVER_MAX_TURNS,
    renumberCollisions: k.PRFIX_RENUMBER_COLLISIONS,
    ninjaCommand: splitNinjaCommand(k.NINJA_MCP_COMMAND, process.platform),
    ninjaCallTimeoutMs: k.NINJA_CALL_TIMEOUT_MS,
    ...(k.NINJA_GIT_EMAIL
      ? { ninjaGitIdentity: { email: k.NINJA_GIT_EMAIL, ...(k.NINJA_GIT_NAME ? { name: k.NINJA_GIT_NAME } : {}) } }
      : {}),
  };
}
