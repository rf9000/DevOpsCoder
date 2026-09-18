import type { Stage } from '../stage.ts';
import {
  CostExceededError,
  type EnvironmentOutput,
  type VerificationOutput,
  type WorktreeContext,
} from '../../types/index.ts';
import type { WorkItemContext } from '../../services/wi-context.ts';
import { assertWithinCostCap } from '../../utils/cost-tracker.ts';
import type { BuildAndTestDeps } from './build-and-test.ts';
import { defaultGetCurrentHeadSha, defaultResetWorktree, isAbortError } from './_stage-helpers.ts';
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
 * A `VerificationOutput` for a round that never actually verified anything.
 * `attempts`/`compiled`/`deploy`/`testRuns`/`passed` default to the emptiest
 * honest values and can be overridden (e.g. the environment-blocker path
 * keeps the round's real `deploy` array); `skipped`/`skipReason` are always
 * stamped last so a caller cannot accidentally clobber them.
 */
function skippedVerification(
  reason: string,
  base: Partial<VerificationOutput> = {},
): VerificationOutput {
  return {
    attempts: 0,
    compiled: false,
    deploy: [],
    testRuns: [],
    passed: false,
    ...base,
    skipped: true,
    skipReason: reason,
  };
}

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
 *
 * **Never throws for an environment or CLI fault.** Everything from
 * `prepareVerification` through the round loop and the fix calls runs inside
 * one try/catch: `waitForRunning` can throw on a terminal/deleted environment
 * or a poll timeout, `installAppById`/`installDependencies` can throw on a CLI
 * error, `downloadSymbols`/`deployApp` can throw instead of returning failed
 * rows, and a persistent `AgentOutputParseError` propagates out of
 * `runTestFixCall`. None of those are things this round's code can fix, and
 * the final `build-and-test` gate remains the authority that judges them
 * before any PR opens — so the cost of swallowing one here is an unverified
 * round that is loudly logged, while the cost of throwing is losing the whole
 * revision loop (and the code review in it) to one deleted environment. Only
 * `CostExceededError` (the loop's cost gate depends on it propagating) and an
 * aborted signal/flag are rethrown; everything else, including a programming
 * error in this machinery, is logged at WARN and swallowed. This is the same
 * "a judgement that cannot be made must not block a run" asymmetry
 * `TERMINAL_ENV_STATUSES` already encodes.
 */
export function createVerifyGateStage(deps: VerifyGateDeps): Stage {
  return {
    name: 'verify',
    canRun: () => true,
    async execute(state, ctx) {
      const { config } = deps;
      if (config.skipBuildTest) {
        state.outputs.verification = skippedVerification('SKIP_BUILD_TEST is set');
        return state;
      }

      const worktree = state.outputs.worktree as WorktreeContext | undefined;
      const environment = state.outputs.environment as EnvironmentOutput | undefined;
      const wiCtx = state.outputs.wiContext as WorkItemContext | undefined;
      if (!worktree || !environment || !wiCtx) {
        // Not an error: SKIP_BUILD_TEST-less runs always have these, and a
        // partially-populated state means an upstream stage already failed.
        const reason = 'worktree/environment/wiContext not populated';
        deps.logger.warn(`verify: ${reason} — skipping`);
        state.outputs.verification = skippedVerification(reason);
        return state;
      }

      try {
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
          state.outputs.verification = skippedVerification(setup.skipReason);
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
          if (round.environmentBlocker) {
            const b = round.environmentBlocker;
            deps.logger.warn(
              `verify: could not deploy ${b.app}: ${b.code} — an environment problem, not ` +
                `something this round's code can fix. Skipping verification; build-and-test ` +
                `will judge it. ${b.error ?? '(no detail from the CLI)'}`,
            );
            // Keep the round's real deploy data (diagnosable), but stamp it
            // skipped so a consumer never reads this as "did not compile" —
            // the gate has already classified this as not the code's fault.
            state.outputs.verification = skippedVerification(
              `could not deploy ${b.app}: ${b.code ?? '(no code)'}` +
                (b.error ? ` — ${b.error}` : ''),
              round.output,
            );
            return state;
          }
          state.outputs.verification = round.output;
          if (round.output.passed) return state;
          failure = round.failure;
        }
        // Still red after the fix budget. This IS real verification data —
        // not a skip — so it is left as the plain (unskipped) round output
        // set above: the reviewer judges the diff anyway and the round counts
        // against MAX_REVISIONS; the final gate is what blocks a PR.
        deps.logger.warn(
          `verify: still red after ${maxAttempts} in-loop fix attempt(s) — the reviewer will ` +
            `judge this round's diff regardless`,
        );
        return state;
      } catch (err) {
        // `isAbortError` only recognises the rejection `AgentRunner` produces.
        // Everything else this stage calls goes through the Continia CLI, which
        // surfaces a cancelled signal as an ordinary `ContiniaCliError` — the
        // "aborted while waiting for Running" branch most visibly, but any of
        // `waitForRunning`/`installAppById`/`installDependencies`/
        // `downloadSymbols`/`deployApp`/`runTests` can. Swallowing one of those
        // made a `revision-loop` timeout (which aborts the signal but never
        // sets `abortFlag`) log an environment-fault diagnosis and stamp a
        // skipped verification for what was actually a timeout. Asking the
        // signal is robust in a way that string-matching CLI messages is not.
        if (err instanceof CostExceededError || isAbortError(err) || ctx.signal.aborted) throw err;
        const message = err instanceof Error ? err.message : String(err);
        // Deliberately unconditional, every round: three rounds against a
        // dead environment must produce three warnings, not one memoised one.
        // Neutral wording on purpose. Most of what lands here is an environment
        // or CLI fault, but not all of it is: `prepareVerification` also throws
        // when the deploy set cannot be derived, which is a configuration
        // problem. Naming a cause the catch-all cannot actually establish sent
        // operators after the wrong thing, so the line reports the effect
        // (this round went unverified) and leaves the message to speak for the
        // cause.
        deps.logger.warn(
          `verify: could not verify this round: ${message} — skipping verification; ` +
            `build-and-test will judge it before any PR opens.`,
        );
        state.outputs.verification = skippedVerification(message);
        return state;
      }
    },
  };
}
