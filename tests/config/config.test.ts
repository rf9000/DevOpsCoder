import { describe, it, expect } from 'bun:test';
import { loadConfig } from '../../src/config/index.ts';

const validEnv: Record<string, string> = {
  AZURE_DEVOPS_PAT: 'test-pat',
  AZURE_DEVOPS_ORG: 'my-org',
  AZURE_DEVOPS_PROJECT: 'my-project',
  ADO_REPOSITORY_NAME: 'test-repo',
  TARGET_REPO_PATH: '/repos/continia-banking',
  WORKTREE_BASE: '/repos/.worktrees',
  MAX_COST_USD_PER_WI: '5.00',
};

describe('loadConfig', () => {
  it('returns AppConfig for a valid env', () => {
    const config = loadConfig(validEnv);
    expect(config.pat).toBe('test-pat');
    expect(config.org).toBe('my-org');
    expect(config.orgUrl).toBe('https://dev.azure.com/my-org');
    expect(config.project).toBe('my-project');
    expect(config.targetRepoPath).toBe('/repos/continia-banking');
    expect(config.worktreeBase).toBe('/repos/.worktrees');
  });

  it('applies defaults to optional fields', () => {
    const config = loadConfig(validEnv);
    expect(config.triggerTag).toBe('agent implement');
    expect(config.blockedTag).toBe('agent-blocked');
    expect(config.needInputTag).toBe('need-input');
    expect(config.pollIntervalMinutes).toBe(5);
    expect(config.concurrency).toBe(1);
    expect(config.maxRevisions).toBe(3);
    expect(config.maxRejectCycles).toBe(3);
    expect(config.claudeModel).toBe('claude-opus-4-7');
    expect(config.stateDir).toBe('.state');
    expect(config.assignedToFilter).toEqual([]);
    expect(config.dryRun).toBe(false);
  });

  it('throws a descriptive error when AZURE_DEVOPS_PAT is missing', () => {
    const env = { ...validEnv };
    delete env.AZURE_DEVOPS_PAT;
    expect(() => loadConfig(env)).toThrow(/AZURE_DEVOPS_PAT/);
    expect(() => loadConfig(env)).toThrow(/Invalid configuration/);
  });

  it('throws when WORKTREE_BASE is missing', () => {
    const env = { ...validEnv };
    delete env.WORKTREE_BASE;
    expect(() => loadConfig(env)).toThrow(/WORKTREE_BASE/);
  });

  it('coerces numeric env vars from strings', () => {
    const config = loadConfig({
      ...validEnv,
      POLL_INTERVAL_MINUTES: '10',
      CONCURRENCY: '3',
      MAX_REVISIONS: '5',
      MAX_REJECT_CYCLES: '7',
    });
    expect(config.pollIntervalMinutes).toBe(10);
    expect(config.concurrency).toBe(3);
    expect(config.maxRevisions).toBe(5);
    expect(config.maxRejectCycles).toBe(7);
  });

  it('parses ASSIGNED_TO_FILTER as comma-separated list with trim', () => {
    const config = loadConfig({
      ...validEnv,
      ASSIGNED_TO_FILTER: 'Alice Smith, Bob Jones ,Carol',
    });
    expect(config.assignedToFilter).toEqual(['Alice Smith', 'Bob Jones', 'Carol']);
  });

  it('returns empty assignedToFilter when env var is empty string', () => {
    const config = loadConfig({ ...validEnv, ASSIGNED_TO_FILTER: '' });
    expect(config.assignedToFilter).toEqual([]);
  });

  it('honours custom tag overrides', () => {
    const config = loadConfig({
      ...validEnv,
      TRIGGER_TAG: 'do-it',
      BLOCKED_TAG: 'stuck',
      NEED_INPUT_TAG: 'help',
    });
    expect(config.triggerTag).toBe('do-it');
    expect(config.blockedTag).toBe('stuck');
    expect(config.needInputTag).toBe('help');
  });

  it('coderMaxTurns and testAuthorMaxTurns default when env vars are absent', () => {
    const config = loadConfig(validEnv);
    expect(config.coderMaxTurns).toBe(80);
    expect(config.testAuthorMaxTurns).toBe(50);
  });

  it('coderMaxTurns and testAuthorMaxTurns coerce from string env vars', () => {
    const config = loadConfig({
      ...validEnv,
      CODER_MAX_TURNS: '120',
      TEST_AUTHOR_MAX_TURNS: '40',
    });
    expect(config.coderMaxTurns).toBe(120);
    expect(config.testAuthorMaxTurns).toBe(40);
  });

  it('throws a descriptive error when ADO_REPOSITORY_NAME is missing', () => {
    const env = { ...validEnv };
    delete env.ADO_REPOSITORY_NAME;
    expect(() => loadConfig(env)).toThrow(/ADO_REPOSITORY_NAME/);
    expect(() => loadConfig(env)).toThrow(/Invalid configuration/);
  });

  it('maps ADO_REPOSITORY_NAME to repositoryName', () => {
    const config = loadConfig({ ...validEnv, ADO_REPOSITORY_NAME: 'test-repo' });
    expect(config.repositoryName).toBe('test-repo');
  });

  it('throws when MAX_COST_USD_PER_WI is missing', () => {
    const env = { ...validEnv };
    delete env.MAX_COST_USD_PER_WI;
    expect(() => loadConfig(env)).toThrow(/MAX_COST_USD_PER_WI/);
    expect(() => loadConfig(env)).toThrow(/Invalid configuration/);
  });

  it('maps MAX_COST_USD_PER_WI to config.maxCostUsdPerWi', () => {
    const config = loadConfig({ ...validEnv, MAX_COST_USD_PER_WI: '5.00' });
    expect(config.maxCostUsdPerWi).toBe(5);
  });

  it('defaults all seven STAGE_TIMEOUT_MS_* when env vars are absent', () => {
    const config = loadConfig(validEnv);
    expect(config.stageTimeoutMs['analyzer']).toBe(300000);
    expect(config.stageTimeoutMs['worktree-setup']).toBe(60000);
    expect(config.stageTimeoutMs['coder']).toBe(1800000);
    expect(config.stageTimeoutMs['reviewer']).toBe(900000);
    expect(config.stageTimeoutMs['test-author']).toBe(1200000);
    expect(config.stageTimeoutMs['draft-pr-creator']).toBe(120000);
    expect(config.stageTimeoutMs['worktree-teardown']).toBe(60000);
  });
});
