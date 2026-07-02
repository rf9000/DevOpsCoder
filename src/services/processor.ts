import { marked } from 'marked';
import type {
  AppConfig,
  PipelineCostInfo,
  PipelineRejection,
  PipelineState,
  PipelineTerminalError,
  ProcessOutcome,
  ReviewerOutput,
  FindingSeverity,
} from '../types/index.ts';
import { formatTimeout } from '../types/index.ts';
import type { Logger } from '../utils/logger.ts';
import type { AdoClient } from '../sdk/azure-devops-client.ts';
import type { PipelineStateStore } from '../state/state-store.ts';
import type { Stage, AbortFlag } from '../pipeline/stage.ts';
import { DEFAULT_STAGE_TIMEOUT_MS, createInitialState, runPipeline } from '../pipeline/orchestrator.ts';
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

// Keep in sync with SEVERITY_RANK in ../pipeline/stages/_stage-helpers.ts and
// SEVERITY_ORDER in ../pipeline/stages/coder.ts — divergence would drop a
// severity group from rendered comments or skew aggregation ordering.
const SEVERITY_ORDER: FindingSeverity[] = [
  'blocking',
  'critical',
  'major',
  'minor',
  'nit',
];

export function renderCostExhaustionMarkdown(
  state: PipelineState,
  config: AppConfig,
  workItemId: number,
): string {
  const lines: string[] = [];
  const cost = state.outputs.cost as PipelineCostInfo | undefined;

  lines.push(`## Pipeline blocked: cost cap exceeded`);
  lines.push('');

  if (!cost) {
    lines.push(
      `The pipeline exceeded the configured cost cap ($${config.maxCostUsdPerWi.toFixed(4)}) and was hard-killed to prevent further charges.`,
    );
    lines.push('');
    lines.push(`### Per-stage spend`);
    lines.push('');
    lines.push('(no cost data recorded)');
  } else {
    lines.push(
      `The pipeline spent $${cost.total.toFixed(4)} (cap: $${config.maxCostUsdPerWi.toFixed(4)}) and was hard-killed to prevent further charges.`,
    );
    lines.push('');
    lines.push(`### Per-stage spend`);
    lines.push('');
    lines.push('| Stage | USD |');
    lines.push('|---|---|');
    const sortedStages = Object.keys(cost.perStage).sort();
    for (const stage of sortedStages) {
      const usd = cost.perStage[stage] ?? 0;
      lines.push(`| ${stage} | $${usd.toFixed(4)} |`);
    }
    lines.push(`| **Total** | **$${cost.total.toFixed(4)}** |`);
  }

  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(
    `To start a fresh attempt, ask the agent operator to run \`bun run src/cli/index.ts reset-state ${workItemId}\`.`,
  );

  return lines.join('\n');
}

function stageNameToEnvVar(stageName: string): string {
  return `STAGE_TIMEOUT_MS_${stageName.toUpperCase().replace(/-/g, '_')}`;
}

export function renderStageTimeoutMarkdown(
  terminalError: PipelineTerminalError,
  config: AppConfig,
  workItemId: number,
): string {
  const stageName = terminalError.stage;
  const rawMs = config.stageTimeoutMs[stageName] ?? DEFAULT_STAGE_TIMEOUT_MS;
  const timeoutFormatted = formatTimeout(rawMs);
  const envVarName = stageNameToEnvVar(stageName);

  const lines: string[] = [];

  lines.push(`## Pipeline blocked: stage timed out`);
  lines.push('');
  lines.push(
    `The "${stageName}" stage exceeded its wall-clock timeout of ${timeoutFormatted} and was hard-killed. The pipeline left the work in whatever partial state the stage produced before the abort fired.`,
  );
  lines.push('');
  lines.push(`### Last stage attempt`);
  lines.push('');
  lines.push(`- Stage: \`${stageName}\``);
  lines.push(`- Timeout: \`${timeoutFormatted}\` (configured via \`${envVarName}\` — see \`.env.example\`)`);
  lines.push(`- Aborted at: ${terminalError.at}`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(
    `To start a fresh attempt, ask the agent operator to run \`bun run src/cli/index.ts reset-state ${workItemId}\`.`,
  );

  return lines.join('\n');
}

export function renderReviewerFindingsMarkdown(
  reviewer: ReviewerOutput,
  config: AppConfig,
  workItemId: number,
): string {
  const lines: string[] = [];
  const totalFindings = reviewer.findings.length;

  lines.push(
    `## Pipeline blocked: reviewer rejected after ${reviewer.attempts} attempt${reviewer.attempts === 1 ? '' : 's'}`,
  );
  lines.push('');
  lines.push(
    `The reviewer found ${totalFindings} finding${totalFindings === 1 ? '' : 's'} across ${reviewer.attempts} attempt${reviewer.attempts === 1 ? '' : 's'} that could not be resolved.`,
  );
  lines.push('');

  // Group findings by severity in descending order
  const grouped = new Map<FindingSeverity, typeof reviewer.findings>();
  for (const sev of SEVERITY_ORDER) grouped.set(sev, []);
  for (const finding of reviewer.findings) {
    grouped.get(finding.severity)?.push(finding);
  }

  for (const sev of SEVERITY_ORDER) {
    const group = grouped.get(sev) ?? [];
    if (group.length === 0) continue;

    lines.push(`### ${sev} findings (${group.length})`);
    lines.push('');
    for (const f of group) {
      const location = f.line !== undefined ? `${f.file}:${f.line}` : f.file;
      lines.push(`- **${location}** (${f.axis}): ${f.title}`);
      lines.push('');
      lines.push(`  ${f.description}`);
      lines.push('');
      if (f.suggestion) {
        lines.push(`  Suggestion: ${f.suggestion}`);
        lines.push('');
      }
    }
  }

  lines.push('---');
  lines.push('');
  lines.push(
    `To start a fresh attempt, ask the agent operator to run \`bun run src/cli/index.ts reset-state ${workItemId}\`.`,
  );

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
      costUsd: (state.outputs.cost as PipelineCostInfo | undefined)?.total ?? 0,
      toolUsage: (state.outputs.toolUsage as Record<string, number> | undefined) ?? {},
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

      // Clear cancelled flag from a previous cycle's external abort. The fresh
      // cycle should start clean so the orchestrator can run unimpeded.
      if (state.cancelled) {
        state.cancelled = false;
      }

      store.save(state);

      const stages = buildPipeline({ config, logger, ado });
      // Forward stub for task-08: outerCtrl will be wired to SIGINT there; the signal
      // satisfies PipelineContext's required field today, with abort propagation handled
      // via ctx.abortFlag in the orchestrator.
      const outerCtrl = new AbortController();
      const context = {
        config,
        logger,
        abortFlag,
        signal: outerCtrl.signal,
        now: () => new Date(),
      };

      try {
        const final = await runPipeline({ stages, state, context, store });

        // Cancelled-return path — orchestrator bailed via external abort. No ADO
        // writes: trigger tag stays, worktree stays, next poll cycle resumes.
        if (final.cancelled) {
          return { kind: 'skipped', workItemId, reason: 'cancelled' };
        }

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
          return {
            kind: 'completed',
            workItemId,
            costUsd: (final.outputs.cost as PipelineCostInfo | undefined)?.total ?? 0,
            toolUsage: (final.outputs.toolUsage as Record<string, number> | undefined) ?? {},
          };
        }

        // Paused path
        const last = final.history[final.history.length - 1];
        const pausedStage =
          last?.outcome === 'pause'
            ? last.stage
            : (final.currentStage ?? 'unknown');
        return {
          kind: 'paused',
          workItemId,
          stage: pausedStage,
          costUsd: (final.outputs.cost as PipelineCostInfo | undefined)?.total ?? 0,
          toolUsage: (final.outputs.toolUsage as Record<string, number> | undefined) ?? {},
        };
      } catch (err) {
        const persisted = store.load(workItemId);

        // Defensive belt-and-suspenders. The orchestrator returns (not throws) on
        // external abort, so this branch is currently unreachable in production —
        // but if a future stage ever combines abort with a throw, we still skip
        // all ADO writes.
        if (persisted?.cancelled) {
          return { kind: 'skipped', workItemId, reason: 'cancelled' };
        }

        const terminalError =
          persisted?.terminalError ?? {
            stage: persisted?.currentStage ?? 'unknown',
            message: err instanceof Error ? err.message : String(err),
            at: new Date().toISOString(),
          };
        if (!config.dryRun) {
          const reviewer = persisted?.outputs.reviewer as ReviewerOutput | undefined;
          if (reviewer && reviewer.findings.length > 0) {
            const markdown = renderReviewerFindingsMarkdown(reviewer, config, workItemId);
            const html = await marked(markdown);
            await safeAdoOp(logger, workItemId, 'addWorkItemComment', () =>
              ado.addWorkItemComment(workItemId, html),
            );
          } else if (persisted && /cost cap/i.test(terminalError.message)) {
            const markdown = renderCostExhaustionMarkdown(persisted, config, workItemId);
            const html = await marked(markdown);
            await safeAdoOp(logger, workItemId, 'addWorkItemComment', () =>
              ado.addWorkItemComment(workItemId, html),
            );
          } else if (persisted && /timeout/i.test(terminalError.message)) {
            const markdown = renderStageTimeoutMarkdown(terminalError, config, workItemId);
            const html = await marked(markdown);
            await safeAdoOp(logger, workItemId, 'addWorkItemComment', () =>
              ado.addWorkItemComment(workItemId, html),
            );
          }
          await safeAdoOp(
            logger,
            workItemId,
            `addTagToWorkItem(${config.blockedTag})`,
            () => ado.addTagToWorkItem(workItemId, config.blockedTag),
          );
        }
        return {
          kind: 'failed',
          workItemId,
          error: terminalError,
          costUsd: (persisted?.outputs.cost as PipelineCostInfo | undefined)?.total ?? 0,
          toolUsage: (persisted?.outputs.toolUsage as Record<string, number> | undefined) ?? {},
        };
      }
    },
  };
}
