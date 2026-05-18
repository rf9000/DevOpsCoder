import { describe, it, expect } from 'bun:test';
import { buildPipeline } from '../../src/services/pipeline-builder.ts';
import { createLogger } from '../../src/utils/logger.ts';
import type { AdoClient } from '../../src/sdk/azure-devops-client.ts';
import type { AppConfig } from '../../src/types/index.ts';

const config = {
  org: 'o',
  orgUrl: 'https://x',
  project: 'p',
  pat: 'pat',
  targetRepoPath: '/r',
  worktreeBase: '/w',
  triggerTag: 'agent implement',
  blockedTag: 'agent-blocked',
  needInputTag: 'need-input',
  pollIntervalMinutes: 5,
  concurrency: 1,
  maxRevisions: 3,
  maxRejectCycles: 3,
  claudeModel: 'claude-opus-4-7',
  stateDir: '.state',
  assignedToFilter: [],
  dryRun: false,
} satisfies AppConfig;

const ado: AdoClient = {
  queryWorkItemsByTag: async () => [],
  getWorkItem: async () => ({ id: 0, fields: {} }),
  getWorkItemComments: async () => [],
  addTagToWorkItem: async () => {},
  removeTagFromWorkItem: async () => {},
  addWorkItemComment: async () => {},
};

describe('buildPipeline', () => {
  it('returns an empty stage list until Plan 3 wires the analyzer', () => {
    const stages = buildPipeline({ config, logger: createLogger(), ado });
    expect(stages).toEqual([]);
  });
});
