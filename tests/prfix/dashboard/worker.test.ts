import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrFixCatalog } from '../../../src/prfix/dashboard/catalog.ts';
import { PrFixJobStore } from '../../../src/prfix/dashboard/store.ts';
import { createPrFixWorker, type PrFixWorker, type PrFixWorkerDeps } from '../../../src/prfix/dashboard/worker.ts';
import type { PrFixOutcome, PrFixReview, PrFixStatus } from '../../../src/prfix/types.ts';
import type { ActivePullRequest } from '../../../src/types/index.ts';

function pr(id: number): ActivePullRequest {
  return {
    id,
    status: 'active',
    title: `PR ${id}`,
    sourceRefName: 'refs/heads/f',
    targetRefName: 'refs/heads/main',
    headCommit: 'abc',
    isDraft: false,
    url: `https://x/${id}`,
    author: 'a',
    createdAt: '',
  };
}

const review = { newHead: 'new', costUsd: 2 } as PrFixReview;

function outcome(prId: number, status: PrFixStatus): PrFixOutcome {
  return {
    ok: status === 'rebased' || status === 'up-to-date' || status === 'awaiting-approval',
    status,
    pullRequestId: prId,
    oldHead: 'old',
    newHead: 'new',
    conflicts: [],
    renumbered: [],
    costUsd: 2,
    error: null,
    ...(status === 'awaiting-approval' ? { review } : {}),
  };
}

interface Deferred {
  prId: number;
  resolve: (o: PrFixOutcome) => void;
  onProgress: (stage: string, detail: string | null) => void;
}

interface Harness {
  worker: PrFixWorker;
  store: PrFixJobStore;
  catalog: PrFixCatalog;
  jobs: Deferred[];
  calls: string[];
  clock: { now: Date };
  flags: { signIn: boolean; wiRunning: Set<number> };
  results: { approve: PrFixStatus; reject: PrFixStatus };
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'prfix-worker-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function harness(overrides: Partial<PrFixWorkerDeps> = {}, load = true): Promise<Harness> {
  const store = new PrFixJobStore(join(root, 'prfix'));
  const clock = { now: new Date('2026-11-17T10:00:00Z') };
  const catalog = new PrFixCatalog(async () => [pr(1), pr(2), pr(3)], () => clock.now);
  if (load) await catalog.refresh();
  const jobs: Deferred[] = [];
  const calls: string[] = [];
  const flags = { signIn: false, wiRunning: new Set<number>() };
  const results: { approve: PrFixStatus; reject: PrFixStatus } = { approve: 'rebased', reject: 'rejected' };
  const worker = createPrFixWorker({
    store,
    catalog,
    repo: 'Banking',
    unavailableReason: null,
    signInNeeded: () => flags.signIn,
    wiRunningForPr: (id) => flags.wiRunning.has(id),
    runJob: (prId, onProgress) =>
      new Promise<PrFixOutcome>((resolve) => {
        calls.push(`job ${prId}`);
        jobs.push({ prId, resolve, onProgress });
      }),
    approve: async (prId) => {
      calls.push(`approve ${prId}`);
      return outcome(prId, results.approve);
    },
    reject: async (prId) => {
      calls.push(`reject ${prId}`);
      return outcome(prId, results.reject);
    },
    cleanupInterrupted: async (prId) => {
      calls.push(`cleanup ${prId}`);
    },
    ttlHours: 24,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    now: () => clock.now,
    ...overrides,
  });
  return { worker, store, catalog, jobs, calls, clock, flags, results };
}

/** Lets the microtasks a resolved fake job queued run to completion. */
async function settle(h: Harness): Promise<void> {
  await h.worker.idle();
}

/** Resolves the job at `index` and waits for the worker to move on. */
async function finishJob(h: Harness, index: number, status: PrFixStatus): Promise<void> {
  const job = h.jobs[index];
  if (!job) throw new Error(`no job ${index}`);
  job.resolve(outcome(job.prId, status));
  // Let the job's completion run; a following job may start and stay in flight.
  for (let i = 0; i < 100; i++) await Promise.resolve();
}

describe('createPrFixWorker', () => {
  describe('enqueue refuses with 409 and a reason', () => {
    test('unavailable', async () => {
      const h = await harness({ unavailableReason: 'no config' });
      expect(h.worker.enqueue(1, 'u')).toEqual({ ok: false, code: 409, error: 'no config' });
    });

    test('PR list not loaded yet', async () => {
      const h = await harness({}, false);
      expect(h.worker.enqueue(1, 'u')).toEqual({ ok: false, code: 409, error: 'PR list not loaded yet' });
    });

    test('already queued', async () => {
      const h = await harness();
      h.flags.signIn = true; // keep it in the queue
      expect(h.worker.enqueue(1, 'u')).toEqual({ ok: true });
      expect(h.worker.enqueue(1, 'v')).toEqual({ ok: false, code: 409, error: 'already queued' });
    });

    test('running', async () => {
      const h = await harness();
      h.worker.enqueue(1, 'u');
      expect(h.calls).toEqual(['job 1']);
      expect(h.worker.enqueue(1, 'v')).toEqual({ ok: false, code: 409, error: 'already running' });
    });

    test('pending', async () => {
      const h = await harness();
      h.worker.enqueue(1, 'u');
      await finishJob(h, 0, 'awaiting-approval');
      await settle(h);
      expect(h.worker.enqueue(1, 'v')).toEqual({
        ok: false,
        code: 409,
        error: 'awaiting approval; approve or reject first',
      });
    });

    test('not in catalog', async () => {
      const h = await harness();
      expect(h.worker.enqueue(9, 'u')).toEqual({ ok: false, code: 409, error: 'PR 9 is not an active PR' });
    });

    test('WI running', async () => {
      const h = await harness();
      h.flags.wiRunning.add(2);
      expect(h.worker.enqueue(2, 'u')).toEqual({
        ok: false,
        code: 409,
        error: 'a work item is running on this PR',
      });
    });
  });

  test('runs one job at a time in FIFO order', async () => {
    const h = await harness();
    h.worker.enqueue(2, 'u');
    h.worker.enqueue(1, 'v');
    h.worker.enqueue(3, 'w');
    h.worker.tick();
    expect(h.calls).toEqual(['job 2']);
    expect(h.worker.status().queue.map((q) => q.prId)).toEqual([1, 3]);
    expect(h.worker.status().prs.map((p) => p.state)).toEqual(['queued', 'running', 'queued']);

    await finishJob(h, 0, 'rebased');
    expect(h.calls).toEqual(['job 2', 'job 1']);
    await finishJob(h, 1, 'verification-failed');
    expect(h.calls).toEqual(['job 2', 'job 1', 'job 3']);
    await finishJob(h, 2, 'up-to-date');
    await settle(h);

    const history = h.store.history();
    expect(history.map((l) => [l.prId, l.outcome.status, l.triggeredBy, l.title])).toEqual([
      [3, 'up-to-date', 'w', 'PR 3'],
      [1, 'verification-failed', 'v', 'PR 1'],
      [2, 'rebased', 'u', 'PR 2'],
    ]);
    expect(h.store.active()).toBeNull();
    expect(h.worker.status().prs.find((p) => p.id === 1)?.lastRun?.outcome.status).toBe('verification-failed');
    expect(h.worker.status().prs.map((p) => p.state)).toEqual(['idle', 'idle', 'idle']);
  });

  test('awaiting-approval becomes pending; approve runs before the next queued job', async () => {
    const h = await harness();
    h.worker.enqueue(1, 'u');
    h.worker.enqueue(2, 'v');
    h.worker.enqueue(3, 'w');
    await finishJob(h, 0, 'awaiting-approval');
    expect(h.calls).toEqual(['job 1', 'job 2']);

    const pending = h.store.pending();
    expect(pending).toEqual([
      {
        prId: 1,
        title: 'PR 1',
        triggeredBy: 'u',
        readyAt: '2026-11-17T10:00:00.000Z',
        expiresAt: '2026-11-18T10:00:00.000Z',
        review,
      },
    ]);
    expect(h.store.history()).toEqual([]);
    expect(h.worker.status().prs.find((p) => p.id === 1)?.state).toBe('awaiting-approval');

    expect(h.worker.requestApprove(1, 'boss')).toEqual({ ok: true });
    expect(h.worker.requestApprove(1, 'boss')).toEqual({ ok: false, code: 409, error: 'approve already requested' });
    expect(h.calls).toEqual(['job 1', 'job 2']); // job 2 still in flight

    await finishJob(h, 1, 'rebased');
    expect(h.calls).toEqual(['job 1', 'job 2', 'approve 1', 'job 3']);
  });

  test('approve writes history with approvedBy and drops the pending item', async () => {
    const h = await harness();
    h.worker.enqueue(1, 'u');
    await finishJob(h, 0, 'awaiting-approval');
    await settle(h);
    h.clock.now = new Date('2026-11-17T11:00:00Z');
    h.worker.requestApprove(1, 'boss');
    await settle(h);

    expect(h.store.pending()).toEqual([]);
    const [last] = h.store.history();
    expect(last?.prId).toBe(1);
    expect(last?.approvedBy).toBe('boss');
    expect(last?.triggeredBy).toBe('u');
    expect(last?.title).toBe('PR 1');
    expect(last?.outcome.status).toBe('rebased');
    expect(last?.at).toBe('2026-11-17T11:00:00.000Z');
  });

  test('an approve that ends head-moved still drops the pending item and records the outcome', async () => {
    const h = await harness();
    h.results.approve = 'head-moved';
    h.worker.enqueue(1, 'u');
    await finishJob(h, 0, 'awaiting-approval');
    await settle(h);
    h.worker.requestApprove(1, 'boss');
    await settle(h);
    expect(h.store.pending()).toEqual([]);
    expect(h.store.history()[0]?.outcome.status).toBe('head-moved');
    expect(h.store.history()[0]?.approvedBy).toBe('boss');
    expect(h.worker.enqueue(1, 'u')).toEqual({ ok: true });
  });

  test('reject writes history with rejectedBy; 404 when not pending', async () => {
    const h = await harness();
    expect(h.worker.requestReject(1, 'boss')).toEqual({ ok: false, code: 404, error: 'PR 1 is not awaiting approval' });
    expect(h.worker.requestApprove(1, 'boss')).toEqual({ ok: false, code: 404, error: 'PR 1 is not awaiting approval' });
    h.worker.enqueue(1, 'u');
    await finishJob(h, 0, 'awaiting-approval');
    await settle(h);
    h.worker.requestReject(1, 'boss');
    await settle(h);
    expect(h.calls).toEqual(['job 1', 'reject 1']);
    expect(h.store.pending()).toEqual([]);
    expect(h.store.history()[0]?.rejectedBy).toBe('boss');
    expect(h.store.history()[0]?.outcome.status).toBe('rejected');
  });

  test('a thrown action records a synthetic error outcome and the worker keeps going', async () => {
    const h = await harness({
      approve: async () => {
        throw new Error('boom');
      },
    });
    h.worker.enqueue(1, 'u');
    await finishJob(h, 0, 'awaiting-approval');
    await settle(h);
    h.worker.enqueue(2, 'v');
    h.worker.requestApprove(1, 'boss');
    await finishJob(h, 1, 'awaiting-approval'); // job 2 started after the approve threw
    await settle(h);
    const approveLine = h.store.history().find((l) => l.prId === 1);
    expect(approveLine?.outcome).toEqual({
      ok: false,
      status: 'error',
      error: 'boom',
      pullRequestId: 1,
      oldHead: null,
      newHead: null,
      conflicts: [],
      renumbered: [],
      costUsd: 0,
    });
    expect(approveLine?.approvedBy).toBe('boss');
    expect(h.store.pending().map((p) => p.prId)).toEqual([2]);
    expect(h.store.active()).toBeNull();
  });

  test('unqueue removes a queued PR; 404 when not queued', async () => {
    const h = await harness();
    h.flags.signIn = true;
    h.worker.enqueue(1, 'u');
    h.worker.enqueue(2, 'u');
    expect(h.worker.unqueue(1)).toEqual({ ok: true });
    expect(h.worker.unqueue(1)).toEqual({ ok: false, code: 404, error: 'PR 1 is not queued' });
    expect(h.store.queue().map((q) => q.prId)).toEqual([2]);
  });

  test('does not start while sign-in is needed and reports waiting signin', async () => {
    const h = await harness();
    h.flags.signIn = true;
    h.worker.enqueue(1, 'u');
    expect(h.calls).toEqual([]);
    expect(h.worker.status().waiting).toBe('signin');
    h.flags.signIn = false;
    expect(h.worker.status().waiting).toBeNull();
    h.worker.tick();
    expect(h.calls).toEqual(['job 1']);
  });

  test('starts nothing once stopping: the queue survives the shutdown', async () => {
    const stop = { now: false };
    const h = await harness({ stopping: () => stop.now });
    h.flags.signIn = true; // queue both without starting either
    h.worker.enqueue(1, 'u');
    h.worker.enqueue(2, 'u');
    h.flags.signIn = false;
    h.worker.tick();
    expect(h.calls).toEqual(['job 1']);
    stop.now = true;
    await finishJob(h, 0, 'cancelled');
    await settle(h);
    expect(h.calls).toEqual(['job 1']);
    expect(h.store.queue().map((q) => q.prId)).toEqual([2]);
  });

  test('history returns the store history', async () => {
    const h = await harness();
    h.worker.enqueue(1, 'u');
    await finishJob(h, 0, 'rebased');
    await settle(h);
    expect(h.worker.history()).toEqual(h.store.history());
    expect(h.worker.history()).toHaveLength(1);
  });

  test('recover records an interrupted job and cleans it up, leaving pending alone', async () => {
    const h = await harness();
    const pending = {
      prId: 2,
      title: 'PR 2',
      triggeredBy: 'v',
      readyAt: 'r',
      expiresAt: '2026-11-18T10:00:00.000Z',
      review,
    };
    h.store.setPending([pending]);
    h.store.setActive({ prId: 1, startedAt: '2026-11-17T09:00:00.000Z', triggeredBy: 'u', title: 'PR 1' });
    await h.worker.recover();

    expect(h.calls).toEqual(['cleanup 1']);
    expect(h.store.active()).toBeNull();
    expect(h.store.pending()).toEqual([pending]);
    const [last] = h.store.history();
    expect(last).toEqual({
      at: '2026-11-17T10:00:00.000Z',
      prId: 1,
      title: 'PR 1',
      triggeredBy: 'u',
      durationMs: null,
      outcome: {
        ok: false,
        status: 'error',
        error: 'interrupted (container restarted)',
        pullRequestId: 1,
        oldHead: null,
        newHead: null,
        conflicts: [],
        renumbered: [],
        costUsd: 0,
      },
    });
  });

  test('recover without active.json does nothing', async () => {
    const h = await harness();
    await h.worker.recover();
    expect(h.calls).toEqual([]);
    expect(h.store.history()).toEqual([]);
  });

  test('expire rejects pending past expiresAt with rejectedBy expired', async () => {
    const h = await harness();
    h.store.setPending([
      { prId: 1, title: 'PR 1', triggeredBy: 'u', readyAt: 'r', expiresAt: '2026-11-17T09:59:00.000Z', review },
      { prId: 2, title: 'PR 2', triggeredBy: 'v', readyAt: 'r', expiresAt: '2026-11-17T10:01:00.000Z', review },
    ]);
    h.worker.expire();
    await settle(h);
    expect(h.calls).toEqual(['reject 1']);
    expect(h.store.pending().map((p) => p.prId)).toEqual([2]);
    expect(h.store.history()[0]?.rejectedBy).toBe('expired');
  });

  test('activeJob phase follows onProgress; phasesDone lists finished stages', async () => {
    const h = await harness();
    h.worker.enqueue(1, 'u');
    const job = h.jobs[0];
    if (!job) throw new Error('no job');
    expect(h.worker.status().activeJob).toEqual({
      prId: 1,
      startedAt: '2026-11-17T10:00:00.000Z',
      triggeredBy: 'u',
      title: 'PR 1',
      phase: null,
      phaseDetail: null,
      phaseSince: null,
      phasesDone: [],
    });

    job.onProgress('pr-intake', null);
    h.clock.now = new Date('2026-11-17T10:01:00Z');
    job.onProgress('rebase-onto-target', null);
    h.clock.now = new Date('2026-11-17T10:02:00Z');
    job.onProgress('rebase-onto-target', 'commit 2/3');
    const active = h.worker.status().activeJob;
    expect(active?.phase).toBe('rebase-onto-target');
    expect(active?.phaseDetail).toBe('commit 2/3');
    expect(active?.phaseSince).toBe('2026-11-17T10:01:00.000Z');
    expect(active?.phasesDone).toEqual(['pr-intake']);

    await finishJob(h, 0, 'rebased');
    await settle(h);
    expect(h.worker.status().activeJob).toBeNull();
    expect(h.store.history()[0]?.durationMs).toBe(120_000);
  });
});
