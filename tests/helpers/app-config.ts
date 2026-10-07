import { loadConfig } from '../../src/config/index.ts';
import type { AppConfig } from '../../src/types/index.ts';

/** The smallest env loadConfig accepts. SKIP_BUILD_TEST avoids the Continia token. */
export const MIN_ENV: Record<string, string> = {
  AZURE_DEVOPS_PAT: 'pat-0123456789',
  AZURE_DEVOPS_ORG: 'my-org',
  AZURE_DEVOPS_PROJECT: 'my-project',
  ADO_REPOSITORY_NAME: 'test-repo',
  TARGET_REPO_PATH: '/repo',
  WORKTREE_BASE: '/worktrees',
  MAX_COST_USD_PER_WI: '5',
  SKIP_BUILD_TEST: 'true',
};

export function makeTestConfig(
  env: Record<string, string | undefined> = {},
  overrides: Partial<AppConfig> = {},
): AppConfig {
  return { ...loadConfig({ ...MIN_ENV, ...env }), ...overrides };
}
