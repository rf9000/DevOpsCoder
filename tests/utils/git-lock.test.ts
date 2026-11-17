import { describe, expect, test } from 'bun:test';
import { createGitLock, NO_GIT_LOCK } from '../../src/utils/git-lock.ts';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('git lock', () => {
  test('serializes', async () => {
    const lock = createGitLock();
    const order: string[] = [];
    const gate = deferred();
    const a = lock.run(async () => {
      order.push('a-start');
      await gate.promise;
      order.push('a-end');
    });
    const b = lock.run(async () => {
      order.push('b-start');
      order.push('b-end');
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['a-start']);
    gate.resolve();
    await Promise.all([a, b]);
    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
  });

  test('releases on throw', async () => {
    const lock = createGitLock();
    const boom = new Error('boom');
    const a = lock.run(async () => {
      throw boom;
    });
    const b = lock.run(async () => 'ok');
    await expect(a).rejects.toBe(boom);
    expect(await b).toBe('ok');
  });

  test('NO_GIT_LOCK runs concurrently', async () => {
    const order: string[] = [];
    const gate = deferred();
    const a = NO_GIT_LOCK.run(async () => {
      order.push('a-start');
      await gate.promise;
      order.push('a-end');
    });
    const b = NO_GIT_LOCK.run(async () => {
      order.push('b-start');
      await gate.promise;
      order.push('b-end');
    });
    expect(order).toEqual(['a-start', 'b-start']);
    gate.resolve();
    await Promise.all([a, b]);
  });
});
