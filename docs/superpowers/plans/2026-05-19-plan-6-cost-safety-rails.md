# Plan 6 — Cost & Safety Rails

## Context

After Plan 5, the pipeline runs end-to-end (analyzer → coder/reviewer loop → test-author → draft-PR → teardown). It can spend unbounded money and run unbounded wall-clock time — there is no cap on `total_cost_usd` per work item, no per-stage timeout (only `maxTurns`), and SIGINT propagates only between stages (the current stage runs to completion before the orchestrator checks `ctx.abortFlag`).

This is fine for development but a liability for production. A confused reviewer or a coder stuck in a tool-use loop can burn real money before any human intervenes. Plan 6 closes those gaps with three production-readiness rails:

1. **Per-WI cost cap** — `MAX_COST_USD_PER_WI` env var enforces a hard cap. Checked between stages; over-cap throws `CostExceededError`; processor posts a cost-exhaustion comment + adds `agent-blocked`; worktree retained for inspection.
2. **Per-stage wall-clock timeout** — `STAGE_TIMEOUT_MS_*` env vars (with sensible defaults) wrap each `stage.execute(state, ctx)`. Exceeded → `StageTimeoutError` → terminal failure with timeout comment.
3. **Mid-stage abort propagation** — `AbortSignal` threaded through `runner.run`. SIGINT or external abort flips the per-stage `AbortController`; the in-flight runner.run aborts immediately. State marks `cancelled: true` (no blocked tag, no comment); worktree intact; next poll cycle re-runs the cancelled stage from scratch.

End state after Plan 6: the agent has hard upper bounds on spend and runtime, and an operator can Ctrl-C without burning the WI. The other two production-readiness pillars (operational hardening — Docker/observability/CI; real-world failure handling — stale-branch rebase, resume-from-stage) are deferred to Plan 7 and Plan 8 respectively.

## Decisions locked

| Decision | Choice |
|---|---|
| Cost-cap unit | Per WI total. Single `total_cost_usd` budget accumulated across analyzer + coder + reviewer + test-author + draft-PR creator. |
| Cost-cap behavior | Hard fail between stages: orchestrator checks `state.outputs.cost.total > config.maxCostUsdPerWi` BEFORE starting each stage. Over → throw `CostExceededError` → existing terminal-error path → processor posts cost-exhaustion comment + `agent-blocked`. Worktree retained. |
| Cost extraction | Breaking change to `AgentRunner.run<T>`: returns `Promise<{ value: T; costUsd: number }>`. Production runner extracts `total_cost_usd` from the SDK final result. ~30 test mocks cascade with `{ value, costUsd: 0 }`. |
| Cost-tracking helper | `src/utils/cost-tracker.ts`: pure helper `createCostTracker(state)` → `{ add(stageName, usd), total(), perStage() }`. Writes through to `state.outputs.cost: { total, perStage }`. |
| Timeout granularity | Per-stage. Wraps each `stage.execute(state, ctx)` call. Reviewer's 6 parallel runner.run calls fall under the reviewer-stage timeout as a single budget. |
| Timeout behavior | Hard terminal failure (same routing as cost cap). On hit → `StageTimeoutError` → processor posts stage-timeout comment + `agent-blocked`. Worktree retained. No retry-on-timeout. |
| Timeout defaults | analyzer 5min, coder 30min, reviewer 15min, test-author 20min, draft-pr-creator 2min, worktree-setup 1min, worktree-teardown 1min. Override via `STAGE_TIMEOUT_MS_*` env vars. |
| Abort granularity | Mid-stage via `AbortSignal` on `AgentRunArgs`. Each stage runs under a per-stage `AbortController` owned by the orchestrator. The controller is fired by SIGINT (external abort) OR per-stage timeout. |
| Abort routing — external (SIGINT/SIGTERM) | `state.cancelled = true`; NO `terminalError`; NO blocked tag; trigger tag remains; worktree intact. Next poll cycle: the processor clears `state.cancelled` on entry and re-runs the pipeline from scratch (which re-enters the cancelled stage as if for the first time — the orchestrator doesn't checkpoint within-stage progress). Both SIGINT and SIGTERM trigger this path; the existing watcher signal handlers in `src/services/watcher.ts` flip `abortFlag.aborted`. |
| Abort routing — timeout | `StageTimeoutError` (already covered above). |
| Cancelled outcome | Folded into existing `ProcessOutcome.kind = 'skipped'` with `reason: 'cancelled'` to minimize `CycleStats` churn. No new outcome kind. |
| Processor comment helpers | Two new exports near `renderRejectMarkdown`: `renderCostExhaustionMarkdown(state, config)` and `renderStageTimeoutMarkdown(state, terminalError, config)`. Both include per-stage spend breakdown and the reset-state instruction. |
| Discriminating cost vs timeout vs reviewer in processor | `terminalError.message` string match (`/cost cap/`, `/timeout/`). Existing reviewer-findings branch checks `outputs.reviewer.findings.length > 0` first. Strict precedence: reviewer findings → cost → timeout. |
| Dry-run | Suppresses BOTH the cost-exhaustion comment AND the timeout comment (same as the existing reviewer-findings suppress behavior). |
| AgentRunArgs change | Additive: `signal?: AbortSignal`. Stages pass `ctx.signal` through. Optional everywhere; legacy callers (none after this plan) tolerate undefined. |
| PipelineContext change | Additive: `signal: AbortSignal`. Orchestrator constructs a fresh `AbortController` per stage and threads `controller.signal` through. The existing `abortFlag: AbortFlag` STAYS — it is the external "shut down the watcher" signal; the `AbortController` is the per-stage cancellation handle. |
| Multimodal images | Still deferred (Plan 5 deferred this; Plan 6 doesn't change scope). |
| Conflict resolution on stale branch | Still deferred to Plan 8. |
| Resume-from-stage CLI | Still deferred to Plan 8. |
| Docker / observability / metrics | Deferred to Plan 7. |

## Architecture overview

```
runPipeline (orchestrator):
  for each stage in stages:
    // Pre-stage gates
    if ctx.abortFlag.aborted:
      // External shutdown before this stage started; return cleanly
      return state
    if state.outputs.cost.total > config.maxCostUsdPerWi:
      throw new CostExceededError(state.outputs.cost.total, config.maxCostUsdPerWi, stage.name)

    // Per-stage AbortController = (external abortFlag OR per-stage timeout)
    const ctrl = new AbortController()
    const stageCtx = { ...ctx, signal: ctrl.signal }

    // Wire abortFlag → ctrl (external SIGINT cascades to runner.run).
    // 100ms poll is the simple v1; implementer MAY swap for direct event
    // coupling (e.g. promoting AbortFlag to wrap an AbortController) if the
    // wiring stays clean.
    const abortFlagWatcher = setInterval(() => {
      if (ctx.abortFlag.aborted && !ctrl.signal.aborted) ctrl.abort('external')
    }, 100)

    // Per-stage timeout
    const timeoutMs = config.stageTimeoutMs[stage.name] ?? DEFAULT_STAGE_TIMEOUT_MS
    const timer = setTimeout(() => ctrl.abort('timeout'), timeoutMs)

    try {
      state = await stage.execute(state, stageCtx)
    } catch (err) {
      if (err.name === 'AbortError' || ctrl.signal.aborted) {
        const reason = ctrl.signal.reason
        if (reason === 'timeout') {
          throw new StageTimeoutError(stage.name, timeoutMs)
        }
        if (reason === 'external') {
          // SIGINT: resumable
          state.cancelled = true
          store.save(state)
          return state
        }
      }
      throw err  // existing terminal-error path
    } finally {
      clearTimeout(timer)
      clearInterval(abortFlagWatcher)
    }

    // Cost accumulated inside stage.execute via the tracker; no explicit step here.

  return state

// Inside each stage:
async execute(state, ctx):
  const tracker = createCostTracker(state)
  // ... existing logic ...
  const { value, costUsd } = await runner.run({ ..., signal: ctx.signal })
  tracker.add(stage.name, costUsd)
  // ... existing logic ...

// Processor (terminal-error catch):
catch (err):
  persisted = store.load(workItemId)
  if persisted?.cancelled:
    return { kind: 'skipped', reason: 'cancelled', workItemId }

  if !dryRun:
    if persisted?.outputs.reviewer?.findings?.length > 0:
      post reviewer-findings comment  // existing (Plan 5 task-12)
    else if /cost cap/.test(terminalError.message):
      post renderCostExhaustionMarkdown
    else if /timeout/.test(terminalError.message):
      post renderStageTimeoutMarkdown

    safeAdoOp(addTagToWorkItem, blockedTag)

  return { kind: 'failed', workItemId, error: terminalError }
```

## Critical files to modify or create

**Modify:**

- `src/pipeline/agent-stage.ts` — `AgentRunner.run<T>` returns `Promise<{ value: T; costUsd: number }>`. `AgentRunArgs.signal?: AbortSignal` added.
- `src/services/claude-agent-runner.ts` — Extract `total_cost_usd` from the SDK's final result message. Respect `args.signal` — pass it to the SDK's `query()` call (if supported) or check `signal.aborted` in the consume loop and throw `AbortError`.
- `src/pipeline/stage.ts` — `PipelineContext.signal: AbortSignal` (additive; required field — orchestrator always sets it).
- `src/pipeline/orchestrator.ts` — Per-stage `AbortController`, timeout race, cost-cap pre-check, distinguish timeout vs external abort. Catch the three new error classes specifically; route through existing `terminalError`/`cancelled` paths.
- `src/types/index.ts` — Add `PipelineCostInfo { total: number; perStage: Record<string, number> }`. Add `CostExceededError`, `StageTimeoutError` classes (or in a sibling errors file — choose by file size).
- `src/config/index.ts` — New env vars: `MAX_COST_USD_PER_WI` (required, no default — explicit operator decision). `STAGE_TIMEOUT_MS_ANALYZER`, `..._CODER`, `..._REVIEWER`, `..._TEST_AUTHOR`, `..._DRAFT_PR_CREATOR`, `..._WORKTREE_SETUP`, `..._WORKTREE_TEARDOWN` — all optional with defaults (5min/30min/15min/20min/2min/1min/1min). Surface as `config.maxCostUsdPerWi: number` and `config.stageTimeoutMs: Record<string, number>`.
- `src/pipeline/stages/analyzer.ts` — Destructure `{ value, costUsd }` from `runner.run`. Pass `signal: ctx.signal`. Call `tracker.add('analyzer', costUsd)`.
- `src/pipeline/stages/coder.ts` — Same as analyzer. Tracker uses `'coder'` key.
- `src/pipeline/stages/reviewer.ts` — Six parallel `runner.run` calls — sum their `costUsd` and call `tracker.add('reviewer', sum)` once after `Promise.all`.
- `src/pipeline/stages/test-author.ts` — Same pattern as coder/analyzer.
- `src/pipeline/stages/worktree-setup.ts`, `worktree-teardown.ts`, `draft-pr-creator.ts` — These stages don't call `runner.run`, but they DO need to respect `ctx.signal` for their own I/O (git ops, ADO HTTP calls). At minimum, pass the signal through to fetch calls in the ADO client. May need a follow-up to `azure-devops-client.ts` to accept a signal on its fetch wrapper.
- `src/sdk/azure-devops-client.ts` — Extend `adoFetch`/`adoFetchWithRetry` to accept an optional `signal: AbortSignal`. Pass through to the underlying fetch. ADO calls in the draft-PR creator and processor honor SIGINT.
- `src/services/processor.ts` — `terminalError.message` branch: route to one of three comment renderers (reviewer/cost/timeout). Honor `state.cancelled` (skip all ADO writes; return `kind: 'skipped', reason: 'cancelled'`). The `state.cancelled` check is FIRST in the catch. Also clear `state.cancelled = false` (and save) at the TOP of `processWorkItem` (before `runPipeline`) so that the next cycle's run starts clean and the orchestrator's pre-stage checks see a fresh state.
- `src/services/pipeline-builder.ts` — No structural change; just thread `config.stageTimeoutMs` and `config.maxCostUsdPerWi` (already on `config`) implicitly — both are read by the orchestrator, not by builder.
- All AgentRunner test mocks (~30 files in `tests/`) — return `{ value, costUsd: 0 }` instead of just `value`.
- Tests for the changed stages — extend assertions where relevant (e.g. cost is tracked correctly per-stage).

**Create:**

- `src/utils/cost-tracker.ts` — Pure helper. Exports `createCostTracker(state: PipelineState): CostTracker` where `CostTracker = { add(stage: string, usd: number): void; total(): number; perStage(): Record<string, number> }`. Initializes `state.outputs.cost = { total: 0, perStage: {} }` if absent. Idempotent on re-entry.
- `src/utils/abort-helpers.ts` (optional, decide during impl) — `combineAbortSignals(...)` or `withTimeout()` if the orchestrator's race wiring inflates. May fold inline.
- `tests/utils/cost-tracker.test.ts` — ~5 tests: add/total/perStage/empty/double-add.
- `tests/integration/cost-cap-e2e.test.ts` — ~1 scenario: full pipeline; coder reports cost > cap; cost-exhaustion comment + blocked tag fire; no PR; worktree retained.

**Test files extended (no new test files for these — extend existing):**

- `tests/pipeline/orchestrator.test.ts` — +9: cost-cap pre-check (3 tests: under/over/cumulative), timeout (3 tests: within/over/cleared-on-success), abort (3 tests: external-aborts-mid-stage-sets-cancelled / external-doesnt-write-terminalError / external-preserves-triggerTag).
- `tests/services/processor.test.ts` — +5: cost comment+tag (1), timeout comment+tag (1), cancelled path skips writes (1), dry-run suppresses cost comment (1), dry-run suppresses timeout comment (1).
- `tests/services/claude-agent-runner.test.ts` — +4: extracts total_cost_usd from result (1), missing field → 0 (1), signal abort → AbortError (1), signal not provided → normal (1).

**Expected final test count:** baseline 259 + ~35 new = ~294 across ~34 files. (Higher than the rough ~24 estimate during brainstorming once cancelled-path and config-fixture coverage was decomposed properly.)

## Existing utilities to reuse (DO NOT REIMPLEMENT)

- `safeAdoOp` from `src/services/processor.ts` — Wrap the two new comment posts.
- `marked` — Render the cost/timeout markdown to HTML (same pattern as the existing reviewer-findings comment).
- `composeCanUseTool` from `src/pipeline/stages/_stage-helpers.ts` — Unchanged.
- `aggregateReviewerFindings` from `_stage-helpers.ts` — Unchanged. The reviewer stage's per-axis cost sums are summed by the reviewer, not by aggregateReviewerFindings.
- `worktreeManager` interface — Unchanged. Plan 6 doesn't change teardown semantics; the failure-path no-teardown rule already holds.

## Out of scope (do not introduce in Plan 6)

- Conflict resolution / rebase on stale-branch push (deferred to Plan 8).
- Resume-from-stage CLI (deferred to Plan 8).
- Docker image, observability/metrics, structured event log (deferred to Plan 7).
- Multimodal image content blocks for the reviewer/coder (still deferred from Plan 5).
- Auto-merging or PR-comment-driven retry.
- Per-stage cost caps (Plan 6 enforces a single per-WI cap only).
- Per-WI wall-clock budget (Plan 6 enforces per-stage timeouts only — these effectively cap the worst case at sum-of-stage-timeouts ≈ 75min on defaults).

## Task list (high-level — `writing-plans` will expand into the manifest)

1. **Types & errors** — Add `PipelineCostInfo`, `CostExceededError`, `StageTimeoutError` to `src/types/index.ts` (or a sibling errors module).
2. **Config** — Add `MAX_COST_USD_PER_WI` (required) and seven `STAGE_TIMEOUT_MS_*` env vars (optional, defaults) to the Zod schema; surface as `config.maxCostUsdPerWi` and `config.stageTimeoutMs`. Update `.env.example`.
3. **AgentRunner contract change** — `run<T>` returns `{ value, costUsd }`; add `signal?: AbortSignal` to `AgentRunArgs`. Update production runner to extract `total_cost_usd` and respect signal.
4. **Cost tracker helper** — `src/utils/cost-tracker.ts`. Pure unit-tested.
5. **PipelineContext + orchestrator wiring** — Add `signal: AbortSignal` to `PipelineContext`. Orchestrator owns per-stage `AbortController`, cost-cap pre-check, timeout race, external-vs-timeout discrimination.
6. **Stage cost tracking** — Wire `tracker.add(stageName, costUsd)` into analyzer/coder/test-author/reviewer (reviewer sums its 6 parallel calls). Stages pass `ctx.signal` to `runner.run`.
7. **ADO client signal support** — `adoFetch` accepts optional `signal`; `addWorkItemComment`/`createPullRequest`/etc. forward it.
8. **Processor — cancelled path** — First check in catch; skip ADO writes; return `kind: 'skipped', reason: 'cancelled'`.
9. **Processor — cost-exhaustion comment** — `renderCostExhaustionMarkdown` helper; routed when `terminalError.message` matches.
10. **Processor — timeout comment** — `renderStageTimeoutMarkdown` helper; routed when `terminalError.message` matches.
11. **Test-mock cascade** — Update ~30 `AgentRunner.run` mocks across `tests/` to return `{ value, costUsd: 0 }`.
12. **Orchestrator tests** — Extend `tests/pipeline/orchestrator.test.ts` with ~9 tests.
13. **Processor tests** — Extend `tests/services/processor.test.ts` with ~5 tests.
14. **AgentRunner tests** — Extend `tests/services/claude-agent-runner.test.ts` with ~4 tests.
15. **Integration e2e: cost-exceeded** — New `tests/integration/cost-cap-e2e.test.ts`. One scenario: coder reports a cost spike → between-stage check fires before reviewer → cost comment + blocked tag + no PR + worktree retained.
16. **Docs + final verification** — Update README / CLAUDE.md / PATTERNS.md / `.env.example` for Plan 6. Note milestone-7 stage (Plan 6 done). Run `bun install / bun run typecheck / bun test`; gate green; working tree clean.

## Verification

End-to-end checks at plan completion:

**Unit + integration:**
```powershell
bun install ; bun run typecheck ; bun test
```
Expected: ~294 tests across ~34 files, 0 fail. Typecheck clean.

**CLI smoke:**
```powershell
bun run src/cli/index.ts help                # mentions Plan 6 features in env-var section if surfaced there
bun run src/cli/index.ts version
```

**Cost-cap real-world smoke** (requires `.env` with `MAX_COST_USD_PER_WI=0.05` set artificially low):
```powershell
bun run src/cli/index.ts run-wi <id>
```
Expected: pipeline runs for 1-2 stages, cost exceeds cap, `agent-blocked` tag added on the WI, a cost-exhaustion comment posted with per-stage spend breakdown. No draft PR. Worktree retained.

**Timeout real-world smoke** (requires `STAGE_TIMEOUT_MS_CODER=5000` set artificially low):
```powershell
bun run src/cli/index.ts run-wi <id>
```
Expected: coder stage aborts at ~5s, timeout comment posted, `agent-blocked` added, no PR.

**Abort propagation smoke** (in a separate terminal, while a real WI is processing):
```powershell
# Terminal 1: bun run start (watcher running)
# Terminal 2: send SIGINT to the watcher (Ctrl-C in terminal 1)
```
Expected: in-flight `runner.run` aborts within ~1s; state file has `cancelled: true`, no `terminalError`, no blocked tag; trigger tag still on WI. On next poll cycle (re-add trigger tag if it was removed by upstream stage; otherwise it stays): pipeline re-runs from the cancelled stage.

## Open items being intentionally deferred

- **Resume-from-cancelled-stage with checkpointed state** — Plan 6 simply re-runs the cancelled stage from scratch on next cycle. A more sophisticated resume (e.g., the coder re-uses the worktree's existing commits, the reviewer re-uses the last successful axis results) is deferred. Worth revisiting if cycles cost meaningfully more after Plan 6 is deployed.
- **Per-stage cost caps** — A single per-WI cap is the v1. If one stage dominates (e.g., reviewer fanout becomes most of the budget), per-stage caps could land in a follow-up. Plan 6 just exposes per-stage spend in `state.outputs.cost.perStage` for visibility.
- **Per-WI wall-clock budget** — Per-stage timeouts effectively cap the worst case at ~75min on defaults. A separate per-WI wall-clock cap is deferred.
- **Soft caps / warnings before hard kill** — Plan 6 is hard-kill only. A "warn at 80%, kill at 100%" pattern would require percentage tracking and warning thresholds — deferred unless real-world deployment shows the hard kill is too abrupt.
- **Conflict resolution on stale-branch push** — Deferred to Plan 8.
- **Resume-from-stage CLI** — Deferred to Plan 8.
- **Docker image + observability** — Deferred to Plan 7.
- **AbortSignal in `Bun.spawn` calls** — Plan 6's abort propagation goes through `runner.run` (the Claude SDK call) and the ADO fetch wrapper. Individual `git` spawns in the coder/test-author/worktree-manager are NOT abort-aware; they run to completion if they're in flight when SIGINT fires. This is acceptable because individual git ops complete in < 5s on any realistic repo. Worth revisiting if git ops become a bottleneck.

## References for executors

- Plan 5: `docs/superpowers/plans/2026-05-18-plan-5-reviewer-pr-teardown.md` — the most recent precedent; in particular task-12's `safeAdoOp` + `marked` + `renderRejectMarkdown` pattern for the new cost/timeout comment renderers.
- Plan 4: `docs/superpowers/plans/2026-05-18-plan-4-worktree-coder-test-author.md` — for the AgentRunner.run cascade pattern (Plan 4 added retry-on-transient with a similar test-mock fan-out).
- Plan 1: `docs/superpowers/plans/2026-05-04-plan-1-skeleton-and-stage-orchestrator.md` — the original `AgentRunner` contract this plan is breaking.
- Anthropic SDK docs (`@anthropic-ai/claude-agent-sdk`) for `total_cost_usd` field shape — verify during task 3 before wiring extraction.
