import { relative } from 'path';
import type { AgentRunner } from '../agent-stage.ts';
import { AgentOutputParseError } from '../../services/claude-agent-runner.ts';
import { ACTIVATION_APP_ID, type ContiniaCli, type DepsInstallInfo } from '../../services/continia-cli.ts';
import type { WorkItemContext } from '../../services/wi-context.ts';
import type { DiscoveredSkill } from '../../services/skill-loader.ts';
import type { Logger } from '../../utils/logger.ts';
import type {
  AppConfig,
  CoderOutput,
  DeployAppResult,
  EnvironmentOutput,
  PipelineState,
  TestRunRecord,
  VerificationOutput,
  WorktreeContext,
} from '../../types/index.ts';
import {
  discoverTestCodeunits as defaultDiscoverTestCodeunits,
  type DiscoveredTestCodeunit,
} from '../../utils/al-test-discovery.ts';
import { createBashAllowlist } from '../../utils/bash-allowlist.ts';
import { createPathEscapeFilter } from '../../utils/path-escape-filter.ts';
import { modelFor } from '../../utils/model-selection.ts';
import { createCostTracker } from '../../utils/cost-tracker.ts';
import { createToolUsageTracker } from '../../utils/tool-usage-tracker.ts';
import {
  CODER_BASH_ALLOW,
  CODER_BASH_DENY,
  coderOutputSchema,
} from './coder.ts';
import {
  MAX_TRANSIENT_RETRIES,
  composeCanUseTool,
  defaultGetChangedFiles,
  defaultGetCurrentHeadSha,
  defaultResetWorktree,
  STRUCTURED_OUTPUT_DENIED_TOOLS,
} from './_stage-helpers.ts';
import { selectTestCodeunits } from '../../utils/test-selection.ts';
import {
  discoverAlApps as defaultDiscoverAlApps,
  localizationAppDir,
  ownerAppOf,
  resolveDeployOrder,
  type AlApp,
} from '../../utils/al-app-graph.ts';

const STACK_TRACE_MAX_LINES = 15;
const STACK_TRACE_MAX_CHARS = 1500;

/** The red parts of one verification round, as input to a fix call. */
export interface VerificationFailure {
  compiled: boolean;
  deploy: DeployAppResult[];
  testRuns: TestRunRecord[];
}

function trimStackTrace(trace: string): string {
  const lines = trace.split('\n');
  let trimmed = lines.slice(0, STACK_TRACE_MAX_LINES).join('\n');
  if (trimmed.length > STACK_TRACE_MAX_CHARS) {
    trimmed = trimmed.slice(0, STACK_TRACE_MAX_CHARS);
  }
  if (trimmed.length < trace.length) {
    trimmed += '\n... (truncated)';
  }
  return trimmed;
}

/**
 * Build the fix-call user prompt from a red verification round. Pure helper
 * for testability. Renders compile/deploy errors when the round didn't
 * compile, otherwise the failing tests (green tests and green codeunits are
 * omitted — they're noise to a fix agent).
 */
export function buildFixPrompt(
  failure: VerificationFailure,
  wiCtx: WorkItemContext,
  worktree: WorktreeContext,
  environment: EnvironmentOutput,
  attempt: number,
  maxAttempts: number,
  skills: DiscoveredSkill[] = [],
): string {
  const sections: string[] = [];

  sections.push(
    `# Fix verification failures — Work Item ${wiCtx.id}: ${wiCtx.title}  (fix attempt ${attempt} of ${maxAttempts})`,
  );
  sections.push(
    `\nThe implementation and tests were deployed to Business Central environment \`${environment.envId}\`` +
      (environment.url ? ` (${environment.url})` : '') +
      `, but verification is red. Fix the code and/or tests in the worktree at \`${worktree.path}\`, then commit.`,
  );

  if (!failure.compiled) {
    sections.push('\n## Compile / deploy errors\n');
    for (const entry of failure.deploy) {
      if (entry.compiled && entry.published) continue;
      sections.push(`- **${entry.app}**: ${entry.error ?? 'compile/publish failed (no error detail)'}`);
    }
  } else {
    sections.push('\n## Failing tests\n');
    for (const run of failure.testRuns) {
      if (run.passed) continue;
      const name = run.codeunitName ? ` "${run.codeunitName}"` : '';
      sections.push(
        `### Codeunit ${run.codeunitId}${name} — ${run.summary.failed} failed / ${run.summary.total} total\n`,
      );
      for (const test of run.tests) {
        if (test.result.toLowerCase() !== 'fail') continue;
        sections.push(`- **${test.name}**${test.fullName ? ` (${test.fullName})` : ''}`);
        if (test.errorMessage) sections.push(`  Error: ${test.errorMessage}`);
        if (test.stackTrace) {
          sections.push('  Stack trace:');
          sections.push('  ```');
          sections.push(trimStackTrace(test.stackTrace));
          sections.push('  ```');
        }
      }
    }
  }

  if (skills.length > 0) {
    sections.push('\n## Available Invocable Skills\n');
    for (const s of skills) {
      sections.push(`- **${s.name}**: ${s.description}`);
    }
  }

  sections.push('\n## Rules');
  sections.push('- Do not weaken or delete tests to make them pass.');
  sections.push('- Stage specific files (git add <file>), then git commit. Do not push.');
  sections.push('- The framework will redeploy and re-run all tests after you finish.');

  return sections.join('\n');
}

export interface ResolveAppPathsArgs {
  apps: AlApp[];
  /** Worktree-relative, from git diff. */
  changedFiles: string[];
  /** Absolute paths of the test codeunits selected for this round. */
  testFiles: string[];
  worktreePath: string;
  /** CONTINIA_APP_PATHS. Non-empty pins the deploy set and skips derivation. */
  override: string[];
}

/**
 * Work out which apps to deploy for this work item.
 *
 * Seeds are the apps owning the changed files and the apps owning the selected
 * test codeunits; the seeds are then expanded over internal dependencies and
 * ordered dependency-first so each app compiles against something already
 * published.
 *
 * Derived rather than configured because a static list cannot be correct in a
 * repo where one WI touches base-application and the next touches export —
 * pinning it either under-deploys (the change compiles nowhere) or
 * over-deploys (every app recompiles every round).
 */
export function resolveAppPaths(args: ResolveAppPathsArgs): string[] {
  if (args.override.length > 0) return args.override;

  const seeds = new Set<string>();
  for (const rel of args.changedFiles) {
    const owner = ownerAppOf(rel, args.apps);
    if (owner) seeds.add(owner.dir);
  }
  for (const abs of args.testFiles) {
    const rel = relative(args.worktreePath, abs);
    const owner = ownerAppOf(rel, args.apps);
    if (owner) seeds.add(owner.dir);
  }
  return resolveDeployOrder(args.apps, [...seeds]);
}

/**
 * Deploy failure codes whose cause is the app's own source, so a fix agent can
 * actually do something about them. See `.claude/skills/continia-deploy`
 * "Result Interpretation" for the full code list.
 *
 * Everything else — `unpublished-sibling`, `dependency-not-on-env`,
 * `symbol-fetch-failed`, `superseded-package-retained`, `app-lock-*`,
 * `higher-version-installed` — is an environment or deploy-set problem. No AL
 * edit fixes those, so routing them into the fix loop spends every attempt (and
 * the money) proving that, then reports the wrong cause. An unrecognised code
 * is treated as environmental for the same reason: a terminal error naming the
 * code is more useful than a fix loop that cannot converge.
 */
export const CODER_FIXABLE_DEPLOY_CODES = new Set([
  'compile-failed',
  'compile-produced-no-app',
  'publish-failed',
]);

/**
 * The first deploy row that failed for a reason the coder cannot fix, if any.
 * A failed row carrying no `code` is treated as coder-fixable — that is the
 * pre-`code` shape, and a compile error is the overwhelmingly common case.
 */
export function findEnvironmentDeployFailure(
  deploy: DeployAppResult[],
): DeployAppResult | undefined {
  return deploy.find(
    (e) =>
      !(e.compiled && e.published) &&
      e.code !== undefined &&
      !CODER_FIXABLE_DEPLOY_CODES.has(e.code),
  );
}

/**
 * Per-work-item memo of the environment-side setup `prepareVerification` does,
 * so the in-loop gate does not reinstall the activation app, the localization
 * dependencies and every deploy-set app's dependencies on every revision round.
 * Lives in `state.outputs.verificationSetup`.
 */
export interface VerificationSetupCache {
  /**
   * The environment every flag below was populated against. A cache is only
   * ever warm for THIS environment: `env-provision` legitimately recreates one
   * on a resumed WI (wrong BC version, another WI's name, terminal status, or a
   * version that cannot be established at all — see Plan 12), and flags carried
   * over from the dead environment would skip the activation-app and
   * Continia Finance installs against the fresh one.
   */
  envId?: string;
  activationInstalled?: boolean;
  localizationInstalled?: boolean;
  depsInstalled?: string[];
}

/**
 * Discard a cache that was not populated against `envId`, including one that
 * cannot say which environment it belongs to (every state file written before
 * `envId` existed). Deliberately asymmetric: a needless re-install costs a few
 * minutes of idempotent work, while a wrongly-skipped one costs the whole run
 * and reports the cause as an environment fault in an app that is not at fault.
 */
function resetCacheIfForeign(cache: VerificationSetupCache, envId: string): void {
  if (cache.envId === envId) return;
  cache.envId = envId;
  cache.activationInstalled = false;
  cache.localizationInstalled = false;
  cache.depsInstalled = [];
}

export interface VerificationSetup {
  env: EnvironmentOutput;
  appPaths: string[];
  codeunits: DiscoveredTestCodeunit[];
  /**
   * Non-fatal reason this round cannot verify. Callers choose the policy: the
   * final gate throws VerificationFailedError, the in-loop gate logs and skips.
   * Returning it rather than throwing is the whole point of the extraction.
   */
  skipReason?: string;
}

export interface VerificationRoundResult {
  output: VerificationOutput;
  /** The red parts, when the round is fixable-red. */
  failure?: VerificationFailure;
  /** Deploy failed for a reason no source edit can address. */
  environmentBlocker?: DeployAppResult;
}

export interface PrepareVerificationArgs {
  config: AppConfig;
  continiaCli: ContiniaCli;
  logger: Logger;
  worktree: WorktreeContext;
  environment: EnvironmentOutput;
  signal?: AbortSignal;
  /** Mutated in place: what this call installs is recorded back into it. */
  cache: VerificationSetupCache;
  /** Test override for AL test-codeunit discovery. */
  discoverTestCodeunits?: (
    worktreePath: string,
    testAppPaths: string[],
  ) => Promise<DiscoveredTestCodeunit[]>;
  /** Test override for the changed-file lookup that drives test selection. */
  getChangedFiles?: (worktreePath: string, baselineSha: string) => Promise<string[]>;
  /** Test override for the app.json scan that drives the derived deploy set. */
  discoverAlApps?: (worktreePath: string) => AlApp[];
  /**
   * Log-line prefix. Both `build-and-test` and the in-loop `verify` gate share
   * this function, and an operator tailing the log needs to tell which stage a
   * line came from. Defaults to `'build-and-test'` so the final gate's log
   * output (and the tests asserting on it) are unchanged.
   */
  logPrefix?: string;
  /**
   * Invoked with the live environment right after `waitForRunning`, before the
   * activation install and any deps installs. `state.outputs.environment`
   * previously only refreshed after this whole function returned, so a throw
   * from inside it (empty appPaths, a failed activation install, a failed
   * deps install) left state holding `env-provision`'s record — which for a
   * fresh environment can carry `status: 'Creating'` and a null `url`. Callers
   * should assign `state.outputs.environment` from here.
   */
  onEnvironmentLive?: (env: EnvironmentOutput) => void;
}

/**
 * Everything that has to be true before a verification round can run: the
 * environment is up and activated, the deploy set is derived, the test
 * codeunits are selected, and every dependency is installed.
 *
 * Returns a `skipReason` rather than throwing for the two "nothing to verify"
 * conditions, because the two call sites want opposite policies: the final gate
 * treats an unverified change as a failure, the in-loop gate logs and moves on.
 */
export async function prepareVerification(
  args: PrepareVerificationArgs,
): Promise<VerificationSetup> {
  const { config, worktree, cache } = args;
  const discover = args.discoverTestCodeunits ?? defaultDiscoverTestCodeunits;
  const changedFilesOf = args.getChangedFiles ?? defaultGetChangedFiles;
  const discoverApps = args.discoverAlApps ?? defaultDiscoverAlApps;
  const logPrefix = args.logPrefix ?? 'build-and-test';
  const callOpts = { worktreePath: worktree.path, signal: args.signal };

  // Before any cached flag is read: a cache from a different environment is a
  // cold cache, not a warm one.
  resetCacheIfForeign(cache, args.environment.envId);

  const live = await args.continiaCli.waitForRunning(args.environment.envId, callOpts);
  const env: EnvironmentOutput = {
    ...args.environment,
    status: live.status,
    url: live.url ?? args.environment.url,
  };
  args.onEnvironmentLive?.(env);

  // A fresh environment can't be interacted with until the Continia Core
  // Internal Activation App is installed. Idempotent — safe on re-entry.
  if (!cache.activationInstalled) {
    await args.continiaCli.installAppById(env.envId, ACTIVATION_APP_ID, callOpts);
    cache.activationInstalled = true;
  }

  // Everything below the environment calls is filesystem-only, so it runs
  // BEFORE the expensive deps-install/compile work: the set of apps worth
  // deploying is derived from what changed and from which tests we picked.
  const appGraph = discoverApps(worktree.path);
  const changedFiles = await changedFilesOf(worktree.path, worktree.baseSha);

  // Scan scope for test discovery. Unset CONTINIA_TEST_APP_PATHS means
  // "every app in the repo" — discovery is cheap (file reads) and selection
  // is what bounds the expensive part.
  const testScanPaths =
    config.continiaTestAppPaths.length > 0
      ? config.continiaTestAppPaths
      : appGraph.map((a) => a.dir);

  const discovered = await discover(worktree.path, testScanPaths);
  if (discovered.length === 0) {
    return {
      env,
      appPaths: [],
      codeunits: [],
      skipReason: `no test codeunits discovered under ${testScanPaths.join(', ')}`,
    };
  }

  // Narrow to what this change actually needs. Codeunits run strictly
  // sequentially against one environment, so running the whole suite is
  // hours of wall clock and a guaranteed stage timeout on a real codebase.
  const selection = selectTestCodeunits({
    discovered,
    changedFiles,
    worktreePath: worktree.path,
    mode: config.testSelection,
    maxCodeunits: config.maxTestCodeunits,
  });
  const codeunits = selection.selected;
  args.logger.info(
    `${logPrefix}: running ${codeunits.length} test codeunit(s) — ${selection.reason}`,
  );
  if (selection.droppedByCap > 0) {
    // Never silent: a truncated run that goes green must not read as
    // "everything passed".
    args.logger.info(
      `${logPrefix}: WARNING ${selection.droppedByCap} selected codeunit(s) dropped by ` +
        `CONTINIA_MAX_TEST_CODEUNITS=${config.maxTestCodeunits} — this round does NOT cover them`,
    );
  }
  if (codeunits.length === 0) {
    // Nothing to verify: an empty selection means the change is unverified,
    // which is exactly what the final gate exists to catch.
    return {
      env,
      appPaths: [],
      codeunits: [],
      skipReason:
        `no test codeunits selected for the changed files (${selection.reason}); ` +
        `set TEST_SELECTION=all to run the full suite`,
    };
  }

  // Deploy set: the apps the change touched, plus the apps owning the tests
  // we are about to run, expanded over internal dependencies and ordered
  // dependency-first. Derived per work item — a static list cannot be right
  // for a repo where one WI touches base-application and the next touches
  // export. CONTINIA_APP_PATHS, when set, overrides this entirely.
  const appPaths = resolveAppPaths({
    apps: appGraph,
    changedFiles,
    testFiles: codeunits.map((c) => c.file),
    worktreePath: worktree.path,
    override: config.continiaAppPaths,
  });
  if (appPaths.length === 0) {
    // No stage prefix: both callers already prefix what they do with this —
    // the verify gate logs `verify: <message>`, and the orchestrator records a
    // terminal error against the stage that raised it. Prefixing here produced
    // `verify: verify could not determine …`.
    throw new Error(
      'could not determine which apps to deploy: no app.json owns the changed ' +
        'files or the selected tests. Set CONTINIA_APP_PATHS to pin the deploy set explicitly.',
    );
  }
  const pinned = config.continiaAppPaths.length > 0;
  args.logger.info(
    `${logPrefix}: deploying ${appPaths.length} app(s) in dependency order — ${appPaths.join(' → ')}` +
      (pinned ? ' (pinned via CONTINIA_APP_PATHS)' : ' (derived)'),
  );
  if (pinned) {
    // Never silent, same reasoning as the dropped-codeunit warning above: a
    // pin replaces the per-WI derivation wholesale, so a test the
    // test-author wrote into a test app outside the list is never published
    // and this round runs a codeunit that isn't on the environment.
    args.logger.warn(
      `${logPrefix}: WARNING CONTINIA_APP_PATHS is pinned, so the deploy set was NOT derived ` +
        'for this work item — apps outside the pin are not deployed, including test apps holding ' +
        'newly written tests. Unset it unless you are deliberately overriding the derivation.',
    );
  }

  // `tail` is what the operator should DO about it, and that differs by
  // call site: a deploy-set app is compiled here, the localization app
  // never is.
  const surfaceDepsInfo = (appPath: string, info: DepsInstallInfo, tail: string): void => {
    if (info.skippedCount > 0 || info.symbolsMissingCount > 0) {
      args.logger.warn(
        `${logPrefix}: deps install for ${appPath} reported ${info.skippedCount} skipped dep(s) ` +
          `and ${info.symbolsMissingCount} symbol gap(s) — ${tail}`,
      );
    }
  };
  const DEPLOY_SET_DEPS_TAIL = 'catalogue misses surface later as compile errors';
  // Nothing compiles the localization app, so a miss here never surfaces as
  // a compile error. It surfaces as an unpublished-sibling /
  // dependency-not-on-env failure blamed on a DIFFERENT app — exactly the
  // misattribution this step exists to end, so it must not read as a
  // benign deferral.
  const LOCALIZATION_DEPS_TAIL =
    'a skipped dep here may mean Continia Finance is NOT on the environment — this app is ' +
    'never compiled, so the miss surfaces later as a deploy failure blamed on another app';

  // Since v29 only the country apps declare Continia Finance —
  // base-application does not — so this is the ONLY step that brings it
  // onto the environment, and it must run before the deploy set's own deps.
  //
  // Deps-installed but never published, and deliberately NOT in appPaths:
  // external/Continia Finance/00_Base_App declares the app.json name
  // "Continia Finance", so a country app in the deploy set would make
  // resolveDeployOrder compile vendored 28.0.0.0 source against BC 29.
  if (!cache.localizationInstalled) {
    const localizationApp = localizationAppDir(appGraph, config.continiaEnvLocalization);
    if (!localizationApp) {
      args.logger.warn(
        `${logPrefix}: no localization app for CONTINIA_ENV_LOCALIZATION=` +
          `${config.continiaEnvLocalization}, and no banking-w1 to fall back on — skipping the ` +
          `localization deps install. Continia Finance will NOT be installed on the environment, ` +
          `and apps depending on it may fail to publish.`,
      );
    } else {
      if (localizationApp.fellBack) {
        // Warn, not info: W1 stands in for the purpose of this step (every
        // country app declares Finance) but it does NOT bring the
        // country-specific Microsoft externals a real banking-<cc> would, so
        // the fallback changes what is on the environment. An operator
        // filtering warn-level lines has to see that.
        args.logger.warn(
          `${logPrefix}: WARNING no app for CONTINIA_ENV_LOCALIZATION=` +
            `'${config.continiaEnvLocalization}'; fell back to banking-w1, installing ` +
            `localization dependencies from ${localizationApp.dir} — every country app declares ` +
            `Continia Finance, so this still brings it onto the environment, but the externals ` +
            `specific to '${config.continiaEnvLocalization}' are NOT installed`,
        );
      } else {
        args.logger.info(
          `${logPrefix}: installing localization dependencies from ${localizationApp.dir}` +
            ' — the only step that brings Continia Finance onto the environment',
        );
      }
      surfaceDepsInfo(
        localizationApp.dir,
        await args.continiaCli.installDependencies(env.envId, localizationApp.dir, callOpts),
        LOCALIZATION_DEPS_TAIL,
      );
      cache.localizationInstalled = true;
    }
  }

  const depsInstalled = (cache.depsInstalled ??= []);
  for (const appPath of appPaths) {
    if (depsInstalled.includes(appPath)) continue;
    surfaceDepsInfo(
      appPath,
      await args.continiaCli.installDependencies(env.envId, appPath, callOpts),
      DEPLOY_SET_DEPS_TAIL,
    );
    depsInstalled.push(appPath);
  }

  return { env, appPaths, codeunits };
}

export interface RunVerificationRoundArgs {
  continiaCli: ContiniaCli;
  env: EnvironmentOutput;
  worktree: WorktreeContext;
  appPaths: string[];
  codeunits: DiscoveredTestCodeunit[];
  config: AppConfig;
  /** Fix attempts consumed before this round — recorded on the output. */
  attempt: number;
  signal?: AbortSignal;
}

/**
 * One deploy + test round against the per-WI environment.
 *
 * An environment-level deploy failure comes back as `environmentBlocker`
 * rather than a throw, so the caller decides whether that is terminal.
 */
export async function runVerificationRound(
  args: RunVerificationRoundArgs,
): Promise<VerificationRoundResult> {
  const { config, appPaths, codeunits, env, attempt } = args;
  const callOpts = { worktreePath: args.worktree.path, signal: args.signal };

  // Re-download symbols every round: the fix call's reset path runs
  // `git clean -fd`, which deletes untracked .alpackages.
  for (const appPath of appPaths) {
    await args.continiaCli.downloadSymbols(env.envId, appPath, callOpts);
  }

  const deploy: DeployAppResult[] = [];
  for (const appPath of appPaths) {
    deploy.push(...(await args.continiaCli.deployApp(env.envId, appPath, callOpts)));
  }

  // Stop before the fix loop when the deploy failed for a reason no
  // source edit can address. Return the round first so the failure is
  // diagnosable from state rather than only from the log.
  const blocker = findEnvironmentDeployFailure(deploy);
  if (blocker) {
    return {
      output: {
        attempts: attempt,
        compiled: false,
        deploy,
        testRuns: [],
        passed: false,
      } satisfies VerificationOutput,
      environmentBlocker: blocker,
    };
  }

  const compiled = deploy.every((e) => e.compiled && e.published);

  const testRuns: TestRunRecord[] = [];
  let passed = false;
  if (compiled) {
    // Strictly sequential — BC forbids parallel test jobs on one env.
    for (const cu of codeunits) {
      const run = await args.continiaCli.runTests(env.envId, cu.id, {
        ...callOpts,
        timeoutSeconds: config.continiaTestTimeoutS,
      });
      testRuns.push({
        attempt,
        codeunitId: cu.id,
        codeunitName: run.summary.codeunitName ?? cu.name,
        passed: run.passed,
        summary: run.summary,
        tests: run.tests,
      });
    }
    passed = testRuns.every((r) => r.passed);
  }

  const output: VerificationOutput = {
    attempts: attempt,
    compiled,
    deploy,
    testRuns,
    passed,
  };

  return { output, ...(passed ? {} : { failure: { compiled, deploy, testRuns } }) };
}

export interface RunTestFixCallArgs {
  runner: AgentRunner;
  config: AppConfig;
  /** The contents of `src/prompts/test-fixer.md`. */
  fixerPromptTemplate: string;
  discoveredSkills: DiscoveredSkill[];
  failure: VerificationFailure;
  wiCtx: WorkItemContext;
  worktree: WorktreeContext;
  env: EnvironmentOutput;
  attempt: number;
  maxAttempts: number;
  state: PipelineState;
  signal?: AbortSignal;
  /** Test override for the HEAD-sha lookup. */
  getCurrentHeadSha?: (worktreePath: string) => Promise<string>;
  /** Test override for the worktree reset. */
  resetWorktree?: (worktreePath: string, baselineSha: string) => Promise<void>;
}

/**
 * One coder session over a red verification round. Retries a malformed
 * structured output the same way the other write stages do, resetting the
 * worktree to the pre-call baseline on every failure.
 */
export async function runTestFixCall(args: RunTestFixCallArgs): Promise<void> {
  const { config, worktree } = args;
  const getHead = args.getCurrentHeadSha ?? defaultGetCurrentHeadSha;
  const reset = args.resetWorktree ?? defaultResetWorktree;
  const canUseTool = composeCanUseTool([
    createBashAllowlist({ allow: CODER_BASH_ALLOW, deny: CODER_BASH_DENY }),
    createPathEscapeFilter(worktree.path),
  ]);

  const prompt = buildFixPrompt(
    args.failure,
    args.wiCtx,
    worktree,
    args.env,
    args.attempt,
    args.maxAttempts,
    args.discoveredSkills,
  );
  const baselineSha = await getHead(worktree.path);
  for (let retry = 0; retry <= MAX_TRANSIENT_RETRIES; retry++) {
    try {
      const { costUsd, toolUsage, usage } = await args.runner.run<CoderOutput>({
        prompt,
        label: `test-fixer (attempt ${args.attempt} of ${args.maxAttempts})`,
        schema: coderOutputSchema,
        model: modelFor(config, 'test-fixer'),
        tools: ['Read', 'Grep', 'Glob', 'Bash', 'Skill', 'Edit', 'Write'],
        disallowedTools: ['NotebookEdit', ...STRUCTURED_OUTPUT_DENIED_TOOLS],
        cwd: worktree.path,
        systemPromptAppend: args.fixerPromptTemplate,
        settingSources: ['project'],
        maxTurns: config.coderMaxTurns,
        canUseTool,
        signal: args.signal,
      });
      // `test-fixer`, not `build-and-test`: the stage itself makes no LLM
      // call, and billing the fixer to the stage buries the one thing worth
      // seeing — how many rounds of AL fixes a red test round actually cost.
      createCostTracker(args.state).add('test-fixer', costUsd, usage);
      createToolUsageTracker(args.state).add('test-fixer', toolUsage);
      return;
    } catch (err) {
      await reset(worktree.path, baselineSha);
      if (err instanceof AgentOutputParseError && retry < MAX_TRANSIENT_RETRIES) {
        continue;
      }
      throw err;
    }
  }
}
