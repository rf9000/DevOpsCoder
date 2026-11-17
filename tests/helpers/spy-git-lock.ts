import { createGitLock, type GitLock } from '../../src/utils/git-lock.ts';

/**
 * A real FIFO `GitLock` that counts what goes through it: `calls` is how many
 * commands ran under the lock, `maxActive` the most that ever ran at once
 * (1 when the lock serialized them).
 */
export function spyGitLock(): { lock: GitLock; calls: () => number; maxActive: () => number } {
  const inner = createGitLock();
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  return {
    lock: {
      run<T>(fn: () => Promise<T>): Promise<T> {
        calls++;
        return inner.run(async () => {
          active++;
          maxActive = Math.max(maxActive, active);
          try {
            return await fn();
          } finally {
            active--;
          }
        });
      },
    },
    calls: () => calls,
    maxActive: () => maxActive,
  };
}
