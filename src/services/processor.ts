import type { AppConfig, ProcessOutcome } from '../types/index.ts';
import type { Logger } from '../utils/logger.ts';
import type { AdoClient } from '../sdk/azure-devops-client.ts';
import type { PipelineStateStore } from '../state/state-store.ts';
import type { Stage, AbortFlag } from '../pipeline/stage.ts';
import { createInitialState, runPipeline } from '../pipeline/orchestrator.ts';
import { slugify } from '../utils/slug.ts';
import type { PipelineBuilderDeps } from './pipeline-builder.ts';

export interface ProcessorDeps {
  config: AppConfig;
  logger: Logger;
  ado: AdoClient;
  store: PipelineStateStore;
  buildPipeline: (deps: PipelineBuilderDeps) => Stage[];
  abortFlag: AbortFlag;
}

export interface Processor {
  processWorkItem(workItemId: number): Promise<ProcessOutcome>;
}

const CLOSED_STATES = new Set(['Resolved', 'Closed', 'Removed']);

function hasStatusCode(err: unknown, code: number): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'statusCode' in err &&
    (err as { statusCode: unknown }).statusCode === code
  );
}

export function createProcessor(deps: ProcessorDeps): Processor {
  const { config, logger, ado, store, buildPipeline, abortFlag } = deps;

  return {
    async processWorkItem(workItemId: number): Promise<ProcessOutcome> {
      if (abortFlag.aborted) {
        return { kind: 'skipped', workItemId, reason: 'aborted' };
      }

      let workItem;
      try {
        workItem = await ado.getWorkItem(workItemId);
      } catch (err) {
        if (hasStatusCode(err, 404)) {
          return { kind: 'skipped', workItemId, reason: 'not-found' };
        }
        throw err;
      }

      const wiState = workItem.fields['System.State'];
      if (wiState && CLOSED_STATES.has(wiState)) {
        return { kind: 'skipped', workItemId, reason: 'closed-state' };
      }

      const title = workItem.fields['System.Title'] ?? `wi-${workItemId}`;
      const state =
        store.load(workItemId) ?? createInitialState(workItemId, slugify(title));
      store.save(state);

      const stages = buildPipeline({ config, logger, ado });
      const context = {
        config,
        logger,
        abortFlag,
        now: () => new Date(),
      };

      try {
        const final = await runPipeline({ stages, state, context, store });
        if (final.completedAt) {
          if (!config.dryRun) {
            await ado.removeTagFromWorkItem(workItemId, config.triggerTag);
          }
          return { kind: 'completed', workItemId };
        }
        const last = final.history[final.history.length - 1];
        const pausedStage = last?.outcome === 'pause' ? last.stage : (final.currentStage ?? 'unknown');
        return { kind: 'paused', workItemId, stage: pausedStage };
      } catch (err) {
        const persisted = store.load(workItemId);
        const terminalError =
          persisted?.terminalError ?? {
            stage: persisted?.currentStage ?? 'unknown',
            message: err instanceof Error ? err.message : String(err),
            at: new Date().toISOString(),
          };
        if (!config.dryRun) {
          try {
            await ado.addTagToWorkItem(workItemId, config.blockedTag);
          } catch (tagErr) {
            logger.error(
              `failed to add blocked tag to WI ${workItemId}`,
              tagErr,
            );
          }
        }
        return { kind: 'failed', workItemId, error: terminalError };
      }
    },
  };
}
