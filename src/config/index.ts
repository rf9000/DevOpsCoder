import { z } from 'zod';
import type { AppConfig } from '../types/index.ts';

const envSchema = z.object({
  AZURE_DEVOPS_PAT: z.string().min(1, 'AZURE_DEVOPS_PAT is required'),
  AZURE_DEVOPS_ORG: z.string().min(1, 'AZURE_DEVOPS_ORG is required'),
  AZURE_DEVOPS_PROJECT: z.string().min(1, 'AZURE_DEVOPS_PROJECT is required'),
  TARGET_REPO_PATH: z.string().min(1, 'TARGET_REPO_PATH is required'),
  WORKTREE_BASE: z.string().min(1, 'WORKTREE_BASE is required'),
  TRIGGER_TAG: z.string().default('agent implement'),
  BLOCKED_TAG: z.string().default('agent-blocked'),
  NEED_INPUT_TAG: z.string().default('need-input'),
  POLL_INTERVAL_MINUTES: z.coerce.number().default(5),
  CONCURRENCY: z.coerce.number().default(1),
  MAX_REVISIONS: z.coerce.number().default(3),
  MAX_REJECT_CYCLES: z.coerce.number().default(3),
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
    targetRepoPath: p.TARGET_REPO_PATH,
    worktreeBase: p.WORKTREE_BASE,
    triggerTag: p.TRIGGER_TAG,
    blockedTag: p.BLOCKED_TAG,
    needInputTag: p.NEED_INPUT_TAG,
    pollIntervalMinutes: p.POLL_INTERVAL_MINUTES,
    concurrency: p.CONCURRENCY,
    maxRevisions: p.MAX_REVISIONS,
    maxRejectCycles: p.MAX_REJECT_CYCLES,
    claudeModel: p.CLAUDE_MODEL,
    stateDir: p.STATE_DIR,
    assignedToFilter,
    dryRun: false,
  };
}
