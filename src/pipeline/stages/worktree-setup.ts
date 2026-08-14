import type { Stage } from '../stage.ts';
import type { WorktreeManager } from '../../services/worktree-manager.ts';
import type { AppConfig, WorktreeContext } from '../../types/index.ts';
import { wireOrchestratorSkills } from '../../services/skill-wiring.ts';

export interface WorktreeSetupDeps {
  worktreeManager: WorktreeManager;
  config: AppConfig;
  /** Test override for the skill symlinker. */
  wireSkills?: (skillsSourceDir: string, worktreePath: string) => void;
}

/**
 * Stage that ensures a per-WI git worktree exists. On first entry, creates a fresh
 * worktree branched off origin/main. On re-entry, forwards the persisted
 * `state.outputs.worktree` to the manager for state-driven reuse (so branch name
 * stays stable across slug renames; orphaned dirs get re-created).
 *
 * When `config.skillsSourceDir` is set, the orchestrator's skills are symlinked
 * into the worktree's `.claude/` (idempotent — re-runs on every entry).
 *
 * Stores the resulting `WorktreeContext` in `state.outputs.worktree`.
 */
export function createWorktreeSetupStage(deps: WorktreeSetupDeps): Stage {
  const wire = deps.wireSkills ?? wireOrchestratorSkills;
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
      if (deps.config.skillsSourceDir) {
        wire(deps.config.skillsSourceDir, ctx.path);
      }
      state.outputs.worktree = ctx;
      return state;
    },
  };
}
