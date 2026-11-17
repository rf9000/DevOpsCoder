import { describe, expect, test } from 'bun:test';
import { PrFixCatalog } from '../../../src/prfix/dashboard/catalog.ts';
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

describe('PrFixCatalog', () => {
  test('refresh loads the list, find looks a PR up', async () => {
    const catalog = new PrFixCatalog(async () => [pr(1), pr(2)], () => new Date('2026-11-17T10:00:00Z'));
    expect(catalog.at).toBeNull();
    await catalog.refresh();
    expect(catalog.prs.map((p) => p.id)).toEqual([1, 2]);
    expect(catalog.at).toBe('2026-11-17T10:00:00.000Z');
    expect(catalog.error).toBeNull();
    expect(catalog.find(2)?.title).toBe('PR 2');
    expect(catalog.find(3)).toBeUndefined();
  });

  test('refresh failure keeps the previous list and sets error', async () => {
    let fail = false;
    let clock = new Date('2026-11-17T10:00:00Z');
    const catalog = new PrFixCatalog(
      async () => {
        if (fail) throw new Error('ADO down');
        return [pr(1)];
      },
      () => clock,
    );
    await catalog.refresh();
    fail = true;
    clock = new Date('2026-11-17T10:02:00Z');
    await catalog.refresh();
    expect(catalog.prs.map((p) => p.id)).toEqual([1]);
    expect(catalog.at).toBe('2026-11-17T10:00:00.000Z');
    expect(catalog.error).toBe('ADO down');

    fail = false;
    await catalog.refresh();
    expect(catalog.error).toBeNull();
    expect(catalog.at).toBe('2026-11-17T10:02:00.000Z');
  });
});
