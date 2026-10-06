import { describe, it, expect, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ENV_DELETED_KEY, sweepClosedPrEnvironments } from '../../src/services/env-cleanup.ts';
import { PipelineStateStore } from '../../src/state/state-store.ts';
import type { AppConfig, PipelineState, PullRequestStatus } from '../../src/types/index.ts';

const config = {
  repositoryName: 'repo',
  targetRepoPath: '/r',
  deleteEnvOnPrClose: true,
} as AppConfig;

const logger = { info: mock(() => {}), warn: mock(() => {}), error: mock(() => {}) };

function withStore(fn: (store: PipelineStateStore) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'env-cleanup-'));
  return fn(new PipelineStateStore(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

function wiState(id: number, envName = `wi-${id}-fix`): PipelineState {
  return {
    workItemId: id, slug: `wi-${id}`, startedAt: '', updatedAt: '', currentStage: null, history: [],
    completedAt: '2026-10-01T00:00:00Z',
    outputs: {
      environment: { envId: `env-${id}`, name: envName, status: 'Running', createdAt: '' },
      draftPr: { id: id * 10, url: 'u', branch: 'b', createdAt: '' },
    },
  };
}

function cli(opts: { deleteFails?: boolean; status?: string } = {}) {
  return {
    deleteEnvironment: mock(async () => {
      if (opts.deleteFails) throw new Error('404 not found');
    }),
    getEnvironment: mock(async () => ({ envId: 'x', status: opts.status ?? 'Running' }) as never),
  };
}

const statuses = (map: Record<number, PullRequestStatus>) => ({
  getPullRequestStatus: mock(async (_repo: string, prId: number) => map[prId] ?? 'active'),
});

describe('sweepClosedPrEnvironments', () => {
  it('deletes the environments of completed and abandoned PRs only, and stamps the state', async () => {
    await withStore(async (store) => {
      store.save(wiState(1));
      store.save(wiState(2));
      store.save(wiState(3));
      const continiaCli = cli();
      const n = await sweepClosedPrEnvironments({
        config, logger, store, continiaCli,
        ado: statuses({ 10: 'completed', 20: 'abandoned', 30: 'active' }),
        now: () => new Date('2026-10-06T12:00:00Z'),
      });
      expect(n).toBe(2);
      expect(continiaCli.deleteEnvironment.mock.calls.map((c) => (c as unknown[])[0]).sort()).toEqual(['env-1', 'env-2']);
      expect(store.load(1)!.outputs[ENV_DELETED_KEY]).toBe('2026-10-06T12:00:00.000Z');
      expect(store.load(3)!.outputs[ENV_DELETED_KEY]).toBeUndefined();
    });
  });

  it('never deletes twice, never deletes a name it did not give, and does nothing when disabled', async () => {
    await withStore(async (store) => {
      const done = wiState(1);
      done.outputs[ENV_DELETED_KEY] = 'earlier';
      store.save(done);
      store.save(wiState(2, 'CB_UK29'));
      const continiaCli = cli();
      const ado = statuses({ 10: 'completed', 20: 'completed' });
      expect(await sweepClosedPrEnvironments({ config, logger, store, continiaCli, ado })).toBe(0);
      expect(continiaCli.deleteEnvironment).not.toHaveBeenCalled();

      store.save(wiState(3));
      expect(
        await sweepClosedPrEnvironments({
          config: { ...config, deleteEnvOnPrClose: false }, logger, store, continiaCli,
          ado: statuses({ 30: 'completed' }),
        }),
      ).toBe(0);
      expect(continiaCli.deleteEnvironment).not.toHaveBeenCalled();
    });
  });

  it('treats a failed delete of an already-deleted environment as done, and retries anything else', async () => {
    await withStore(async (store) => {
      store.save(wiState(1));
      const ado = statuses({ 10: 'completed' });
      expect(
        await sweepClosedPrEnvironments({ config, logger, store, ado, continiaCli: cli({ deleteFails: true }) }),
      ).toBe(0);
      expect(store.load(1)!.outputs[ENV_DELETED_KEY]).toBeUndefined();

      expect(
        await sweepClosedPrEnvironments({
          config, logger, store, ado, continiaCli: cli({ deleteFails: true, status: 'Deleted' }),
        }),
      ).toBe(1);
      expect(store.load(1)!.outputs[ENV_DELETED_KEY]).toBeDefined();
    });
  });

  it('skips a WI whose PR status cannot be read', async () => {
    await withStore(async (store) => {
      store.save(wiState(1));
      const continiaCli = cli();
      const ado = { getPullRequestStatus: mock(async () => { throw new Error('401'); }) };
      expect(await sweepClosedPrEnvironments({ config, logger, store, ado, continiaCli })).toBe(0);
      expect(continiaCli.deleteEnvironment).not.toHaveBeenCalled();
    });
  });
});
