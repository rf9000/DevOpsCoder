import type { AppConfig, CycleStats } from '../types/index.ts';
import type { AdoClient } from '../sdk/azure-devops-client.ts';
import type { PipelineStateStore } from '../state/state-store.ts';
import type { Logger } from '../utils/logger.ts';
import type { Processor } from './processor.ts';
import type { AbortFlag } from '../pipeline/stage.ts';
import { runPool } from '../utils/pool.ts';
import { formatToolUsage } from '../utils/tool-usage-tracker.ts';
import { formatSpendLine } from '../utils/cost-report.ts';

export interface WatcherDeps {
  config: AppConfig;
  logger: Logger;
  ado: AdoClient;
  store: PipelineStateStore;
  processor: Processor;
  abortFlag: AbortFlag;
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
  const resumable = store.listResumable().map((s) => s.workItemId);
  const candidates = Array.from(new Set<number>([...tagged, ...resumable]));
  stats.considered = candidates.length;

  if (candidates.length === 0) {
    logger.info('poll cycle: no candidates');
    return stats;
  }

  logger.info(`poll cycle: ${candidates.length} candidate(s)`);

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

async function sleepInterruptible(
  ms: number,
  abortFlag: AbortFlag,
): Promise<void> {
  const stepMs = 250;
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (abortFlag.aborted) return;
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
    if (abortFlag.aborted) break;
    await sleepInterruptible(config.pollIntervalMinutes * 60_000, abortFlag);
  }
  logger.info('watcher stopped');
}
