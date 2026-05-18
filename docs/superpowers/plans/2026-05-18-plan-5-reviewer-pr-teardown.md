# Plan 5 — Real Reviewer + Draft-PR Creator + Worktree Teardown

## Context

After Plan 4, the pipeline writes commits to a per-WI branch in the target repo's worktree but never pushes or opens a PR. The reviewer is a stub that always approves; the revisionLoop runs exactly one iteration. There is no teardown — worktrees and branches accumulate.

Plan 5 closes the loop:
1. **Real reviewer** (6 parallel axes: safety-correctness, performance, code-structure, naming-style, security, integration) — replaces the Plan 4 stub in-place. Aggregates findings, deduplicates by `file:line`, severity-orders, sets `state.outputs.reviewer.approved` accordingly. `revisionLoop(coder, reviewer)` now actually loops when the reviewer rejects.
2. **Draft-PR creator** — pushes the WI branch and opens a draft PR via ADO REST. Does NOT add the `code-review` label (human action — that's how `DevOpsCodeReviewer` only runs when humans opt in).
3. **Worktree teardown** — `worktreeManager.removeWorktree` at the end of a successful pipeline. Failures are best-effort logged, never fail the pipeline.
4. **Exhaustion handler** — when revisionLoop runs out of revisions, the pipeline posts the final reviewer findings as a WI comment, adds `agent-blocked`, leaves the worktree intact for inspection, terminal-fails.

End state after Plan 5: a WI tagged `agent implement` either (a) gets a reject from the analyzer (Plan 3 flow), (b) gets a draft PR with passing reviews, or (c) gets blocked with a "could not satisfy reviewer" comment.

## Decisions locked

| Decision | Choice |
|---|---|
| Reviewer parallelism | TypeScript-native `Promise.all` of 6 `runner.run()` calls — NOT a Skill+subagent dispatch. Matches the rest of the codebase's stage-as-runner-wrapper pattern; lets each axis be its own injectable, testable call. |
| Reviewer axes | 6: safety-correctness, performance, code-structure, naming-style, security, integration. Each has its own prompt file under `src/prompts/reviewers/`. |
| Finding shape | Structured Zod: `{ severity: 'blocking' \| 'critical' \| 'major' \| 'minor' \| 'nit', file: string, line?: number, title: string, description: string, suggestion?: string, axis: string }`. Per-axis JSON output: `{ findings: Finding[] }`. Aggregation dedups by `file:line`, takes max severity, concatenates axis labels. |
| Approval predicate | `approved === true` iff zero `blocking` AND zero `critical` findings. Any `blocking` or `critical` → not approved → revisionLoop iterates. |
| Coder sees prior reviewer feedback | On revisionLoop iteration 2+, coder's `buildCoderUserPrompt` includes a "Previous reviewer findings" section. Coder is told to address them or justify ignoring (in the next coder summary). |
| Reviewer Bash safety | Strict read-only allowlist: `git log`, `git diff`, `git show`, `git blame`, `git status`, `ls`, `cat`, `pwd`, `bun run typecheck`, `bun test --run` (no watch). Denies everything else, plus the same shell-composition guard from `bash-allowlist.ts`. |
| Reviewer tools | `Read`, `Grep`, `Glob`, `Bash`, `Skill`. NO `Edit`, `Write`, `NotebookEdit`. NO retry/baseline-reset (reviewer is read-only — nothing to reset). |
| revisionLoop exhaustion | New `onExhausted` handler wired in pipeline-builder. Post a markdown WI comment containing the final reviewer findings (rendered via `marked`), remove `triggerTag`, add `blockedTag`, leave worktree intact for inspection. Pipeline returns `'failed'` outcome. |
| Draft-PR creator timing | Last "productive" stage before teardown. Order: `[analyzer, worktree-setup, revisionLoop(coder, reviewer), test-author, draft-pr-creator, worktree-teardown]`. |
| PR title format | `[Agent] {wi.title}` (matches existing conventions; clear marker that this is agent-authored). |
| PR description | Built from a template: WI link, analyzer summary, coder summary, test-author summary, reviewer "approved with findings:" if any non-blocking findings remain. No status check; the human's existing `code-review` label flow is preserved. |
| PR body has the agent's full summary | YES — the PR description carries the full audit trail so reviewers don't have to dig through state files. |
| `code-review` label | Plan 5 does NOT add it. Per project memory: "DevopsCoder does NOT add the code-review label on its draft PR — that stays a human action so the existing DevOpsCodeReviewer only runs when the human asks for it." |
| Worktree teardown timing | Final stage of a successful pipeline. Runs AFTER draft-PR creator. On failure paths (analyzer reject, coder/test-author terminal error, reviewer exhaustion), worktree is intentionally **NOT** torn down — humans inspect what the agent left behind. |
| Draft-PR creator failure handling | Post a WI comment with the failure detail, add `blockedTag`, NO worktree teardown. Treat as terminal failure. |
| Multimodal images | Still deferred — defer further. No UI-implementation WIs on the current Plan 5 acceptance list. |
| Cost budget per WI | Not enforced as hard limit yet. Log cumulative `total_cost_usd` per stage to `state.outputs.{stage}.cost` for visibility. A future plan can add a hard cap. |

## Architecture overview

```
runPipeline:
  → analyzer (existing)
  → worktree-setup (existing)
  → revisionLoop({
      producer: coder,
      reviewer: reviewer  // NEW: real 6-axis fan-out
      maxAttempts: config.maxRevisions
      isApproved: (state) => state.outputs.reviewer.approved === true
      onExhausted: (state, ctx) => {
        // Stash final findings in state for the processor to read
        state.terminalError = {
          stage: 'revision-loop',
          message: 'reviewer rejected ${config.maxRevisions} times',
          at: now()
        };
        throw new Error(...); // becomes terminal failure
      }
    })
  → test-author (existing)
  → draft-pr-creator (NEW): pushes branch + opens draft PR + state.outputs.draftPr
  → worktree-teardown (NEW): worktreeManager.removeWorktree, best-effort

Processor:
  - state.terminalError set by onExhausted exception → catch path adds blockedTag
    AND posts the reviewer findings as a comment (read from state.outputs.reviewer.feedback)
  - state.completedAt after worktree-teardown → existing 'completed' path removes triggerTag

Reviewer stage internals:
  buildReviewerUserPrompt(diff, analyzer, coder, testAuthor, wiCtx, axis):
    → markdown context block + the per-axis prompt template
  fetch worktree diff: git diff origin/main..HEAD
  Promise.all([
    runner.run(promptCorrectness, schema=findingSchema, cwd=worktree.path, tools=READ_ONLY, ...),
    runner.run(promptPerformance, ...),
    runner.run(promptCodeStructure, ...),
    runner.run(promptNamingStyle, ...),
    runner.run(promptSecurity, ...),
    runner.run(promptIntegration, ...),
  ])
  aggregateFindings(...): dedup by file:line, severity priority, merge axis labels
  state.outputs.reviewer = { approved, findings, attempts }
```

## Critical files to modify or create

**Modify:**
- `src/types/index.ts` — extend `ReviewerOutput` from Plan 4's loose stub shape to `{ approved: boolean, findings: Finding[], attempts: number }`. Add `Finding` interface, `FindingSeverity` union, `DraftPrOutput` interface.
- `src/sdk/azure-devops-client.ts` — add `createPullRequest(opts: CreatePrArgs): Promise<PullRequest>` method. New ADO REST endpoint: `POST /{project}/_apis/git/repositories/{repoId}/pullrequests?api-version=7.1`. Body `{ sourceRefName, targetRefName, title, description, isDraft: true }`. Also add `getRepositoryId(repoName)` if needed to resolve repo IDs.
- `src/types/index.ts` — add `PullRequest`, `CreatePullRequestArgs` types.
- `src/config/index.ts` — add `ADO_REPOSITORY_ID` or `ADO_REPOSITORY_NAME` env var (PR creation needs the repo, which isn't determinable from `targetRepoPath` alone in ADO's API model). Update `.env.example`.
- `src/pipeline/stages/coder.ts` — `buildCoderUserPrompt` accepts optional `previousReviewerFeedback: Finding[]` parameter. Renders a "Previous reviewer findings" section on iteration 2+.
- `src/pipeline/stages/reviewer.ts` — full body rewrite (Plan 4 stub → real implementation). File name and exported factory name stay stable per Plan 4 commitment.
- `src/pipeline/stages/_stage-helpers.ts` — add `aggregateReviewerFindings(perAxisOutputs: ReviewerAxisOutput[]) → Finding[]` pure helper.
- `src/services/pipeline-builder.ts` — append `draftPrCreator` + `worktreeTeardown` stages; wire `onExhausted` for revisionLoop; new injection points (`reviewerPromptTemplates`, `prDescriptionTemplate`, `pushBranch` override).
- `src/services/processor.ts` — terminal failure path adds the reviewer findings comment when `state.outputs.reviewer.findings.length > 0`.
- `src/cli/index.ts` — new `debug-pr <id>` command that prints the draft-PR info from state (for operator inspection).
- `README.md`, `CLAUDE.md`, `PATTERNS.md`, `.env.example` — Plan 5 documentation pass.

**Create:**
- `src/prompts/reviewers/safety-correctness.md` — per-axis prompt (TryFunction, errors, breaking changes, Record.Get/CalcFields pitfalls).
- `src/prompts/reviewers/performance.md` — SetLoadFields, DeleteAll guards, subscriber design, deferred reads.
- `src/prompts/reviewers/code-structure.md` — SOLID, access control, parameter passing, interface usage.
- `src/prompts/reviewers/naming-style.md` — PascalCase/camelCase, object captions, AL object IDs.
- `src/prompts/reviewers/security.md` — secrets/credentials, telemetry PII, secure storage.
- `src/prompts/reviewers/integration.md` — event publishers/subscribers, job-queue patterns.
- `src/prompts/reviewer-shared.md` — shared head for all 6 axes (output schema, "find issues only in your axis" rule, severity definitions, "final message must be the JSON" rule).
- `src/prompts/draft-pr-description.md` — PR description template (uses placeholder syntax that the stage builder fills in).
- `src/pipeline/stages/draft-pr-creator.ts` — pushes branch via `Bun.spawn('git', ['push', 'origin', branch])`, calls `ado.createPullRequest`, stores `state.outputs.draftPr`.
- `src/pipeline/stages/worktree-teardown.ts` — best-effort `worktreeManager.removeWorktree`. Catches and logs all errors; never throws.

**Test files:**
- `tests/sdk/azure-devops-client.test.ts` — extend with `createPullRequest` tests (~3-4 new).
- `tests/pipeline/stages/reviewer.test.ts` — full rewrite (was 2 stub tests; now ~10): parallel-fanout, per-axis runner calls, aggregation by file:line, severity priority, approved/not-approved predicates, reviewer Bash allowlist (deny `git push`).
- `tests/pipeline/stages/draft-pr-creator.test.ts` — ~6 tests: pushes branch, creates PR, stores draftPr output, handles push failure, handles ADO API failure, PR description has all sections.
- `tests/pipeline/stages/worktree-teardown.test.ts` — ~4 tests: calls removeWorktree, best-effort on failure, no-op when state.outputs.worktree missing, returns state unchanged on error.
- `tests/services/pipeline-builder.test.ts` — extend with ~3 new tests for full 6-stage chain + onExhausted wiring.
- `tests/services/processor.test.ts` — extend with ~3 new tests for reviewer-findings comment on exhaustion.
- `tests/pipeline/stages/coder.test.ts` — extend with ~2 new tests for reviewer-feedback rendering on iteration 2+.
- `tests/pipeline/stages/_stage-helpers.test.ts` — NEW file with ~6 tests for `aggregateReviewerFindings` (dedup, severity priority, empty input, axis-label concat).
- `tests/integration/pr-e2e.test.ts` — NEW: full pipeline analyzer→worktree→coder→reviewer (rejects then approves)→test-author→draft-pr→teardown, against mocked ADO + runner + worktree-manager. ~3-4 scenarios.

**Expected final test count:** ~270 across ~33 files (213 baseline + ~55 new).

## Existing utilities to reuse (DO NOT REIMPLEMENT)

- `agentStage`-style internals are NOT reused for the reviewer (the reviewer hand-rolls its fan-out parallelism, similar to how the analyzer hand-rolls its reject-or-proceed branch).
- `composeCanUseTool`, `MAX_TRANSIENT_RETRIES`, `defaultGetCurrentHeadSha`, `defaultResetWorktree` from `src/pipeline/stages/_stage-helpers.ts` — coder's reviewer-feedback-rendering uses no new helpers.
- `createBashAllowlist` from `src/utils/bash-allowlist.ts` — reviewer has its own (read-only) allow/deny patterns.
- `createPathEscapeFilter` from `src/utils/path-escape-filter.ts` — actually unused by the reviewer (no `Edit`/`Write` tools), but cheap belt-and-suspenders.
- `runPool` from `src/utils/pool.ts` — NOT used; the reviewer's 6 parallel calls go straight through `Promise.all` (6 is small enough that no pool is needed).
- `marked` — for rendering the exhaustion comment markdown.
- `worktreeManager.removeWorktree` from Plan 4.
- `revisionLoop` from Plan 1 — wired with the real reviewer + onExhausted.

## Task list (execution order; dependencies in parens)

1. **Types extensions** — `Finding`, `FindingSeverity`, `DraftPrOutput`, `PullRequest`, `CreatePullRequestArgs`, full `ReviewerOutput` (no longer `unknown[]` for feedback). Update `tests/services/pipeline-builder.test.ts` shim if needed for the new ReviewerOutput shape. ~1 test (config extension if a new env var lands).
2. **Config: ADO repository identifier** — add `ADO_REPOSITORY_NAME` (or `_ID`) env var. Update Zod schema + `.env.example`. ~2 tests.
3. **ADO client: `createPullRequest`** — POST to `/{project}/_apis/git/repositories/{repoId}/pullrequests?api-version=7.1`. Resolves repoId from name via a one-shot GET if needed. ~3 tests (success, draft flag, error path).
4. **`aggregateReviewerFindings` pure helper** in `_stage-helpers.ts` — dedup by `file:line`, severity priority, axis-label concat. ~6 tests.
5. **Reviewer Bash allowlist** — defined inline in `reviewer.ts` (read-only). No new test file; covered by reviewer.test.ts.
6. **6 reviewer prompts** (`src/prompts/reviewers/*.md`) + `reviewer-shared.md`. Content task, no tests.
7. **Reviewer stage (full rewrite)** — replaces Plan 4 stub body. Per-axis `runner.run()` via `Promise.all`. Stores `{ approved, findings, attempts }`. ~10 tests.
8. **Coder reads prior reviewer feedback** — extend `buildCoderUserPrompt` signature; render "Previous reviewer findings" section when feedback is present. ~2 new tests (and update one existing test to verify section absent when no feedback).
9. **PR description template** — `src/prompts/draft-pr-description.md` (template strings filled in by the stage builder, NOT model-rendered). Content task.
10. **Draft-PR creator stage** — pushes branch via `Bun.spawn` + `ado.createPullRequest`. Stores `state.outputs.draftPr`. ~6 tests.
11. **Worktree-teardown stage** — calls `worktreeManager.removeWorktree`. Best-effort. ~4 tests.
12. **Pipeline-builder wiring** — full 6-stage chain + `onExhausted` handler. ~3 new tests. Existing tests cascade (update stage-count assertions).
13. **Processor exhaustion comment** — terminal-error path now also posts the reviewer findings as a markdown comment if `state.outputs.reviewer.findings.length > 0`. ~3 new tests.
14. **CLI: `debug-pr <id>`** — prints `state.outputs.draftPr` JSON. Manual smoke only.
15. **Integration e2e** — `tests/integration/pr-e2e.test.ts`. 3-4 scenarios: happy path (analyzer proceeds → coder → reviewer approves → test-author → PR → teardown), revisionLoop iteration (coder retries after reviewer rejects → succeeds on attempt 2), revisionLoop exhaustion (3 rejects → comment + blockedTag), PR-creation failure (terminal).
16. **Docs + final verification** — README/CLAUDE.md/PATTERNS.md updates. `.env.example` includes `ADO_REPOSITORY_NAME`. Final gate green.

## Verification

End-to-end checks at plan completion.

**Unit + integration:**
```powershell
bun install ; bun run typecheck ; bun test
```
Expected: ~270 tests across ~33 files, 0 fail. Typecheck clean.

**CLI smoke:**
```powershell
bun run src/cli/index.ts help                # mentions debug-pr
bun run src/cli/index.ts version
bun run src/cli/index.ts debug-pr 999        # safe no-op on missing state
```

**Real ADO + Claude smoke** (requires `.env` with valid PAT + a WI tagged `agent implement` whose description is genuinely implementable):
```powershell
bun run src/cli/index.ts run-wi <id> -- --dry-run   # exercises full pipeline without ADO writes (no PR created)
bun run src/cli/index.ts run-wi <id>                # for real: expect a draft PR opened, no `code-review` label
```

Manual verification on the draft PR:
1. PR exists in ADO UI for the target repo, branch = `agent/wi-<id>-<slug>`.
2. PR is in draft state.
3. PR description has: WI link, analyzer summary, coder summary, test-author summary, any non-blocking reviewer findings.
4. No `code-review` label on the PR (human action only).
5. Worktree dir is gone: `git -C ${TARGET_REPO_PATH} worktree list` no longer shows it.
6. `agent/wi-<id>-<slug>` branch is gone locally (origin still has it).
7. `agent implement` tag removed from the WI; `completedAt` set on the state file.

**Revision-loop exhaustion test (manual):**
1. Tag a deliberately tricky WI (e.g. one that asks for code that violates AL conventions on purpose).
2. Run the pipeline; observe revisionLoop iterating 3 times.
3. After exhaustion: WI has `agent-blocked` tag, a markdown comment with the final reviewer findings, no draft PR.
4. The worktree is STILL there (intentional — for human inspection).

## Open items being intentionally deferred

- **Multimodal image content blocks** for reviewer/coder (still deferred to a future plan if a UI WI ever needs it).
- **Hard cost budget per WI** (currently cost is logged but not enforced).
- **Wall-clock timeout per stage** (only `maxTurns` is enforced).
- **Multi-target-repo support** (the agent operates on one `TARGET_REPO_PATH`).
- **Post-PR labels** — DevopsCoder does NOT add `code-review`. Human-action policy stays.
- **Auto-merging** — agent never merges; human always decides.
- **Conflict resolution** — if the branch is stale relative to origin/main by the time of `git push`, push will fail. Draft-PR creator catches the failure and treats it as terminal (operator rebases or `reset-state`s).
- **PR comment threading on review** — Plan 5's PR description carries the agent's full audit trail inline. Per-finding inline comments on the diff are a future enhancement.

## References for executors

- Plan 1: `docs/superpowers/plans/2026-05-04-plan-1-skeleton-and-stage-orchestrator.md`
- Plan 2: `docs/superpowers/plans/2026-05-15-plan-2-ado-client-and-watcher.md`
- Plan 3: `docs/superpowers/plans/2026-05-15-plan-3-analyzer-stage.md`
- Plan 4: `docs/superpowers/plans/2026-05-18-plan-4-worktree-coder-test-author.md`
- Sibling: `C:\GeneralDev\DevOpsPullers\DevOpsCodeReviewer` — for the 6-axis review prompts (port the rule files; mirror the severity model and dedup-by-`file:line` aggregation). NOT for the parallel-dispatch mechanism (sibling uses Skill+subagents; we use TypeScript `Promise.all`).
- Sibling reviewer's 6 axis prompts: `.claude/skills/code-review/agents/{safety-correctness,performance,code-structure,naming-style,security,integration}-reviewer.md`. Adapt these into `src/prompts/reviewers/`.
- Project memory: `C:\Users\rf\.claude\projects\C--GeneralDev-DevOpsPullers-DevOpsCoder\memory\project_devopscoder_role.md` — confirms "DevopsCoder does NOT add the code-review label on its draft PR — that stays a human action".
