/**
 * Serializes work that touches the shared git clone. The watcher runs work
 * items and fix-pr jobs in one process; both use separate worktrees, but git
 * commands run against the base clone itself (fetch, worktree add/prune, ...)
 * must not overlap.
 */
export interface GitLock {
  run<T>(fn: () => Promise<T>): Promise<T>;
}

/** FIFO: each call waits for every earlier call to settle, success or failure. */
export function createGitLock(): GitLock {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      const result = tail.then(fn, fn);
      tail = result.catch(() => undefined);
      return result;
    },
  };
}

/** No locking: runs `fn` directly. The default when no lock is injected. */
export const NO_GIT_LOCK: GitLock = {
  run: (fn) => fn(),
};
