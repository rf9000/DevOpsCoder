import { marked } from 'marked';
import type {
  AppConfig,
  EnvironmentOutput,
  PipelineCostInfo,
  PipelineRejection,
  PipelineState,
  PipelineTerminalError,
  ProcessOutcome,
  ReviewerOutput,
  DraftPrOutput,
  FindingSeverity,
  VerificationOutput,
} from '../types/index.ts';
import { formatTimeout } from '../types/index.ts';
import type { Logger } from '../utils/logger.ts';
import type { AdoClient } from '../sdk/azure-devops-client.ts';
import type { PipelineStateStore } from '../state/state-store.ts';
import type { Stage, AbortFlag } from '../pipeline/stage.ts';
import { DEFAULT_STAGE_TIMEOUT_MS, createInitialState, runPipeline } from '../pipeline/orchestrator.ts';
import { slugify } from '../utils/slug.ts';
import { findTagAdder, formatAdoMention } from '../utils/tag-history.ts';
import type { CostLedger } from './cost-ledger.ts';
import type { PipelineBuilderDeps } from './pipeline-builder.ts';
import { REVISION_LOOP_EXHAUSTED } from './pipeline-builder.ts';

export interface ProcessorDeps {
  config: AppConfig;
  logger: Logger;
  ado: AdoClient;
  store: PipelineStateStore;
  buildPipeline: (deps: PipelineBuilderDeps) => Stage[];
  abortFlag: AbortFlag;
  /** Append-only spend log. Omitted in tests and dry runs. */
  ledger?: CostLedger;
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

/** Cap on rendered list items — comments stay scannable even if a stage overshoots. */
const MAX_COMMENT_LIST_ITEMS = 4;

function capList(items: string[]): string[] {
  return items.slice(0, MAX_COMMENT_LIST_ITEMS);
}

export function renderRejectMarkdown(
  rejection: PipelineRejection,
  severity: 'reject' | 'blocked',
  config: AppConfig,
  workItemId: number,
  /** @-mention for whoever applied the trigger tag; '' when unknown. */
  mention = '',
): string {
  const lines: string[] = [];
  const at = mention ? `${mention} ` : '';

  if (severity === 'blocked') {
    lines.push(`## Blocked after ${config.maxRejectCycles} rejections`);
  } else {
    lines.push(`## Need more info`);
  }

  lines.push('');
  lines.push(`${at}${rejection.summary}`);
  lines.push('');

  if (rejection.reasons.length > 0) {
    lines.push(`**Missing**`);
    for (const r of capList(rejection.reasons)) lines.push(`- ${r}`);
    lines.push('');
  }

  if (rejection.questions && rejection.questions.length > 0) {
    lines.push(`**Questions**`);
    for (const q of capList(rejection.questions)) lines.push(`- ${q}`);
    lines.push('');
  }

  if (severity === 'blocked') {
    lines.push(
      `Rejected ${config.maxRejectCycles}×. Operator: \`reset-state ${workItemId}\` to retry.`,
    );
  } else {
    lines.push(`Update the WI, then re-add \`${config.triggerTag}\`.`);
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
    `Re-add the \`${config.triggerTag}\` tag to retry from the failed stage, or ask the agent operator to run \`bun run src/cli/index.ts reset-state ${workItemId}\` for a completely fresh attempt.`,
  );

  return lines.join('\n');
}

const COMMENT_STACK_TRACE_MAX_LINES = 15;
const COMMENT_STACK_TRACE_MAX_CHARS = 1500;

function trimTraceForComment(trace: string): string {
  let trimmed = trace.split('\n').slice(0, COMMENT_STACK_TRACE_MAX_LINES).join('\n');
  if (trimmed.length > COMMENT_STACK_TRACE_MAX_CHARS) {
    trimmed = trimmed.slice(0, COMMENT_STACK_TRACE_MAX_CHARS);
  }
  if (trimmed.length < trace.length) trimmed += '\n... (truncated)';
  return trimmed;
}

export function renderVerificationFailureMarkdown(
  state: PipelineState,
  config: AppConfig,
  workItemId: number,
): string {
  const verification = state.outputs.verification as VerificationOutput | undefined;
  const environment = state.outputs.environment as EnvironmentOutput | undefined;
  const lines: string[] = [];

  lines.push(`## Pipeline blocked: verification failed on the test environment`);
  lines.push('');
  lines.push(
    `The implementation was deployed to a Business Central environment, but verification was still red after ${config.maxTestFixAttempts} fix attempt${config.maxTestFixAttempts === 1 ? '' : 's'}. No draft PR was created.`,
  );
  lines.push('');
  if (environment) {
    lines.push(
      `- Environment: \`${environment.envId}\`${environment.url ? ` (${environment.url})` : ''} — auto-deletes ~10 days after creation`,
    );
    lines.push('');
  }

  if (!verification) {
    lines.push('(no verification details were recorded)');
  } else if (!verification.compiled) {
    lines.push(`### Compile / deploy errors`);
    lines.push('');
    for (const entry of verification.deploy) {
      if (entry.compiled && entry.published) continue;
      lines.push(`- **${entry.app}**: ${entry.error ?? 'compile/publish failed (no error detail)'}`);
    }
  } else {
    lines.push(`### Failing tests`);
    lines.push('');
    for (const run of verification.testRuns) {
      if (run.passed) continue;
      const name = run.codeunitName ? ` "${run.codeunitName}"` : '';
      lines.push(
        `#### Codeunit ${run.codeunitId}${name} — ${run.summary.failed} failed / ${run.summary.total} total`,
      );
      lines.push('');
      for (const test of run.tests) {
        if (test.result.toLowerCase() !== 'fail') continue;
        lines.push(`- **${test.name}**${test.errorMessage ? `: ${test.errorMessage}` : ''}`);
        if (test.stackTrace) {
          lines.push('');
          lines.push('  ```');
          lines.push(trimTraceForComment(test.stackTrace));
          lines.push('  ```');
        }
      }
      lines.push('');
    }
  }

  lines.push('');
  lines.push('The worktree is retained for inspection.');
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(
    `Re-add the \`${config.triggerTag}\` tag to retry from the failed stage, or ask the agent operator to run \`bun run src/cli/index.ts reset-state ${workItemId}\` for a completely fresh attempt.`,
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
    `Re-add the \`${config.triggerTag}\` tag to retry from the failed stage, or ask the agent operator to run \`bun run src/cli/index.ts reset-state ${workItemId}\` for a completely fresh attempt.`,
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

  lines.push(`## Review not passed (${reviewer.attempts}×)`);
  lines.push('');
  lines.push(`${totalFindings} unresolved finding${totalFindings === 1 ? '' : 's'}:`);
  lines.push('');

  // Group findings by severity in descending order
  const grouped = new Map<FindingSeverity, typeof reviewer.findings>();
  for (const sev of SEVERITY_ORDER) grouped.set(sev, []);
  for (const finding of reviewer.findings) {
    grouped.get(finding.severity)?.push(finding);
  }

  // Title only — titles are self-contained, and the full description plus
  // suggestion for every finding turned this comment into pages of prose.
  // Detail lives in the retained worktree and the run log.
  let shown = 0;
  for (const sev of SEVERITY_ORDER) {
    const group = grouped.get(sev) ?? [];
    for (const f of group) {
      if (shown >= MAX_COMMENT_LIST_ITEMS) break;
      const location = f.line !== undefined ? `${f.file}:${f.line}` : f.file;
      lines.push(`- **${sev}** ${location} — ${f.title}`);
      shown++;
    }
  }
  if (totalFindings > shown) {
    lines.push(`- …and ${totalFindings - shown} more`);
  }
  lines.push('');

  lines.push(
    `Re-add \`${config.triggerTag}\` to retry, or operator: \`reset-state ${workItemId}\`.`,
  );

  return lines.join('\n');
}

/**
 * Fallback comment for a terminal failure that none of the specific renderers
 * claim (ADO API errors, git failures, agent crashes). Without this a human
 * sees only the blocked tag and has to go read container logs to find out why.
 */
export function renderTerminalFailureMarkdown(
  terminalError: PipelineTerminalError,
  config: AppConfig,
  workItemId: number,
): string {
  const lines: string[] = [];

  lines.push(`## Pipeline blocked: ${terminalError.stage} failed`);
  lines.push('');
  lines.push(
    `The "${terminalError.stage}" stage failed with a terminal error. This is not a review or verification rejection — the pipeline hit an operational problem and stopped.`,
  );
  lines.push('');
  lines.push(`### Error`);
  lines.push('');
  lines.push('```');
  lines.push(terminalError.message);
  lines.push('```');
  lines.push('');
  lines.push(`- Stage: \`${terminalError.stage}\``);
  lines.push(`- Failed at: ${terminalError.at}`);
  lines.push('');
  lines.push('The worktree is retained for inspection.');
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(
    `Re-add the \`${config.triggerTag}\` tag to retry from the failed stage, or ask the agent operator to run \`bun run src/cli/index.ts reset-state ${workItemId}\` for a completely fresh attempt.`,
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
  const { config, logger, ado, store, buildPipeline, abortFlag, ledger } = deps;

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
        // Notify whoever asked for this work. Best-effort: the updates endpoint
        // is a separate call and a failure here must not cost us the comment.
        let mention = '';
        try {
          const updates = await ado.getWorkItemUpdates(state.workItemId);
          const adder = findTagAdder(updates, config.triggerTag);
          if (adder) mention = formatAdoMention(adder.identity);
        } catch (err) {
          logger.info(
            `WI ${state.workItemId}: could not resolve who applied ${config.triggerTag} :: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        const markdown = renderRejectMarkdown(
          rejection,
          severity,
          config,
          state.workItemId,
          mention,
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

  // One choke point for the spend log: every terminal outcome funnels through
  // the wrapper below, so the ledger cannot drift from the outcomes the watcher
  // reports. `skipped` is excluded — nothing ran, so there is nothing to bill.
  function recordSpend(outcome: ProcessOutcome): void {
    if (!ledger || outcome.kind === 'skipped') return;
    const persisted = store.load(outcome.workItemId);
    const cost = persisted?.outputs.cost as PipelineCostInfo | undefined;
    const draftPr = persisted?.outputs.draftPr as DraftPrOutput | undefined;
    ledger.record({
      at: new Date().toISOString(),
      workItemId: outcome.workItemId,
      outcome: outcome.kind,
      costUsd: 'costUsd' in outcome ? outcome.costUsd : 0,
      ...(draftPr ? { prId: draftPr.id, prUrl: draftPr.url } : {}),
      ...(cost?.perStage ? { perStage: cost.perStage } : {}),
    });
  }

  const inner = {
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

      // Clear a previous cycle's terminal error for the same reason. Leaving it
      // set makes the orchestrator refuse to stamp completedAt even when the
      // resumed run succeeds end-to-end (see orchestrator.ts "currentStage ==
      // null && !completedAt && !terminalError"), so the processor reports
      // `paused`, never removes the trigger tag, and the next poll re-runs the
      // whole pipeline from the top. Observed in production: a WI that failed at
      // draft-pr-creator, was fixed, then opened its PR successfully but kept
      // the trigger tag.
      // currentStage is deliberately NOT reset — resuming at the failed stage is
      // what makes a retry cheap instead of re-paying for the coder.
      if (state.terminalError) {
        state.terminalError = undefined;
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
          // Verification failure must be checked FIRST: by the time build-and-test
          // fails, the reviewer has usually approved (possibly with non-blocking
          // findings), and the reviewer-findings branch would hijack the comment.
          if (persisted && /verification failed/i.test(terminalError.message)) {
            const markdown = renderVerificationFailureMarkdown(persisted, config, workItemId);
            const html = await marked(markdown);
            await safeAdoOp(logger, workItemId, 'addWorkItemComment', () =>
              ado.addWorkItemComment(workItemId, html),
            );
          } else if (
            reviewer &&
            reviewer.findings.length > 0 &&
            terminalError.message.includes(REVISION_LOOP_EXHAUSTED)
          ) {
            // Gated on the exhaustion marker, not merely "findings exist": the
            // reviewer can approve with non-blocking findings and the pipeline
            // then die later (e.g. a draft-PR 404). Reporting that as "reviewer
            // rejected" told humans something false.
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
          } else {
            const markdown = renderTerminalFailureMarkdown(terminalError, config, workItemId);
            const html = await marked(markdown);
            await safeAdoOp(logger, workItemId, 'addWorkItemComment', () =>
              ado.addWorkItemComment(workItemId, html),
            );
          }
          // Blocking a WI must also un-trigger it. Left on, the trigger tag
          // makes every poll cycle re-enter the pipeline — and a re-entry that
          // reaches the revision loop costs real money (~$8/run observed), with
          // the cost cap only checked at top-level stage boundaries. Retrying is
          // now a deliberate human act: re-add the tag (resumes at the failed
          // stage) or reset-state for a clean run. Mirrors the reject path,
          // which has always swapped trigger → need-input/blocked.
          await safeAdoOp(
            logger,
            workItemId,
            'removeTagFromWorkItem(triggerTag)',
            () => ado.removeTagFromWorkItem(workItemId, config.triggerTag),
          );
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

  return {
    async processWorkItem(workItemId: number): Promise<ProcessOutcome> {
      const outcome = await inner.processWorkItem(workItemId);
      recordSpend(outcome);
      return outcome;
    },
  };
}
