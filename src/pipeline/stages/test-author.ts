import { z } from 'zod';
import type { Stage } from '../stage.ts';
import type { AgentRunner, CanUseToolFn } from '../agent-stage.ts';
import { AgentOutputParseError } from '../../services/claude-agent-runner.ts';
import type {
  AppConfig,
  CoderOutput,
  TestAuthorOutput,
  WorktreeContext,
} from '../../types/index.ts';
import type { WorkItemContext } from '../../services/wi-context.ts';
import type { DiscoveredSkill } from '../../services/skill-loader.ts';
import type { AnalyzerOutput } from './analyzer.ts';
import { createBashAllowlist } from '../../utils/bash-allowlist.ts';
import { createPathEscapeFilter } from '../../utils/path-escape-filter.ts';

export const testAuthorOutputSchema = z.object({
  summary: z.string(),
  testFilesChanged: z.array(z.string()),
  commits: z.array(z.string()),
}) satisfies z.ZodType<TestAuthorOutput>;

/** Maximum number of times the test-author retries the runner after an AgentOutputParseError. */
export const MAX_TRANSIENT_RETRIES = 2;

const TEST_AUTHOR_BASH_ALLOW: RegExp[] = [
  /^git (status|diff|log|show|blame)\b/,
  /^git add (?!-A\b|\.\s*$|--all\b|:\/)/,
  /^git commit\b/,
  /^git rm\b/,
  /^git mv\b/,
  // Test runners and quick verification
  /^bun (run )?test\b/,
  /^bun (run )?typecheck\b/,
  /^bun (run )?build\b/,
  /^bun (run )?lint\b/,
  /^npm (run )?test\b/,
  /^npm (run )?typecheck\b/,
  /^npm (run )?build\b/,
  /^npm (run )?lint\b/,
  /^npx vitest\b/,
  /^npx jest\b/,
  /^npx mocha\b/,
  /^jest\b/,
  /^vitest\b/,
  /^pytest\b/,
  /^go test\b/,
  // Basic file ops
  /^ls\b/,
  /^cat\b/,
  /^echo\b/,
  /^pwd\b/,
];

const TEST_AUTHOR_BASH_DENY: RegExp[] = [
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

function composeCanUseTool(filters: CanUseToolFn[]): CanUseToolFn {
  return async (toolName, input) => {
    for (const filter of filters) {
      const result = await filter(toolName, input);
      if (result.behavior === 'deny') return result;
    }
    return { behavior: 'allow' };
  };
}

async function defaultGetCurrentHeadSha(worktreePath: string): Promise<string> {
  const proc = Bun.spawn(['git', 'rev-parse', 'HEAD'], {
    cwd: worktreePath,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const out = await new Response(proc.stdout as ReadableStream).text();
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(
      `git rev-parse HEAD failed (exit ${code}) in ${worktreePath}`,
    );
  }
  return out.trim();
}

async function defaultResetWorktree(
  worktreePath: string,
  baselineSha: string,
): Promise<void> {
  try {
    const reset = Bun.spawn(['git', 'reset', '--hard', baselineSha], {
      cwd: worktreePath,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await reset.exited;
  } catch {
    // ignore
  }
  try {
    const clean = Bun.spawn(['git', 'clean', '-fd'], {
      cwd: worktreePath,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await clean.exited;
  } catch {
    // ignore
  }
}

export interface TestAuthorStageDeps {
  config: AppConfig;
  runner: AgentRunner;
  /** The contents of `src/prompts/test-author.md`. */
  promptTemplate: string;
  discoveredSkills: DiscoveredSkill[];
  /** Test override for the HEAD-sha lookup. */
  getCurrentHeadSha?: (worktreePath: string) => Promise<string>;
  /** Test override for the worktree reset. */
  resetWorktree?: (worktreePath: string, baselineSha: string) => Promise<void>;
}

/**
 * Build the test-author's user-prompt markdown. Pure helper for testability.
 */
export function buildTestAuthorUserPrompt(
  analyzer: AnalyzerOutput,
  coder: CoderOutput,
  wiCtx: WorkItemContext,
  worktree: WorktreeContext,
  skills: DiscoveredSkill[],
): string {
  const sections: string[] = [];
  sections.push(`# Writing tests for Work Item ${wiCtx.id}: ${wiCtx.title}`);
  sections.push('');
  sections.push('## Analyzer framing');
  sections.push(analyzer.summary);
  sections.push('');
  sections.push('## What the coder did');
  sections.push(coder.summary);
  if (coder.filesChanged.length > 0) {
    sections.push('\n### Files the coder changed\n');
    for (const f of coder.filesChanged) sections.push(`- ${f}`);
  }
  if (coder.commits.length > 0) {
    sections.push('\n### Coder commits\n');
    for (const c of coder.commits) sections.push(`- ${c}`);
  }
  sections.push('');
  sections.push('## Worktree');
  sections.push(`- Path: ${worktree.path}`);
  sections.push(`- Branch: ${worktree.branch}`);
  sections.push('');
  sections.push('## Work Item');
  sections.push(`Type: ${wiCtx.workItemType || 'unspecified'}`);

  if (wiCtx.description) {
    sections.push('\n### Description\n');
    sections.push(wiCtx.description);
  }
  if (wiCtx.acceptanceCriteria) {
    sections.push('\n### Acceptance Criteria\n');
    sections.push(wiCtx.acceptanceCriteria);
  }
  if (wiCtx.reproSteps) {
    sections.push('\n### Reproduction Steps\n');
    sections.push(wiCtx.reproSteps);
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
 * Hand-rolled Stage (same shape as the coder stage). Reads `state.outputs.coder`
 * and writes `state.outputs.testAuthor`. Runs in the same worktree the coder used.
 */
export function createTestAuthorStage(deps: TestAuthorStageDeps): Stage {
  const getHead = deps.getCurrentHeadSha ?? defaultGetCurrentHeadSha;
  const reset = deps.resetWorktree ?? defaultResetWorktree;

  return {
    name: 'test-author',
    canRun: () => true,
    async execute(state, _ctx) {
      const analyzer = state.outputs.analyzer as AnalyzerOutput | undefined;
      const coder = state.outputs.coder as CoderOutput | undefined;
      const wiCtx = state.outputs.wiContext as WorkItemContext | undefined;
      const worktree = state.outputs.worktree as WorktreeContext | undefined;
      if (!analyzer || !coder || !wiCtx || !worktree) {
        throw new Error(
          'test-author requires state.outputs.analyzer, .coder, .wiContext, and .worktree to be populated by upstream stages',
        );
      }

      const baselineSha = await getHead(worktree.path);
      const prompt = buildTestAuthorUserPrompt(
        analyzer,
        coder,
        wiCtx,
        worktree,
        deps.discoveredSkills,
      );
      const canUseTool = composeCanUseTool([
        createBashAllowlist({
          allow: TEST_AUTHOR_BASH_ALLOW,
          deny: TEST_AUTHOR_BASH_DENY,
        }),
        createPathEscapeFilter(worktree.path),
      ]);

      let lastError: unknown;
      for (let attempt = 0; attempt <= MAX_TRANSIENT_RETRIES; attempt++) {
        try {
          const output = await deps.runner.run<TestAuthorOutput>({
            prompt,
            schema: testAuthorOutputSchema,
            tools: ['Read', 'Grep', 'Glob', 'Bash', 'Skill', 'Edit', 'Write'],
            disallowedTools: ['NotebookEdit'],
            cwd: worktree.path,
            systemPromptAppend: deps.promptTemplate,
            settingSources: ['project'],
            maxTurns: deps.config.testAuthorMaxTurns,
            canUseTool,
          });
          state.outputs.testAuthor = output;
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
