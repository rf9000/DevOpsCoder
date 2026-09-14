import { z } from 'zod';
import type { Stage } from '../stage.ts';
import type { AgentRunner } from '../agent-stage.ts';
import { AgentOutputParseError } from '../../services/claude-agent-runner.ts';
import type {
  AppConfig,
  CoderOutput,
  Finding,
  PlanOutput,
  ReviewerOutput,
  WorktreeContext,
} from '../../types/index.ts';
import type { WorkItemContext } from '../../services/wi-context.ts';
import type { DiscoveredSkill } from '../../services/skill-loader.ts';
import type { AnalyzerOutput } from './analyzer.ts';
import { createBashAllowlist } from '../../utils/bash-allowlist.ts';
import { createPathEscapeFilter } from '../../utils/path-escape-filter.ts';
import {
  MAX_TRANSIENT_RETRIES,
  composeCanUseTool,
  defaultGetCurrentHeadSha,
  defaultResetWorktree,
  STRUCTURED_OUTPUT_DENIED_TOOLS,
} from './_stage-helpers.ts';
import { CODER_BASH_ALLOW, CODER_BASH_DENY } from './coder-policy.ts';
import { modelFor, planMaxTurns, planModelFor } from '../../utils/model-selection.ts';
import { renderPlanSection, runPlanStep } from './_plan.ts';
import { createCostTracker } from '../../utils/cost-tracker.ts';
import { createToolUsageTracker } from '../../utils/tool-usage-tracker.ts';

export { MAX_TRANSIENT_RETRIES } from './_stage-helpers.ts';

export const coderOutputSchema = z.object({
  summary: z.string(),
  filesChanged: z.array(z.string()),
  commits: z.array(z.string()),
  // Optional so a state file written before these existed still validates on
  // re-entry, and so a model that omits them degrades to the WI title +
  // summary rather than failing the stage.
  prTitle: z.string().optional(),
  prBullets: z.array(z.string()).optional(),
}) satisfies z.ZodType<CoderOutput>;

// Re-exported for the build-and-test stage's fix calls (same agent, same
// policy) and for the read-only plan step, which reuses the deny half.
export { CODER_BASH_ALLOW, CODER_BASH_DENY } from './coder-policy.ts';

export interface CoderStageDeps {
  config: AppConfig;
  runner: AgentRunner;
  /** The contents of `src/prompts/coder.md`. */
  promptTemplate: string;
  /** The contents of `src/prompts/coder-planner.md`. Only read when a
   * `coder-plan` model is configured; without one there is no plan step. */
  plannerPromptTemplate?: string;
  discoveredSkills: DiscoveredSkill[];
  /** Test override for the HEAD-sha lookup. */
  getCurrentHeadSha?: (worktreePath: string) => Promise<string>;
  /** Test override for the worktree reset. */
  resetWorktree?: (worktreePath: string, baselineSha: string) => Promise<void>;
}

// Keep in sync with SEVERITY_RANK in ./_stage-helpers.ts — diverging would silently
// drop a severity group from the rendered prompt or skew aggregation ordering.
const SEVERITY_ORDER: Finding['severity'][] = [
  'blocking',
  'critical',
  'major',
  'minor',
  'nit',
];

/**
 * Build the coder's user-prompt markdown from analyzer output + WI context + worktree info.
 * Pure helper for testability.
 */
export function buildCoderUserPrompt(
  analyzer: AnalyzerOutput,
  wiCtx: WorkItemContext,
  worktree: WorktreeContext,
  skills: DiscoveredSkill[],
  previousReviewerFeedback?: Finding[],
  plan?: PlanOutput,
): string {
  const sections: string[] = [];
  sections.push(`# Implementing Work Item ${wiCtx.id}: ${wiCtx.title}`);
  sections.push('');
  sections.push('## Analyzer framing');
  sections.push(analyzer.summary);
  sections.push('');
  sections.push('## Worktree');
  sections.push(`- Path: ${worktree.path}`);
  sections.push(`- Branch: ${worktree.branch}`);
  sections.push(`- Base SHA: ${worktree.baseSha}`);
  sections.push('');
  sections.push('## Work Item');
  sections.push(`Type: ${wiCtx.workItemType || 'unspecified'}`);

  if (wiCtx.description) {
    sections.push('\n### Description\n');
    sections.push(wiCtx.description);
  }
  if (wiCtx.reproSteps) {
    sections.push('\n### Reproduction Steps\n');
    sections.push(wiCtx.reproSteps);
  }
  if (wiCtx.acceptanceCriteria) {
    sections.push('\n### Acceptance Criteria\n');
    sections.push(wiCtx.acceptanceCriteria);
  }
  if (wiCtx.images.length > 0) {
    sections.push('\n### Attached images\n');
    for (const img of wiCtx.images) {
      sections.push(`- ${img.alt || '(no alt)'}: ${img.url}`);
    }
  }
  if (wiCtx.comments.length > 0) {
    sections.push('\n### Comment history\n');
    for (const c of wiCtx.comments) {
      const author = c.author || 'anonymous';
      const date = c.createdDate ? ` (${c.createdDate})` : '';
      sections.push(`#### ${author}${date}\n${c.text}\n`);
    }
  }
  if (skills.length > 0) {
    sections.push('\n## Available Invocable Skills\n');
    for (const s of skills) {
      sections.push(`- **${s.name}**: ${s.description}`);
    }
  }
  if (previousReviewerFeedback && previousReviewerFeedback.length > 0) {
    sections.push('\n## Previous reviewer findings — address or justify ignoring\n');
    sections.push(
      'The reviewer rejected your previous attempt with the following findings.\n' +
      'For each, either fix the issue in this attempt OR explain in your summary\n' +
      'why the finding doesn\'t apply.',
    );
    // Group by severity, preserving within-group input order.
    const bySeverity = new Map<Finding['severity'], Finding[]>();
    for (const f of previousReviewerFeedback) {
      const group = bySeverity.get(f.severity);
      if (group) {
        group.push(f);
      } else {
        bySeverity.set(f.severity, [f]);
      }
    }
    for (const severity of SEVERITY_ORDER) {
      const group = bySeverity.get(severity);
      if (!group || group.length === 0) continue;
      sections.push(`\n### ${severity} findings\n`);
      for (const f of group) {
        const loc = f.line != null ? `${f.file}:${f.line}` : f.file;
        sections.push(`- **${loc}** (${f.axis}): ${f.title}`);
        sections.push(`  ${f.description}`);
        if (f.suggestion) {
          sections.push(`  Suggestion: ${f.suggestion}`);
        }
      }
    }
  }
  if (plan) {
    sections.push(
      renderPlanSection(
        plan,
        'Approved plan',
        'A planning agent produced this plan for the change. Implement it. If the ' +
          'codebase contradicts a step, follow the codebase and say so in your summary — ' +
          'do not silently redesign the approach.',
      ),
    );
  }
  return sections.join('\n');
}

/**
 * Hand-rolled Stage — the coder has retry-on-transient-error +
 * baseline-reset-on-throw semantics beyond a plain run-the-runner-and-stash.
 */
export function createCoderStage(deps: CoderStageDeps): Stage {
  const getHead = deps.getCurrentHeadSha ?? defaultGetCurrentHeadSha;
  const reset = deps.resetWorktree ?? defaultResetWorktree;

  return {
    name: 'coder',
    canRun: () => true,
    async execute(state, ctx) {
      const analyzer = state.outputs.analyzer as AnalyzerOutput | undefined;
      const wiCtx = state.outputs.wiContext as WorkItemContext | undefined;
      const worktree = state.outputs.worktree as WorktreeContext | undefined;
      if (!analyzer || !wiCtx || !worktree) {
        throw new Error(
          'coder requires state.outputs.analyzer, .wiContext, and .worktree to be populated by upstream stages',
        );
      }

      const baselineSha = await getHead(worktree.path);
      const reviewer = state.outputs.reviewer as ReviewerOutput | undefined;
      const previousFindings = reviewer?.findings;

      // Plan step — only when a plan model is configured. Re-planned on a
      // revision, because findings that reject an *approach* would otherwise be
      // re-implemented from the same stale plan; reused as-is on a plain re-entry
      // (resume after a crash or timeout) so the expensive call is not repeated
      // for nothing.
      const planModel = planModelFor(deps.config, 'coder-plan');
      let plan = state.outputs.coderPlan as PlanOutput | undefined;
      if (
        planModel !== undefined &&
        deps.plannerPromptTemplate !== undefined &&
        (plan === undefined || (previousFindings?.length ?? 0) > 0)
      ) {
        const planned = await runPlanStep({
          runner: deps.runner,
          step: 'coder-plan',
          label: 'coder:plan',
          model: planModel,
          maxTurns: planMaxTurns(deps.config),
          prompt: buildCoderUserPrompt(
            analyzer,
            wiCtx,
            worktree,
            deps.discoveredSkills,
            previousFindings,
          ),
          systemPromptAppend: deps.plannerPromptTemplate,
          worktreePath: worktree.path,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        createCostTracker(state).add('coder-plan', planned.costUsd, planned.usage);
        createToolUsageTracker(state).add('coder-plan', planned.toolUsage);
        plan = planned.plan;
        state.outputs.coderPlan = plan;
      }
      const prompt = buildCoderUserPrompt(
        analyzer,
        wiCtx,
        worktree,
        deps.discoveredSkills,
        previousFindings,
        plan,
      );
      const canUseTool = composeCanUseTool([
        createBashAllowlist({ allow: CODER_BASH_ALLOW, deny: CODER_BASH_DENY }),
        createPathEscapeFilter(worktree.path),
      ]);

      let lastError: unknown;
      for (let attempt = 0; attempt <= MAX_TRANSIENT_RETRIES; attempt++) {
        try {
          const { value: output, costUsd, toolUsage, usage } = await deps.runner.run<CoderOutput>({
            prompt,
            label: `coder (attempt ${attempt + 1})`,
            schema: coderOutputSchema,
            model: modelFor(deps.config, 'coder'),
            tools: ['Read', 'Grep', 'Glob', 'Bash', 'Skill', 'Edit', 'Write'],
            disallowedTools: ['NotebookEdit', ...STRUCTURED_OUTPUT_DENIED_TOOLS],
            cwd: worktree.path,
            systemPromptAppend: deps.promptTemplate,
            settingSources: ['project'],
            maxTurns: deps.config.coderMaxTurns,
            canUseTool,
            signal: ctx.signal,
          });
          // Only record cost on success (failed attempts threw before this line).
          createCostTracker(state).add('coder', costUsd, usage);
          createToolUsageTracker(state).add('coder', toolUsage);
          state.outputs.coder = output;
          return state;
        } catch (err) {
          lastError = err;
          await reset(worktree.path, baselineSha);
          if (
            err instanceof AgentOutputParseError &&
            attempt < MAX_TRANSIENT_RETRIES
          ) {
            continue;
          }
          throw err;
        }
      }
      throw lastError;
    },
  };
}
