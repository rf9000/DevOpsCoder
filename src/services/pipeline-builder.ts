import type { Stage } from '../pipeline/stage.ts';
import type { AppConfig } from '../types/index.ts';
import type { AdoClient } from '../sdk/azure-devops-client.ts';
import type { Logger } from '../utils/logger.ts';

export interface PipelineBuilderDeps {
  config: AppConfig;
  logger: Logger;
  ado: AdoClient;
}

export function buildPipeline(_deps: PipelineBuilderDeps): Stage[] {
  // Plans 3-5 fill this in: analyzer, coder, revision loop, test author, reviewer, draft PR.
  return [];
}
