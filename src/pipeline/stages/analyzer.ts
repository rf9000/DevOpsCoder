import { z } from 'zod';
import type { Stage } from '../stage.ts';
import { PipelineRejectError } from '../stage.ts';
import type { AdoClient } from '../../sdk/azure-devops-client.ts';
import type { AgentRunner, CanUseToolFn } from '../agent-stage.ts';
import {
  fetchWiContext as defaultFetchWiContext,
  type WorkItemContext,
} from '../../services/wi-context.ts';
import type { DiscoveredSkill } from '../../services/skill-loader.ts';
import type { AppConfig } from '../../types/index.ts';
import { createBashAllowlist } from '../../utils/bash-allowlist.ts';
import { STRUCTURED_OUTPUT_DENIED_TOOLS } from './_stage-helpers.ts';
import { modelFor } from '../../utils/model-selection.ts';
import { createCostTracker } from '../../utils/cost-tracker.ts';
import { createToolUsageTracker } from '../../utils/tool-usage-tracker.ts';

export const analyzerOutputSchema = z.object({
  verdict: z.enum(['proceed', 'reject']),
  summary: z.string(),
  reasons: z.array(z.string()),
  questions: z.array(z.string()).optional(),
});

export type AnalyzerOutput = z.infer<typeof analyzerOutputSchema>;

// The analyzer is a read-only readiness gate: it may inspect the target repo but
// must never mutate it. `disallowedTools` already blocks Edit/Write; this allowlist
// enforces the same contract on Bash instead of trusting the prompt alone.
const ANALYZER_BASH_ALLOW: RegExp[] = [
  /^git (status|diff|log|show|blame|grep|ls-files)\b/,
  /^ls\b/,
  /^cat\b/,
  /^head\b/,
  /^tail\b/,
  /^wc\b/,
  /^pwd\b/,
];

export interface AnalyzerStageDeps {
  config: AppConfig;
  ado: AdoClient;
  runner: AgentRunner;
  discoveredSkills: DiscoveredSkill[];
  /** The contents of `src/prompts/analyzer.md`, passed in by pipeline-builder. */
  promptTemplate: string;
  /** Optional override for the Bash permission filter. */
  canUseTool?: CanUseToolFn;
  /** Optional override of the fetcher (used by tests). Defaults to wi-context.ts. */
  fetchWiContext?: (
    ado: AdoClient,
    workItemId: number,
  ) => Promise<WorkItemContext>;
}

/**
 * Build the analyzer's user-prompt markdown from a fetched WI context and the
 * discovered skill catalog. Pure helper for testability.
 */
export function buildAnalyzerUserPrompt(
  ctx: WorkItemContext,
  skills: DiscoveredSkill[],
): string {
  const sections: string[] = [];

  sections.push(`# Work Item ${ctx.id}: ${ctx.title}`);
  sections.push(`\n**Type:** ${ctx.workItemType || 'unspecified'}`);
  sections.push(`**State:** ${ctx.state || 'unspecified'}`);

  sections.push('\n## Description\n');
  sections.push(ctx.description || '_(empty)_');

  if (ctx.reproSteps) {
    sections.push('\n## Reproduction Steps\n');
    sections.push(ctx.reproSteps);
  }

  if (ctx.acceptanceCriteria) {
    sections.push('\n## Acceptance Criteria\n');
    sections.push(ctx.acceptanceCriteria);
  }

  if (ctx.images.length > 0) {
    sections.push('\n## Attached images\n');
    for (const img of ctx.images) {
      sections.push(`- ${img.alt || '(no alt)'}: ${img.url}`);
    }
  }

  if (ctx.comments.length > 0) {
    sections.push('\n## Comment history\n');
    for (const c of ctx.comments) {
      const author = c.author || 'anonymous';
      const date = c.createdDate ? ` (${c.createdDate})` : '';
      sections.push(`### ${author}${date}\n${c.text}\n`);
    }
  }

  if (skills.length > 0) {
    sections.push('\n## Available Invocable Skills\n');
    for (const s of skills) {
      sections.push(`- **${s.name}**: ${s.description}`);
    }
  }

  return sections.join('\n');
}

/**
 * Hand-rolled Stage — the analyzer's
 * verdict branches into either `state.outputs.analyzer` (proceed) or
 * `throw new PipelineRejectError(...)` (reject), which the orchestrator catches
 * to populate `state.rejection`. The processor then dispatches the reject path.
 */
export function createAnalyzerStage(deps: AnalyzerStageDeps): Stage {
  const fetcher = deps.fetchWiContext ?? defaultFetchWiContext;
  const canUseTool =
    deps.canUseTool ??
    createBashAllowlist({ allow: ANALYZER_BASH_ALLOW, deny: [] });
  return {
    name: 'analyzer',
    canRun: () => true,
    async execute(state, ctx) {
      const wiCtx = await fetcher(deps.ado, state.workItemId);
      const prompt = buildAnalyzerUserPrompt(wiCtx, deps.discoveredSkills);

      const { value: output, costUsd, toolUsage, usage } = await deps.runner.run<AnalyzerOutput>({
        prompt,
        label: 'analyzer',
        schema: analyzerOutputSchema,
        model: modelFor(deps.config, 'analyzer'),
        tools: ['Read', 'Grep', 'Glob', 'Bash', 'Skill'],
        disallowedTools: ['Edit', 'Write', 'NotebookEdit', ...STRUCTURED_OUTPUT_DENIED_TOOLS],
        cwd: deps.config.targetRepoPath,
        systemPromptAppend: deps.promptTemplate,
        settingSources: ['project'],
        maxTurns: 20,
        canUseTool,
        signal: ctx.signal,
      });

      createCostTracker(state).add('analyzer', costUsd, usage);
      createToolUsageTracker(state).add('analyzer', toolUsage);
      state.outputs.wiContext = wiCtx;

      if (output.verdict === 'reject') {
        throw new PipelineRejectError({
          reasons: output.reasons,
          summary: output.summary,
          questions: output.questions,
        });
      }

      state.outputs.analyzer = output;
      return state;
    },
  };
}
