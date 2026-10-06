import type { AppConfig, DraftPrOutput, EnvironmentOutput } from '../types/index.ts';
import type { AdoClient } from '../sdk/azure-devops-client.ts';
import type { PipelineStateStore } from '../state/state-store.ts';
import type { Logger } from '../utils/logger.ts';
import { TERMINAL_ENV_STATUSES, type ContiniaCli } from './continia-cli.ts';

/** Written to `state.outputs.environmentDeletedAt` once a WI's environment is gone. */
export const ENV_DELETED_KEY = 'environmentDeletedAt';

export interface EnvCleanupDeps {
  config: AppConfig;
  logger: Logger;
  ado: Pick<AdoClient, 'getPullRequestStatus'>;
  store: PipelineStateStore;
  continiaCli: Pick<ContiniaCli, 'deleteEnvironment' | 'getEnvironment'>;
  /** Injectable clock for the deleted-at stamp. */
  now?: () => Date;
}

/**
 * Delete the BC environment of every WI whose draft PR is completed or
 * abandoned. Returns how many were deleted.
 *
 * The environment stays while the PR is open: its URL and login are in the PR
 * description for the human reviewer. Once the PR closes nobody can use it, and
 * the account's 50-environment quota is shared with every developer — an
 * overnight experiment exhausted it on 2026-10-03, which blocked env-provision
 * for production too. DemoPortal's own expiry (~14 days, and sometimes sooner)
 * is far too slow to rely on.
 *
 * Only an environment whose name the pipeline gave it (`wi-<id>-…`) is ever
 * deleted. Every failure is per-WI and logged; one bad PR lookup must not stop
 * the sweep, and a sweep must never fail a poll cycle.
 */
export async function sweepClosedPrEnvironments(deps: EnvCleanupDeps): Promise<number> {
  const { config, logger, ado, store, continiaCli } = deps;
  if (!config.deleteEnvOnPrClose) return 0;
  const now = deps.now ?? (() => new Date());
  let deleted = 0;

  for (const state of store.listAll()) {
    const env = state.outputs.environment as EnvironmentOutput | undefined;
    const pr = state.outputs.draftPr as DraftPrOutput | undefined;
    if (!env?.envId || !pr?.id || state.outputs[ENV_DELETED_KEY]) continue;
    const id = state.workItemId;
    if (!env.name.startsWith(`wi-${id}-`)) {
      logger.warn(`WI ${id}: not deleting environment ${env.envId} — '${env.name}' is not a pipeline-created name`);
      continue;
    }

    let status: string;
    try {
      status = await ado.getPullRequestStatus(config.repositoryName, pr.id);
    } catch (err) {
      logger.warn(`WI ${id}: could not read PR ${pr.id} status: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (status !== 'completed' && status !== 'abandoned') continue;

    const opts = { worktreePath: config.targetRepoPath };
    try {
      await continiaCli.deleteEnvironment(env.envId, opts);
    } catch (err) {
      // Already gone (DemoPortal expired it early, or someone deleted it by
      // hand) is the outcome we wanted. Anything else is retried next cycle.
      const gone = await continiaCli
        .getEnvironment(env.envId, opts)
        .then((info) => TERMINAL_ENV_STATUSES.has(info.status))
        .catch(() => false);
      if (!gone) {
        logger.warn(
          `WI ${id}: could not delete environment ${env.envId} (PR ${pr.id} ${status}): ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
    }
    state.outputs[ENV_DELETED_KEY] = now().toISOString();
    store.save(state);
    deleted += 1;
    logger.info(`WI ${id}: deleted environment ${env.envId} (${env.name}) — PR ${pr.id} ${status}`);
  }
  return deleted;
}
