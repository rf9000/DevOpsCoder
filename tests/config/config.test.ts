import { describe, it, expect } from 'bun:test';
import { loadConfig } from '../../src/config/index.ts';
import {
  DEFAULT_PLAN_MAX_TURNS,
  modelFor,
  planMaxTurns,
  planModelFor,
} from '../../src/utils/model-selection.ts';

const validEnv: Record<string, string> = {
  AZURE_DEVOPS_PAT: 'test-pat',
  AZURE_DEVOPS_ORG: 'my-org',
  AZURE_DEVOPS_PROJECT: 'my-project',
  ADO_REPOSITORY_NAME: 'test-repo',
  TARGET_REPO_PATH: '/repos/continia-banking',
  WORKTREE_BASE: '/repos/.worktrees',
  MAX_COST_USD_PER_WI: '5.00',
  CONTINIA_ENV_PROFILE_ID: 'profile-123',
  CONTINIA_API_TOKEN: 'tok-abc',
  CONTINIA_APP_PATHS: 'Core/Cloud,Banking/Cloud',
};

describe('loadConfig', () => {
  it('returns AppConfig for a valid env', () => {
    const config = loadConfig(validEnv);
    expect(config.pat).toBe('test-pat');
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
    expect(config.logDir).toBe('logs');
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

  it('defaults all STAGE_TIMEOUT_MS_* when env vars are absent', () => {
    const config = loadConfig(validEnv);
    expect(config.stageTimeoutMs['analyzer']).toBe(300_000);
    expect(config.stageTimeoutMs['worktree-setup']).toBe(60_000);
    expect(config.stageTimeoutMs['test-author']).toBe(1_200_000);
    expect(config.stageTimeoutMs['draft-pr-creator']).toBe(120_000);
    expect(config.stageTimeoutMs['worktree-teardown']).toBe(60_000);
  });

  it('derives the revision-loop timeout from maxRevisions × (coder + reviewer) budgets', () => {
    const config = loadConfig(validEnv);
    // Default: 3 revisions × (30 min coder + 15 min reviewer) = 135 min.
    expect(config.stageTimeoutMs['revision-loop']).toBe(3 * (1_800_000 + 900_000));
  });

  it('derived revision-loop timeout follows overridden budgets', () => {
    const config = loadConfig({
      ...validEnv,
      MAX_REVISIONS: '2',
      STAGE_TIMEOUT_MS_CODER: '600000',
      STAGE_TIMEOUT_MS_REVIEWER: '300000',
    });
    expect(config.stageTimeoutMs['revision-loop']).toBe(2 * (600_000 + 300_000));
  });

  it('STAGE_TIMEOUT_MS_REVISION_LOOP overrides the derived default', () => {
    const config = loadConfig({
      ...validEnv,
      STAGE_TIMEOUT_MS_REVISION_LOOP: '4200000',
    });
    expect(config.stageTimeoutMs['revision-loop']).toBe(4_200_000);
  });

  it('does not expose never-enforced coder/reviewer keys in stageTimeoutMs', () => {
    // The orchestrator only times top-level stages; 'coder' and 'reviewer'
    // run nested inside 'revision-loop' and their keys were dead config.
    const config = loadConfig(validEnv);
    expect(config.stageTimeoutMs['coder']).toBeUndefined();
    expect(config.stageTimeoutMs['reviewer']).toBeUndefined();
  });

  describe('per-step model overrides', () => {
    it('no CLAUDE_MODEL_* set → every step resolves to CLAUDE_MODEL, no plan step', () => {
      const config = loadConfig({ ...validEnv, CLAUDE_MODEL: 'claude-opus-5' });
      expect(config.stepModel).toEqual({});
      for (const step of ['analyzer', 'coder', 'reviewer', 'test-author', 'test-fixer'] as const) {
        expect(modelFor(config, step)).toBe('claude-opus-5');
      }
      expect(planModelFor(config, 'coder-plan')).toBeUndefined();
      expect(planModelFor(config, 'test-author-plan')).toBeUndefined();
    });

    it('resolves each step to its own override and leaves the rest on CLAUDE_MODEL', () => {
      const config = loadConfig({
        ...validEnv,
        CLAUDE_MODEL: 'claude-sonnet-5',
        CLAUDE_MODEL_ANALYZER: 'claude-opus-5',
        CLAUDE_MODEL_REVIEWER: 'claude-opus-5',
        CLAUDE_MODEL_TEST_FIXER: 'claude-haiku-4-5',
      });
      expect(modelFor(config, 'analyzer')).toBe('claude-opus-5');
      expect(modelFor(config, 'reviewer')).toBe('claude-opus-5');
      expect(modelFor(config, 'test-fixer')).toBe('claude-haiku-4-5');
      expect(modelFor(config, 'coder')).toBe('claude-sonnet-5');
      expect(modelFor(config, 'test-author')).toBe('claude-sonnet-5');
    });

    it('CLAUDE_MODEL_PLANNING turns on both plan steps; a specific plan var wins', () => {
      const both = loadConfig({
        ...validEnv,
        CLAUDE_MODEL: 'claude-sonnet-5',
        CLAUDE_MODEL_PLANNING: 'claude-opus-5',
      });
      expect(planModelFor(both, 'coder-plan')).toBe('claude-opus-5');
      expect(planModelFor(both, 'test-author-plan')).toBe('claude-opus-5');

      const specific = loadConfig({
        ...validEnv,
        CLAUDE_MODEL_PLANNING: 'claude-opus-5',
        CLAUDE_MODEL_TEST_AUTHOR_PLAN: 'claude-sonnet-5',
      });
      expect(planModelFor(specific, 'coder-plan')).toBe('claude-opus-5');
      expect(planModelFor(specific, 'test-author-plan')).toBe('claude-sonnet-5');
    });

    it('one plan var enables only that stage plan step', () => {
      const config = loadConfig({ ...validEnv, CLAUDE_MODEL_CODER_PLAN: 'claude-opus-5' });
      expect(planModelFor(config, 'coder-plan')).toBe('claude-opus-5');
      expect(planModelFor(config, 'test-author-plan')).toBeUndefined();
    });

    it('a blank override reads as unset rather than as an empty model name', () => {
      const config = loadConfig({
        ...validEnv,
        CLAUDE_MODEL: 'claude-opus-5',
        CLAUDE_MODEL_CODER: '   ',
        CLAUDE_MODEL_PLANNING: '',
      });
      expect(config.stepModel).toEqual({});
      expect(modelFor(config, 'coder')).toBe('claude-opus-5');
      expect(planModelFor(config, 'coder-plan')).toBeUndefined();
    });

    it('PLAN_MAX_TURNS defaults to DEFAULT_PLAN_MAX_TURNS and is overridable', () => {
      expect(planMaxTurns(loadConfig(validEnv))).toBe(DEFAULT_PLAN_MAX_TURNS);
      expect(planMaxTurns(loadConfig({ ...validEnv, PLAN_MAX_TURNS: '12' }))).toBe(12);
    });

    it('a configured plan step widens the stage budget it fronts', () => {
      const base = loadConfig({ ...validEnv, MAX_REVISIONS: '2' });
      const withPlan = loadConfig({
        ...validEnv,
        MAX_REVISIONS: '2',
        CLAUDE_MODEL_PLANNING: 'claude-opus-5',
        STAGE_TIMEOUT_MS_PLAN: '100000',
      });
      expect(withPlan.stageTimeoutMs['revision-loop']).toBe(
        (base.stageTimeoutMs['revision-loop'] ?? 0) + 2 * 100_000,
      );
      expect(withPlan.stageTimeoutMs['test-author']).toBe(
        (base.stageTimeoutMs['test-author'] ?? 0) + 100_000,
      );
    });

    it('an explicit STAGE_TIMEOUT_MS_REVISION_LOOP still pins the budget', () => {
      const config = loadConfig({
        ...validEnv,
        CLAUDE_MODEL_PLANNING: 'claude-opus-5',
        STAGE_TIMEOUT_MS_REVISION_LOOP: '55000',
      });
      expect(config.stageTimeoutMs['revision-loop']).toBe(55_000);
    });
  });

  describe('Plan 10 — verification gate config', () => {
    it('throws when CONTINIA_ENV_PROFILE_ID / CONTINIA_API_TOKEN are missing', () => {
      // CONTINIA_APP_PATHS is deliberately NOT in this list: the deploy set is
      // derived per work item from the changed files and the selected tests.
      for (const key of ['CONTINIA_ENV_PROFILE_ID', 'CONTINIA_API_TOKEN']) {
        const env = { ...validEnv };
        delete env[key];
        expect(() => loadConfig(env)).toThrow(new RegExp(key));
      }
    });

    it('parses CONTINIA_APP_PATHS as ordered, trimmed list', () => {
      const config = loadConfig({
        ...validEnv,
        CONTINIA_APP_PATHS: ' Core/Cloud , Banking/Cloud ,Banking/Test ',
      });
      expect(config.continiaAppPaths).toEqual(['Core/Cloud', 'Banking/Cloud', 'Banking/Test']);
    });

    it('CONTINIA_APP_PATHS is optional — empty means "derive the deploy set"', () => {
      expect(loadConfig({ ...validEnv, CONTINIA_APP_PATHS: ' , ' }).continiaAppPaths).toEqual([]);
      const env = { ...validEnv };
      delete env.CONTINIA_APP_PATHS;
      expect(loadConfig(env).continiaAppPaths).toEqual([]);
    });

    it('CONTINIA_TEST_APP_PATHS is empty when absent — build-and-test scans every app', () => {
      const env = { ...validEnv };
      delete env.CONTINIA_TEST_APP_PATHS;
      expect(loadConfig(env).continiaTestAppPaths).toEqual([]);
    });

    it('CONTINIA_TEST_APP_PATHS overrides when set', () => {
      const config = loadConfig({ ...validEnv, CONTINIA_TEST_APP_PATHS: 'Banking/Test' });
      expect(config.continiaTestAppPaths).toEqual(['Banking/Test']);
    });

    it('defaults continiaCliPath and maxTestFixAttempts', () => {
      const config = loadConfig(validEnv);
      expect(config.continiaCliPath).toBe('.tools/continia.exe');
      expect(config.maxTestFixAttempts).toBe(2);
      expect(config.continiaEnvProfileId).toBe('profile-123');
      expect(config.continiaApiToken).toBe('tok-abc');
    });

    it('defaults the env-provision timeout to 5 minutes', () => {
      const config = loadConfig(validEnv);
      expect(config.stageTimeoutMs['env-provision']).toBe(300_000);
    });

    it('derives the build-and-test timeout from (fixAttempts+1)×verifyPass + fixAttempts×coder', () => {
      const config = loadConfig(validEnv);
      // Defaults: (2+1)×15min + 2×30min = 105 min.
      expect(config.stageTimeoutMs['build-and-test']).toBe(3 * 900_000 + 2 * 1_800_000);
    });

    it('derived build-and-test timeout follows overridden budgets', () => {
      const config = loadConfig({
        ...validEnv,
        MAX_TEST_FIX_ATTEMPTS: '1',
        STAGE_TIMEOUT_MS_VERIFY_PASS: '600000',
        STAGE_TIMEOUT_MS_CODER: '1200000',
      });
      expect(config.stageTimeoutMs['build-and-test']).toBe(2 * 600_000 + 1 * 1_200_000);
    });

    it('STAGE_TIMEOUT_MS_BUILD_AND_TEST overrides the derived default', () => {
      const config = loadConfig({ ...validEnv, STAGE_TIMEOUT_MS_BUILD_AND_TEST: '7200000' });
      expect(config.stageTimeoutMs['build-and-test']).toBe(7_200_000);
    });

    it('defaults continiaTestTimeoutS to 600 seconds', () => {
      const config = loadConfig(validEnv);
      expect(config.continiaTestTimeoutS).toBe(600);
    });

    it('CONTINIA_TEST_TIMEOUT_S overrides the per-test-run timeout', () => {
      const config = loadConfig({ ...validEnv, CONTINIA_TEST_TIMEOUT_S: '900' });
      expect(config.continiaTestTimeoutS).toBe(900);
    });
  });

  it('SKILLS_SOURCE_DIR is optional and maps to skillsSourceDir', () => {
    expect(loadConfig(validEnv).skillsSourceDir).toBeUndefined();
    expect(loadConfig({ ...validEnv, SKILLS_SOURCE_DIR: '/app/.claude' }).skillsSourceDir).toBe('/app/.claude');
  });

  it('CLAUDE_CODE_EXECUTABLE_PATH is optional and maps to claudeCodeExecutablePath', () => {
    expect(loadConfig(validEnv).claudeCodeExecutablePath).toBeUndefined();
    expect(
      loadConfig({ ...validEnv, CLAUDE_CODE_EXECUTABLE_PATH: '/home/claude/.local/bin/claude' })
        .claudeCodeExecutablePath,
    ).toBe('/home/claude/.local/bin/claude');
  });

  describe('SKIP_BUILD_TEST', () => {
    it('defaults to false and CONTINIA_* stay required', () => {
      expect(loadConfig(validEnv).skipBuildTest).toBe(false);
      const env = { ...validEnv };
      delete env.CONTINIA_API_TOKEN;
      expect(() => loadConfig(env)).toThrow(/CONTINIA_API_TOKEN/);
    });

    it('accepts 1/true/yes/on case-insensitively', () => {
      for (const v of ['1', 'true', 'YES', 'On']) {
        expect(loadConfig({ ...validEnv, SKIP_BUILD_TEST: v }).skipBuildTest).toBe(true);
      }
      expect(loadConfig({ ...validEnv, SKIP_BUILD_TEST: '0' }).skipBuildTest).toBe(false);
    });

    it('true → the three CONTINIA_* vars become optional (harness smoke tests need no DemoPortal token)', () => {
      const env: Record<string, string> = { ...validEnv, SKIP_BUILD_TEST: 'true' };
      delete env.CONTINIA_ENV_PROFILE_ID;
      delete env.CONTINIA_API_TOKEN;
      delete env.CONTINIA_APP_PATHS;
      const config = loadConfig(env);
      expect(config.skipBuildTest).toBe(true);
      expect(config.continiaAppPaths).toEqual([]);
    });

    it('false + missing var → error names the var and the bypass', () => {
      const env = { ...validEnv };
      delete env.CONTINIA_ENV_PROFILE_ID;
      expect(() => loadConfig(env)).toThrow(/CONTINIA_ENV_PROFILE_ID.*SKIP_BUILD_TEST/);
    });
  });
});

describe('LOG_DIR', () => {
  it('defaults to logs/ beside the working directory', () => {
    expect(loadConfig(validEnv).logDir).toBe('logs');
  });

  it('honours an explicit override', () => {
    expect(loadConfig({ ...validEnv, LOG_DIR: '/var/log/devops-coder' }).logDir).toBe(
      '/var/log/devops-coder',
    );
  });
});
