import { describe, it, expect, mock } from 'bun:test';
import {
  createReadOnlyAdoClient,
  ExperimentWriteBlockedError,
} from '../../src/services/read-only-ado.ts';
import type { AdoClient } from '../../src/sdk/azure-devops-client.ts';

describe('createReadOnlyAdoClient', () => {
  const inner = {
    queryWorkItemsByTag: mock(async () => [1]),
    getWorkItem: mock(async () => ({ id: 1, fields: {} })),
    getWorkItemComments: mock(async () => []),
    getWorkItemUpdates: mock(async () => []),
    addTagToWorkItem: mock(async () => {}),
    removeTagFromWorkItem: mock(async () => {}),
    addWorkItemComment: mock(async () => {}),
    createPullRequest: mock(async () => ({})),
    createPullRequestThread: mock(async () => {}),
  };
  const ado = createReadOnlyAdoClient(inner as unknown as AdoClient);

  it('passes reads through', async () => {
    expect(await ado.queryWorkItemsByTag('t')).toEqual([1]);
    await ado.getWorkItem(1);
    await ado.getWorkItemComments(1);
    await ado.getWorkItemUpdates(1);
    expect(inner.getWorkItem).toHaveBeenCalledTimes(1);
  });

  it('throws on every write and never reaches the inner client', async () => {
    await expect(ado.addTagToWorkItem(1, 't')).rejects.toBeInstanceOf(ExperimentWriteBlockedError);
    await expect(ado.removeTagFromWorkItem(1, 't')).rejects.toBeInstanceOf(ExperimentWriteBlockedError);
    await expect(ado.addWorkItemComment(1, 'x')).rejects.toBeInstanceOf(ExperimentWriteBlockedError);
    await expect(
      ado.createPullRequest({} as Parameters<AdoClient['createPullRequest']>[0]),
    ).rejects.toThrow(/createPullRequest/);
    await expect(
      ado.createPullRequestThread({} as Parameters<AdoClient['createPullRequestThread']>[0]),
    ).rejects.toBeInstanceOf(ExperimentWriteBlockedError);
    expect(inner.addWorkItemComment).not.toHaveBeenCalled();
    expect(inner.createPullRequest).not.toHaveBeenCalled();
  });
});
