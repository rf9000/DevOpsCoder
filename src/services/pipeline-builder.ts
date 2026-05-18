import { readFileSync } from 'fs';
import type { Stage } from '../pipeline/stage.ts';
import type { AppConfig } from '../types/index.ts';
import type { AdoClient } from '../sdk/azure-devops-client.ts';
import type { Logger } from '../utils/logger.ts';
import type { AgentRunner, CanUseToolFn } from '../pipeline/agent-stage.ts';
import { createClaudeAgentRunner } from './claude-agent-runner.ts';
import {
  discoverTargetRepoSkills,
  type DiscoveredSkill,
} from './skill-loader.ts';
import { createAnalyzerStage } from '../pipeline/stages/analyzer.ts';

const ANALYZER_PROMPT_PATH = `${import.meta.dir}/../prompts/analyzer.md`;

export interface PipelineBuilderDeps {
  config: AppConfig;
  logger: Logger;
  ado: AdoClient;
  /** Optional runner override. Defaults to `createClaudeAgentRunner`. */
  runner?: AgentRunner;
  /** Optional skill-list override. Defaults to `discoverTargetRepoSkills(config.targetRepoPath)`. */
  discoveredSkills?: DiscoveredSkill[];
  /** Optional analyzer prompt body override. Defaults to the contents of `src/prompts/analyzer.md`. */
  analyzerPromptTemplate?: string;
  /** Optional Bash permission filter for the analyzer. */
  canUseTool?: CanUseToolFn;
}

export function buildPipeline(deps: PipelineBuilderDeps): Stage[] {
  const runner =
    deps.runner ??
    createClaudeAgentRunner({ config: deps.config, logger: deps.logger });
  const discoveredSkills =
    deps.discoveredSkills ??
    discoverTargetRepoSkills(deps.config.targetRepoPath);
  const analyzerPromptTemplate =
    deps.analyzerPromptTemplate ?? readFileSync(ANALYZER_PROMPT_PATH, 'utf-8');

  return [
    createAnalyzerStage({
      config: deps.config,
      ado: deps.ado,
      runner,
      discoveredSkills,
      promptTemplate: analyzerPromptTemplate,
      canUseTool: deps.canUseTool,
    }),
  ];
}
