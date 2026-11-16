import { describe, it, expect } from 'bun:test';
import { loadPrFixConfig } from '../../src/prfix/config.ts';

const env: Record<string, string> = {
  AZURE_DEVOPS_PAT: 'test-pat',
  AZURE_DEVOPS_ORG: 'my-org',
  AZURE_DEVOPS_PROJECT: 'my-project',
  ADO_REPOSITORY_NAME: 'test-repo',
  TARGET_REPO_PATH: '/repos/continia-banking',
  WORKTREE_BASE: '/repos/.worktrees',
  MAX_COST_USD_PER_WI: '5.00',
  CONTINIA_ENV_PROFILE_ID: 'profile-123',
  CONTINIA_API_TOKEN: 'tok-abc',
  BOT_GIT_NAME: 'Bot',
  BOT_GIT_EMAIL: 'bot@example.com',
};

describe('loadPrFixConfig', () => {
  it('defaults', () => {
    const c = loadPrFixConfig(env);
    expect(c.maxConflictCommits).toBe(3);
    expect(c.maxConflictFiles).toBe(10);
    expect(c.resolverMaxTurns).toBe(40);
    expect(c.app.maxTestFixAttempts).toBe(0);
  });

  it('reads PRFIX_MAX_CONFLICT_COMMITS / PRFIX_MAX_CONFLICT_FILES / REBASE_RESOLVER_MAX_TURNS', () => {
    const c = loadPrFixConfig({
      ...env,
      PRFIX_MAX_CONFLICT_COMMITS: '5',
      PRFIX_MAX_CONFLICT_FILES: '7',
      REBASE_RESOLVER_MAX_TURNS: '12',
    });
    expect(c.maxConflictCommits).toBe(5);
    expect(c.maxConflictFiles).toBe(7);
    expect(c.resolverMaxTurns).toBe(12);
  });

  it('rejects 0 and non-integers', () => {
    for (const key of ['PRFIX_MAX_CONFLICT_COMMITS', 'PRFIX_MAX_CONFLICT_FILES', 'REBASE_RESOLVER_MAX_TURNS']) {
      expect(() => loadPrFixConfig({ ...env, [key]: '0' })).toThrow(key);
      expect(() => loadPrFixConfig({ ...env, [key]: '1.5' })).toThrow(key);
    }
  });

  it('requires BOT_GIT_NAME and BOT_GIT_EMAIL', () => {
    expect(() => loadPrFixConfig({ ...env, BOT_GIT_NAME: '', BOT_GIT_EMAIL: '' })).toThrow(
      /BOT_GIT_NAME[\s\S]*BOT_GIT_EMAIL/,
    );
  });

  it('sets stage timeouts', () => {
    const t = loadPrFixConfig(env).app.stageTimeoutMs;
    expect(t['pr-intake']).toBe(120_000);
    expect(t['pr-worktree']).toBe(300_000);
    expect(t['rebase-onto-target']).toBe(4 * 1_800_000);
    expect(t['push-rebased']).toBe(300_000);
    expect(t['pr-comment']).toBe(120_000);
  });

  it('lets explicit STAGE_TIMEOUT_MS_* values win', () => {
    const t = loadPrFixConfig({
      ...env,
      STAGE_TIMEOUT_MS_PR_INTAKE: '1000',
      STAGE_TIMEOUT_MS_PR_WORKTREE: '2000',
      STAGE_TIMEOUT_MS_REBASE_ONTO_TARGET: '3000',
      STAGE_TIMEOUT_MS_PUSH_REBASED: '4000',
      STAGE_TIMEOUT_MS_PR_COMMENT: '5000',
    }).app.stageTimeoutMs;
    expect([t['pr-intake'], t['pr-worktree'], t['rebase-onto-target'], t['push-rebased'], t['pr-comment']]).toEqual([
      1000, 2000, 3000, 4000, 5000,
    ]);
  });
});
