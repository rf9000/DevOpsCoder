import { z } from 'zod';
import type { Stage } from '../stage.ts';
import type { AgentRunner } from '../agent-stage.ts';
import type {
  AppConfig,
  CoderOutput,
  Finding,
  FindingSeverity,
  ReviewerOutput,
  TestAuthorOutput,
  WorktreeContext,
} from '../../types/index.ts';
import type { WorkItemContext } from '../../services/wi-context.ts';
import type { AnalyzerOutput } from './analyzer.ts';
import { createBashAllowlist } from '../../utils/bash-allowlist.ts';
import {
  composeCanUseTool,
  aggregateReviewerFindings,
  clampSeverity,
  isAbortError,
  runWithParseRetry,
  STRUCTURED_OUTPUT_DENIED_TOOLS,
} from './_stage-helpers.ts';
import { AgentOutputParseError } from '../../services/claude-agent-runner.ts';
import type { AgentRunResult } from '../agent-stage.ts';
import { modelFor } from '../../utils/model-selection.ts';
import { createCostTracker } from '../../utils/cost-tracker.ts';
import { createToolUsageTracker, mergeToolUsage } from '../../utils/tool-usage-tracker.ts';

// ---------------------------------------------------------------------------
// Review axes
// ---------------------------------------------------------------------------

export const REVIEW_AXES = [
  'safety-correctness',
  'performance',
  'code-structure',
  'naming-style',
  'security',
  'integration',
] as const;

type ReviewAxis = typeof REVIEW_AXES[number];

/**
 * The highest severity each axis is permitted to assign.
 *
 * `approved = !any(blocking|critical)`, so severity is not a label — it is the
 * loop-exit switch, and every axis holds a copy of it. Six independent agents
 * each get a chance to over-rate, and `aggregateReviewerFindings` keeps the
 * *highest* severity when axes collide on a `file:line`, so one inflated call
 * decides the round on its own.
 *
 * WI 82205 is the worked example: three rounds and $23.95 spent, ending on a
 * single `critical` whose own title read "diverging from established codebase
 * idiom" — raised jointly by `safety-correctness` and `naming-style`. The
 * rubric in reviewer-shared.md already classifies pattern violations as `major`
 * and already warns against over-flagging; the prompt said so and the model did
 * it anyway. So the ceiling is enforced here, in code, where it cannot be
 * argued with.
 *
 * The split is by what an axis is *for*. Axes that exist to catch a fatal
 * problem keep the barrier; axes that exist to improve the shape of the code
 * keep their voice — their findings still reach the PR — but cannot hold the
 * pipeline. Retune this table rather than loosening the barrier itself: the
 * question "may naming-style block a merge?" has a defensible answer, while
 * "should critical findings block?" does not.
 */
export const AXIS_SEVERITY_CEILING: Record<ReviewAxis, FindingSeverity> = {
  'safety-correctness': 'blocking',
  security: 'blocking',
  integration: 'critical',
  performance: 'major',
  'code-structure': 'major',
  'naming-style': 'minor',
};

// ---------------------------------------------------------------------------
// Per-axis output schema
// ---------------------------------------------------------------------------

const axisOutputSchema = z.object({
  findings: z.array(
    z.object({
      severity: z.enum(['blocking', 'critical', 'major', 'minor', 'nit']),
      file: z.string(),
      line: z.number().optional(),
      title: z.string(),
      description: z.string(),
      suggestion: z.string().optional(),
      axis: z.string(),
    }),
  ),
}) satisfies z.ZodType<{ findings: Finding[] }>;

// ---------------------------------------------------------------------------
// Read-only Bash allowlist
// ---------------------------------------------------------------------------

const REVIEWER_BASH_ALLOW: RegExp[] = [
  /^git (status|diff|log|show|blame)\b/,
  /^bun (run )?typecheck\b/,
  /^bun test\b/, // covers `bun test <path>`, `bun test --timeout`, etc.
  /^ls\b/,
  /^cat\b/,
  /^pwd\b/,
];

const REVIEWER_BASH_DENY: RegExp[] = [
  /^bun test .*--watch\b/, // `bun test --watch` runs a persistent watcher process that would hang an agent turn — deny.
  /^git push\b/,
  /^git commit\b/,
  /^git checkout\b/,
  /^git switch\b/,
  /^git reset\b/,
  /^git rebase\b/,
  /^git merge\b/,
  /^git branch\b/,
  /^git stash\b/,
  /^git clean\b/,
  /^git config\b/,
  /^git remote\b/,
  /^rm\b/,
  /^cd\b/,
  /^bun add\b/,
  /^bun remove\b/,
  /^npm\b/,
  /^npx\b/,
  /^pip\b/,
];

// ---------------------------------------------------------------------------
// Deps interface
// ---------------------------------------------------------------------------

export interface ReviewerStageDeps {
  config: AppConfig;
  runner: AgentRunner;
  /** Shared head, prepended to each axis system prompt (contents of src/prompts/reviewer-shared.md). */
  sharedPromptTemplate: string;
  /** Per-axis system prompts, keyed by axis name (contents of src/prompts/reviewers/*.md). */
  axisPromptTemplates: Record<ReviewAxis, string>;
  /** Optional override for the number of turns each axis gets. Default 30. */
  maxTurnsPerAxis?: number;
}

// ---------------------------------------------------------------------------
// User-prompt builder (exported for testability)
// ---------------------------------------------------------------------------

export function buildReviewerUserPrompt(args: {
  wiCtx: WorkItemContext;
  analyzer: AnalyzerOutput;
  coder: CoderOutput;
  testAuthor: TestAuthorOutput | undefined;
  worktree: WorktreeContext;
  attempts: number;
  maxAttempts: number;
}): string {
  const { wiCtx, analyzer, coder, testAuthor, worktree, attempts, maxAttempts } = args;
  const sections: string[] = [];

  // Work item
  sections.push('## Work item');
  sections.push(`- ID: ${wiCtx.id}`);
  sections.push(`- Title: ${wiCtx.title}`);
  sections.push(`- Type: ${wiCtx.workItemType || 'unspecified'}`);
  if (wiCtx.description) {
    sections.push(`\n### Description\n${wiCtx.description}`);
  }
  if (wiCtx.acceptanceCriteria) {
    sections.push(`\n### Acceptance Criteria\n${wiCtx.acceptanceCriteria}`);
  }
  sections.push('');

  // Analyzer framing
  sections.push('## Analyzer framing');
  sections.push(analyzer.summary);
  sections.push('');

  // Coder summary
  sections.push('## Coder summary');
  sections.push(coder.summary);
  if (coder.filesChanged.length > 0) {
    sections.push('\nFiles changed:');
    for (const f of coder.filesChanged) {
      sections.push(`- ${f}`);
    }
  }
  sections.push('');

  // Test-author summary (only if present)
  if (testAuthor !== undefined) {
    sections.push('## Test-author summary');
    sections.push(testAuthor.summary);
    if (testAuthor.testFilesChanged.length > 0) {
      sections.push('\nTest files changed:');
      for (const f of testAuthor.testFilesChanged) {
        sections.push(`- ${f}`);
      }
    }
    sections.push('');
  }

  // Worktree
  sections.push('## Worktree');
  sections.push(`- Path: ${worktree.path}`);
  sections.push(`- Branch: ${worktree.branch}`);
  sections.push(`- Base SHA: ${worktree.baseSha}`);
  sections.push(`- Commit range to review: \`${worktree.baseSha}..HEAD\``);
  sections.push('');

  // Reviewer iteration
  sections.push('## Reviewer iteration');
  sections.push(`Attempt ${attempts} of ${maxAttempts}`);
  sections.push('');

  // Your job
  sections.push('## Your job');
  sections.push(
    `Run \`git diff ${worktree.baseSha}..HEAD\` for the changed code. Apply the detection targets in your axis. Emit \`{ "findings": [...] }\`.`,
  );

  return sections.join('\n');
}

// ---------------------------------------------------------------------------
// Stage factory
// ---------------------------------------------------------------------------

/**
 * Plan 5 reviewer: runs 6 axis sub-agents in parallel via Promise.all, each with
 * the shared prompt head prepended to its axis-specific system prompt. Aggregates
 * findings via aggregateReviewerFindings; approved = no blocking AND no critical.
 *
 * Intentionally NOT retried on transient errors — the reviewer is read-only, so
 * there's nothing to reset. A thrown per-axis error propagates from Promise.all
 * directly to the orchestrator's terminal-failure branch.
 */
export function createReviewerStage(deps: ReviewerStageDeps): Stage {
  return {
    name: 'reviewer',
    canRun: () => true,
    async execute(state, ctx) {
      const wiCtx = state.outputs.wiContext as WorkItemContext | undefined;
      const analyzer = state.outputs.analyzer as AnalyzerOutput | undefined;
      const coder = state.outputs.coder as CoderOutput | undefined;
      const testAuthor = state.outputs.testAuthor as TestAuthorOutput | undefined;
      const worktree = state.outputs.worktree as WorktreeContext | undefined;

      if (!wiCtx || !analyzer || !coder || !worktree) {
        throw new Error(
          'reviewer requires state.outputs.{wiContext, analyzer, coder, worktree} to be populated',
        );
      }

      const prevAttempts =
        (state.outputs.reviewer as ReviewerOutput | undefined)?.attempts ?? 0;
      const attempts = prevAttempts + 1;

      const prompt = buildReviewerUserPrompt({
        wiCtx,
        analyzer,
        coder,
        testAuthor,
        worktree,
        attempts,
        maxAttempts: deps.config.maxRevisions,
      });

      const canUseTool = composeCanUseTool([
        createBashAllowlist({ allow: REVIEWER_BASH_ALLOW, deny: REVIEWER_BASH_DENY }),
      ]);
      // Production always supplies this from REVIEWER_MAX_TURNS; the fallback
      // exists for direct construction in tests and is kept equal to the config
      // default so the two can never quietly disagree.
      const maxTurns = deps.maxTurnsPerAxis ?? 50;

      // Bill each axis to its own key. One lumped `reviewer` number hides which
      // axis is expensive, and the axes are the whole of the reviewer's cost —
      // six independent full-context reads of the same diff.
      const costTracker = createCostTracker(state);
      const toolUsageTracker = createToolUsageTracker(state);

      // One axis failing must not leave the other five running. `Promise.all`
      // rejects on the first rejection but never cancels its siblings, so a
      // dead axis used to leave up to five full-context reviews running — and
      // billing — for minutes after the stage had already failed and written
      // its outcome. This controller cancels them, and stays chained to the
      // stage signal so an external abort still reaches every axis.
      const fanOut = new AbortController();
      const abortFanOut = (): void => fanOut.abort();
      if (ctx.signal.aborted) fanOut.abort();
      else ctx.signal.addEventListener('abort', abortFanOut, { once: true });

      // The first failure that is not a cancellation. Aborting the siblings
      // makes them reject too, so rethrowing whichever rejection happens to sit
      // first in axis order would report an AbortError as the cause of a
      // failure it was only a consequence of.
      let rootCause: unknown;

      const settled = await Promise.allSettled(
        REVIEW_AXES.map((axis) =>
          runWithParseRetry(
            () =>
              deps.runner.run<{ findings: Finding[] }>({
                prompt,
                label: `reviewer:${axis}`,
                schema: axisOutputSchema,
                model: modelFor(deps.config, 'reviewer'),
                tools: ['Read', 'Grep', 'Glob', 'Bash'],
                disallowedTools: [
                  'Edit',
                  'Write',
                  'NotebookEdit',
                  ...STRUCTURED_OUTPUT_DENIED_TOOLS,
                ],
                cwd: worktree.path,
                systemPromptAppend: `${deps.sharedPromptTemplate}\n\n${deps.axisPromptTemplates[axis]}`,
                settingSources: ['project'],
                maxTurns,
                canUseTool,
                signal: fanOut.signal,
              }),
            // Bill the attempts that threw as well. An axis that answers in
            // prose has still bought its tokens, and it is the expensive
            // failure mode — three full reviews of the same diff.
            (err) => {
              if (err instanceof AgentOutputParseError && err.spend) {
                costTracker.add(`reviewer:${axis}`, err.spend.costUsd, err.spend.usage);
                toolUsageTracker.add('reviewer', err.spend.toolUsage);
              }
            },
          )
            .then((result) => {
              // Bill on settle rather than after the fan-out: spend recorded
              // only once all six have resolved is spend discarded the moment
              // any one of them throws — including axes that finished
              // successfully minutes before the failure.
              costTracker.add(`reviewer:${axis}`, result.costUsd, result.usage);
              return result;
            })
            .catch((err: unknown) => {
              if (rootCause === undefined && !isAbortError(err)) rootCause = err;
              fanOut.abort();
              throw err;
            }),
        ),
      );

      ctx.signal.removeEventListener('abort', abortFanOut);

      if (rootCause !== undefined) throw rootCause;
      const rejected = settled.find((s) => s.status === 'rejected');
      if (rejected !== undefined) throw (rejected as PromiseRejectedResult).reason;

      const axisResults = settled.map(
        (s) =>
          (s as PromiseFulfilledResult<AgentRunResult<{ findings: Finding[] }>>).value,
      );

      const mergedToolUsage = mergeToolUsage(axisResults.map((r) => r.toolUsage));
      toolUsageTracker.add('reviewer', mergedToolUsage);

      // Clamp per axis BEFORE aggregating: the merge promotes a group to its
      // highest member, so a ceiling applied afterwards could be re-breached by
      // a co-located finding from a stricter axis. Keyed on the axis that
      // actually ran, never on the model-supplied `axis` field — that field is
      // part of what is being policed.
      const flat = axisResults.flatMap((r, i) => {
        const axis = REVIEW_AXES[i]!;
        const ceiling = AXIS_SEVERITY_CEILING[axis];
        return r.value.findings.map((f) => {
          const severity = clampSeverity(f.severity, ceiling);
          if (severity !== f.severity) {
            ctx.logger.info(
              `reviewer:${axis}: ${f.severity} -> ${severity} (axis ceiling) — ${f.file}: ${f.title}`,
            );
          }
          return { ...f, severity };
        });
      });
      const findings = aggregateReviewerFindings(flat);
      const approved = !findings.some(
        (f) => f.severity === 'blocking' || f.severity === 'critical',
      );

      const output: ReviewerOutput = { approved, findings, attempts };
      state.outputs.reviewer = output;
      return state;
    },
  };
}
