import type { Stage } from '../stage.ts';
import type { ReviewerOutput } from '../../types/index.ts';

/**
 * Plan 4 stub reviewer. ALWAYS approves with no feedback.
 *
 * Plan 5 will replace the body of `execute` with the real reviewer
 * (parallel-fanout across correctness/tests/security/style reviewers,
 * aggregated verdict, structured feedback). The FILE NAME and EXPORTED
 * FACTORY NAME stay stable — `pipeline-builder.ts`'s wiring does not
 * change between Plan 4 and Plan 5. Only the `execute` body evolves.
 *
 * `revisionLoop(coder, reviewer)` calls this with `isApproved: (s) =>
 * (s.outputs.reviewer as ReviewerOutput)?.approved === true`, so in Plan 4
 * the loop runs exactly one iteration (this stub always approves).
 */
export interface ReviewerStageDeps {
  // Plan 5 will add: { runner, promptTemplate, discoveredSkills, config, ... }
}

export function createReviewerStage(_deps: ReviewerStageDeps): Stage {
  return {
    name: 'reviewer',
    canRun: () => true,
    async execute(state, _ctx) {
      const output: ReviewerOutput = { approved: true, findings: [], attempts: 0 };
      state.outputs.reviewer = output;
      return state;
    },
  };
}
