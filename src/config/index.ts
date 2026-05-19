import { z } from 'zod';
import type { AppConfig } from '../types/index.ts';

const envSchema = z.object({
  AZURE_DEVOPS_PAT: z.string().min(1, 'AZURE_DEVOPS_PAT is required'),
  AZURE_DEVOPS_ORG: z.string().min(1, 'AZURE_DEVOPS_ORG is required'),
  AZURE_DEVOPS_PROJECT: z.string().min(1, 'AZURE_DEVOPS_PROJECT is required'),
  ADO_REPOSITORY_NAME: z.string().min(1, 'ADO_REPOSITORY_NAME is required'),
  TARGET_REPO_PATH: z.string().min(1, 'TARGET_REPO_PATH is required'),
  WORKTREE_BASE: z.string().min(1, 'WORKTREE_BASE is required'),
  TRIGGER_TAG: z.string().default('agent implement'),
  BLOCKED_TAG: z.string().default('agent-blocked'),
  NEED_INPUT_TAG: z.string().default('need-input'),
  POLL_INTERVAL_MINUTES: z.coerce.number().default(5),
  CONCURRENCY: z.coerce.number().default(1),
  MAX_REVISIONS: z.coerce.number().default(3),
  MAX_REJECT_CYCLES: z.coerce.number().default(3),
  CODER_MAX_TURNS: z.coerce.number().default(80),
  TEST_AUTHOR_MAX_TURNS: z.coerce.number().default(50),
  MAX_COST_USD_PER_WI: z.coerce.number().positive('MAX_COST_USD_PER_WI must be > 0'),
  STAGE_TIMEOUT_MS_ANALYZER: z.coerce.number().int().positive().default(300000),
  STAGE_TIMEOUT_MS_CODER: z.coerce.number().int().positive().default(1800000),
  STAGE_TIMEOUT_MS_REVIEWER: z.coerce.number().int().positive().default(900000),
  STAGE_TIMEOUT_MS_TEST_AUTHOR: z.coerce.number().int().positive().default(1200000),
  STAGE_TIMEOUT_MS_DRAFT_PR_CREATOR: z.coerce.number().int().positive().default(120000),
  STAGE_TIMEOUT_MS_WORKTREE_SETUP: z.coerce.number().int().positive().default(60000),
  STAGE_TIMEOUT_MS_WORKTREE_TEARDOWN: z.coerce.number().int().positive().default(60000),
  CLAUDE_MODEL: z.string().default('claude-opus-4-7'),
  STATE_DIR: z.string().default('.state'),
  ASSIGNED_TO_FILTER: z.string().optional(),
});

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): AppConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const messages = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${messages}`);
  }
  const p = result.data;

  const assignedToFilter = p.ASSIGNED_TO_FILTER
    ? p.ASSIGNED_TO_FILTER.split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : [];

  return {
    org: p.AZURE_DEVOPS_ORG,
    orgUrl: `https://dev.azure.com/${p.AZURE_DEVOPS_ORG}`,
    project: p.AZURE_DEVOPS_PROJECT,
    pat: p.AZURE_DEVOPS_PAT,
    repositoryName: p.ADO_REPOSITORY_NAME,
    targetRepoPath: p.TARGET_REPO_PATH,
    worktreeBase: p.WORKTREE_BASE,
    triggerTag: p.TRIGGER_TAG,
    blockedTag: p.BLOCKED_TAG,
    needInputTag: p.NEED_INPUT_TAG,
    pollIntervalMinutes: p.POLL_INTERVAL_MINUTES,
    concurrency: p.CONCURRENCY,
    maxRevisions: p.MAX_REVISIONS,
    maxRejectCycles: p.MAX_REJECT_CYCLES,
    coderMaxTurns: p.CODER_MAX_TURNS,
    testAuthorMaxTurns: p.TEST_AUTHOR_MAX_TURNS,
    maxCostUsdPerWi: p.MAX_COST_USD_PER_WI,
    stageTimeoutMs: {
      'analyzer': p.STAGE_TIMEOUT_MS_ANALYZER,
      'worktree-setup': p.STAGE_TIMEOUT_MS_WORKTREE_SETUP,
      'coder': p.STAGE_TIMEOUT_MS_CODER,
      'reviewer': p.STAGE_TIMEOUT_MS_REVIEWER,
      'test-author': p.STAGE_TIMEOUT_MS_TEST_AUTHOR,
      'draft-pr-creator': p.STAGE_TIMEOUT_MS_DRAFT_PR_CREATOR,
      'worktree-teardown': p.STAGE_TIMEOUT_MS_WORKTREE_TEARDOWN,
    },
    claudeModel: p.CLAUDE_MODEL,
    stateDir: p.STATE_DIR,
    assignedToFilter,
    dryRun: false,
  };
}
