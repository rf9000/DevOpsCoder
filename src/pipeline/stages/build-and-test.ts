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
  defaultGetCurrentHeadSha,
  defaultResetWorktree,
} from './_stage-helpers.ts';

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

      for (const appPath of config.continiaAppPaths) {
        const info = await deps.continiaCli.installDependencies(env.envId, appPath, callOpts);
        if (info.skippedCount > 0 || info.symbolsMissingCount > 0) {
          deps.logger.warn(
            `build-and-test: deps install for ${appPath} reported ${info.skippedCount} skipped dep(s) ` +
              `and ${info.symbolsMissingCount} symbol gap(s) — catalogue misses surface later as compile errors`,
          );
        }
      }

      const codeunits = await discover(worktree.path, config.continiaTestAppPaths);
      if (codeunits.length === 0) {
        throw new VerificationFailedError(
          0,
          true,
          `no test codeunits discovered under ${config.continiaTestAppPaths.join(', ')}`,
        );
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
          await runFixCall(failure, attempt);
        }

        // Re-download symbols every round: the fix call's reset path runs
        // `git clean -fd`, which deletes untracked .alpackages.
        for (const appPath of config.continiaAppPaths) {
          await deps.continiaCli.downloadSymbols(env.envId, appPath, callOpts);
        }

        const deploy: DeployAppResult[] = [];
        for (const appPath of config.continiaAppPaths) {
          deploy.push(...(await deps.continiaCli.deployApp(env.envId, appPath, callOpts)));
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
            const { costUsd, toolUsage } = await deps.runner.run<CoderOutput>({
              prompt,
              schema: coderOutputSchema,
              tools: ['Read', 'Grep', 'Glob', 'Bash', 'Skill', 'Edit', 'Write'],
              disallowedTools: ['NotebookEdit'],
              cwd: worktree!.path,
              systemPromptAppend: deps.fixerPromptTemplate,
              settingSources: ['project'],
              maxTurns: config.coderMaxTurns,
              canUseTool,
              signal: ctx.signal,
            });
            createCostTracker(state).add('build-and-test', costUsd);
            createToolUsageTracker(state).add('build-and-test', toolUsage);
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
