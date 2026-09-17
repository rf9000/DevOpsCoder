import type { Stage } from '../stage.ts';
import type { EnvironmentOutput, WorktreeContext } from '../../types/index.ts';
import type { WorkItemContext } from '../../services/wi-context.ts';
import { assertWithinCostCap } from '../../utils/cost-tracker.ts';
import type { BuildAndTestDeps } from './build-and-test.ts';
import { defaultGetCurrentHeadSha, defaultResetWorktree } from './_stage-helpers.ts';
import {
  prepareVerification,
  runTestFixCall,
  runVerificationRound,
  type VerificationFailure,
  type VerificationSetupCache,
} from './_verification.ts';

/**
 * `VerifyGateDeps` mirrors `BuildAndTestDeps` exactly — same CLI, runner,
 * fixer prompt, and test overrides. The two stages differ only in policy
 * (see the module doc below), not in what they need injected.
 */
export type VerifyGateDeps = BuildAndTestDeps;

/**
 * Deploy + run the repo's existing tests after every revision round.
 *
 * Same mechanism as `build-and-test`, opposite failure policy. Three conditions
 * that are terminal for the final gate are ordinary here and degrade to a
 * logged skip:
 *
 * - **Nothing discovered / nothing selected.** `test-author` has not run yet, so
 *   a change touching files no existing codeunit covers is the normal case, not
 *   an unverified PR.
 * - **An environment-class deploy failure.** No AL edit fixes `unpublished-sibling`
 *   or `symbol-fetch-failed`. Failing the revision loop on one would let an
 *   environment hiccup destroy a work item's code review; the final gate still
 *   catches it authoritatively before any PR is opened.
 *
 * Compile errors and red tests are neither — they are statements about the code,
 * so they feed `runTestFixCall` exactly as they do in the final gate, bounded by
 * the smaller `maxInLoopFixAttempts`.
 */
export function createVerifyGateStage(deps: VerifyGateDeps): Stage {
  return {
    name: 'verify',
    canRun: () => true,
    async execute(state, ctx) {
      const { config } = deps;
      if (config.skipBuildTest) return state;

      const worktree = state.outputs.worktree as WorktreeContext | undefined;
      const environment = state.outputs.environment as EnvironmentOutput | undefined;
      const wiCtx = state.outputs.wiContext as WorkItemContext | undefined;
      if (!worktree || !environment || !wiCtx) {
        // Not an error: SKIP_BUILD_TEST-less runs always have these, and a
        // partially-populated state means an upstream stage already failed.
        deps.logger.warn('verify: worktree/environment/wiContext not populated — skipping');
        return state;
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
        logPrefix: 'verify',
        onEnvironmentLive: (env) => {
          state.outputs.environment = env;
        },
        ...(deps.discoverTestCodeunits ? { discoverTestCodeunits: deps.discoverTestCodeunits } : {}),
        ...(deps.getChangedFiles ? { getChangedFiles: deps.getChangedFiles } : {}),
        ...(deps.discoverAlApps ? { discoverAlApps: deps.discoverAlApps } : {}),
      });
      state.outputs.environment = setup.env;
      if (setup.skipReason) {
        deps.logger.warn(`verify: ${setup.skipReason} — skipping verification for this round`);
        return state;
      }

      const maxAttempts = config.maxInLoopFixAttempts ?? 1;
      let failure: VerificationFailure | undefined;
      for (let attempt = 0; attempt <= maxAttempts; attempt++) {
        if (ctx.abortFlag.aborted) return state;
        if (attempt > 0 && failure) {
          assertWithinCostCap(state, config.maxCostUsdPerWi, 'verify');
          await runTestFixCall({
            runner: deps.runner,
            config,
            fixerPromptTemplate: deps.fixerPromptTemplate,
            discoveredSkills: deps.discoveredSkills,
            failure,
            wiCtx,
            worktree,
            env: setup.env,
            attempt,
            maxAttempts,
            state,
            signal: ctx.signal,
            getCurrentHeadSha: deps.getCurrentHeadSha ?? defaultGetCurrentHeadSha,
            resetWorktree: deps.resetWorktree ?? defaultResetWorktree,
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
          deps.logger.warn(
            `verify: could not deploy ${b.app}: ${b.code} — an environment problem, not ` +
              `something this round's code can fix. Skipping verification; build-and-test ` +
              `will judge it. ${b.error ?? '(no detail from the CLI)'}`,
          );
          return state;
        }
        if (round.output.passed) return state;
        failure = round.failure;
      }
      // Still red after the fix budget. The reviewer judges the diff anyway and
      // the round counts against MAX_REVISIONS — the final gate is what blocks a PR.
      deps.logger.warn(
        `verify: still red after ${maxAttempts} in-loop fix attempt(s) — the reviewer will ` +
          `judge this round's diff regardless`,
      );
      return state;
    },
  };
}
