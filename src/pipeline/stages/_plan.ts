import { z } from 'zod';
import type { AgentRunner } from '../agent-stage.ts';
import { AgentOutputParseError } from '../../services/claude-agent-runner.ts';
import type { PlanOutput } from '../../types/index.ts';
import { createBashAllowlist } from '../../utils/bash-allowlist.ts';
import { createPathEscapeFilter } from '../../utils/path-escape-filter.ts';
import type { PlanStep } from '../../utils/model-selection.ts';
import { CODER_BASH_DENY } from './coder-policy.ts';
import { MAX_TRANSIENT_RETRIES, composeCanUseTool } from './_stage-helpers.ts';

/**
 * Tools a planner gets. No `Edit`/`Write`: the plan step exists so an expensive
 * model reasons about the change and a cheaper one types it, which only pays off
 * if the planner cannot start typing.
 */
export const PLAN_TOOLS = ['Read', 'Grep', 'Glob', 'Bash', 'Skill'] as const;

/** Belt to the tool list's braces — a preset-supplied writer tool still can't run. */
export const PLAN_DISALLOWED_TOOLS = ['Edit', 'Write', 'NotebookEdit'] as const;

/** Read-only subset of the coder's allowlist: inspect the tree, change nothing. */
export const PLAN_BASH_ALLOW: RegExp[] = [
  /^git (status|diff|log|show|blame)\b/,
  /^ls\b/,
  /^cat\b/,
  /^echo\b/,
  /^pwd\b/,
];

export const planOutputSchema = z.object({
  approach: z.string(),
  // Defaulted: a planner that returns only an approach is thin but usable, and
  // failing the stage over a missing array would burn the expensive call.
  steps: z.array(z.string()).default([]),
  filesToTouch: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
}) satisfies z.ZodType<PlanOutput>;

export interface RunPlanStepArgs {
  runner: AgentRunner;
  /** Cost-ledger key and runner log label suffix, e.g. 'coder-plan'. */
  step: PlanStep;
  /** Label for the runner's cost line, e.g. 'coder:plan'. */
  label: string;
  model: string;
  maxTurns: number;
  /** Same context prompt the write call gets, minus the plan section. */
  prompt: string;
  /** Contents of the planner prompt template. */
  systemPromptAppend: string;
  worktreePath: string;
  signal?: AbortSignal;
}

export interface PlanStepResult {
  plan: PlanOutput;
  costUsd: number;
  toolUsage: Record<string, number>;
}

/**
 * Run one read-only plan call. Retries a malformed structured output the same
 * way the write stages do; no worktree reset on failure because a planner has
 * no way to dirty the tree.
 */
export async function runPlanStep(args: RunPlanStepArgs): Promise<PlanStepResult> {
  const canUseTool = composeCanUseTool([
    createBashAllowlist({ allow: PLAN_BASH_ALLOW, deny: CODER_BASH_DENY }),
    createPathEscapeFilter(args.worktreePath),
  ]);

  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_TRANSIENT_RETRIES; attempt++) {
    try {
      const { value, costUsd, toolUsage } = await args.runner.run<PlanOutput>({
        prompt: args.prompt,
        label: args.label,
        schema: planOutputSchema,
        model: args.model,
        tools: [...PLAN_TOOLS],
        disallowedTools: [...PLAN_DISALLOWED_TOOLS],
        cwd: args.worktreePath,
        systemPromptAppend: args.systemPromptAppend,
        settingSources: ['project'],
        maxTurns: args.maxTurns,
        canUseTool,
        ...(args.signal ? { signal: args.signal } : {}),
      });
      return { plan: value, costUsd, toolUsage };
    } catch (err) {
      lastError = err;
      if (err instanceof AgentOutputParseError && attempt < MAX_TRANSIENT_RETRIES) {
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

/**
 * Render a plan into the markdown section the write call receives. Pure helper.
 * `heading` differs per stage ('Approved plan' vs 'Approved test plan') so the
 * writing agent knows whose plan it is looking at.
 */
export function renderPlanSection(plan: PlanOutput, heading: string, intro: string): string {
  const sections: string[] = [`\n## ${heading}\n`, intro, '', `**Approach:** ${plan.approach}`];
  if (plan.steps.length > 0) {
    sections.push('', '**Steps:**');
    plan.steps.forEach((s, i) => sections.push(`${i + 1}. ${s}`));
  }
  if (plan.filesToTouch.length > 0) {
    sections.push('', '**Files the plan expects to touch:**');
    for (const f of plan.filesToTouch) sections.push(`- ${f}`);
  }
  if (plan.risks.length > 0) {
    sections.push('', '**Risks called out by the planner:**');
    for (const r of plan.risks) sections.push(`- ${r}`);
  }
  return sections.join('\n');
}
