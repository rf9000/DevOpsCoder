import { z } from 'zod';
import type { AppConfig } from '../types/index.ts';

/** '1' | 'true' | 'yes' | 'on' (case-insensitive) → true; blank/unset → default. */
const boolFlag = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v.trim() === '') return defaultValue;
      return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
    });

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
  STAGE_TIMEOUT_MS_ANALYZER: z.coerce.number().int().positive().default(300_000),
  STAGE_TIMEOUT_MS_CODER: z.coerce.number().int().positive().default(1_800_000),
  STAGE_TIMEOUT_MS_REVIEWER: z.coerce.number().int().positive().default(900_000),
  STAGE_TIMEOUT_MS_REVISION_LOOP: z.coerce.number().int().positive().optional(),
  STAGE_TIMEOUT_MS_ENV_PROVISION: z.coerce.number().int().positive().default(300_000),
  STAGE_TIMEOUT_MS_VERIFY_PASS: z.coerce.number().int().positive().default(900_000),
  STAGE_TIMEOUT_MS_BUILD_AND_TEST: z.coerce.number().int().positive().optional(),
  CONTINIA_CLI_PATH: z.string().default('.tools/continia.exe'),
  CONTINIA_ENV_PROFILE_ID: z.string().default(''),
  CONTINIA_API_TOKEN: z.string().default(''),
  CONTINIA_APP_PATHS: z.string().default(''),
  CONTINIA_TEST_APP_PATHS: z.string().optional(),
  SKIP_BUILD_TEST: boolFlag(false),
  TEST_SELECTION: z.enum(['changed', 'related', 'all']).default('related'),
  CONTINIA_MAX_TEST_CODEUNITS: z.coerce.number().int().nonnegative().default(25),
  MAX_TEST_FIX_ATTEMPTS: z.coerce.number().int().nonnegative().default(2),
  CONTINIA_TEST_TIMEOUT_S: z.coerce.number().int().positive().default(600),
  STAGE_TIMEOUT_MS_TEST_AUTHOR: z.coerce.number().int().positive().default(1_200_000),
  STAGE_TIMEOUT_MS_DRAFT_PR_CREATOR: z.coerce.number().int().positive().default(120_000),
  STAGE_TIMEOUT_MS_WORKTREE_SETUP: z.coerce.number().int().positive().default(60_000),
  STAGE_TIMEOUT_MS_WORKTREE_TEARDOWN: z.coerce.number().int().positive().default(60_000),
  CLAUDE_MODEL: z.string().default('claude-opus-4-7'),
  // Per-step model overrides. Blank/unset → CLAUDE_MODEL. CLAUDE_MODEL_PLANNING
  // is the one-knob default for both plan steps; naming any plan model is what
  // turns the plan-then-write split on (see src/utils/model-selection.ts).
  CLAUDE_MODEL_PLANNING: z.string().optional(),
  CLAUDE_MODEL_ANALYZER: z.string().optional(),
  CLAUDE_MODEL_CODER_PLAN: z.string().optional(),
  CLAUDE_MODEL_CODER: z.string().optional(),
  CLAUDE_MODEL_REVIEWER: z.string().optional(),
  CLAUDE_MODEL_TEST_AUTHOR_PLAN: z.string().optional(),
  CLAUDE_MODEL_TEST_AUTHOR: z.string().optional(),
  CLAUDE_MODEL_TEST_FIXER: z.string().optional(),
  PLAN_MAX_TURNS: z.coerce.number().int().positive().default(30),
  STAGE_TIMEOUT_MS_PLAN: z.coerce.number().int().positive().default(600_000),
  STATE_DIR: z.string().default('.state'),
  LOG_DIR: z.string().default('logs'),
  ASSIGNED_TO_FILTER: z.string().optional(),
  SKILLS_SOURCE_DIR: z.string().optional(),
  CLAUDE_CODE_EXECUTABLE_PATH: z.string().optional(),
  COST_LOG_PATH: z.string().optional(),
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

  // A harness smoke test should not need a DemoPortal token — the Continia
  // config is only required when the verification gate actually runs.
  if (!p.SKIP_BUILD_TEST) {
    const missing = (
      [
        ['CONTINIA_ENV_PROFILE_ID', p.CONTINIA_ENV_PROFILE_ID],
        ['CONTINIA_API_TOKEN', p.CONTINIA_API_TOKEN],
      ] as const
    ).filter(([, v]) => v.trim() === '');
    if (missing.length > 0) {
      throw new Error(
        `Invalid configuration:\n${missing
          .map(([k]) => `  - ${k}: required unless SKIP_BUILD_TEST=true (the verification gate uses the Continia CLI)`)
          .join('\n')}`,
      );
    }
  }

  const assignedToFilter = p.ASSIGNED_TO_FILTER
    ? p.ASSIGNED_TO_FILTER.split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : [];

  const splitPaths = (raw: string): string[] =>
    raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

  // Both optional: build-and-test derives the deploy set per work item from the
  // changed files plus the selected tests, and scans every app for test
  // codeunits when no scan scope is pinned. Non-empty values override either.
  const continiaAppPaths = splitPaths(p.CONTINIA_APP_PATHS);
  const continiaTestAppPaths = splitPaths(p.CONTINIA_TEST_APP_PATHS ?? '');

  // A blank env var reads as "not set" so an operator can comment a model out
  // by emptying it without the empty string reaching the SDK as a model name.
  const model = (raw: string | undefined): string | undefined => {
    const trimmed = raw?.trim();
    return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
  };
  const planningModel = model(p.CLAUDE_MODEL_PLANNING);
  const coderPlanModel = model(p.CLAUDE_MODEL_CODER_PLAN) ?? planningModel;
  const testPlanModel = model(p.CLAUDE_MODEL_TEST_AUTHOR_PLAN) ?? planningModel;
  const stepModel: Record<string, string> = {};
  const setStep = (step: string, value: string | undefined): void => {
    if (value !== undefined) stepModel[step] = value;
  };
  setStep('analyzer', model(p.CLAUDE_MODEL_ANALYZER));
  setStep('coder-plan', coderPlanModel);
  setStep('coder', model(p.CLAUDE_MODEL_CODER));
  setStep('reviewer', model(p.CLAUDE_MODEL_REVIEWER));
  setStep('test-author-plan', testPlanModel);
  setStep('test-author', model(p.CLAUDE_MODEL_TEST_AUTHOR));
  setStep('test-fixer', model(p.CLAUDE_MODEL_TEST_FIXER));

  // A configured plan step adds one read-only call to the stage it fronts, so
  // the stage's wall-clock budget has to grow with it or the split would start
  // timing out runs that used to fit.
  const coderPlanBudget = coderPlanModel !== undefined ? p.STAGE_TIMEOUT_MS_PLAN : 0;
  const testPlanBudget = testPlanModel !== undefined ? p.STAGE_TIMEOUT_MS_PLAN : 0;

  return {
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
      // 'coder' and 'reviewer' run nested inside the top-level 'revision-loop'
      // stage, which is the unit the orchestrator actually times. Their env
      // vars act as per-iteration budgets that size the loop's default.
      'revision-loop':
        p.STAGE_TIMEOUT_MS_REVISION_LOOP ??
        p.MAX_REVISIONS *
          (coderPlanBudget + p.STAGE_TIMEOUT_MS_CODER + p.STAGE_TIMEOUT_MS_REVIEWER),
      'env-provision': p.STAGE_TIMEOUT_MS_ENV_PROVISION,
      // The build-and-test stage runs up to (fixAttempts+1) deterministic
      // deploy+test passes (VERIFY_PASS budget each) interleaved with up to
      // fixAttempts coder fix calls (CODER budget each).
      'build-and-test':
        p.STAGE_TIMEOUT_MS_BUILD_AND_TEST ??
        (p.MAX_TEST_FIX_ATTEMPTS + 1) * p.STAGE_TIMEOUT_MS_VERIFY_PASS +
          p.MAX_TEST_FIX_ATTEMPTS * p.STAGE_TIMEOUT_MS_CODER,
      'test-author': p.STAGE_TIMEOUT_MS_TEST_AUTHOR + testPlanBudget,
      'draft-pr-creator': p.STAGE_TIMEOUT_MS_DRAFT_PR_CREATOR,
      'worktree-teardown': p.STAGE_TIMEOUT_MS_WORKTREE_TEARDOWN,
    },
    claudeModel: p.CLAUDE_MODEL,
    stepModel,
    planMaxTurns: p.PLAN_MAX_TURNS,
    stateDir: p.STATE_DIR,
    logDir: p.LOG_DIR,
    costLogPath: p.COST_LOG_PATH ?? `${p.STATE_DIR}/cost-ledger.jsonl`,
    assignedToFilter,
    continiaCliPath: p.CONTINIA_CLI_PATH,
    continiaEnvProfileId: p.CONTINIA_ENV_PROFILE_ID,
    continiaApiToken: p.CONTINIA_API_TOKEN,
    continiaAppPaths,
    continiaTestAppPaths,
    maxTestFixAttempts: p.MAX_TEST_FIX_ATTEMPTS,
    continiaTestTimeoutS: p.CONTINIA_TEST_TIMEOUT_S,
    skillsSourceDir: p.SKILLS_SOURCE_DIR,
    claudeCodeExecutablePath: p.CLAUDE_CODE_EXECUTABLE_PATH,
    skipBuildTest: p.SKIP_BUILD_TEST,
    testSelection: p.TEST_SELECTION,
    maxTestCodeunits: p.CONTINIA_MAX_TEST_CODEUNITS,
    dryRun: false,
  };
}
