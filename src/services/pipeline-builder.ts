import { readFileSync } from 'fs';
import { join } from 'path';
import type { Stage } from '../pipeline/stage.ts';
import type { AppConfig, PipelineState, ReviewerOutput } from '../types/index.ts';
import type { AdoClient } from '../sdk/azure-devops-client.ts';
import type { Logger } from '../utils/logger.ts';
import type { AgentRunner, CanUseToolFn } from '../pipeline/agent-stage.ts';
import type { PipelineContext } from '../pipeline/stage.ts';
import { createClaudeAgentRunner } from './claude-agent-runner.ts';
import {
  discoverTargetRepoSkills,
  discoverSkillsIn,
  mergeSkills,
  type DiscoveredSkill,
} from './skill-loader.ts';
import {
  createWorktreeManager,
  type WorktreeManager,
} from './worktree-manager.ts';
import { createContiniaCli, type ContiniaCli } from './continia-cli.ts';
import type { DiscoveredTestCodeunit } from '../utils/al-test-discovery.ts';
import { createAnalyzerStage } from '../pipeline/stages/analyzer.ts';
import { createWorktreeSetupStage } from '../pipeline/stages/worktree-setup.ts';
import { createEnvProvisionStage } from '../pipeline/stages/env-provision.ts';
import { createBuildAndTestStage } from '../pipeline/stages/build-and-test.ts';
import { createCoderStage } from '../pipeline/stages/coder.ts';
import { createFixFindingsStage } from '../pipeline/stages/fix-findings.ts';
import { createVerifyGateStage } from '../pipeline/stages/_verify-gate.ts';
import { createTestAuthorStage } from '../pipeline/stages/test-author.ts';
import { createReviewerStage, REVIEW_AXES } from '../pipeline/stages/reviewer.ts';
import { revisionLoop } from '../pipeline/revision-loop.ts';
import { createDraftPrCreatorStage } from '../pipeline/stages/draft-pr-creator.ts';
import { createWorktreeTeardownStage } from '../pipeline/stages/worktree-teardown.ts';

const ANALYZER_PROMPT_PATH = `${import.meta.dir}/../prompts/analyzer.md`;
const CODER_PROMPT_PATH = `${import.meta.dir}/../prompts/coder.md`;
const CODER_PLANNER_PROMPT_PATH = `${import.meta.dir}/../prompts/coder-planner.md`;
const TEST_AUTHOR_PROMPT_PATH = `${import.meta.dir}/../prompts/test-author.md`;
const TEST_PLANNER_PROMPT_PATH = `${import.meta.dir}/../prompts/test-planner.md`;
const TEST_FIXER_PROMPT_PATH = `${import.meta.dir}/../prompts/test-fixer.md`;
const FIX_FINDINGS_PROMPT_PATH = `${import.meta.dir}/../prompts/fix-findings.md`;
const REVIEWER_SHARED_PROMPT_PATH = `${import.meta.dir}/../prompts/reviewer-shared.md`;
const DRAFT_PR_DESCRIPTION_PROMPT_PATH = `${import.meta.dir}/../prompts/draft-pr-description.md`;
const PR_MESSAGE_PROMPT_PATH = `${import.meta.dir}/../prompts/pr-message.md`;
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
  /** Optional ContiniaCli override. Defaults to `createContiniaCli` (real spawns). */
  continiaCli?: ContiniaCli;
  /** Optional test-fixer prompt body override. */
  testFixerPromptTemplate?: string;
  /** Test override: inject a fake AL test-codeunit discovery so build-and-test doesn't scan disk. */
  discoverTestCodeunits?: (
    worktreePath: string,
    testAppPaths: string[],
  ) => Promise<DiscoveredTestCodeunit[]>;
  /** Optional skill-list override. Defaults to `discoverTargetRepoSkills(config.targetRepoPath)`. */
  discoveredSkills?: DiscoveredSkill[];
  /** Optional analyzer prompt body override. */
  analyzerPromptTemplate?: string;
  /** Optional coder prompt body override. */
  coderPromptTemplate?: string;
  /** Optional code-planner prompt body override (plan step). */
  coderPlannerPromptTemplate?: string;
  /** Optional fix-findings prompt body override (revision rounds 2+). */
  fixFindingsPromptTemplate?: string;
  /** Optional test-author prompt body override. */
  testAuthorPromptTemplate?: string;
  /** Optional test-planner prompt body override (plan step). */
  testPlannerPromptTemplate?: string;
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
  /** Optional draft-PR description template override. Default reads from src/prompts/draft-pr-description.md. */
  prDescriptionTemplate?: string;
  /** Optional PR-message prompt body override. Default reads from src/prompts/pr-message.md. */
  prMessagePromptTemplate?: string;
  /** Optional pushBranch override for the draft-PR creator. Defaults to a real `git push origin <branch>` call. */
  pushBranch?: (branch: string, cwd: string) => Promise<void>;
}

/**
 * Builds the full Plan 5 stage chain:
 *   [analyzer, worktree-setup, revisionLoop(coder | fix-findings, verify, reviewer, onExhausted), test-author, draft-pr-creator, worktree-teardown]
 *
 * On exhaustion of the revision loop (reviewer rejected `maxRevisions` times),
 * onExhausted throws, the orchestrator records a terminalError, and the
 * processor (separately) posts the reviewer findings as a WI comment and
 * adds the blocked tag. On all failure paths (analyzer reject, coder/test-author
 * error, reviewer exhaustion, draft-PR creation failure), worktree teardown is
 * intentionally NOT run — humans inspect what the agent left behind.
 *
 * Production callers (CLI → processor) use the defaults; tests inject mocks via the
 * optional override fields.
 */
/**
 * Marker embedded in the revision loop's exhaustion error. The processor keys
 * its reviewer-findings comment on this instead of merely "reviewer output
 * exists", so a later-stage failure (e.g. a draft-PR 404) can no longer be
 * mislabelled as a reviewer rejection.
 */
export const REVISION_LOOP_EXHAUSTED = 'exhausted revision loop';

export function buildPipeline(deps: PipelineBuilderDeps): Stage[] {
  const runner =
    deps.runner ??
    createClaudeAgentRunner({ config: deps.config, logger: deps.logger });
  const worktreeManager =
    deps.worktreeManager ?? createWorktreeManager({ config: deps.config });
  const continiaCli = deps.continiaCli ?? createContiniaCli({ config: deps.config });
  const discoveredSkills =
    deps.discoveredSkills ??
    mergeSkills(
      discoverTargetRepoSkills(deps.config.targetRepoPath),
      deps.config.skillsSourceDir
        ? discoverSkillsIn(join(deps.config.skillsSourceDir, 'skills'))
        : [],
    );
  const analyzerPromptTemplate =
    deps.analyzerPromptTemplate ?? readFileSync(ANALYZER_PROMPT_PATH, 'utf-8');
  const coderPromptTemplate =
    deps.coderPromptTemplate ?? readFileSync(CODER_PROMPT_PATH, 'utf-8');
  const coderPlannerPromptTemplate =
    deps.coderPlannerPromptTemplate ?? readFileSync(CODER_PLANNER_PROMPT_PATH, 'utf-8');
  const testAuthorPromptTemplate =
    deps.testAuthorPromptTemplate ??
    readFileSync(TEST_AUTHOR_PROMPT_PATH, 'utf-8');
  const testPlannerPromptTemplate =
    deps.testPlannerPromptTemplate ?? readFileSync(TEST_PLANNER_PROMPT_PATH, 'utf-8');
  const testFixerPromptTemplate =
    deps.testFixerPromptTemplate ?? readFileSync(TEST_FIXER_PROMPT_PATH, 'utf-8');
  const fixFindingsPromptTemplate =
    deps.fixFindingsPromptTemplate ?? readFileSync(FIX_FINDINGS_PROMPT_PATH, 'utf-8');
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
  const prDescriptionTemplate =
    deps.prDescriptionTemplate ?? readFileSync(DRAFT_PR_DESCRIPTION_PROMPT_PATH, 'utf-8');
  const prMessagePromptTemplate =
    deps.prMessagePromptTemplate ?? readFileSync(PR_MESSAGE_PROMPT_PATH, 'utf-8');

  const coder = createCoderStage({
    config: deps.config,
    runner,
    promptTemplate: coderPromptTemplate,
    plannerPromptTemplate: coderPlannerPromptTemplate,
    discoveredSkills,
    getCurrentHeadSha: deps.getCurrentHeadSha,
    resetWorktree: deps.resetWorktree,
  });

  const fixFindings = createFixFindingsStage({
    config: deps.config,
    runner,
    promptTemplate: fixFindingsPromptTemplate,
    discoveredSkills,
    getCurrentHeadSha: deps.getCurrentHeadSha,
    resetWorktree: deps.resetWorktree,
  });

  // No in-loop verification without an environment — SKIP_BUILD_TEST removes
  // env-provision, so there is nothing to deploy to.
  const verify = deps.config.skipBuildTest
    ? undefined
    : createVerifyGateStage({
        config: deps.config,
        continiaCli,
        runner,
        logger: deps.logger,
        fixerPromptTemplate: testFixerPromptTemplate,
        discoveredSkills,
        getCurrentHeadSha: deps.getCurrentHeadSha,
        resetWorktree: deps.resetWorktree,
        discoverTestCodeunits: deps.discoverTestCodeunits,
      });

  const reviewer = createReviewerStage({
    config: deps.config,
    runner,
    maxTurnsPerAxis: deps.config.reviewerMaxTurns,
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
    createWorktreeSetupStage({ worktreeManager, config: deps.config }),
    ...(deps.config.skipBuildTest
      ? []
      : [
          createEnvProvisionStage({
            config: deps.config,
            continiaCli,
            logger: deps.logger,
          }),
        ]),
    revisionLoop({
      name: 'revision-loop',
      initialProducer: coder,
      reviseProducer: fixFindings,
      ...(verify ? { verify } : {}),
      reviewer,
      maxAttempts: deps.config.maxRevisions,
      isApproved: (state) => {
        const review = state.outputs.reviewer as ReviewerOutput | undefined;
        return review?.approved === true;
      },
      onExhausted: async (_state: PipelineState, _ctx: PipelineContext): Promise<PipelineState> => {
        throw new Error(
          `reviewer rejected ${deps.config.maxRevisions} times — ${REVISION_LOOP_EXHAUSTED}`,
        );
      },
    }),
    createTestAuthorStage({
      config: deps.config,
      runner,
      promptTemplate: testAuthorPromptTemplate,
      plannerPromptTemplate: testPlannerPromptTemplate,
      discoveredSkills,
      getCurrentHeadSha: deps.getCurrentHeadSha,
      resetWorktree: deps.resetWorktree,
    }),
    ...(deps.config.skipBuildTest
      ? []
      : [
          createBuildAndTestStage({
            config: deps.config,
            continiaCli,
            runner,
            logger: deps.logger,
            fixerPromptTemplate: testFixerPromptTemplate,
            discoveredSkills,
            getCurrentHeadSha: deps.getCurrentHeadSha,
            resetWorktree: deps.resetWorktree,
            discoverTestCodeunits: deps.discoverTestCodeunits,
          }),
        ]),
    createDraftPrCreatorStage({
      config: deps.config,
      ado: deps.ado,
      prDescriptionTemplate,
      // The nested `pr-message` step: writes title + bullets from the branch
      // diff, the way the team's fw-step4-pullRequest command does by hand.
      runner,
      prMessagePromptTemplate,
      pushBranch: deps.pushBranch,
      // Read-only here: used solely to fetch the environment login for the
      // description's Test Environment block.
      continiaCli,
    }),
    createWorktreeTeardownStage({
      worktreeManager,
      logger: deps.logger,
    }),
  ];
}
