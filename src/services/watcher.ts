import type { AppConfig, CycleStats } from '../types/index.ts';
import type { AdoClient } from '../sdk/azure-devops-client.ts';
import type { PipelineStateStore } from '../state/state-store.ts';
import type { Logger } from '../utils/logger.ts';
import { CLOSED_STATES, hasStatusCode, type Processor } from './processor.ts';
import type { AbortFlag } from '../pipeline/stage.ts';
import { runPool } from '../utils/pool.ts';
import { formatToolUsage } from '../utils/tool-usage-tracker.ts';
import { formatSpendLine } from '../utils/cost-report.ts';
import type { DemoPortalSession } from './demoportal-auth.ts';

/** Set to true to cut the watcher's sleep short (a sign-in finished). */
export interface WakeFlag {
  requested: boolean;
}

export interface WatcherDeps {
  config: AppConfig;
  logger: Logger;
  ado: AdoClient;
  store: PipelineStateStore;
  processor: Processor;
  abortFlag: AbortFlag;
  /**
   * Runs after every poll cycle: deletes environments whose PR has closed
   * (`sweepClosedPrEnvironments`). Absent when there is nothing to sweep
   * (dry runs, SKIP_BUILD_TEST).
   */
  sweepEnvironments?: () => Promise<number>;
  /** DemoPortal's Azure AD session; absent with an API token. Work is held while it needs a sign-in. */
  demoPortal?: DemoPortalSession;
  /** Wakes the sleeping watcher, e.g. when a sign-in finishes. */
  wake?: WakeFlag;
}

export function createAbortFlag(): AbortFlag {
  return { aborted: false };
}

function emptyStats(): CycleStats {
  return { considered: 0, completed: 0, paused: 0, failed: 0, skipped: 0, rejected: 0 };
}

export async function runPollCycle(deps: WatcherDeps): Promise<CycleStats> {
  const { config, logger, ado, store, processor, abortFlag } = deps;
  const stats = emptyStats();

  const tagged = await ado.queryWorkItemsByTag(config.triggerTag);
  await withdrawDroppedRejections(deps, new Set(tagged));
  const resumable = store.listResumable().map((s) => s.workItemId);
  const candidates = Array.from(new Set<number>([...tagged, ...resumable]));
  stats.considered = candidates.length;

  if (candidates.length === 0) {
    logger.info('poll cycle: no candidates');
    // Keeps the dashboard's sign-in card right while idle; never fails the cycle.
    await deps.demoPortal?.peek().catch((err) => logger.warn(`DemoPortal sign-in check failed :: ${err instanceof Error ? err.message : String(err)}`));
    return stats;
  }

  logger.info(`poll cycle: ${candidates.length} candidate(s)`);

  if (deps.demoPortal && !(await signedIn(deps.demoPortal, logger))) {
    logger.info(`DemoPortal sign-in needed; ${candidates.length} work item(s) wait. Sign in from the dashboard or run continia auth login`);
    return stats;
  }

  await runPool(candidates, Math.max(1, config.concurrency), async (id) => {
    if (abortFlag.aborted) return;
    try {
      const outcome = await processor.processWorkItem(id);
      // Second line rather than a longer first one: the outcome line is what
      // gets grepped, and a six-step split would push the outcome off-screen.
      if (outcome.kind !== 'skipped') {
        const split = formatSpendLine(outcome.perStage);
        if (split) logger.info(`WI ${id}: spend — ${split}`);
      }
      switch (outcome.kind) {
        case 'completed':
          stats.completed++;
          logger.info(`WI ${id}: completed (cost: $${outcome.costUsd.toFixed(2)}${formatToolUsage(outcome.toolUsage)})`);
          break;
        case 'paused':
          stats.paused++;
          logger.info(`WI ${id}: paused at ${outcome.stage} (cost: $${outcome.costUsd.toFixed(2)}${formatToolUsage(outcome.toolUsage)})`);
          break;
        case 'failed':
          stats.failed++;
          logger.error(`WI ${id}: failed at ${outcome.error.stage}: ${outcome.error.message} (cost: $${outcome.costUsd.toFixed(2)}${formatToolUsage(outcome.toolUsage)})`);
          break;
        case 'skipped':
          stats.skipped++;
          logger.info(`WI ${id}: skipped (${outcome.reason})`);
          break;
        case 'rejected':
          stats.rejected++;
          logger.info(
            `WI ${id}: rejected (${outcome.severity}, count=${outcome.rejectCount}, cost: $${outcome.costUsd.toFixed(2)}${formatToolUsage(outcome.toolUsage)})`,
          );
          break;
      }
    } catch (err) {
      stats.failed++;
      logger.error(`WI ${id}: processor threw`, err);
    }
  });

  return stats;
}

/**
 * `ensure()` throwing (the CLI could not even start) must not hold work back:
 * the job reports its own sign-in error, as when the check fails inside ensure.
 */
async function signedIn(demoPortal: DemoPortalSession, logger: Logger): Promise<boolean> {
  try {
    return await demoPortal.ensure();
  } catch (err) {
    logger.warn(`DemoPortal sign-in check failed - ${err instanceof Error ? err.message : String(err)}`);
    return true;
  }
}

/**
 * A rejected WI waits for the human to answer and re-add the trigger tag. When
 * they drop it instead (remove need-input/blocked without re-tagging, close or
 * delete the WI), the state file would keep the rejection forever and the
 * dashboard would show the WI as waiting for input. Mark those withdrawn.
 * Best-effort per WI: an ADO error leaves the rejection for the next cycle.
 */
export async function withdrawDroppedRejections(deps: WatcherDeps, tagged: Set<number>): Promise<void> {
  const { config, logger, ado, store } = deps;
  const open = store
    .listAll()
    .filter((s) => s.rejection?.dispatched && !s.rejection.withdrawnAt && !tagged.has(s.workItemId));
  for (const state of open) {
    let reason: string | null;
    try {
      const wi = await ado.getWorkItem(state.workItemId);
      const wiState = wi.fields['System.State'];
      const tags = (wi.fields['System.Tags'] ?? '').split(';').map((t) => t.trim().toLowerCase());
      const waitTags = [config.needInputTag, config.blockedTag].map((t) => t.toLowerCase());
      reason = wiState && CLOSED_STATES.has(wiState) ? `WI is ${wiState}`
        : waitTags.some((t) => tags.includes(t)) ? null
        : `${config.needInputTag}/${config.blockedTag} tag removed`;
    } catch (err) {
      if (!hasStatusCode(err, 404)) {
        logger.warn(`WI ${state.workItemId}: rejection check failed, retrying next cycle :: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      reason = 'WI not found';
    }
    if (!reason) continue;
    state.rejection!.withdrawnAt = new Date().toISOString();
    store.save(state);
    logger.info(`WI ${state.workItemId}: rejection withdrawn (${reason})`);
  }
}

export async function sleepInterruptible(
  ms: number,
  abortFlag: AbortFlag,
  wake?: WakeFlag,
): Promise<void> {
  const stepMs = 250;
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (abortFlag.aborted) return;
    if (wake?.requested) {
      wake.requested = false;
      return;
    }
    const remaining = deadline - Date.now();
    await new Promise((resolve) => setTimeout(resolve, Math.min(stepMs, remaining)));
  }
}

export async function startWatcher(deps: WatcherDeps): Promise<void> {
  const { config, logger, abortFlag } = deps;
  const onSignal = (sig: string) => {
    logger.info(`received ${sig}, stopping after current cycle`);
    abortFlag.aborted = true;
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  logger.info(
    `watcher starting (poll every ${config.pollIntervalMinutes} min, concurrency ${config.concurrency})`,
  );
  while (!abortFlag.aborted) {
    try {
      const stats = await runPollCycle(deps);
      logger.info(
        `cycle done: considered=${stats.considered} completed=${stats.completed} paused=${stats.paused} rejected=${stats.rejected} failed=${stats.failed} skipped=${stats.skipped}`,
      );
    } catch (err) {
      logger.error('poll cycle threw, continuing', err);
    }
    if (deps.sweepEnvironments && !abortFlag.aborted && deps.demoPortal?.status().needed) {
      // Deleting an environment needs DemoPortal too; it would only fail until someone signs in.
      logger.info('environment sweep skipped - DemoPortal sign-in needed');
    } else if (deps.sweepEnvironments && !abortFlag.aborted) {
      try {
        const deleted = await deps.sweepEnvironments();
        if (deleted > 0) logger.info(`environment sweep: deleted ${deleted} environment(s) of closed PRs`);
      } catch (err) {
        logger.error('environment sweep threw, continuing', err);
      }
    }
    if (abortFlag.aborted) break;
    await sleepInterruptible(config.pollIntervalMinutes * 60_000, abortFlag, deps.wake);
  }
  logger.info('watcher stopped');
}
