import { readFileSync } from 'fs';
import type { Stage } from '../pipeline/stage.ts';
import type { AppConfig, ReviewerOutput } from '../types/index.ts';
import type { AdoClient } from '../sdk/azure-devops-client.ts';
import type { Logger } from '../utils/logger.ts';
import type { AgentRunner, CanUseToolFn } from '../pipeline/agent-stage.ts';
import { createClaudeAgentRunner } from './claude-agent-runner.ts';
import {
  discoverTargetRepoSkills,
  type DiscoveredSkill,
} from './skill-loader.ts';
import {
  createWorktreeManager,
  type WorktreeManager,
} from './worktree-manager.ts';
import { createAnalyzerStage } from '../pipeline/stages/analyzer.ts';
import { createWorktreeSetupStage } from '../pipeline/stages/worktree-setup.ts';
import { createCoderStage } from '../pipeline/stages/coder.ts';
import { createTestAuthorStage } from '../pipeline/stages/test-author.ts';
import { createReviewerStage, REVIEW_AXES } from '../pipeline/stages/reviewer.ts';
import { revisionLoop } from '../pipeline/revision-loop.ts';

const ANALYZER_PROMPT_PATH = `${import.meta.dir}/../prompts/analyzer.md`;
const CODER_PROMPT_PATH = `${import.meta.dir}/../prompts/coder.md`;
const TEST_AUTHOR_PROMPT_PATH = `${import.meta.dir}/../prompts/test-author.md`;
const REVIEWER_SHARED_PROMPT_PATH = `${import.meta.dir}/../prompts/reviewer-shared.md`;
const REVIEWER_AXIS_PROMPT_PATHS: Record<typeof REVIEW_AXES[number], string> = {
  'safety-correctness': `${import.meta.dir}/../prompts/reviewers/safety-correctness.md`,
  'performance': `${import.meta.dir}/../prompts/reviewers/performance.md`,
  'code-structure': `${import.meta.dir}/../prompts/reviewers/code-structure.md`,
  'naming-style': `${import.meta.dir}/../prompts/reviewers/naming-style.md`,
  'security': `${import.meta.dir}/../prompts/reviewers/security.md`,
  'integration': `${import.meta.dir}/../prompts/reviewers/integration.md`,
};

export interface PipelineBuilderDeps {
  config: AppConfig;
  logger: Logger;
  ado: AdoClient;
  /** Optional runner override. Defaults to `createClaudeAgentRunner`. */
  runner?: AgentRunner;
  /** Optional worktree-manager override. Defaults to `createWorktreeManager`. */
  worktreeManager?: WorktreeManager;
  /** Optional skill-list override. Defaults to `discoverTargetRepoSkills(config.targetRepoPath)`. */
  discoveredSkills?: DiscoveredSkill[];
  /** Optional analyzer prompt body override. */
  analyzerPromptTemplate?: string;
  /** Optional coder prompt body override. */
  coderPromptTemplate?: string;
  /** Optional test-author prompt body override. */
  testAuthorPromptTemplate?: string;
  /** Optional reviewer shared-prompt body override. */
  reviewerSharedPromptTemplate?: string;
  /** Optional per-axis reviewer prompt body overrides. Default reads from src/prompts/reviewers/*.md. */
  reviewerAxisPromptTemplates?: Record<typeof REVIEW_AXES[number], string>;
  /** Optional canUseTool override for the analyzer. */
  canUseTool?: CanUseToolFn;
  /** Test override: inject a fake HEAD-sha reader so coder/test-author don't spawn git. */
  getCurrentHeadSha?: (worktreePath: string) => Promise<string>;
  /** Test override: inject a fake worktree resetter so coder/test-author don't spawn git. */
  resetWorktree?: (worktreePath: string, baselineSha: string) => Promise<void>;
}

/**
 * Builds the full stage chain:
 *   [analyzer, worktree-setup, revisionLoop(coder, reviewer), test-author]
 *
 * Production callers (CLI → processor) use the defaults; tests inject mocks via the
 * optional override fields.
 */
export function buildPipeline(deps: PipelineBuilderDeps): Stage[] {
  const runner =
    deps.runner ??
    createClaudeAgentRunner({ config: deps.config, logger: deps.logger });
  const worktreeManager =
    deps.worktreeManager ?? createWorktreeManager({ config: deps.config });
  const discoveredSkills =
    deps.discoveredSkills ??
    discoverTargetRepoSkills(deps.config.targetRepoPath);
  const analyzerPromptTemplate =
    deps.analyzerPromptTemplate ?? readFileSync(ANALYZER_PROMPT_PATH, 'utf-8');
  const coderPromptTemplate =
    deps.coderPromptTemplate ?? readFileSync(CODER_PROMPT_PATH, 'utf-8');
  const testAuthorPromptTemplate =
    deps.testAuthorPromptTemplate ??
    readFileSync(TEST_AUTHOR_PROMPT_PATH, 'utf-8');
  const reviewerSharedPromptTemplate =
    deps.reviewerSharedPromptTemplate ?? readFileSync(REVIEWER_SHARED_PROMPT_PATH, 'utf-8');
  // Object.fromEntries types as Record<string, string>; cast is safe because
  // the source array is REVIEW_AXES — the same union the cast widens to.
  const reviewerAxisPromptTemplates =
    deps.reviewerAxisPromptTemplates ??
    Object.fromEntries(
      REVIEW_AXES.map((axis) => [
        axis,
        readFileSync(REVIEWER_AXIS_PROMPT_PATHS[axis], 'utf-8'),
      ]),
    ) as Record<typeof REVIEW_AXES[number], string>;

  const coder = createCoderStage({
    config: deps.config,
    runner,
    promptTemplate: coderPromptTemplate,
    discoveredSkills,
    getCurrentHeadSha: deps.getCurrentHeadSha,
    resetWorktree: deps.resetWorktree,
  });

  const reviewer = createReviewerStage({
    config: deps.config,
    runner,
    sharedPromptTemplate: reviewerSharedPromptTemplate,
    axisPromptTemplates: reviewerAxisPromptTemplates,
  });

  return [
    createAnalyzerStage({
      config: deps.config,
      ado: deps.ado,
      runner,
      discoveredSkills,
      promptTemplate: analyzerPromptTemplate,
      canUseTool: deps.canUseTool,
    }),
    createWorktreeSetupStage({ worktreeManager }),
    revisionLoop({
      name: 'revision-loop',
      producer: coder,
      reviewer,
      maxAttempts: deps.config.maxRevisions,
      isApproved: (state) => {
        const review = state.outputs.reviewer as ReviewerOutput | undefined;
        return review?.approved === true;
      },
    }),
    createTestAuthorStage({
      config: deps.config,
      runner,
      promptTemplate: testAuthorPromptTemplate,
      discoveredSkills,
      getCurrentHeadSha: deps.getCurrentHeadSha,
      resetWorktree: deps.resetWorktree,
    }),
  ];
}
