import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  runPollCycle,
  createAbortFlag,
} from '../../src/services/watcher.ts';
import { PipelineStateStore } from '../../src/state/state-store.ts';
import { createLogger } from '../../src/utils/logger.ts';
import type { AppConfig, ProcessOutcome } from '../../src/types/index.ts';
import type { AdoClient } from '../../src/sdk/azure-devops-client.ts';
import type { Processor } from '../../src/services/processor.ts';

const baseConfig = {
  org: 'o',
  orgUrl: 'https://x',
  project: 'p',
  pat: 'pat',
  repositoryName: 'test-repo',
  targetRepoPath: '/r',
  worktreeBase: '/w',
  triggerTag: 'agent implement',
  blockedTag: 'agent-blocked',
  needInputTag: 'need-input',
  pollIntervalMinutes: 5,
  concurrency: 2,
  maxRevisions: 3,
  maxRejectCycles: 3,
  coderMaxTurns: 80,
  testAuthorMaxTurns: 50,
  claudeModel: 'claude-opus-4-7',
  stateDir: '.state',
  assignedToFilter: [],
  dryRun: false,
} satisfies AppConfig;

function makeAdo(ids: number[]): AdoClient {
  return {
    queryWorkItemsByTag: mock(async () => ids),
    getWorkItem: mock(async () => ({ id: 0, fields: {} })),
    getWorkItemComments: mock(async () => []),
    addTagToWorkItem: mock(async () => {}),
    removeTagFromWorkItem: mock(async () => {}),
    addWorkItemComment: mock(async () => {}),
  };
}

function makeProcessor(
  fn: (id: number) => Promise<ProcessOutcome>,
): Processor {
  return { processWorkItem: mock(fn) };
}

describe('runPollCycle', () => {
  let dir: string;
  let store: PipelineStateStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'watcher-'));
    store = new PipelineStateStore(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('aggregates outcomes across all candidate WIs', async () => {
    const ado = makeAdo([101, 102, 103, 104]);
    const proc = makeProcessor(async (id) => {
      if (id === 101) return { kind: 'completed', workItemId: id };
      if (id === 102) return { kind: 'paused', workItemId: id, stage: 'await-human' };
      if (id === 103)
        return {
          kind: 'failed',
          workItemId: id,
          error: { stage: 'x', message: 'boom', at: 'now' },
        };
      return { kind: 'skipped', workItemId: id, reason: 'closed-state' };
    });
    const stats = await runPollCycle({
      config: baseConfig,
      logger: createLogger(),
      ado,
      store,
      processor: proc,
      abortFlag: createAbortFlag(),
    });
    expect(stats).toEqual({
      considered: 4,
      completed: 1,
      paused: 1,
      failed: 1,
      skipped: 1,
      rejected: 0,
    });
  });

  it('queries ADO with the configured trigger tag', async () => {
    const ado = makeAdo([]);
    const proc = makeProcessor(async (id) => ({ kind: 'completed', workItemId: id }));
    await runPollCycle({
      config: { ...baseConfig, triggerTag: 'custom-tag' },
      logger: createLogger(),
      ado,
      store,
      processor: proc,
      abortFlag: createAbortFlag(),
    });
    expect(ado.queryWorkItemsByTag).toHaveBeenCalledWith('custom-tag');
  });

  it('unions tagged IDs with resumable state files (dedup)', async () => {
    store.save({
      workItemId: 999,
      slug: 'resume-me',
      startedAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      currentStage: 'something',
      history: [],
      attempts: {},
      outputs: {},
    });
    const ado = makeAdo([101, 999]);
    const seen: number[] = [];
    const proc = makeProcessor(async (id) => {
      seen.push(id);
      return { kind: 'completed', workItemId: id };
    });
    const stats = await runPollCycle({
      config: baseConfig,
      logger: createLogger(),
      ado,
      store,
      processor: proc,
      abortFlag: createAbortFlag(),
    });
    expect(stats.considered).toBe(2);
    expect(seen.sort()).toEqual([101, 999]);
  });

  it('respects config.concurrency by running at most N processors at once', async () => {
    let active = 0;
    let peak = 0;
    const proc = makeProcessor(async (id) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return { kind: 'completed', workItemId: id };
    });
    const ado = makeAdo([1, 2, 3, 4, 5, 6, 7, 8]);
    await runPollCycle({
      config: { ...baseConfig, concurrency: 3 },
      logger: createLogger(),
      ado,
      store,
      processor: proc,
      abortFlag: createAbortFlag(),
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  it('counts processor exceptions as failed without aborting the cycle', async () => {
    const proc = makeProcessor(async (id) => {
      if (id === 2) throw new Error('processor blew up');
      return { kind: 'completed', workItemId: id };
    });
    const ado = makeAdo([1, 2, 3]);
    const stats = await runPollCycle({
      config: baseConfig,
      logger: createLogger(),
      ado,
      store,
      processor: proc,
      abortFlag: createAbortFlag(),
    });
    expect(stats.considered).toBe(3);
    expect(stats.completed).toBe(2);
    expect(stats.failed).toBe(1);
  });

  it('returns zero stats and does not call the processor when no candidates', async () => {
    const proc = makeProcessor(async (id) => ({ kind: 'completed', workItemId: id }));
    const ado = makeAdo([]);
    const stats = await runPollCycle({
      config: baseConfig,
      logger: createLogger(),
      ado,
      store,
      processor: proc,
      abortFlag: createAbortFlag(),
    });
    expect(stats).toEqual({
      considered: 0,
      completed: 0,
      paused: 0,
      failed: 0,
      skipped: 0,
      rejected: 0,
    });
    expect(proc.processWorkItem).not.toHaveBeenCalled();
  });

  it('stops dispatching new work when abortFlag flips mid-cycle', async () => {
    const abortFlag = createAbortFlag();
    let processed = 0;
    const proc = makeProcessor(async (id) => {
      processed++;
      if (processed === 1) abortFlag.aborted = true;
      return { kind: 'completed', workItemId: id };
    });
    const ado = makeAdo([1, 2, 3, 4, 5]);
    const stats = await runPollCycle({
      config: { ...baseConfig, concurrency: 1 },
      logger: createLogger(),
      ado,
      store,
      processor: proc,
      abortFlag,
    });
    // 'considered' is the number of candidates found in the cycle (5).
    // The abort signal cuts the actual work short, so the four outcome counters
    // sum to LESS than 'considered' — that gap is the abort signature.
    expect(processed).toBeLessThan(5);
    expect(stats.considered).toBe(5);
    const dispatched =
      stats.completed + stats.paused + stats.failed + stats.skipped;
    expect(dispatched).toBeLessThan(stats.considered);
  });

  it('counts rejected outcomes into stats.rejected with severity in the log', async () => {
    const ado = makeAdo([301, 302]);
    const proc = makeProcessor(async (id) => {
      if (id === 301)
        return {
          kind: 'rejected',
          workItemId: id,
          severity: 'reject',
          rejectCount: 1,
        };
      return {
        kind: 'rejected',
        workItemId: id,
        severity: 'blocked',
        rejectCount: 3,
      };
    });
    const stats = await runPollCycle({
      config: baseConfig,
      logger: createLogger(),
      ado,
      store,
      processor: proc,
      abortFlag: createAbortFlag(),
    });
    expect(stats.considered).toBe(2);
    expect(stats.rejected).toBe(2);
    expect(stats.completed).toBe(0);
  });
});
