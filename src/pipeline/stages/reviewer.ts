import { z } from 'zod';
import type { Stage } from '../stage.ts';
import type { AgentRunner } from '../agent-stage.ts';
import type {
  AppConfig,
  CoderOutput,
  Finding,
  ReviewerOutput,
  TestAuthorOutput,
  WorktreeContext,
} from '../../types/index.ts';
import type { WorkItemContext } from '../../services/wi-context.ts';
import type { AnalyzerOutput } from './analyzer.ts';
import { createBashAllowlist } from '../../utils/bash-allowlist.ts';
import { composeCanUseTool, aggregateReviewerFindings } from './_stage-helpers.ts';

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
  /^bun test\b/, // also covers `bun test <path>` and `bun test --run`
  /^ls\b/,
  /^cat\b/,
  /^pwd\b/,
];

const REVIEWER_BASH_DENY: RegExp[] = [
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
    async execute(state, _ctx) {
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
      const maxTurns = deps.maxTurnsPerAxis ?? 30;

      const axisResults = await Promise.all(
        REVIEW_AXES.map((axis) =>
          deps.runner.run<{ findings: Finding[] }>({
            prompt,
            schema: axisOutputSchema,
            tools: ['Read', 'Grep', 'Glob', 'Bash', 'Skill'],
            disallowedTools: ['Edit', 'Write', 'NotebookEdit'],
            cwd: worktree.path,
            systemPromptAppend: `${deps.sharedPromptTemplate}\n\n${deps.axisPromptTemplates[axis]}`,
            settingSources: ['project'],
            maxTurns,
            canUseTool,
          }),
        ),
      );

      const flat = axisResults.flatMap((r) => r.findings);
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
