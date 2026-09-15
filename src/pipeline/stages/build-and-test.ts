import { relative } from 'path';
import type { Stage } from '../stage.ts';
import type { AgentRunner } from '../agent-stage.ts';
import { AgentOutputParseError } from '../../services/claude-agent-runner.ts';
import { ACTIVATION_APP_ID, type ContiniaCli } from '../../services/continia-cli.ts';
import type { WorkItemContext } from '../../services/wi-context.ts';
import type { DiscoveredSkill } from '../../services/skill-loader.ts';
import type { Logger } from '../../utils/logger.ts';
import {
  VerificationFailedError,
  type AppConfig,
  type CoderOutput,
  type DeployAppResult,
  type EnvironmentOutput,
  type TestRunRecord,
  type VerificationOutput,
  type WorktreeContext,
} from '../../types/index.ts';
import {
  discoverTestCodeunits as defaultDiscoverTestCodeunits,
  type DiscoveredTestCodeunit,
} from '../../utils/al-test-discovery.ts';
import { createBashAllowlist } from '../../utils/bash-allowlist.ts';
import { createPathEscapeFilter } from '../../utils/path-escape-filter.ts';
import { modelFor } from '../../utils/model-selection.ts';
import { assertWithinCostCap, createCostTracker } from '../../utils/cost-tracker.ts';
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

export interface BuildAndTestDeps {
  config: AppConfig;
  continiaCli: ContiniaCli;
  runner: AgentRunner;
  logger: Logger;
  /** The contents of `src/prompts/test-fixer.md`. */
  fixerPromptTemplate: string;
  discoveredSkills: DiscoveredSkill[];
  /** Test override for the HEAD-sha lookup. */
  getCurrentHeadSha?: (worktreePath: string) => Promise<string>;
  /** Test override for the worktree reset. */
  resetWorktree?: (worktreePath: string, baselineSha: string) => Promise<void>;
  /** Test override for AL test-codeunit discovery. */
  discoverTestCodeunits?: (
    worktreePath: string,
    testAppPaths: string[],
  ) => Promise<DiscoveredTestCodeunit[]>;
  /** Test override for the changed-file lookup that drives test selection. */
  getChangedFiles?: (worktreePath: string, baselineSha: string) => Promise<string[]>;
  /** Test override for the app.json scan that drives the derived deploy set. */
  discoverAlApps?: (worktreePath: string) => AlApp[];
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

function summarize(failure: VerificationFailure): string {
  if (!failure.compiled) {
    const firstRed = failure.deploy.find((e) => !e.compiled || !e.published);
    return `app ${firstRed?.app ?? '(unknown)'} failed to compile/publish`;
  }
  const failed = failure.testRuns.reduce((n, r) => n + r.summary.failed, 0);
  const codeunits = failure.testRuns
    .filter((r) => !r.passed)
    .map((r) => r.codeunitId)
    .join(', ');
  return `${failed} failing test(s) in codeunit(s) ${codeunits}`;
}

/**
 * The verification gate: deploy the worktree's apps to the per-WI BC
 * environment and run every discovered test codeunit. Red results feed a
 * bounded coder fix loop (`maxTestFixAttempts`); still red afterwards throws
 * `VerificationFailedError`, which the processor renders as a WI comment.
 * Only a fully green round lets the pipeline continue to the draft PR.
 *
 * Hand-rolled loop (not `revisionLoop`) — the "reviewer" here is a
 * deterministic deploy+test sequence whose results parameterize the next fix
 * prompt, and round 0 has no producer call at all.
 */
export function createBuildAndTestStage(deps: BuildAndTestDeps): Stage {
  const getHead = deps.getCurrentHeadSha ?? defaultGetCurrentHeadSha;
  const reset = deps.resetWorktree ?? defaultResetWorktree;
  const discover = deps.discoverTestCodeunits ?? defaultDiscoverTestCodeunits;
  const changedFilesOf = deps.getChangedFiles ?? defaultGetChangedFiles;
  const discoverApps = deps.discoverAlApps ?? defaultDiscoverAlApps;
  const { config } = deps;

  return {
    name: 'build-and-test',
    canRun: () => true,
    async execute(state, ctx) {
      const worktree = state.outputs.worktree as WorktreeContext | undefined;
      const environment = state.outputs.environment as EnvironmentOutput | undefined;
      const wiCtx = state.outputs.wiContext as WorkItemContext | undefined;
      if (!worktree || !environment || !wiCtx) {
        throw new Error(
          'build-and-test requires state.outputs.worktree, .environment, and .wiContext to be populated by upstream stages',
        );
      }
      const callOpts = { worktreePath: worktree.path, signal: ctx.signal };

      const live = await deps.continiaCli.waitForRunning(environment.envId, callOpts);
      const env: EnvironmentOutput = {
        ...environment,
        status: live.status,
        url: live.url ?? environment.url,
      };
      state.outputs.environment = env;

      // A fresh environment can't be interacted with until the Continia Core
      // Internal Activation App is installed. Idempotent — safe on re-entry.
      await deps.continiaCli.installAppById(env.envId, ACTIVATION_APP_ID, callOpts);

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
        throw new VerificationFailedError(
          0,
          true,
          `no test codeunits discovered under ${testScanPaths.join(', ')}`,
        );
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
      deps.logger.info(
        `build-and-test: running ${codeunits.length} test codeunit(s) — ${selection.reason}`,
      );
      if (selection.droppedByCap > 0) {
        // Never silent: a truncated run that goes green must not read as
        // "everything passed".
        deps.logger.info(
          `build-and-test: WARNING ${selection.droppedByCap} selected codeunit(s) dropped by ` +
            `CONTINIA_MAX_TEST_CODEUNITS=${config.maxTestCodeunits} — this round does NOT cover them`,
        );
      }
      if (codeunits.length === 0) {
        // Fail loudly rather than green-washing: an empty selection means the
        // change is unverified, which is exactly what this gate exists to catch.
        throw new VerificationFailedError(
          0,
          true,
          `no test codeunits selected for the changed files (${selection.reason}); ` +
            `set TEST_SELECTION=all to run the full suite`,
        );
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
        throw new Error(
          'build-and-test could not determine which apps to deploy: no app.json owns the changed ' +
            'files or the selected tests. Set CONTINIA_APP_PATHS to pin the deploy set explicitly.',
        );
      }
      const pinned = config.continiaAppPaths.length > 0;
      deps.logger.info(
        `build-and-test: deploying ${appPaths.length} app(s) in dependency order — ${appPaths.join(' → ')}` +
          (pinned ? ' (pinned via CONTINIA_APP_PATHS)' : ' (derived)'),
      );
      if (pinned) {
        // Never silent, same reasoning as the dropped-codeunit warning above: a
        // pin replaces the per-WI derivation wholesale, so a test the
        // test-author wrote into a test app outside the list is never published
        // and this round runs a codeunit that isn't on the environment.
        deps.logger.warn(
          'build-and-test: WARNING CONTINIA_APP_PATHS is pinned, so the deploy set was NOT derived ' +
            'for this work item — apps outside the pin are not deployed, including test apps holding ' +
            'newly written tests. Unset it unless you are deliberately overriding the derivation.',
        );
      }

      for (const appPath of appPaths) {
        const info = await deps.continiaCli.installDependencies(env.envId, appPath, callOpts);
        if (info.skippedCount > 0 || info.symbolsMissingCount > 0) {
          deps.logger.warn(
            `build-and-test: deps install for ${appPath} reported ${info.skippedCount} skipped dep(s) ` +
              `and ${info.symbolsMissingCount} symbol gap(s) — catalogue misses surface later as compile errors`,
          );
        }
      }

      const canUseTool = composeCanUseTool([
        createBashAllowlist({ allow: CODER_BASH_ALLOW, deny: CODER_BASH_DENY }),
        createPathEscapeFilter(worktree.path),
      ]);

      let failure: VerificationFailure | undefined;
      // `attempt` = fix attempts consumed before this verification round.
      for (let attempt = 0; attempt <= config.maxTestFixAttempts; attempt++) {
        if (ctx.abortFlag.aborted) return state;

        if (attempt > 0 && failure) {
          // Same reasoning as the revision loop: each fix call is a full coder
          // session, and the orchestrator's cost gate does not run again until
          // this stage returns.
          assertWithinCostCap(state, config.maxCostUsdPerWi, 'build-and-test');
          await runFixCall(failure, attempt);
        }

        // Re-download symbols every round: the fix call's reset path runs
        // `git clean -fd`, which deletes untracked .alpackages.
        for (const appPath of appPaths) {
          await deps.continiaCli.downloadSymbols(env.envId, appPath, callOpts);
        }

        const deploy: DeployAppResult[] = [];
        for (const appPath of appPaths) {
          deploy.push(...(await deps.continiaCli.deployApp(env.envId, appPath, callOpts)));
        }

        // Stop before the fix loop when the deploy failed for a reason no
        // source edit can address. Persist the round first so the failure is
        // diagnosable from state rather than only from the log.
        const blocker = findEnvironmentDeployFailure(deploy);
        if (blocker) {
          state.outputs.verification = {
            attempts: attempt,
            compiled: false,
            deploy,
            testRuns: [],
            passed: false,
          } satisfies VerificationOutput;
          throw new Error(
            `build-and-test could not deploy ${blocker.app}: ${blocker.code} — an environment ` +
              `or deploy-set problem, not something the code can fix. ` +
              `${blocker.error ?? '(no detail from the CLI)'}`,
          );
        }

        const compiled = deploy.every((e) => e.compiled && e.published);

        const testRuns: TestRunRecord[] = [];
        let passed = false;
        if (compiled) {
          // Strictly sequential — BC forbids parallel test jobs on one env.
          for (const cu of codeunits) {
            const run = await deps.continiaCli.runTests(env.envId, cu.id, {
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

        state.outputs.verification = {
          attempts: attempt,
          compiled,
          deploy,
          testRuns,
          passed,
        } satisfies VerificationOutput;

        if (passed) return state;

        failure = { compiled, deploy, testRuns };
        if (attempt === config.maxTestFixAttempts) {
          throw new VerificationFailedError(attempt, compiled, summarize(failure));
        }
      }
      return state;

      async function runFixCall(red: VerificationFailure, attempt: number): Promise<void> {
        const prompt = buildFixPrompt(
          red,
          wiCtx!,
          worktree!,
          env,
          attempt,
          config.maxTestFixAttempts,
          deps.discoveredSkills,
        );
        const baselineSha = await getHead(worktree!.path);
        for (let retry = 0; retry <= MAX_TRANSIENT_RETRIES; retry++) {
          try {
            const { costUsd, toolUsage, usage } = await deps.runner.run<CoderOutput>({
              prompt,
              label: `test-fixer (attempt ${attempt} of ${config.maxTestFixAttempts})`,
              schema: coderOutputSchema,
              model: modelFor(config, 'test-fixer'),
              tools: ['Read', 'Grep', 'Glob', 'Bash', 'Skill', 'Edit', 'Write'],
              disallowedTools: ['NotebookEdit', ...STRUCTURED_OUTPUT_DENIED_TOOLS],
              cwd: worktree!.path,
              systemPromptAppend: deps.fixerPromptTemplate,
              settingSources: ['project'],
              maxTurns: config.coderMaxTurns,
              canUseTool,
              signal: ctx.signal,
            });
            // `test-fixer`, not `build-and-test`: the stage itself makes no LLM
            // call, and billing the fixer to the stage buries the one thing worth
            // seeing — how many rounds of AL fixes a red test round actually cost.
            createCostTracker(state).add('test-fixer', costUsd, usage);
            createToolUsageTracker(state).add('test-fixer', toolUsage);
            return;
          } catch (err) {
            await reset(worktree!.path, baselineSha);
            if (err instanceof AgentOutputParseError && retry < MAX_TRANSIENT_RETRIES) {
              continue;
            }
            throw err;
          }
        }
      }
    },
  };
}
