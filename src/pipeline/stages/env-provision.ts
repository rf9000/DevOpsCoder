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
 * resolves, OR its BC version no longer satisfies the worktree, a fresh
 * environment is created and the record overwritten.
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

    const profiles = (await deps.continiaCli.listProfiles(chosen, callOpts)).filter(
      (p) => p.isEnabled !== false,
    );
    const wanted = deps.config.continiaEnvLocalization;
    const match = profiles.find(
      (p) => p.localization?.toLowerCase() === wanted.toLowerCase(),
    );
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

          if (required && liveVersion && !satisfiesBcVersion(required, liveVersion)) {
            // The resume case that would otherwise never heal: a work item that
            // banked an environment from a stale pin keeps reusing it forever.
            deps.logger.info(
              `env-provision: persisted environment ${persisted.envId} is BC ${liveVersion}, which does not ` +
                `satisfy the BC ${required} this worktree requires — creating a fresh one`,
            );
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

      // Derived profiles are correct by construction — the version came from the
      // catalogue. A pin is the case worth the extra `env get`: it is the one
      // path where the profile and the requirement were never compared.
      let bcVersion = created.bcVersion;
      if (pinnedProfileId && required) {
        const live = await deps.continiaCli.getEnvironment(created.id, callOpts);
        bcVersion = live.bcVersion ?? bcVersion;
        if (bcVersion && !satisfiesBcVersion(required, bcVersion)) {
          throw new Error(
            `env-provision: CONTINIA_ENV_PROFILE_ID=${pinnedProfileId} created a BC ${bcVersion} environment, ` +
              `but this worktree's app.json files require BC ${required}. Update the pin to a matching ` +
              `profile, or unset CONTINIA_ENV_PROFILE_ID to let the profile be derived.`,
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
