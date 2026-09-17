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
import type { Logger } from '../../src/utils/logger.ts';
import type { AppConfig, ProcessOutcome } from '../../src/types/index.ts';
import type { AdoClient } from '../../src/sdk/azure-devops-client.ts';
import type { Processor } from '../../src/services/processor.ts';

interface CapturedLogger extends Logger {
  infoLines: string[];
  errorLines: string[];
}

function makeCaptureLogger(): CapturedLogger {
  const infoLines: string[] = [];
  const errorLines: string[] = [];
  return {
    infoLines,
    errorLines,
    info(msg: string) { infoLines.push(msg); },
    warn(_msg: string) {},
    error(msg: string) { errorLines.push(msg); },
  };
}

const baseConfig = {
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
  coderMaxTurns: 80, reviewerMaxTurns: 50,
  testAuthorMaxTurns: 50,
  maxCostUsdPerWi: 5.00,
  stageTimeoutMs: {},
  claudeModel: 'claude-opus-4-7',
  stateDir: '.state', logDir: 'logs',
  assignedToFilter: [],
  continiaCliPath: '.tools/continia.exe', continiaEnvProfileId: 'prof-1', continiaEnvLocalization: 'base', continiaApiToken: 'tok', continiaAppPaths: ['App'], continiaTestAppPaths: ['App'], maxTestFixAttempts: 2, continiaTestTimeoutS: 600, dryRun: false, skipBuildTest: false, testSelection: 'all', maxTestCodeunits: 0, costLogPath: '.state/cost-ledger.jsonl',
} satisfies AppConfig;

function makeAdo(ids: number[]): AdoClient {
  return {
    queryWorkItemsByTag: mock(async () => ids),
    getWorkItem: mock(async () => ({ id: 0, fields: {} })),
    getWorkItemComments: mock(async () => []),
    getWorkItemUpdates: mock(async () => []),
    createPullRequestThread: mock(async () => {}),
    addTagToWorkItem: mock(async () => {}),
    removeTagFromWorkItem: mock(async () => {}),
    addWorkItemComment: mock(async () => {}),
    createPullRequest: mock(async () => ({ id: 0, url: '', sourceRefName: '', targetRefName: '' })),
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
      if (id === 101) return { kind: 'completed', workItemId: id, costUsd: 0, toolUsage: {}, perStage: {} };
      if (id === 102) return { kind: 'paused', workItemId: id, stage: 'await-human', costUsd: 0, toolUsage: {}, perStage: {} };
      if (id === 103)
        return {
          kind: 'failed',
          workItemId: id,
          error: { stage: 'x', message: 'boom', at: 'now' },
          costUsd: 0,
          toolUsage: {},
          perStage: {},
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
    const proc = makeProcessor(async (id) => ({ kind: 'completed', workItemId: id, costUsd: 0, toolUsage: {}, perStage: {} }));
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
      outputs: {},
    });
    const ado = makeAdo([101, 999]);
    const seen: number[] = [];
    const proc = makeProcessor(async (id) => {
      seen.push(id);
      return { kind: 'completed', workItemId: id, costUsd: 0, toolUsage: {}, perStage: {} };
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
      return { kind: 'completed', workItemId: id, costUsd: 0, toolUsage: {}, perStage: {} };
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
      return { kind: 'completed', workItemId: id, costUsd: 0, toolUsage: {}, perStage: {} };
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
    const proc = makeProcessor(async (id) => ({ kind: 'completed', workItemId: id, costUsd: 0, toolUsage: {}, perStage: {} }));
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
      return { kind: 'completed', workItemId: id, costUsd: 0, toolUsage: {}, perStage: {} };
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
          costUsd: 0,
          toolUsage: {},
          perStage: {},
        };
      return {
        kind: 'rejected',
        workItemId: id,
        severity: 'blocked',
        rejectCount: 3,
        costUsd: 0,
        toolUsage: {},
        perStage: {},
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

  it('completed outcome log includes cost suffix', async () => {
    const captured = makeCaptureLogger();
    const ado = makeAdo([401]);
    const proc = makeProcessor(async (id) => ({
      kind: 'completed',
      workItemId: id,
      costUsd: 0.42,
      toolUsage: {},
      perStage: {},
    }));
    await runPollCycle({
      config: baseConfig,
      logger: captured,
      ado,
      store,
      processor: proc,
      abortFlag: createAbortFlag(),
    });
    expect(captured.infoLines.some((l) => l.includes('(cost: $0.42)'))).toBe(true);
  });

  // The grand total alone cannot be read back to a cause, which is the whole
  // reason a $17 run reads as unattributable while tailing the container log.
  it('logs a per-step spend split alongside the completed outcome', async () => {
    const captured = makeCaptureLogger();
    const ado = makeAdo([402]);
    const proc = makeProcessor(async (id) => ({
      kind: 'completed',
      workItemId: id,
      costUsd: 12.36,
      toolUsage: {},
      perStage: {
        coder: { usd: 8.21, calls: 3, inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, turns: 0, models: [] },
        reviewer: { usd: 4.02, calls: 6, inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, turns: 0, models: [] },
        analyzer: { usd: 0.13, calls: 1, inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, turns: 0, models: [] },
      },
    }));
    await runPollCycle({
      config: baseConfig,
      logger: captured,
      ado,
      store,
      processor: proc,
      abortFlag: createAbortFlag(),
    });
    expect(
      captured.infoLines.some((l) =>
        l.includes('WI 402: spend — coder $8.21, reviewer $4.02, analyzer $0.13'),
      ),
    ).toBe(true);
  });

  it('logs the spend split for a failed run too', async () => {
    const captured = makeCaptureLogger();
    const ado = makeAdo([403]);
    const proc = makeProcessor(async (id) => ({
      kind: 'failed',
      workItemId: id,
      error: { stage: 'build-and-test', message: 'verification failed', at: 'now' },
      costUsd: 1.9,
      toolUsage: {},
      perStage: {
        'test-fixer': { usd: 1.9, calls: 4, inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, turns: 0, models: [] },
      },
    }));
    await runPollCycle({
      config: baseConfig,
      logger: captured,
      ado,
      store,
      processor: proc,
      abortFlag: createAbortFlag(),
    });
    expect(captured.infoLines.some((l) => l.includes('WI 403: spend — test-fixer $1.90'))).toBe(true);
  });

  it('omits the spend line when no per-step spend was recorded', async () => {
    const captured = makeCaptureLogger();
    const ado = makeAdo([404]);
    const proc = makeProcessor(async (id) => ({
      kind: 'completed',
      workItemId: id,
      costUsd: 0,
      toolUsage: {},
      perStage: {},
    }));
    await runPollCycle({
      config: baseConfig,
      logger: captured,
      ado,
      store,
      processor: proc,
      abortFlag: createAbortFlag(),
    });
    expect(captured.infoLines.some((l) => l.includes('spend —'))).toBe(false);
  });

  it('completed outcome log includes tool-usage suffix after the cost segment', async () => {
    const captured = makeCaptureLogger();
    const ado = makeAdo([411]);
    const proc = makeProcessor(async (id) => ({
      kind: 'completed',
      workItemId: id,
      costUsd: 0.42,
      toolUsage: { Edit: 5, Bash: 2 },
      perStage: {},
    }));
    await runPollCycle({
      config: baseConfig,
      logger: captured,
      ado,
      store,
      processor: proc,
      abortFlag: createAbortFlag(),
    });
    const line = captured.infoLines.find((l) => l.includes('completed'));
    expect(line).toBeDefined();
    expect(line).toContain('(cost: $0.42, tools: Edit×5, Bash×2)');
  });

  it('paused outcome log includes cost suffix and stage', async () => {
    const captured = makeCaptureLogger();
    const ado = makeAdo([402]);
    const proc = makeProcessor(async (id) => ({
      kind: 'paused',
      workItemId: id,
      stage: 'await-human',
      costUsd: 0.10,
      toolUsage: {},
      perStage: {},
    }));
    await runPollCycle({
      config: baseConfig,
      logger: captured,
      ado,
      store,
      processor: proc,
      abortFlag: createAbortFlag(),
    });
    const line = captured.infoLines.find((l) => l.includes('paused'));
    expect(line).toBeDefined();
    expect(line).toContain('await-human');
    expect(line).toContain('(cost: $0.10)');
  });

  it('paused outcome log includes tool-usage suffix', async () => {
    const captured = makeCaptureLogger();
    const ado = makeAdo([412]);
    const proc = makeProcessor(async (id) => ({
      kind: 'paused',
      workItemId: id,
      stage: 'await-human',
      costUsd: 0.10,
      toolUsage: { Write: 1 },
      perStage: {},
    }));
    await runPollCycle({
      config: baseConfig,
      logger: captured,
      ado,
      store,
      processor: proc,
      abortFlag: createAbortFlag(),
    });
    const line = captured.infoLines.find((l) => l.includes('paused'));
    expect(line).toBeDefined();
    expect(line).toContain('await-human');
    expect(line).toContain('(cost: $0.10, tools: Write×1)');
  });

  it('failed outcome error log includes cost suffix and stage + message', async () => {
    const captured = makeCaptureLogger();
    const ado = makeAdo([403]);
    const proc = makeProcessor(async (id) => ({
      kind: 'failed',
      workItemId: id,
      error: { stage: 'coder', message: 'oops', at: 'now' },
      costUsd: 1.23,
      toolUsage: {},
      perStage: {},
    }));
    await runPollCycle({
      config: baseConfig,
      logger: captured,
      ado,
      store,
      processor: proc,
      abortFlag: createAbortFlag(),
    });
    const line = captured.errorLines.find((l) => l.includes('failed'));
    expect(line).toBeDefined();
    expect(line).toContain('coder');
    expect(line).toContain('oops');
    expect(line).toContain('(cost: $1.23)');
  });

  it('failed outcome error log includes tool-usage suffix', async () => {
    const captured = makeCaptureLogger();
    const ado = makeAdo([413]);
    const proc = makeProcessor(async (id) => ({
      kind: 'failed',
      workItemId: id,
      error: { stage: 'coder', message: 'oops', at: 'now' },
      costUsd: 1.23,
      toolUsage: { Bash: 3 },
      perStage: {},
    }));
    await runPollCycle({
      config: baseConfig,
      logger: captured,
      ado,
      store,
      processor: proc,
      abortFlag: createAbortFlag(),
    });
    const line = captured.errorLines.find((l) => l.includes('failed'));
    expect(line).toBeDefined();
    expect(line).toContain('coder');
    expect(line).toContain('oops');
    expect(line).toContain('(cost: $1.23, tools: Bash×3)');
  });

  it('rejected outcome log includes cost suffix and severity + count', async () => {
    const captured = makeCaptureLogger();
    const ado = makeAdo([404]);
    const proc = makeProcessor(async (id) => ({
      kind: 'rejected',
      workItemId: id,
      severity: 'reject',
      rejectCount: 2,
      costUsd: 0.05,
      toolUsage: {},
      perStage: {},
    }));
    await runPollCycle({
      config: baseConfig,
      logger: captured,
      ado,
      store,
      processor: proc,
      abortFlag: createAbortFlag(),
    });
    const line = captured.infoLines.find((l) => l.includes('rejected'));
    expect(line).toBeDefined();
    expect(line).toContain('reject');
    expect(line).toContain('count=2');
    expect(line).toContain('cost: $0.05');
  });

  it('rejected outcome log has no tools fragment when toolUsage is empty', async () => {
    const captured = makeCaptureLogger();
    const ado = makeAdo([414]);
    const proc = makeProcessor(async (id) => ({
      kind: 'rejected',
      workItemId: id,
      severity: 'reject',
      rejectCount: 2,
      costUsd: 0.05,
      toolUsage: {},
      perStage: {},
    }));
    await runPollCycle({
      config: baseConfig,
      logger: captured,
      ado,
      store,
      processor: proc,
      abortFlag: createAbortFlag(),
    });
    const line = captured.infoLines.find((l) => l.includes('rejected'));
    expect(line).toBeDefined();
    expect(line).toContain('cost: $0.05');
    expect(line).not.toContain('tools:');
  });

  it('skipped outcome log does NOT include cost suffix', async () => {
    const captured = makeCaptureLogger();
    const ado = makeAdo([405]);
    const proc = makeProcessor(async (id) => ({
      kind: 'skipped',
      workItemId: id,
      reason: 'closed-state',
    }));
    await runPollCycle({
      config: baseConfig,
      logger: captured,
      ado,
      store,
      processor: proc,
      abortFlag: createAbortFlag(),
    });
    const line = captured.infoLines.find((l) => l.includes('skipped'));
    expect(line).toBeDefined();
    expect(line).toContain('closed-state');
    expect(line).not.toContain('cost:');
  });
});
