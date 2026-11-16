import { z } from 'zod';
import { loadConfig } from '../config/index.ts';
import type { AppConfig } from '../types/index.ts';

export interface PrFixConfig {
  app: AppConfig;
  maxConflictCommits: number;
  maxConflictFiles: number;
  resolverMaxTurns: number;
}

const knobSchema = z.object({
  PRFIX_MAX_CONFLICT_COMMITS: z.coerce.number().int().positive().default(3),
  PRFIX_MAX_CONFLICT_FILES: z.coerce.number().int().positive().default(10),
  REBASE_RESOLVER_MAX_TURNS: z.coerce.number().int().positive().default(40),
});

const REBASE_PER_COMMIT_BUDGET_MS = 1_800_000;

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
  app.maxTestFixAttempts = 0;
  app.stageTimeoutMs = {
    ...app.stageTimeoutMs,
    'pr-intake': explicitMs(env, 'STAGE_TIMEOUT_MS_PR_INTAKE') ?? 120_000,
    'pr-worktree': explicitMs(env, 'STAGE_TIMEOUT_MS_PR_WORKTREE') ?? 300_000,
    'rebase-onto-target':
      explicitMs(env, 'STAGE_TIMEOUT_MS_REBASE_ONTO_TARGET') ??
      (k.PRFIX_MAX_CONFLICT_COMMITS + 1) * REBASE_PER_COMMIT_BUDGET_MS,
    'push-rebased': explicitMs(env, 'STAGE_TIMEOUT_MS_PUSH_REBASED') ?? 300_000,
    'pr-comment': explicitMs(env, 'STAGE_TIMEOUT_MS_PR_COMMENT') ?? 120_000,
  };
  return {
    app,
    maxConflictCommits: k.PRFIX_MAX_CONFLICT_COMMITS,
    maxConflictFiles: k.PRFIX_MAX_CONFLICT_FILES,
    resolverMaxTurns: k.REBASE_RESOLVER_MAX_TURNS,
  };
}
