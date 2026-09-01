import { z } from 'zod';
import type { AgentRunner, AgentUsage } from '../agent-stage.ts';
import { AgentOutputParseError } from '../../services/claude-agent-runner.ts';
import type { PrMessageOutput, WorktreeContext } from '../../types/index.ts';
import type { WorkItemContext } from '../../services/wi-context.ts';
import { createBashAllowlist } from '../../utils/bash-allowlist.ts';
import { createPathEscapeFilter } from '../../utils/path-escape-filter.ts';
import { CODER_BASH_DENY } from './coder-policy.ts';
import { MAX_TRANSIENT_RETRIES, composeCanUseTool } from './_stage-helpers.ts';

/**
 * The PR-message step: the automated port of the team's
 * `/FinishWork:fw-step4-pullRequest` command.
 *
 * It is a separate call, and not another field on the coder's output, because
 * the command's shape is what keeps its output short. The command reads
 * `git diff main...HEAD`, groups the hunks and writes one headline per group —
 * so there is nowhere for the *story* of the change to go. A coder asked for
 * the same bullets at the end of a 20-turn session that included review rounds
 * and a failed compile writes from memory of that session instead, and the
 * memory leaks in ("Reviewer findings addressed: ...", "no compile check was
 * possible"). A fresh context cannot narrate a run it never saw.
 */

/** Read-only: this step describes the branch, it never touches it. */
export const PR_MESSAGE_TOOLS = ['Read', 'Grep', 'Glob', 'Bash'] as const;

/** Belt to the tool list's braces — a preset-supplied writer tool still can't run. */
export const PR_MESSAGE_DISALLOWED_TOOLS = ['Edit', 'Write', 'NotebookEdit'] as const;

/** Enough to read a diff and the files it touches. Nothing that mutates. */
export const PR_MESSAGE_BASH_ALLOW: RegExp[] = [
  /^git (status|diff|log|show|blame)\b/,
  /^ls\b/,
  /^cat\b/,
  /^pwd\b/,
];

/**
 * Turn budget. Reading a diff and writing four lines is a short job; a low
 * ceiling is also the backstop against a model that decides to explore the
 * whole repository on a step whose entire input is one diff.
 */
export const PR_MESSAGE_MAX_TURNS = 20;

export const prMessageOutputSchema = z.object({
  title: z.string(),
  bullets: z.array(z.string()),
}) satisfies z.ZodType<PrMessageOutput>;

/**
 * Build the user prompt. The work item is included for framing only — which of
 * several changes is the dominant one — and the prompt says so, because the
 * description of a PR must come from the diff, not from the request.
 */
export function buildPrMessagePrompt(args: {
  wiCtx: WorkItemContext;
  worktree: WorktreeContext;
}): string {
  const { wiCtx, worktree } = args;
  return [
    `# Write the PR message for work item ${wiCtx.id}`,
    '',
    `**Worktree:** ${worktree.path}`,
    `**Branch:** ${worktree.branch}`,
    `**Base commit:** ${worktree.baseSha}`,
    '',
    `Read the branch's changes with \`git diff ${worktree.baseSha}..HEAD\` and follow`,
    'Steps 1-5 of your instructions.',
    '',
    '## Work item (framing only — describe the diff, not this)',
    '',
    `**${wiCtx.title}**`,
    '',
    wiCtx.description?.trim() || '_(no description)_',
  ].join('\n');
}

export interface RunPrMessageStepArgs {
  runner: AgentRunner;
  model: string;
  /** Contents of `src/prompts/pr-message.md`. */
  systemPromptAppend: string;
  wiCtx: WorkItemContext;
  worktree: WorktreeContext;
  signal?: AbortSignal;
}

export interface PrMessageStepResult {
  message: PrMessageOutput;
  costUsd: number;
  toolUsage: Record<string, number>;
  usage: AgentUsage;
}

/**
 * Run the PR-message call. Retries a malformed structured output the way the
 * other stages do; no worktree reset on failure, because a read-only step has
 * no way to dirty the tree.
 *
 * Callers treat a throw as "fall back to the coder's own bullets" — a PR whose
 * description is a little worse still beats no PR at all.
 */
export async function runPrMessageStep(
  args: RunPrMessageStepArgs,
): Promise<PrMessageStepResult> {
  const canUseTool = composeCanUseTool([
    createBashAllowlist({ allow: PR_MESSAGE_BASH_ALLOW, deny: CODER_BASH_DENY }),
    createPathEscapeFilter(args.worktree.path),
  ]);

  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_TRANSIENT_RETRIES; attempt++) {
    try {
      const { value, costUsd, toolUsage, usage } = await args.runner.run<PrMessageOutput>({
        prompt: buildPrMessagePrompt({ wiCtx: args.wiCtx, worktree: args.worktree }),
        label: 'pr-message',
        schema: prMessageOutputSchema,
        model: args.model,
        tools: [...PR_MESSAGE_TOOLS],
        disallowedTools: [...PR_MESSAGE_DISALLOWED_TOOLS],
        cwd: args.worktree.path,
        systemPromptAppend: args.systemPromptAppend,
        settingSources: ['project'],
        maxTurns: PR_MESSAGE_MAX_TURNS,
        canUseTool,
        ...(args.signal ? { signal: args.signal } : {}),
      });
      return { message: value, costUsd, toolUsage, usage };
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
