import type { Stage } from '../stage.ts';
import type { ContiniaCli } from '../../services/continia-cli.ts';
import { ContiniaCliError } from '../../services/continia-cli.ts';
import type { AppConfig, EnvironmentOutput, WorktreeContext } from '../../types/index.ts';
import type { Logger } from '../../utils/logger.ts';

export interface EnvProvisionDeps {
  config: AppConfig;
  continiaCli: ContiniaCli;
  logger: Logger;
}

/** DemoPortal env names are kept short; slug tails beyond this are dropped. */
const MAX_ENV_NAME_LENGTH = 40;

/**
 * Fire-and-forget provisioning of the per-WI BC environment: `env create` +
 * `env start`, persisted to `state.outputs.environment` — intentionally NO
 * polling to Running. The orchestrator is strictly sequential, so the 1-3 min
 * boot runs concurrently with the (much longer) revision loop; build-and-test
 * does the `waitForRunning`. Environments are never torn down — DemoPortal
 * auto-deletes them ~10 days after creation.
 *
 * Re-entry mirrors worktree-setup's persisted-reuse: a persisted envId is
 * validated via `env get` and reused (started if needed); if it no longer
 * resolves, a fresh environment is created and the record overwritten.
 */
export function createEnvProvisionStage(deps: EnvProvisionDeps): Stage {
  return {
    name: 'env-provision',
    canRun: () => true,
    async execute(state, ctx) {
      const worktree = state.outputs.worktree as WorktreeContext | undefined;
      if (!worktree) {
        throw new Error('env-provision requires state.outputs.worktree (worktree-setup must run first)');
      }
      const callOpts = { worktreePath: worktree.path, signal: ctx.signal };

      const persisted = state.outputs.environment as EnvironmentOutput | undefined;
      if (persisted) {
        try {
          const live = await deps.continiaCli.getEnvironment(persisted.envId, callOpts);
          if (live.status !== 'Running' && live.status !== 'Starting') {
            await deps.continiaCli.startEnvironment(persisted.envId, callOpts);
          }
          state.outputs.environment = {
            ...persisted,
            status: live.status,
            url: live.url ?? persisted.url,
          } satisfies EnvironmentOutput;
          return state;
        } catch (err) {
          if (!(err instanceof ContiniaCliError)) throw err;
          deps.logger.info(
            `env-provision: persisted environment ${persisted.envId} no longer resolves (${err.message}); creating a fresh one`,
          );
        }
      }

      const name = `wi-${state.workItemId}-${state.slug}`.slice(0, MAX_ENV_NAME_LENGTH);
      const created = await deps.continiaCli.createEnvironment(
        name,
        deps.config.continiaEnvProfileId,
        callOpts,
      );
      await deps.continiaCli.startEnvironment(created.id, callOpts);

      state.outputs.environment = {
        envId: created.id,
        name,
        url: created.url,
        status: created.status,
        createdAt: ctx.now().toISOString(),
      } satisfies EnvironmentOutput;
      return state;
    },
  };
}
