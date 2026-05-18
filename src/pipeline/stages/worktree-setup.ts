import type { Stage } from '../stage.ts';
import type { WorktreeManager } from '../../services/worktree-manager.ts';
import type { WorktreeContext } from '../../types/index.ts';

export interface WorktreeSetupDeps {
  worktreeManager: WorktreeManager;
}

/**
 * Stage that ensures a per-WI git worktree exists. On first entry, creates a fresh
 * worktree branched off origin/main. On re-entry, forwards the persisted
 * `state.outputs.worktree` to the manager for state-driven reuse (so branch name
 * stays stable across slug renames; orphaned dirs get re-created).
 *
 * Stores the resulting `WorktreeContext` in `state.outputs.worktree`.
 */
export function createWorktreeSetupStage(deps: WorktreeSetupDeps): Stage {
  return {
    name: 'worktree-setup',
    canRun: () => true,
    async execute(state) {
      const persisted = state.outputs.worktree as WorktreeContext | undefined;
      const ctx = await deps.worktreeManager.ensureWorktree({
        workItemId: state.workItemId,
        slug: state.slug,
        persistedWorktree: persisted,
      });
      state.outputs.worktree = ctx;
      return state;
    },
  };
}
