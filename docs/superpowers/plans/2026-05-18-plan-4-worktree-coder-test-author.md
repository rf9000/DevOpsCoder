# Plan 4 — Worktree manager + Coder + Test-author stages

## Context

Plan 3 (`docs/superpowers/plans/2026-05-15-plan-3-analyzer-stage.md` — done) shipped the analyzer as a readiness gate. After a WI passes the analyzer (`verdict: proceed`), the pipeline currently has no more stages — the orchestrator marks `completedAt`, the processor removes the trigger tag, and the WI is done with no work performed.

Plan 4 inserts the **first stages that write to the target repo**:

1. **`worktree-setup`** — provisions an isolated `git worktree` for the WI (`${WORKTREE_BASE}/wi-{id}-{slug}` on branch `agent/wi-{id}-{slug}`, branched from a freshly-fetched `origin/main`). State-driven idempotent reuse on re-entry.
2. **`revisionLoop(coder, reviewer)`** — the coder uses Claude with full read/write/edit tooling, working inside the worktree, to implement what the WI asks. The reviewer is a Plan 4 stub that always approves; Plan 5 swaps it for a real parallel-fan-out reviewer.
3. **`test-author`** — a second Claude call that adds/updates tests for what the coder just shipped. Runs in the same worktree.

After Plan 4 completes, the WI's branch in the local clone has commits from the coder + test-author. The trigger tag is removed. Plan 5 adds push + draft-PR creation + worktree teardown. **Plan 4 does not push.**

## Decisions locked

| Decision | Choice |
|---|---|
| Worktree management | YES, from day one. `src/services/worktree-manager.ts` + `src/pipeline/stages/worktree-setup.ts`. |
| Stage order | `analyzer → worktree-setup → revisionLoop(coder, reviewer) → test-author`. worktree-setup only runs after analyzer proceeds (no branches on rejected WIs). |
| Coder/test-author output | Structured JSON via Zod. Coder: `{ summary, filesChanged: string[], commits: string[] }`. Test-author: `{ summary, testFilesChanged: string[], commits: string[] }`. |
| Stub reviewer | File is `src/pipeline/stages/reviewer.ts` with a Plan 4 stub body that synchronously emits `{ approved: true, feedback: [] }`. Header comment marks it as stub; Plan 5 swaps the body in-place. No new Claude SDK call wasted on a guaranteed-approve. |
| revisionLoop retry | Stays pure (current implementation). Transient-error retry (e.g. `AgentOutputParseError`, network blips) is handled INSIDE the coder stage's body via a small retry loop around `runner.run`. |
| Coder failure | On any throw inside the coder stage, reset worktree to the per-attempt baseline SHA (recorded at the top of `execute`), then re-throw. `git reset --hard ${baselineSha}` + `git clean -fd`. |
| Coder Bash safety | **Strict allowlist** (not extended denylist). Read-only git ops, `git add <paths>` (no `-A`/`.`), `git commit -m`, `git rm`, `git mv`, `bun test`/`bun run typecheck`/`npm test`. Deny `git push`/`reset`/`rebase`/`merge`/`checkout`/`stash drop`/`clean -f`/`config`/`remote`. Deny `cd`. |
| Path-escape filter | Filter `Edit`/`Write` tool calls via `canUseTool` — reject any path that resolves outside `cwd` (the worktree). Cheap belt-and-suspenders against runaway agent paths. |
| Worktree reuse on re-entry | **State-driven.** If `state.outputs.worktree` exists AND the path-on-disk + branch validate, reuse. Otherwise treat as orphan: `git worktree prune` + delete dir + recreate. |
| Branch name immutability | Lock at first creation. `state.outputs.worktree.branch` is the source of truth on re-entry, NOT the recomputed slug. Avoids slug-drift double-branches. |
| Pass WI context to coder | Analyzer persists its fetched `WorkItemContext` into `state.outputs.wiContext`. Coder reads from state, no redundant ADO fetch. |
| Commits across revisionLoop iterations | **Stack** — coder builds on prior iteration's commits (the reviewer-rejection path in Plan 5 lets it amend). Worktree state reflects all prior attempts. Revisit in Plan 5. |
| Test-author self-verification | Test-author MAY run `bun test` against its own work (added to its Bash allowlist). Plan 4 doesn't fail the pipeline on test results — it's just a quality check the agent can self-perform. |
| maxTurns | Config-tunable. New env vars `CODER_MAX_TURNS` (default 80) and `TEST_AUTHOR_MAX_TURNS` (default 50). |
| Multimodal images | Defer to Plan 5. Coder gets image URLs as text references (just like the analyzer); can `Read` them on demand if needed. |
| `reset-state <id>` CLI | Also cleans up the worktree + branch via `worktreeManager.removeWorktree`. Add `--keep-worktree` flag for humans who want to inspect. |
| `Bun.spawn` for git | Yes — first non-Claude-SDK shell-out in the codebase. Wrapped behind `worktree-manager.ts`'s interface. Thrown `WorktreeError` carries `{ command, exitCode, stdout, stderr }`. |
| Concurrency | Stays at 1 (config default). Worktrees would support >1 but Plan 4 doesn't certify it. Mark as a future "parallelism" plan. |

## Architecture overview

```
Watcher poll cycle
  → Processor.processWorkItem(id)
    → load-or-create state, clear stale rejection
    → runPipeline([analyzer, worktreeSetup, revisionLoop(coder, reviewer), testAuthor])
       → analyzer.execute → state.outputs.analyzer + state.outputs.wiContext
          (proceed → next stage; reject → throws PipelineRejectError)
       → worktreeSetup.execute
          → worktreeManager.ensureWorktree({ wiId, slug, state })
             → if state.outputs.worktree?.path && exists on disk + git registry: reuse
             → else: prune + rm + git worktree add ${path} -b ${branch} origin/main
          → state.outputs.worktree = { path, branch, baseSha }
       → revisionLoop(coder, reviewer).execute
          → for attempt in 1..maxRevisions:
             → coder.execute (records baseSha in attempt-local var)
                → runner.run(... cwd: worktreePath, full toolset, strict bash allowlist, path-escape filter ...)
                → on PARSE/TRANSIENT throw: git reset --hard baselineSha + git clean -fd; retry up to 2x
                → on hard throw: same cleanup, re-throw
                → on success: state.outputs.coder = { summary, filesChanged, commits }
             → reviewer.execute (Plan 4 stub: state.outputs.reviewer = { approved: true, feedback: [] })
             → isApproved: true → exit loop
       → testAuthor.execute → state.outputs.testAuthor = { summary, testFilesChanged, commits }
    → final.completedAt set by orchestrator (no more stages)
  → Processor sees completedAt → removeTriggerTag → return 'completed'
```

## Critical files to modify or create

**Modify:**
- `src/types/index.ts` — add `WorktreeContext`, `CoderOutput`, `TestAuthorOutput`, `ReviewerOutput` types. Extend `AppConfig` with `coderMaxTurns` and `testAuthorMaxTurns`. Extend `WorkItemContext` (already exported from wi-context.ts) reference if needed for `state.outputs.wiContext` shape.
- `src/config/index.ts` — read `CODER_MAX_TURNS` (default 80) and `TEST_AUTHOR_MAX_TURNS` (default 50).
- `src/pipeline/stages/analyzer.ts` — after successful runner call, write `state.outputs.wiContext = wiCtx` so downstream stages can read.
- `src/services/pipeline-builder.ts` — append `worktreeSetup`, `revisionLoop(coder, reviewer)`, `testAuthor` to the stage list. Add new injection points for the same overrides we have today.
- `src/cli/index.ts` — extend `reset-state <id>` to also call `worktreeManager.removeWorktree({ id, slug })`. Add `--keep-worktree` flag.
- `tests/pipeline/stages/analyzer.test.ts` — add 1 test for `state.outputs.wiContext` persistence.
- `README.md`, `CLAUDE.md`, `PATTERNS.md` — Plan 4 changes (new stages, worktree pattern, new env vars).

**Create:**
- `src/services/worktree-manager.ts` — `createWorktreeManager(config)` → `{ ensureWorktree, removeWorktree }`. Wraps `Bun.spawn('git', [...])`. Custom `WorktreeError`. State-driven reuse. Idempotent. Ensures `worktreeBase` directory exists.
- `src/pipeline/stages/worktree-setup.ts` — Stage wrapping `worktreeManager.ensureWorktree`. Stores `state.outputs.worktree = { path, branch, baseSha }`. Records `baseSha` (the SHA of `origin/main` at creation time) for later baseline-reset logic.
- `src/pipeline/stages/coder.ts` — `createCoderStage({ runner, config, promptTemplate, discoveredSkills })`. Uses `agentStage` factory plus a wrapping retry loop. Reads `state.outputs.analyzer`, `state.outputs.wiContext`, `state.outputs.worktree`. Sets `cwd = state.outputs.worktree.path`. Tools: `Read, Grep, Glob, Bash, Skill, Edit, Write`. Disallowed: `NotebookEdit`. `canUseTool` enforces the strict Bash allowlist + path-escape filter. `maxTurns: config.coderMaxTurns`. Output schema: `{ summary, filesChanged, commits }`. On thrown error: `git reset --hard ${attemptBaselineSha}` + `git clean -fd` + re-throw.
- `src/pipeline/stages/test-author.ts` — same shape as coder, separate prompt, separate output. Tools include test runner allowlist. `maxTurns: config.testAuthorMaxTurns`. Output: `{ summary, testFilesChanged, commits }`.
- `src/pipeline/stages/reviewer.ts` — Plan 4 stub. Exports `createReviewerStage(deps)` returning a Stage that synchronously sets `state.outputs.reviewer = { approved: true, feedback: [] }`. Plan 5 replaces the body in-place.
- `src/utils/bash-allowlist.ts` — `createBashAllowlist({ allow: RegExp[], deny: RegExp[] }) → CanUseToolFn` factory for the coder's Bash filter. Composable for reuse in test-author.
- `src/utils/path-escape-filter.ts` — `createPathEscapeFilter(cwd: string) → CanUseToolFn` factory. Rejects `Edit`/`Write` calls whose resolved path is outside `cwd`.
- `src/prompts/coder.md` — system prompt. Commit hygiene, allowed tools, output schema, "don't push, don't touch main, don't rebase".
- `src/prompts/test-author.md` — system prompt. Test conventions, output schema.

**Test files:**
- `tests/services/worktree-manager.test.ts` — ~8 tests with `mkdtempSync` real-git fixtures (Bun.spawn against actual git in a temp dir). Covers: create-new, reuse-from-state, orphan-prune-and-recreate, branch-name-immutability, remove, error-on-non-zero-exit, ensureWorktreeBase, path-with-space.
- `tests/utils/bash-allowlist.test.ts` — ~8 tests covering allowed commands (`git status`, `git commit -m`, `bun test`) and denied commands (`git push`, `git reset --hard HEAD~3`, `rm -rf`, `cd ..`).
- `tests/utils/path-escape-filter.test.ts` — ~5 tests covering inside-cwd writes (allowed), outside-cwd writes (denied), `..` escapes, absolute paths.
- `tests/pipeline/stages/worktree-setup.test.ts` — ~5 tests with mock worktree-manager covering: fresh-creation, state-driven-reuse, orphan-recreate, error propagation.
- `tests/pipeline/stages/coder.test.ts` — ~8 tests covering: happy path output stash, retry-on-AgentOutputParseError, retry-budget-exhausted, baseline-reset-on-throw, prompt-includes-analyzer-summary, prompt-includes-wiContext, prompt-includes-skills, correct runner options.
- `tests/pipeline/stages/test-author.test.ts` — ~5 tests covering: happy path, reads coder output, correct runner options + tools allowlist.
- `tests/pipeline/stages/reviewer.test.ts` — 2 tests (stub always approves, output shape matches schema).
- `tests/services/pipeline-builder.test.ts` — extend with 2 tests for the new stage chain.
- `tests/integration/coder-e2e.test.ts` — ~3 tests covering the analyzer→worktree-setup→coder→test-author happy path with mocked runner + mocked worktree-manager + real state-store + real revision-loop.

Plus updates to existing tests that touch `state.outputs.analyzer` (now also expects `state.outputs.wiContext` to be present) and any pipeline-builder test that asserts stage count (was 1, now 5+ since revisionLoop counts as one stage).

**Expected final test count:** ~200 across ~28 files (151 baseline + ~50 new).

## Existing utilities to reuse (DO NOT REIMPLEMENT)

- `agentStage` from `src/pipeline/agent-stage.ts` — coder and test-author are both transparent run-and-stash stages and fit this factory cleanly. (Analyzer is hand-rolled because of reject branching; coder/test-author have no branching flow.)
- `revisionLoop` from `src/pipeline/revision-loop.ts` — wraps coder + reviewer.
- `createClaudeAgentRunner` from `src/services/claude-agent-runner.ts` — production runner.
- `discoverTargetRepoSkills` from `src/services/skill-loader.ts` — Plan 3 added this.
- `fetchWiContext` from `src/services/wi-context.ts` — Plan 3 added this. Analyzer already calls it; Plan 4 just persists the result to state.
- `slugify` from `src/utils/slug.ts` — for the *initial* branch name.
- `createLogger` from `src/utils/logger.ts`.
- `marked` (already in deps) — not needed in Plan 4 (no markdown→HTML conversion required; coder/test-author output is structured JSON, not human-readable comments).

## Task list (execution order; dependencies in parens)

1. **Types + config** — add `WorktreeContext`, `CoderOutput`, `TestAuthorOutput`, `ReviewerOutput` interfaces; extend `AppConfig` with `coderMaxTurns`, `testAuthorMaxTurns`; update `loadConfig`. ~2 tests on the config extensions. *No deps.*
2. **`bash-allowlist` utility** — pure factory: `createBashAllowlist({ allow, deny })` returns `CanUseToolFn`. ~8 tests. *No deps.*
3. **`path-escape-filter` utility** — pure factory: `createPathEscapeFilter(cwd)` returns `CanUseToolFn`. ~5 tests. *No deps.*
4. **`worktree-manager` service** — `Bun.spawn`-backed `ensureWorktree` + `removeWorktree` + `WorktreeError`. Tests use real git in tmpdir. ~8 tests. *(1)*
5. **`worktree-setup` stage** — calls worktree-manager, persists `state.outputs.worktree`. ~5 tests. *(1, 4)*
6. **Analyzer extension** — persist `state.outputs.wiContext`. 1 new test in analyzer.test.ts. *(none — Plan 3 file)*
7. **`coder.md` prompt** — system prompt. No tests; copy-edit pass.
8. **`coder` stage** — `agentStage` plus retry-on-transient wrapper plus baseline-reset on error. Reads analyzer/wiContext/worktree from state. ~8 tests. *(1, 2, 3, 5, 6, 7)*
9. **`test-author.md` prompt** — system prompt. *(none.)*
10. **`test-author` stage** — same shape as coder, separate output schema, runs after the coder. ~5 tests. *(1, 2, 3, 5, 9)*
11. **`reviewer` stub stage** — synchronous always-approve. ~2 tests. *(1)*
12. **`pipeline-builder` wiring** — assemble the new chain. Update existing tests (stage count, name assertions). ~2 new tests. *(5, 8, 10, 11)*
13. **CLI `reset-state` extension** — delegate to worktree-manager.removeWorktree; add `--keep-worktree` flag. No new tests; manual smoke. *(4)*
14. **Integration e2e** — `tests/integration/coder-e2e.test.ts`. ~3 tests covering analyzer→worktree→coder→test-author with mocked runner + mocked worktree-manager. *(12)*
15. **Docs** — README/CLAUDE.md/PATTERNS.md updates. *(14)*

## Verification

End-to-end checks at plan completion.

**Unit + integration:**
```powershell
bun install ; bun run typecheck ; bun test
```
Expected: ~200 tests across ~28 files, 0 fail. Typecheck clean.

**CLI smoke:**
```powershell
bun run src/cli/index.ts help                # mentions new --keep-worktree flag
bun run src/cli/index.ts version
bun run src/cli/index.ts garbage             # exits 1
bun run src/cli/index.ts reset-state 999     # safe no-op on missing state
```

**Real ADO + Claude smoke** (requires `.env` with valid PAT + a real WI tagged `agent implement`):
```powershell
bun run src/cli/index.ts debug-tags
bun run src/cli/index.ts run-wi <id> -- --dry-run   # exercises analyzer + worktree + coder + test-author end-to-end without ADO writes
bun run src/cli/index.ts run-wi <id>                # for real: the WI's branch exists locally with coder + test-author commits; trigger tag removed
```

Manual verification on the worktree:
1. Find the worktree dir: `git -C ${TARGET_REPO_PATH} worktree list`
2. `cd ${WORKTREE_BASE}/wi-<id>-<slug>` and `git log --oneline` — expect at least 2 commits (coder + test-author).
3. `git diff main..HEAD` shows the intended changes plus the new/updated tests.
4. Run `bun test` (or whatever the target repo's test command is) inside the worktree to verify the work compiles and tests pass.
5. Run `bun run src/cli/index.ts reset-state <id>` (from the DevopsCoder repo). Verify the `.state/<id>.json` is deleted AND the worktree dir is gone AND `git worktree list` no longer shows it AND `git branch` no longer shows `agent/wi-<id>-<slug>`.
6. Run `bun run src/cli/index.ts reset-state <id> -- --keep-worktree` against a different WI. Verify only `.state/<id>.json` is deleted; worktree stays.

## Open items being intentionally deferred to Plan 5

- **Real reviewer stage** — parallel-fan-out across reviewers (correctness, tests, security, style). Stub-replacement only.
- **Draft-PR creator** — pushes the branch and opens a draft PR via ADO REST.
- **Worktree teardown after PR creation** — `worktreeManager.removeWorktree` invoked at the end of a successful pipeline.
- **Multimodal image payloads** for the coder (e.g., for UI mockup work).
- **Local test execution as a pipeline stage** (Plan 5 may make it part of the review fan-out — the test-author still runs `bun test` as self-verification in Plan 4, but the pipeline doesn't fail on test failures).
- **Wall-clock abort budget** per stage (stage-level timeouts beyond `maxTurns`).
- **State file size budget / truncation** for very large `filesChanged` arrays.
- **Cost reporting per stage** (log `total_cost_usd` to state outputs).

## References for executors

- Plan 1: `docs/superpowers/plans/2026-05-04-plan-1-skeleton-and-stage-orchestrator.md`
- Plan 2: `docs/superpowers/plans/2026-05-15-plan-2-ado-client-and-watcher.md`
- Plan 3: `docs/superpowers/plans/2026-05-15-plan-3-analyzer-stage.md`
- Sibling investigator's canUseTool pattern: `C:\GeneralDev\DevOpsPullers\DevOpsInvestigateWorkItems\src\services\investigator.ts` (lines 8-26 — but we replace the denylist with an allowlist)
- Project memory on the human-gated flow: `C:\Users\rf\.claude\projects\C--GeneralDev-DevOpsPullers-DevOpsCoder\memory\project_devopscoder_role.md`
- Project memory on sibling repos: `C:\Users\rf\.claude\projects\C--GeneralDev-DevOpsPullers-DevOpsCoder\memory\reference_sibling_repos.md`
