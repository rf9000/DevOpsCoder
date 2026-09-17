import type { Stage } from '../stage.ts';
import type { AgentRunner } from '../agent-stage.ts';
import type { ContiniaCli } from '../../services/continia-cli.ts';
import type { WorkItemContext } from '../../services/wi-context.ts';
import type { DiscoveredSkill } from '../../services/skill-loader.ts';
import type { Logger } from '../../utils/logger.ts';
import {
  VerificationFailedError,
  type AppConfig,
  type EnvironmentOutput,
  type WorktreeContext,
} from '../../types/index.ts';
import type { DiscoveredTestCodeunit } from '../../utils/al-test-discovery.ts';
import { assertWithinCostCap } from '../../utils/cost-tracker.ts';
import type { AlApp } from '../../utils/al-app-graph.ts';
import {
  prepareVerification,
  runTestFixCall,
  runVerificationRound,
  type VerificationFailure,
  type VerificationSetupCache,
} from './_verification.ts';

// The verification machinery lives in `_verification.ts` so the in-loop gate
// can reuse it; these stay on this module's surface because that is where the
// rest of the codebase (and its tests) already import them from. Re-exported
// rather than defined-here-and-imported-there to keep the two modules acyclic.
export {
  buildFixPrompt,
  resolveAppPaths,
  findEnvironmentDeployFailure,
  CODER_FIXABLE_DEPLOY_CODES,
} from './_verification.ts';
export type { VerificationFailure, ResolveAppPathsArgs } from './_verification.ts';

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

      state.outputs.verificationSetup ??= {};
      const cache = state.outputs.verificationSetup as VerificationSetupCache;
      const setup = await prepareVerification({
        config,
        continiaCli: deps.continiaCli,
        logger: deps.logger,
        worktree,
        environment,
        signal: ctx.signal,
        cache,
        ...(deps.discoverTestCodeunits ? { discoverTestCodeunits: deps.discoverTestCodeunits } : {}),
        ...(deps.getChangedFiles ? { getChangedFiles: deps.getChangedFiles } : {}),
        ...(deps.discoverAlApps ? { discoverAlApps: deps.discoverAlApps } : {}),
      });
      state.outputs.environment = setup.env;
      // The final gate's policy: an unverified change must never reach a PR.
      if (setup.skipReason) throw new VerificationFailedError(0, true, setup.skipReason);

      let failure: VerificationFailure | undefined;
      // `attempt` = fix attempts consumed before this verification round.
      for (let attempt = 0; attempt <= config.maxTestFixAttempts; attempt++) {
        if (ctx.abortFlag.aborted) return state;

        if (attempt > 0 && failure) {
          // Same reasoning as the revision loop: each fix call is a full coder
          // session, and the orchestrator's cost gate does not run again until
          // this stage returns.
          assertWithinCostCap(state, config.maxCostUsdPerWi, 'build-and-test');
          await runTestFixCall({
            runner: deps.runner,
            config,
            logger: deps.logger,
            fixerPromptTemplate: deps.fixerPromptTemplate,
            discoveredSkills: deps.discoveredSkills,
            failure,
            wiCtx,
            worktree,
            env: setup.env,
            attempt,
            maxAttempts: config.maxTestFixAttempts,
            state,
            signal: ctx.signal,
            ...(deps.getCurrentHeadSha ? { getCurrentHeadSha: deps.getCurrentHeadSha } : {}),
            ...(deps.resetWorktree ? { resetWorktree: deps.resetWorktree } : {}),
          });
        }

        const round = await runVerificationRound({
          continiaCli: deps.continiaCli,
          env: setup.env,
          worktree,
          appPaths: setup.appPaths,
          codeunits: setup.codeunits,
          config,
          attempt,
          signal: ctx.signal,
        });
        state.outputs.verification = round.output;

        if (round.environmentBlocker) {
          const b = round.environmentBlocker;
          throw new Error(
            `build-and-test could not deploy ${b.app}: ${b.code} — an environment ` +
              `or deploy-set problem, not something the code can fix. ` +
              `${b.error ?? '(no detail from the CLI)'}`,
          );
        }

        if (round.output.passed) return state;

        failure = round.failure;
        if (attempt === config.maxTestFixAttempts) {
          throw new VerificationFailedError(attempt, round.output.compiled, summarize(failure!));
        }
      }
      return state;
    },
  };
}
