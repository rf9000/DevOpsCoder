import { marked } from 'marked';
import type {
  AppConfig,
  PipelineRejection,
  PipelineState,
  ProcessOutcome,
} from '../types/index.ts';
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

export function renderRejectMarkdown(
  rejection: PipelineRejection,
  severity: 'reject' | 'blocked',
  config: AppConfig,
  workItemId: number,
): string {
  const lines: string[] = [];

  if (severity === 'blocked') {
    lines.push(
      `## Implementation blocked after ${config.maxRejectCycles} rejection cycles`,
    );
  } else {
    lines.push(`## I need more information before I can implement this`);
  }

  lines.push('');
  lines.push(rejection.summary);
  lines.push('');

  if (rejection.reasons.length > 0) {
    lines.push(`### What's missing`);
    for (const r of rejection.reasons) lines.push(`- ${r}`);
    lines.push('');
  }

  if (rejection.questions && rejection.questions.length > 0) {
    lines.push(`### Questions`);
    for (const q of rejection.questions) lines.push(`- ${q}`);
    lines.push('');
  }

  lines.push('---');
  if (severity === 'blocked') {
    lines.push(
      `I've rejected this work item ${config.maxRejectCycles} times. To start a fresh attempt, ask the agent operator to run \`bun run src/cli/index.ts reset-state ${workItemId}\`.`,
    );
  } else {
    lines.push(
      `After you've addressed the items above, re-add the \`${config.triggerTag}\` tag to try again.`,
    );
  }

  return lines.join('\n');
}

async function safeAdoOp(
  logger: Logger,
  workItemId: number,
  opName: string,
  op: () => Promise<void>,
): Promise<void> {
  try {
    await op();
  } catch (err) {
    logger.error(`WI ${workItemId}: ${opName} failed`, err);
  }
}

export function createProcessor(deps: ProcessorDeps): Processor {
  const { config, logger, ado, store, buildPipeline, abortFlag } = deps;

  async function dispatchRejection(
    state: PipelineState,
    isRecovery: boolean,
  ): Promise<ProcessOutcome> {
    const rejection = state.rejection!;

    if (!isRecovery) {
      // Fresh dispatch: increment cumulative reject count BEFORE writes so that
      // a mid-write crash leaves the count already bumped and the recovery
      // branch can resume on the next cycle.
      state.rejectCount = (state.rejectCount ?? 0) + 1;
      store.save(state);
    }

    const newCount = state.rejectCount ?? 1;
    const severity: 'reject' | 'blocked' =
      newCount >= config.maxRejectCycles ? 'blocked' : 'reject';

    if (!config.dryRun) {
      // Comment is posted ONCE on the fresh-dispatch path. Recovery skips it
      // to avoid duplicates (we assume the previous cycle may have already
      // posted it; tags are idempotent so retrying them is safe).
      if (!isRecovery) {
        const markdown = renderRejectMarkdown(
          rejection,
          severity,
          config,
          state.workItemId,
        );
        const html = await marked(markdown);
        await safeAdoOp(logger, state.workItemId, 'addWorkItemComment', () =>
          ado.addWorkItemComment(state.workItemId, html),
        );
      }
      await safeAdoOp(
        logger,
        state.workItemId,
        'removeTagFromWorkItem(triggerTag)',
        () => ado.removeTagFromWorkItem(state.workItemId, config.triggerTag),
      );
      const tagToAdd =
        severity === 'blocked' ? config.blockedTag : config.needInputTag;
      await safeAdoOp(
        logger,
        state.workItemId,
        `addTagToWorkItem(${tagToAdd})`,
        () => ado.addTagToWorkItem(state.workItemId, tagToAdd),
      );
    }

    // Mark dispatch as complete so the next entry knows to treat any
    // subsequent re-tag as a fresh attempt (clear rejection + run pipeline)
    // rather than a recovery.
    state.rejection!.dispatched = true;
    store.save(state);

    return {
      kind: 'rejected',
      workItemId: state.workItemId,
      severity,
      rejectCount: newCount,
    };
  }

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

      // Crash-recovery branch: the previous cycle set state.rejection but didn't
      // finish dispatching the side-effects (e.g., process killed between
      // comment-post and tag-swap). Retry only the tag ops; skip the comment to
      // avoid duplicates. Don't re-run the pipeline.
      if (state.rejection && !state.rejection.dispatched) {
        return await dispatchRejection(state, true);
      }

      // Stale-rejection branch: previous cycle fully dispatched a reject, then
      // the human re-added the trigger tag. Clear the rejection (preserve
      // rejectCount — it's cumulative) and run the pipeline fresh.
      if (state.rejection && state.rejection.dispatched) {
        state.rejection = undefined;
      }

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

        // Reject path: check rejection BEFORE completedAt
        if (final.rejection) {
          return await dispatchRejection(final, false);
        }

        // Completed path: reset rejectCount if it was non-zero (analyzer finally accepted)
        if (final.completedAt) {
          if (final.rejectCount !== undefined && final.rejectCount > 0) {
            final.rejectCount = 0;
            store.save(final);
          }
          if (!config.dryRun) {
            await ado.removeTagFromWorkItem(workItemId, config.triggerTag);
          }
          return { kind: 'completed', workItemId };
        }

        // Paused path
        const last = final.history[final.history.length - 1];
        const pausedStage =
          last?.outcome === 'pause'
            ? last.stage
            : (final.currentStage ?? 'unknown');
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
