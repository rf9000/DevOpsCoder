import { z } from 'zod';
import type { Stage } from '../stage.ts';
import type { AgentRunner } from '../agent-stage.ts';
import { AgentOutputParseError } from '../../services/claude-agent-runner.ts';
import type {
  AppConfig,
  CoderOutput,
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
} from './_stage-helpers.ts';

export { MAX_TRANSIENT_RETRIES } from './_stage-helpers.ts';

export const coderOutputSchema = z.object({
  summary: z.string(),
  filesChanged: z.array(z.string()),
  commits: z.array(z.string()),
}) satisfies z.ZodType<CoderOutput>;

const CODER_BASH_ALLOW: RegExp[] = [
  /^git (status|diff|log|show|blame)\b/,
  /^git add (?!-A\b|\.\s*$|--all\b|:\/)/,
  /^git commit\b/,
  /^git rm\b/,
  /^git mv\b/,
  /^(bun |npm |npx )(run )?(typecheck|build|lint)\b/,
  /^bun (run )?typecheck\b/,
  /^ls\b/,
  /^cat\b/,
  /^echo\b/,
  /^pwd\b/,
];

const CODER_BASH_DENY: RegExp[] = [
  /^git push\b/,
  /^git checkout\b/,
  /^git switch\b/,
  /^git reset\b/,
  /^git rebase\b/,
  /^git merge\b/,
  /^git branch (-d|-D|-m)\b/,
  /^git stash\b/,
  /^git clean\b/,
  /^git config\b/,
  /^git remote\b/,
  /^git commit --amend\b/,
  /^rm\b/,
  /^cd\b/,
  /^bun add\b/,
  /^bun remove\b/,
  /^npm install\b/,
  /^npm i\b/,
  /^pip install\b/,
];

export interface CoderStageDeps {
  config: AppConfig;
  runner: AgentRunner;
  /** The contents of `src/prompts/coder.md`. */
  promptTemplate: string;
  discoveredSkills: DiscoveredSkill[];
  /** Test override for the HEAD-sha lookup. */
  getCurrentHeadSha?: (worktreePath: string) => Promise<string>;
  /** Test override for the worktree reset. */
  resetWorktree?: (worktreePath: string, baselineSha: string) => Promise<void>;
}

/**
 * Build the coder's user-prompt markdown from analyzer output + WI context + worktree info.
 * Pure helper for testability.
 */
export function buildCoderUserPrompt(
  analyzer: AnalyzerOutput,
  wiCtx: WorkItemContext,
  worktree: WorktreeContext,
  skills: DiscoveredSkill[],
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
  return sections.join('\n');
}

/**
 * Hand-rolled Stage (intentionally NOT via the agentStage factory) — the coder
 * has retry-on-transient-error + baseline-reset-on-throw semantics that don't fit
 * the factory's transparent pass-through. The factory is for stages that just
 * run-the-runner-and-stash.
 */
export function createCoderStage(deps: CoderStageDeps): Stage {
  const getHead = deps.getCurrentHeadSha ?? defaultGetCurrentHeadSha;
  const reset = deps.resetWorktree ?? defaultResetWorktree;

  return {
    name: 'coder',
    canRun: () => true,
    async execute(state, _ctx) {
      const analyzer = state.outputs.analyzer as AnalyzerOutput | undefined;
      const wiCtx = state.outputs.wiContext as WorkItemContext | undefined;
      const worktree = state.outputs.worktree as WorktreeContext | undefined;
      if (!analyzer || !wiCtx || !worktree) {
        throw new Error(
          'coder requires state.outputs.analyzer, .wiContext, and .worktree to be populated by upstream stages',
        );
      }

      const baselineSha = await getHead(worktree.path);
      const prompt = buildCoderUserPrompt(
        analyzer,
        wiCtx,
        worktree,
        deps.discoveredSkills,
      );
      const canUseTool = composeCanUseTool([
        createBashAllowlist({ allow: CODER_BASH_ALLOW, deny: CODER_BASH_DENY }),
        createPathEscapeFilter(worktree.path),
      ]);

      let lastError: unknown;
      for (let attempt = 0; attempt <= MAX_TRANSIENT_RETRIES; attempt++) {
        try {
          const output = await deps.runner.run<CoderOutput>({
            prompt,
            schema: coderOutputSchema,
            tools: ['Read', 'Grep', 'Glob', 'Bash', 'Skill', 'Edit', 'Write'],
            disallowedTools: ['NotebookEdit'],
            cwd: worktree.path,
            systemPromptAppend: deps.promptTemplate,
            settingSources: ['project'],
            maxTurns: deps.config.coderMaxTurns,
            canUseTool,
          });
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
