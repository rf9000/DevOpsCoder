import type { Stage } from '../stage.ts';
import type { WorktreeContext } from '../../types/index.ts';
import type { WorktreeManager } from '../../services/worktree-manager.ts';
import type { Logger } from '../../utils/logger.ts';

export interface WorktreeTeardownStageDeps {
  worktreeManager: WorktreeManager;
  logger: Logger;
}

export function createWorktreeTeardownStage(deps: WorktreeTeardownStageDeps): Stage {
  return {
    name: 'worktree-teardown',
    canRun: () => true,
    async execute(state) {
      const worktree = state.outputs.worktree as WorktreeContext | undefined;

      if (worktree === undefined) {
        // Worktree was never created (pipeline failed before worktree-setup ran).
        // Skip silently — no log, return state unchanged.
        return state;
      }

      try {
        await deps.worktreeManager.removeWorktree({
          workItemId: state.workItemId,
          slug: state.slug,
          persistedWorktree: worktree,
        });
      } catch (err) {
        deps.logger.warn(
          { err, workItemId: state.workItemId, slug: state.slug },
          `worktree teardown failed for wi-${state.workItemId}-${state.slug}`,
        );
        // Do NOT rethrow — cleanup is best-effort; pipeline already succeeded.
      }

      return state;
    },
  };
}
