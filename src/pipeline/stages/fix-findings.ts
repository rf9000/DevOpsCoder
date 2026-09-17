import { z } from 'zod';
import type {
  AppConfig,
  CoderOutput,
  Finding,
  FindingAddressed,
  FindingSeverity,
  PlanOutput,
  ReviewerOutput,
  WorktreeContext,
} from '../../types/index.ts';
import type { DiscoveredSkill } from '../../services/skill-loader.ts';
import type { WorkItemContext } from '../../services/wi-context.ts';
import type { Stage } from '../stage.ts';
import type { AgentRunner } from '../agent-stage.ts';
import { AgentOutputParseError } from '../../services/claude-agent-runner.ts';
import { coderOutputSchema } from './coder.ts';
import { renderPlanSection } from './_plan.ts';
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
import { modelFor } from '../../utils/model-selection.ts';
import { createCostTracker } from '../../utils/cost-tracker.ts';
import { createToolUsageTracker } from '../../utils/tool-usage-tracker.ts';

/**
 * The fix step's output: the coder's shape plus a self-report on each finding.
 *
 * `findingsAddressed` is optional so a model that omits it degrades to "no
 * report" rather than failing the stage — the edits are the deliverable, the
 * report is commentary.
 */
export const fixFindingsOutputSchema = coderOutputSchema.extend({
  findingsAddressed: z
    .array(
      z.object({
        file: z.string(),
        line: z.number().optional(),
        action: z.enum(['fixed', 'declined']),
        reason: z.string(),
      }),
    )
    .optional(),
});

export type FixFindingsOutput = z.infer<typeof fixFindingsOutputSchema>;

// Keep in sync with SEVERITY_ORDER in ./coder.ts and SEVERITY_RANK in
// ./_stage-helpers.ts — diverging silently drops a severity group.
const SEVERITY_ORDER: FindingSeverity[] = ['blocking', 'critical', 'major', 'minor', 'nit'];

export interface BuildFixFindingsPromptArgs {
  findings: Finding[];
  /** `git diff <baseSha>..HEAD` from the worktree. */
  diff: string;
  worktree: WorktreeContext;
  workItemId: number;
  workItemTitle: string;
  /** The plan the coder already implemented. Context, never re-derived. */
  plan?: PlanOutput;
  skills: DiscoveredSkill[];
  round: number;
  maxRounds: number;
}

/**
 * Build the fix step's user prompt.
 *
 * Deliberately narrow. The coder's prompt carries the analyzer framing, the
 * full WI description, repro steps, acceptance criteria and the entire comment
 * history — everything needed to implement the change from nothing. Handing
 * that to a revision round is what turned WI 82205's rounds 2 and 3 into
 * re-implementations costing $3.90 and 147 turns instead of seven targeted
 * fixes. Only the WI id and title survive, and only so the agent can name what
 * it is working on.
 */
export function buildFixFindingsPrompt(args: BuildFixFindingsPromptArgs): string {
  const sections: string[] = [];

  sections.push(
    `# Fix reviewer findings — Work Item ${args.workItemId}: ${args.workItemTitle}  (round ${args.round} of ${args.maxRounds})`,
  );
  sections.push(
    `\nThe implementation in the worktree at \`${args.worktree.path}\` (branch ` +
      `\`${args.worktree.branch}\`, base \`${args.worktree.baseSha}\`) was rejected by the ` +
      `reviewer. Fix the findings below in that worktree and commit. Change nothing else.`,
  );

  sections.push('\n## Findings to address\n');
  const bySeverity = new Map<FindingSeverity, Finding[]>();
  for (const f of args.findings) {
    const group = bySeverity.get(f.severity);
    if (group) group.push(f);
    else bySeverity.set(f.severity, [f]);
  }
  for (const severity of SEVERITY_ORDER) {
    const group = bySeverity.get(severity);
    if (!group || group.length === 0) continue;
    sections.push(`\n### ${severity} findings\n`);
    for (const f of group) {
      const loc = f.line != null ? `${f.file}:${f.line}` : f.file;
      sections.push(`- **${loc}** (${f.axis}): ${f.title}`);
      sections.push(`  ${f.description}`);
      if (f.suggestion) sections.push(`  Suggestion: ${f.suggestion}`);
    }
  }

  sections.push('\n## Current diff under review\n');
  sections.push('```diff');
  sections.push(args.diff);
  sections.push('```');

  if (args.plan) {
    sections.push(
      renderPlanSection(
        args.plan,
        'Plan already implemented',
        'This plan was approved and implemented in an earlier round. It is context for ' +
          'understanding the change — do NOT re-derive it, and do not restructure the ' +
          'implementation to suit it. Fix the findings against the code as it stands.',
      ),
    );
  }

  if (args.skills.length > 0) {
    sections.push('\n## Available Invocable Skills\n');
    for (const s of args.skills) {
      sections.push(`- **${s.name}**: ${s.description}`);
    }
  }

  sections.push('\n## Rules');
  sections.push('- Fix the finding at its source. If the same rule is violated in another file you are touching, fix it there too — never copy the pattern forward into a new file.');
  sections.push('- Do not re-architect. An approved plan already ran; you are correcting it.');
  sections.push('- Do not weaken or delete tests to make anything pass.');
  sections.push('- Stage specific files (git add <file>), then git commit. Do not push.');
  sections.push('- Report each finding in `findingsAddressed` as `fixed` or `declined` with a reason. A `declined` finding is NOT waived — the reviewer will judge the code again regardless.');

  return sections.join('\n');
}

/** Read the diff the reviewer judged. Returns '' on failure — the findings
 *  still name their own file:line, so a missing diff degrades the prompt
 *  rather than failing the round. */
export async function defaultGetDiff(worktreePath: string, baseSha: string): Promise<string> {
  try {
    const proc = Bun.spawn(['git', 'diff', `${baseSha}..HEAD`], {
      cwd: worktreePath, stdout: 'pipe', stderr: 'pipe',
    });
    const out = await new Response(proc.stdout as ReadableStream).text();
    if ((await proc.exited) !== 0) return '';
    return out;
  } catch {
    return '';
  }
}

export interface FixFindingsStageDeps {
  config: AppConfig;
  runner: AgentRunner;
  /** The contents of `src/prompts/fix-findings.md`. */
  promptTemplate: string;
  discoveredSkills: DiscoveredSkill[];
  getCurrentHeadSha?: (worktreePath: string) => Promise<string>;
  resetWorktree?: (worktreePath: string, baselineSha: string) => Promise<void>;
  getDiff?: (worktreePath: string, baseSha: string) => Promise<string>;
}

/**
 * Rounds 2+ of the revision loop. Replaces the coder — it does not run in
 * addition to it — so exactly one producer runs per round.
 *
 * Writes `state.outputs.coder`, not a key of its own, because every downstream
 * consumer (the reviewer prompt, the draft-PR fallback bullets) reads
 * `outputs.coder`. Its own contribution, `findingsAddressed`, goes to a
 * separate key.
 */
export function createFixFindingsStage(deps: FixFindingsStageDeps): Stage {
  const getHead = deps.getCurrentHeadSha ?? defaultGetCurrentHeadSha;
  const reset = deps.resetWorktree ?? defaultResetWorktree;
  const diffOf = deps.getDiff ?? defaultGetDiff;

  return {
    name: 'fix-findings',
    canRun: () => true,
    async execute(state, ctx) {
      const worktree = state.outputs.worktree as WorktreeContext | undefined;
      const wiCtx = state.outputs.wiContext as WorkItemContext | undefined;
      const reviewer = state.outputs.reviewer as ReviewerOutput | undefined;
      if (!worktree || !wiCtx || !reviewer) {
        throw new Error(
          'fix-findings requires state.outputs.worktree, .wiContext and .reviewer to be populated by upstream stages',
        );
      }

      const baselineSha = await getHead(worktree.path);
      const prompt = buildFixFindingsPrompt({
        findings: reviewer.findings,
        diff: await diffOf(worktree.path, worktree.baseSha),
        worktree,
        workItemId: wiCtx.id,
        workItemTitle: wiCtx.title,
        ...(state.outputs.coderPlan ? { plan: state.outputs.coderPlan as PlanOutput } : {}),
        skills: deps.discoveredSkills,
        round: reviewer.attempts + 1,
        maxRounds: deps.config.maxRevisions,
      });

      const canUseTool = composeCanUseTool([
        createBashAllowlist({ allow: CODER_BASH_ALLOW, deny: CODER_BASH_DENY }),
        createPathEscapeFilter(worktree.path),
      ]);

      let lastError: unknown;
      for (let attempt = 0; attempt <= MAX_TRANSIENT_RETRIES; attempt++) {
        try {
          const { value, costUsd, toolUsage, usage } =
            await deps.runner.run<FixFindingsOutput>({
              prompt,
              label: `fix-findings (attempt ${attempt + 1})`,
              schema: fixFindingsOutputSchema,
              model: modelFor(deps.config, 'fix-findings'),
              tools: ['Read', 'Grep', 'Glob', 'Bash', 'Skill', 'Edit', 'Write'],
              disallowedTools: ['NotebookEdit', ...STRUCTURED_OUTPUT_DENIED_TOOLS],
              cwd: worktree.path,
              systemPromptAppend: deps.promptTemplate,
              settingSources: ['project'],
              maxTurns: deps.config.fixFindingsMaxTurns ?? deps.config.coderMaxTurns,
              canUseTool,
              signal: ctx.signal,
            });
          createCostTracker(state).add('fix-findings', costUsd, usage);
          createToolUsageTracker(state).add('fix-findings', toolUsage);

          const { findingsAddressed, ...coder } = value;
          state.outputs.coder = coder satisfies CoderOutput;
          if (findingsAddressed) {
            state.outputs.findingsAddressed = findingsAddressed satisfies FindingAddressed[];
          }
          return state;
        } catch (err) {
          lastError = err;
          await reset(worktree.path, baselineSha);
          if (err instanceof AgentOutputParseError && attempt < MAX_TRANSIENT_RETRIES) continue;
          throw err;
        }
      }
      throw lastError;
    },
  };
}
