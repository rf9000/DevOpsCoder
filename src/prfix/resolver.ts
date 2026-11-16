import { z } from 'zod';
import type { AgentRunner } from '../pipeline/agent-stage.ts';
import { AgentOutputParseError } from '../services/claude-agent-runner.ts';
import {
  composeCanUseTool,
  runWithParseRetry,
  STRUCTURED_OUTPUT_DENIED_TOOLS,
} from '../pipeline/stages/_stage-helpers.ts';
import type { AppConfig, PipelineState } from '../types/index.ts';
import { createBashAllowlist } from '../utils/bash-allowlist.ts';
import { createCostTracker } from '../utils/cost-tracker.ts';
import { effortFor, modelFor } from '../utils/model-selection.ts';
import { createPathEscapeFilter } from '../utils/path-escape-filter.ts';
import { createToolUsageTracker } from '../utils/tool-usage-tracker.ts';
import type { RebaseStep } from './prfix-git.ts';

/**
 * Read-only Bash for the resolver. The resolver runs mid-rebase: `git add`,
 * `git rebase --continue` and friends are the stage's job, and a model that ran
 * them itself would advance the rebase past checks the stage has not made yet.
 * Anything not matched here is denied (allowlist semantics).
 */
export const RESOLVER_BASH_ALLOW: RegExp[] = [
  /^git (status|diff|log|show|blame)\b/,
  /^ls\b/,
  /^cat\b/,
  /^pwd\b/,
];

export const resolverOutputSchema = z.object({
  files: z.array(z.object({ path: z.string(), resolution: z.string() })),
  summary: z.string(),
});

export type ResolverOutput = z.infer<typeof resolverOutputSchema>;

export function buildResolverPrompt(a: {
  commit: string;
  subject: string;
  files: string[];
  targetSha: string;
  prTitle: string;
}): string {
  return [
    `# Resolve rebase conflicts — PR: ${a.prTitle}`,
    '',
    `The PR branch is being rebased onto target commit \`${a.targetSha}\`.`,
    `Commit \`${a.commit}\` ("${a.subject}") stopped with conflicts in these files:`,
    '',
    ...a.files.map((f) => `- \`${f}\``),
    '',
    'Resolve exactly these files. Inspect with:',
    `- \`git show ${a.commit}\``,
    ...a.files.map((f) => `- \`git log ${a.targetSha} -- ${f}\``),
    '- `git diff`',
    '',
    'Keep the target side\'s changes and make the commit still do what its subject says.',
    'Leave no conflict markers, delete no files, and run no git command that changes state.',
  ].join('\n');
}

/**
 * One resolver call for one conflicted rebase step. Edits the files in place;
 * staging and `rebase --continue` are the caller's.
 *
 * Unlike fix-findings, a parse failure does NOT reset the worktree before the
 * retry: we are mid-rebase, and a reset would destroy the rebase state. The
 * retry simply runs against whatever the failed attempt left on disk.
 */
export async function resolveConflict(a: {
  runner: AgentRunner;
  config: AppConfig;
  promptTemplate: string;
  maxTurns: number;
  worktreePath: string;
  step: Extract<RebaseStep, { kind: 'conflict' }>;
  targetSha: string;
  prTitle: string;
  state: PipelineState;
  signal: AbortSignal;
}): Promise<ResolverOutput> {
  const prompt = buildResolverPrompt({
    commit: a.step.commit,
    subject: a.step.subject,
    files: a.step.files,
    targetSha: a.targetSha,
    prTitle: a.prTitle,
  });
  const canUseTool = composeCanUseTool([
    createBashAllowlist({ allow: RESOLVER_BASH_ALLOW, deny: [] }),
    createPathEscapeFilter(a.worktreePath),
  ]);
  const cost = createCostTracker(a.state);
  const tools = createToolUsageTracker(a.state);

  return runWithParseRetry(
    async (attempt) => {
      const { value, costUsd, toolUsage, usage } = await a.runner.run<ResolverOutput>({
        prompt,
        label: `rebase-resolver (attempt ${attempt + 1})`,
        schema: resolverOutputSchema,
        model: modelFor(a.config, 'rebase-resolver'),
        effort: effortFor(a.config, 'rebase-resolver'),
        tools: ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write'],
        disallowedTools: ['NotebookEdit', ...STRUCTURED_OUTPUT_DENIED_TOOLS],
        cwd: a.worktreePath,
        systemPromptAppend: a.promptTemplate,
        settingSources: ['project'],
        maxTurns: a.maxTurns,
        canUseTool,
        signal: a.signal,
      });
      cost.add('rebase-resolver', costUsd, usage);
      tools.add('rebase-resolver', toolUsage);
      return value;
    },
    (err) => {
      // A reply that failed to parse has still bought its tokens.
      if (err instanceof AgentOutputParseError && err.spend) {
        cost.add('rebase-resolver', err.spend.costUsd, err.spend.usage);
        tools.add('rebase-resolver', err.spend.toolUsage);
      }
    },
  );
}
