import type { Stage } from '../stage.ts';
import type { ContiniaCli, ContiniaCallOpts } from '../../services/continia-cli.ts';
import { ContiniaCliError } from '../../services/continia-cli.ts';
import type { AppConfig, EnvironmentOutput, WorktreeContext } from '../../types/index.ts';
import type { Logger } from '../../utils/logger.ts';
import { discoverAlApps as defaultDiscoverAlApps, type AlApp } from '../../utils/al-app-graph.ts';
import { maxBcVersion, satisfiesBcVersion, selectBcVersion } from '../../utils/bc-version.ts';

export interface EnvProvisionDeps {
  config: AppConfig;
  continiaCli: ContiniaCli;
  logger: Logger;
  /** Test override for the app.json scan that drives version derivation. */
  discoverAlApps?: (worktreePath: string) => AlApp[];
}

/** DemoPortal env names are kept short; slug tails beyond this are dropped. */
const MAX_ENV_NAME_LENGTH = 40;

/**
 * The highest BC version any app in the worktree asks for, across both
 * `application` and `platform`.
 *
 * Every app, not the deploy set: that is derived in `build-and-test` from the
 * files the coder changed, and at provision time the coder has not run. The
 * eventual deploy set is always a subset of what is scanned here, so the
 * maximum over everything is guaranteed to satisfy it.
 */
export function resolveRequiredBcVersion(apps: AlApp[]): string | undefined {
  const declared: string[] = [];
  for (const app of apps) {
    if (app.application) declared.push(app.application);
    if (app.platform) declared.push(app.platform);
  }
  return maxBcVersion(declared);
}

/**
 * Fire-and-forget provisioning of the per-WI BC environment: profile selection
 * + `env create` + `env start`, persisted to `state.outputs.environment` —
 * intentionally NO polling to Running. The orchestrator is strictly sequential,
 * so the 1-3 min boot runs concurrently with the (much longer) revision loop;
 * build-and-test does the `waitForRunning`. Environments are never torn down —
 * DemoPortal auto-deletes them ~10 days after creation.
 *
 * The profile is DERIVED from the worktree's manifests rather than pinned. The
 * `continia-env-setup` procedure developers follow by hand is three steps —
 * list versions, pick one, create — and this stage previously ran only the
 * third, against a GUID frozen in config. That is how a BC 28.1 environment
 * came to be built for a branch requiring 29.0.0.0, and why the mismatch only
 * surfaced eight stages later as `symbol-fetch-failed`, after $33 of spend.
 *
 * Re-entry mirrors worktree-setup's persisted-reuse: a persisted envId is
 * validated via `env get` and reused (started if needed); if it no longer
 * resolves, OR its BC version no longer satisfies the worktree, OR that
 * version cannot be established at all, a fresh environment is created and
 * the record overwritten.
 */
export function createEnvProvisionStage(deps: EnvProvisionDeps): Stage {
  const discover = deps.discoverAlApps ?? defaultDiscoverAlApps;

  /** Steps 1-3 of the env-setup procedure: versions -> lowest satisfying -> localization. */
  async function selectProfileId(required: string, callOpts: ContiniaCallOpts): Promise<string> {
    const available = await deps.continiaCli.listProfileVersions(callOpts);
    const chosen = selectBcVersion(required, available);
    if (!chosen) {
      throw new Error(
        `env-provision: no DemoPortal profile version satisfies the BC ${required} required by this ` +
          `worktree's app.json files (available: ${available.join(', ') || 'none'}). ` +
          `Set CONTINIA_ENV_PROFILE_ID to pin a profile explicitly if this is deliberate.`,
      );
    }

    const enabled = (await deps.continiaCli.listProfiles(chosen, callOpts)).filter(
      (p) => p.isEnabled !== false,
    );
    // Re-check the version the rows actually carry. `--bc-version` is a
    // server-side filter no test in this repo has ever run against the live
    // CLI, and a list that came back unfiltered would hand the localization
    // match a 28.1 profile that looks exactly as valid as a 29.0 one. A row
    // with no bcVersion at all is dropped here rather than in the schema, so
    // one malformed row cannot fail the whole query (see continia-cli.ts).
    const profiles = enabled.filter(
      (p) => p.bcVersion !== undefined && satisfiesBcVersion(required, p.bcVersion),
    );
    if (profiles.length < enabled.length) {
      deps.logger.warn(
        `env-provision: dropped ${enabled.length - profiles.length} of ${enabled.length} enabled profile(s) ` +
          `returned for BC ${chosen}: their reported bcVersion is missing or below the required BC ${required} ` +
          `('continia env profiles list --bc-version' did not filter as expected)`,
      );
    }

    const wanted = deps.config.continiaEnvLocalization;
    // Sorted, not `.find`: the real rows carry a `platform` field, so a
    // version/localization pair can publish more than one profile and CLI
    // ordering is not a promise. Pick deterministically and say so.
    // Codepoint order, not `localeCompare` — the runtime may be built without
    // ICU (Bun returns 0 for every pair), and the whole point here is a
    // choice that does not vary between hosts.
    const matches = profiles
      .filter((p) => p.localization?.toLowerCase() === wanted.toLowerCase())
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (matches.length > 1) {
      deps.logger.warn(
        `env-provision: BC ${chosen} publishes ${matches.length} enabled '${wanted}' profiles ` +
          `(${matches.map((p) => p.id).join(', ')}) — taking the lowest id`,
      );
    }
    const match = matches[0];
    if (!match) {
      const have = profiles
        .map((p) => p.localization ?? '?')
        .sort()
        .join(', ');
      throw new Error(
        `env-provision: BC ${chosen} publishes no enabled '${wanted}' profile ` +
          `(available localizations: ${have || 'none'}). Set CONTINIA_ENV_LOCALIZATION to one of ` +
          `those, or CONTINIA_ENV_PROFILE_ID to pin a profile.`,
      );
    }

    deps.logger.info(
      `env-provision: worktree requires BC ${required} — selected ${chosen} '${wanted}' ` +
        `profile ${match.id}${match.description ? ` (${match.description})` : ''}`,
    );
    return match.id;
  }

  return {
    name: 'env-provision',
    canRun: () => true,
    async execute(state, ctx) {
      const worktree = state.outputs.worktree as WorktreeContext | undefined;
      if (!worktree) {
        throw new Error('env-provision requires state.outputs.worktree (worktree-setup must run first)');
      }
      const callOpts = { worktreePath: worktree.path, signal: ctx.signal };

      const required = resolveRequiredBcVersion(discover(worktree.path));
      const pinnedProfileId = deps.config.continiaEnvProfileId.trim();

      const persisted = state.outputs.environment as EnvironmentOutput | undefined;
      if (persisted) {
        try {
          const live = await deps.continiaCli.getEnvironment(persisted.envId, callOpts);
          const liveVersion = live.bcVersion ?? persisted.bcVersion;

          // Three outcomes, and the middle one is the whole point: an
          // environment whose version cannot be established is NOT reused.
          // `env get` can omit bcVersion, report it under a name we do not
          // read, or null it out for a Stopped/Draft environment, and every
          // state file written before this plan carries none — so "unknown"
          // is the live case on the first run after deploy, not a theoretical
          // one. Reusing it unchecked silently reproduces the $33 failure;
          // recreating costs a boot that overlaps the revision loop anyway.
          let recreateBecause: string | undefined;
          // Ownership first: a foreign environment's BC version is irrelevant,
          // and the cost of getting this wrong is not a wasted boot — it is
          // starting and deploying onto an environment a colleague or another
          // agent is using. The pipeline cannot enumerate environments (there is
          // no `env list` in ContiniaCli), so a foreign id can only reach here
          // through a hand-edited or copied state file; the check is cheap and
          // the failure is loud, so it is verified rather than assumed.
          //
          // No description means no judgement is possible, and an impossible
          // comparison never blocks — the same rule the version checks below use.
          const expectedPrefix = `wi-${state.workItemId}-`;
          if (live.description && !live.description.startsWith(expectedPrefix)) {
            recreateBecause =
              `it is named '${live.description}', which is not this work item's '${expectedPrefix}…' — it ` +
              `belongs to someone else, so it will not be started or deployed to; creating a fresh one`;
          } else if (required && !liveVersion) {
            recreateBecause =
              `its BC version could not be established ('env get' reported none and the state file records ` +
              `none), so it cannot be checked against the BC ${required} this worktree requires — recreating ` +
              `rather than reusing it unchecked`;
          } else if (required && liveVersion && !satisfiesBcVersion(required, liveVersion)) {
            // The resume case that would otherwise never heal: a work item that
            // banked an environment from a stale pin keeps reusing it forever.
            recreateBecause =
              `it is BC ${liveVersion}, which does not satisfy the BC ${required} this worktree requires — ` +
              `creating a fresh one`;
          }

          if (recreateBecause) {
            deps.logger.warn(`env-provision: persisted environment ${persisted.envId}: ${recreateBecause}`);
          } else {
            if (live.status !== 'Running' && live.status !== 'Starting') {
              await deps.continiaCli.startEnvironment(persisted.envId, callOpts);
            }
            state.outputs.environment = {
              ...persisted,
              status: live.status,
              url: live.url ?? persisted.url,
              bcVersion: liveVersion,
            } satisfies EnvironmentOutput;
            return state;
          }
        } catch (err) {
          if (!(err instanceof ContiniaCliError)) throw err;
          deps.logger.info(
            `env-provision: persisted environment ${persisted.envId} no longer resolves (${err.message}); creating a fresh one`,
          );
        }
      }

      let profileId: string;
      if (pinnedProfileId) {
        profileId = pinnedProfileId;
        if (!required) {
          deps.logger.info(
            'env-provision: CONTINIA_ENV_PROFILE_ID is pinned and no app.json declares "application" or ' +
              '"platform" — creating from the pin WITHOUT BC version validation',
          );
        }
      } else if (required) {
        profileId = await selectProfileId(required, callOpts);
      } else {
        throw new Error(
          `env-provision: no app.json under ${worktree.path} declares "application" or "platform", so the ` +
            `required BC version cannot be derived. Set CONTINIA_ENV_PROFILE_ID to pin a profile explicitly.`,
        );
      }

      const name = `wi-${state.workItemId}-${state.slug}`.slice(0, MAX_ENV_NAME_LENGTH);
      const created = await deps.continiaCli.createEnvironment(name, profileId, callOpts);
      await deps.continiaCli.startEnvironment(created.id, callOpts);

      // Validate whatever we just created, pinned or derived. A derived
      // profile is NOT correct by construction: the catalogue rows and the
      // `--bc-version` filter behind them are the same third-party CLI output
      // this stage exists to stop trusting blindly, and "it was chosen
      // carefully once" is exactly the argument that cost $33. `env create
      // --json` may not report bcVersion, so pay the one extra `env get`
      // unconditionally — it is one CLI call against a whole-pipeline failure.
      let bcVersion = created.bcVersion;
      if (required) {
        const live = await deps.continiaCli.getEnvironment(created.id, callOpts);
        bcVersion = live.bcVersion ?? bcVersion;
        if (!bcVersion) {
          deps.logger.warn(
            `env-provision: environment ${created.id} reports no BC version, so the BC ${required} this ` +
              `worktree requires could NOT be verified against it — proceeding unverified`,
          );
        } else if (!satisfiesBcVersion(required, bcVersion)) {
          throw new Error(
            pinnedProfileId
              ? `env-provision: CONTINIA_ENV_PROFILE_ID=${pinnedProfileId} created a BC ${bcVersion} environment, ` +
                `but this worktree's app.json files require BC ${required}. Update the pin to a matching ` +
                `profile, or unset CONTINIA_ENV_PROFILE_ID to let the profile be derived.`
              : `env-provision: the derived profile ${profileId} produced a BC ${bcVersion} environment, but this ` +
                `worktree's app.json files require BC ${required}. The DemoPortal profile catalogue and the ` +
                `environment it created disagree; set CONTINIA_ENV_PROFILE_ID to pin a known-good profile.`,
          );
        }
      }

      state.outputs.environment = {
        envId: created.id,
        name,
        url: created.url,
        status: created.status,
        createdAt: ctx.now().toISOString(),
        bcVersion: bcVersion ?? (pinnedProfileId ? undefined : required),
      } satisfies EnvironmentOutput;
      return state;
    },
  };
}
