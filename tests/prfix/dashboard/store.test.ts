import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrFixJobStore, type HistoryLine, type PendingApproval } from '../../../src/prfix/dashboard/store.ts';
import type { PrFixOutcome, PrFixReview } from '../../../src/prfix/types.ts';

function outcome(prId: number): PrFixOutcome {
  return {
    ok: true,
    status: 'rebased',
    pullRequestId: prId,
    oldHead: 'a',
    newHead: 'b',
    conflicts: [],
    renumbered: [],
    costUsd: 1,
    error: null,
  };
}

function line(prId: number, at: string): HistoryLine {
  return { at, prId, title: `PR ${prId}`, triggeredBy: 'u', durationMs: 5, outcome: outcome(prId) };
}

describe('PrFixJobStore', () => {
  let dir: string;
  beforeEach(() => {
    dir = join(mkdtempSync(join(tmpdir(), 'prfix-store-')), 'prfix');
  });
  afterEach(() => {
    rmSync(join(dir, '..'), { recursive: true, force: true });
  });

  test('empty store reads as empty', () => {
    const store = new PrFixJobStore(dir);
    expect(store.queue()).toEqual([]);
    expect(store.pending()).toEqual([]);
    expect(store.active()).toBeNull();
    expect(store.history()).toEqual([]);
  });

  test('history keeps the newest 500', () => {
    const store = new PrFixJobStore(dir);
    for (let i = 1; i <= 503; i++) store.appendHistory(line(i, `t${i}`));
    const history = store.history();
    expect(history).toHaveLength(500);
    expect(history[0]?.prId).toBe(503);
    expect(history[499]?.prId).toBe(4);
  });

  test('files round-trip and survive a new instance', () => {
    const store = new PrFixJobStore(dir);
    const review = { newHead: 'b' } as PrFixReview;
    const pending: PendingApproval = {
      prId: 2,
      title: 'Two',
      triggeredBy: 'u',
      readyAt: 'r',
      expiresAt: 'e',
      review,
    };
    store.setQueue([{ prId: 1, queuedBy: 'u', queuedAt: 'q' }]);
    store.setPending([pending]);
    store.setActive({ prId: 3, startedAt: 's', triggeredBy: 'u', title: 'Three' });
    store.appendHistory(line(4, 'a'));
    store.appendHistory(line(5, 'b'));

    const again = new PrFixJobStore(dir);
    expect(again.queue()).toEqual([{ prId: 1, queuedBy: 'u', queuedAt: 'q' }]);
    expect(again.pending()).toEqual([pending]);
    expect(again.active()).toEqual({ prId: 3, startedAt: 's', triggeredBy: 'u', title: 'Three' });
    expect(again.history().map((h) => h.prId)).toEqual([5, 4]);

    again.setActive(null);
    expect(new PrFixJobStore(dir).active()).toBeNull();
  });
});
