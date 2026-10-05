import type { AdoClient } from '../sdk/azure-devops-client.ts';

/**
 * Thrown by a read-only ADO client when anything tries to write. Replays must
 * leave no trace on the work item: a comment or tag change on a closed WI is
 * noise for whoever owns it, and a PR from an experiment branch is worse.
 */
export class ExperimentWriteBlockedError extends Error {
  override readonly name = 'ExperimentWriteBlockedError';
  constructor(public readonly method: string) {
    super(`experiment harness blocked an ADO write: ${method}`);
  }
}

/**
 * Wrap an `AdoClient` so every read passes through and every write throws.
 *
 * Throwing rather than no-op'ing is deliberate: a stage that writes during a
 * replay is a stage the harness failed to strip out, and a silent no-op would
 * hide that until the day it ran against the real client.
 */
export function createReadOnlyAdoClient(inner: AdoClient): AdoClient {
  const blocked = (method: string) => async (): Promise<never> => {
    throw new ExperimentWriteBlockedError(method);
  };
  return {
    queryWorkItemsByTag: (tag, opts) => inner.queryWorkItemsByTag(tag, opts),
    getWorkItem: (id, opts) => inner.getWorkItem(id, opts),
    getWorkItemComments: (id, opts) => inner.getWorkItemComments(id, opts),
    getWorkItemUpdates: (id, opts) => inner.getWorkItemUpdates(id, opts),
    addTagToWorkItem: blocked('addTagToWorkItem'),
    removeTagFromWorkItem: blocked('removeTagFromWorkItem'),
    addWorkItemComment: blocked('addWorkItemComment'),
    createPullRequest: blocked('createPullRequest'),
    createPullRequestThread: blocked('createPullRequestThread'),
  };
}
