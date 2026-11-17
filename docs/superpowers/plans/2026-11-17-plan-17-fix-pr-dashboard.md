# Plan 17: fix-pr from the dashboard (DevOpsCoder side) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The watcher container runs fix-pr jobs queued from the monitor dashboard, holds each green result for approval, and pushes or discards it on the admin's Approve/Reject.

**Architecture:** A PR-fixer worker lives in the `watch` process next to the poll loop. It owns a persisted queue, pending approvals and history under `.state/prfix/`, runs one thing at a time (approve/reject before new jobs), and calls `fixPr` in a new hold mode that stops before `push-rebased`. `approvePrFix` / `rejectPrFix` finish or discard a held run from its saved state. The existing control API gains the queue/approve/reject/stats routes. A process-wide git lock serializes git commands on the shared clone, since a job and a work item now run at once.

**Tech Stack:** Bun, TypeScript (strict, `.ts` imports, `type` imports), Zod, bun:test.

**Spec:** `docs/superpowers/specs/2026-11-17-fix-pr-dashboard-design.md`. The monitor side is a separate plan in monitor-the-situation: `docs/superpowers/plans/2026-11-17-coder-pr-fixer-panel.md`.

## Global Constraints

- The CLI `fix-pr` behaves exactly as today (direct push, `--dry-run`, `--keep-env`). Every addition to `fixPr` is optional and off by default.
- A dashboard run never pushes without Approve. The push lease stays the pre-rebase head read at intake (`rebase.preRebaseSha` / `prFixInput.pr.headCommit`), never a head read at queue or approve time.
- One worker action at a time (job, approve or reject). Approve/reject run before the next queued job.
- PR fixer unavailable (with a reason string, `/queue` 409) when: `loadPrFixConfig` threw, `config.dryRun`, or `config.skipBuildTest`.
- Sign-in needed (`demoPortal.status().needed`): nothing starts; `waiting: 'signin'`. Never fail a queued job for it.
- `PRFIX_APPROVAL_TTL_HOURS` default 24; expired pending → rejected with `rejectedBy: 'expired'`.
- `history.jsonl` keeps the newest 500 lines.
- Range-diff and each conflict file diff are capped at 20 000 characters, with a `\n… (truncated)` suffix.
- No cost-ledger line and no `WI<id>.log` for fix-pr jobs.
- Control API: no auth, 4 KB body limit, user from `X-Remote-User` (`'unknown'` when absent).
- `stop_grace_period: 2m` on the devops-coder service.

## Review Focus

1. Approve after a developer pushed to the PR branch while the result waited → `head-moved`, nothing overwritten, IDs released, worktree kept. (Task 3 test.)
2. Container restarts while a job runs → on start, the job is recorded `failed` / `interrupted (container restarted)`, its env deleted, unpushed IDs released; pending approvals untouched. (Task 4 test.)
3. Container restarts while a result awaits approval → still pending after restart and approvable. (Task 4 test.)
4. Fix pressed for a PR that is queued, running, pending, not in the catalog, or whose work item is running → 409 with a reason that names which. (Task 4 test.)
5. Red gate / up-to-date in hold mode → no pending item, no Approve, normal cleanup. (Task 3 test.)

---

### Task 1: Process-wide git lock

**Files:**
- Create: `src/utils/git-lock.ts`
- Modify: `src/services/worktree-manager.ts` (deps + `runGit`), `src/prfix/prfix-git.ts` (deps + `runGit`)
- Test: `tests/utils/git-lock.test.ts`, extend `tests/prfix/prfix-git.test.ts` or the worktree-manager test if their runner is injectable

**Interfaces:**
- Produces: `export interface GitLock { run<T>(fn: () => Promise<T>): Promise<T> }`, `export function createGitLock(): GitLock` (FIFO promise chain), `export const NO_GIT_LOCK: GitLock` (runs `fn` directly). `createWorktreeManager` and `createPrFixGit` deps gain `gitLock?: GitLock` (default `NO_GIT_LOCK`).

- [ ] **Step 1: Failing tests** in `git-lock.test.ts`:
  - `serializes`: two `run` calls whose fns await a deferred; assert the second fn has not started until the first resolves (`order` array equals `['a-start','a-end','b-start','b-end']`).
  - `releases on throw`: first fn rejects; second still runs; first `run` rejects with the same error.
  - `NO_GIT_LOCK runs concurrently`: both fns start before either ends.
- [ ] **Step 2:** `bun test tests/utils/git-lock.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement** `git-lock.ts`. Then in both modules, `runGit` wraps the spawn in `gitLock.run` **only when `cwd` is the base clone** (`baseRepoPath` in worktree-manager, `repo`/`config.targetRepoPath` in prfix-git). Commands with a worktree `cwd` are not locked. Ruling: the overlay's `info/exclude` append is synchronous `fs` code and git never writes that file, so it needs no lock.
- [ ] **Step 4:** `bun test && bun run typecheck` → all pass.
- [ ] **Step 5:** `git commit -m "feat: process-wide git lock for commands on the shared clone"`

### Task 2: List active PRs

**Files:**
- Modify: `src/sdk/azure-devops-client.ts`, `src/types/index.ts`
- Test: `tests/sdk/azure-devops-client.test.ts` (follow the existing `getPullRequest` test's fake fetch)

**Interfaces:**
- Produces: `export interface ActivePullRequest extends PullRequestDetails { author: string; createdAt: string }`; `AdoClient.listActivePullRequests(repositoryName: string, opts?: { signal?: AbortSignal }): Promise<ActivePullRequest[]>` → `GET /{project}/_apis/git/repositories/{repo}/pullrequests?searchCriteria.status=active&$top=200&api-version=7.1`. `author` = `createdBy.displayName ?? ''`, `createdAt` = `creationDate ?? ''`. Rows without `lastMergeSourceCommit.commitId` are skipped. `url` is the web URL `{orgUrl}/{project}/_git/{repo}/pullrequest/{id}` (reuse an existing web-URL helper if one exists, else build it here).

- [ ] **Step 1: Failing test** `listActivePullRequests maps rows and skips rows without a head`: fake response `{ value: [ {pullRequestId: 61400, title:'Ponto', createdBy:{displayName:'René'}, creationDate:'2026-11-01T00:00:00Z', sourceRefName:'refs/heads/f', targetRefName:'refs/heads/main', lastMergeSourceCommit:{commitId:'abc'}, isDraft:false, status:'active'}, {pullRequestId: 2, lastMergeSourceCommit:{}} ] }` → one row with `id 61400`, `author 'René'`, `headCommit 'abc'`, and the request URL contains `searchCriteria.status=active`.
- [ ] **Step 2:** run it → FAIL.
- [ ] **Step 3:** implement; add the method to every fake `AdoClient` in tests that typecheck against the interface.
- [ ] **Step 4:** `bun test && bun run typecheck` → pass.
- [ ] **Step 5:** `git commit -m "feat: AdoClient.listActivePullRequests"`

### Task 3: Hold mode, approve, reject, progress

**Files:**
- Modify: `src/pipeline/orchestrator.ts` (`RunPipelineOptions`), `src/prfix/types.ts`, `src/prfix/fix-pr.ts`, `src/prfix/prfix-git.ts`, `src/services/pipeline-builder.ts`
- Test: `tests/prfix/fix-pr.test.ts`, `tests/pipeline/orchestrator.test.ts`, `tests/prfix/prfix-git.test.ts`

**Interfaces:**
- Consumes: `GitLock` (Task 1) passes through unchanged.
- Produces:
  - `RunPipelineOptions.onProgress?: (stage: string, detail: string | null) => void`: called with `(name, null)` when a stage starts (after the `canRun` check passes) and `(name, detail)` on every accepted `reportProgress`.
  - `PrFixStatus` gains `'awaiting-approval'` (`ok: true`) and `'rejected'` (`ok: false`).
  - `export interface PrFixReview { preRebaseSha: string; targetSha: string; targetRefName: string; newHead: string; commitsReplayed: number; conflicts: (ConflictResolution & { diffs: { path: string; diff: string }[] })[]; renumbered: RenumberedObject[]; tests: { passed: boolean; codeunits: number } | null; rangeDiff: string; costUsd: number }`. `PrFixOutcome` gains `review?: PrFixReview` (set only for `awaiting-approval`).
  - `FixPrDeps` gains `holdBeforePush?: boolean` and `onProgress?: RunPipelineOptions['onProgress']`.
  - `PrFixPipelineDeps` gains `holdBeforePush?: boolean`: when true, `buildPrFixPipeline` omits `push-rebased` and `pr-comment`.
  - `export function buildPrFixFinishStages(deps: Pick<PrFixPipelineDeps, 'ado' | 'git' | 'keepEnv'>): Stage[]` → `[push-rebased, pr-comment]`.
  - `export async function approvePrFix(deps: FixPrDeps & { finishStages: Stage[] }): Promise<PrFixOutcome>` and `export async function rejectPrFix(deps: FixPrDeps): Promise<PrFixOutcome>`, both loading `store.load(pullRequestId)`; a missing state throws `Error('no held fix-pr state for PR <id>')`.
  - `PrFixGit.rangeDiff(path: string, base: string, oldHead: string, newHead: string): Promise<string>` → `git range-diff --no-color <base> <oldHead> <newHead>`; `PrFixGit.fileDiff(path: string, from: string, to: string, file: string): Promise<string>` → `git diff --no-color <from> <to> -- <file>`. Both capped (Global Constraints).

- [ ] **Step 1: Failing tests** (fix-pr.test.ts uses the existing fake stages/git/store):
  - `hold: green run ends awaiting-approval with a review`: stages = intake…build-and-test fakes setting `rebase`, `renumber`, `verification`; `holdBeforePush: true` → `outcome.status === 'awaiting-approval'`, `outcome.ok`, `outcome.review.rangeDiff` equals the fake's text, env deleted, `git.removeWorktree` not called, Ninja `unassign` not called.
  - `hold: red gate ends verification-failed, releases IDs, no review`.
  - `hold: up-to-date ends up-to-date, no review`.
  - `approve pushes from the saved state and removes the worktree`: saved state from the hold test; `approvePrFix` → fake push called with `expectedRemoteSha` = the saved `preRebaseSha`; status `rebased`; worktree removed; no unassign.
  - `approve after a developer push ends head-moved`: fake push throws `HeadMovedError` → status `head-moved`, IDs released (`unassign` called), worktree kept, failure comment posted.
  - `reject releases IDs and removes the worktree`: status `rejected`, `unassign` called per `used` reserved ID, `removeWorktree` called, no push.
  - orchestrator: `onProgress gets stage start and reportProgress details` → calls `[['a', null], ['a', 'half'], ['b', null]]`.
  - prfix-git (real temp repo, as the existing tests do): `rangeDiff and fileDiff return git's text and cap at 20 000 chars`.
- [ ] **Step 2:** run them → FAIL.
- [ ] **Step 3: Implement.**
  - Hold cleanup: on `awaiting-approval`, delete the env (unless `keepEnv`), keep IDs and worktree, save state. Build the review from `state.outputs` and the two new git calls; a failing diff call puts `"(diff unavailable: <message>)"` in that field instead of failing the run.
  - `approvePrFix`: set `state.currentStage = 'push-rebased'`, clear `terminalError`/`cancelled`, run `finishStages`, then the existing outcome/comment/cleanup path. Factor `fixPr`'s try/catch + `postFailureComment` + `cleanUp` into one helper both use, so the outcome rules stay in one place.
  - `rejectPrFix`: `releaseReservedIds`, `git.removeWorktree`, outcome `rejected` with `error: null`.
- [ ] **Step 4:** `bun test && bun run typecheck` → pass.
- [ ] **Step 5:** `git commit -m "feat: fix-pr hold-before-push mode with approve and reject"`

### Task 4: PR-fixer worker, store and catalog

**Files:**
- Create: `src/prfix/dashboard/store.ts`, `src/prfix/dashboard/catalog.ts`, `src/prfix/dashboard/worker.ts`
- Test: `tests/prfix/dashboard/store.test.ts`, `catalog.test.ts`, `worker.test.ts`

**Interfaces:**
- Consumes: `listActivePullRequests` (Task 2); `fixPr`/`approvePrFix`/`rejectPrFix`, `PrFixOutcome`, `PrFixReview` (Task 3).
- Produces:
  - `store.ts`: `QueueEntry { prId: number; queuedBy: string; queuedAt: string }`; `PendingApproval { prId: number; title: string; triggeredBy: string; readyAt: string; expiresAt: string; review: PrFixReview }`; `ActiveJob { prId: number; startedAt: string; triggeredBy: string; title: string }`; `HistoryLine { at: string; prId: number; title: string; triggeredBy: string; durationMs: number | null; outcome: PrFixOutcome; approvedBy?: string; rejectedBy?: string }`. `class PrFixJobStore(dir)` with `queue()/setQueue()`, `pending()/setPending()`, `active()/setActive(job | null)`, `appendHistory(line)` (keeps newest 500), `history(): HistoryLine[]` newest first. Files: `queue.json`, `pending.json`, `active.json`, `history.jsonl` in `dir` (= `<stateDir>/prfix`). Writes are write-temp-then-rename.
  - `catalog.ts`: `class PrFixCatalog(list: () => Promise<ActivePullRequest[]>, now)` with `prs`, `at`, `error`, `refresh()` (never throws; keeps the previous list on failure), `find(prId)`.
  - `worker.ts`: `createPrFixWorker(deps: PrFixWorkerDeps): PrFixWorker` where
    - `PrFixWorkerDeps { store: PrFixJobStore; catalog: PrFixCatalog; repo: string; unavailableReason: string | null; signInNeeded: () => boolean; wiRunningForPr: (prId: number) => boolean; runJob: (prId: number, onProgress: (stage: string, detail: string | null) => void) => Promise<PrFixOutcome>; approve: (prId: number) => Promise<PrFixOutcome>; reject: (prId: number) => Promise<PrFixOutcome>; cleanupInterrupted: (prId: number) => Promise<void>; ttlHours: number; logger: Logger; now: () => Date }`
    - `PrFixWorker { enqueue(prId, user): WorkerResult; unqueue(prId): WorkerResult; requestApprove(prId, user): WorkerResult; requestReject(prId, user): WorkerResult; status(): PrFixStatusView; recover(): Promise<void>; expire(): void; tick(): void; idle(): Promise<void> }`, `WorkerResult = { ok: true } | { ok: false; code: 400 | 404 | 409; error: string }`.
    - `PrFixStatusView { available: boolean; unavailableReason: string | null; repo: string; prs: Array<ActivePullRequest & { state: 'idle' | 'queued' | 'running' | 'awaiting-approval'; lastRun: HistoryLine | null }>; prsAt: string | null; prsError: string | null; queue: QueueEntry[]; pending: PendingApproval[]; activeJob: (ActiveJob & { phase: string | null; phaseDetail: string | null; phaseSince: string | null; phasesDone: string[] }) | null; waiting: 'signin' | null }`.
  - Rules: `enqueue` 409 when unavailable, queued, running, pending, not in catalog, or `wiRunningForPr`. `requestApprove`/`requestReject` 404 when not pending, else put an action at the front of an in-memory action list and `tick()`. `tick()` starts the next action if none runs and sign-in is not needed: approve/reject first, then the queue head. A job's `awaiting-approval` outcome becomes a `PendingApproval` (expiry = now + ttl); every other outcome becomes a history line. Approve/reject outcomes become history lines with `approvedBy`/`rejectedBy` and remove the pending item. After each action: `catalog.refresh()`, then `tick()` again. `recover()`: if `active.json` exists, write a history line `failed` / `interrupted (container restarted)`, call `cleanupInterrupted(prId)`, clear `active.json`. `expire()`: pending older than `expiresAt` → `reject` with `rejectedBy: 'expired'`. `idle()` resolves when no action runs.

- [ ] **Step 1: Failing tests:**
  - store: `history keeps the newest 500`; `files round-trip and survive a new instance`.
  - catalog: `refresh failure keeps the previous list and sets error`.
  - worker (fake deps, fixed clock):
    - `enqueue refuses with 409 and a reason` for each of: unavailable, already queued, running, pending, not in catalog, WI running (Review Focus 4).
    - `runs one job at a time in FIFO order`.
    - `awaiting-approval becomes pending; approve runs before the next queued job`.
    - `approve writes history with approvedBy and drops the pending item`.
    - `does not start while sign-in is needed and reports waiting signin`.
    - `recover records an interrupted job and cleans it up, leaving pending alone` (Review Focus 2 and 3).
    - `expire rejects pending past expiresAt with rejectedBy expired`.
    - `activeJob phase follows onProgress; phasesDone lists finished stages`.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** implement. `wiRunningForPr` is supplied by the wiring (Task 5), not computed here.
- [ ] **Step 4:** `bun test && bun run typecheck` → pass.
- [ ] **Step 5:** `git commit -m "feat: PR-fixer worker with queue, approvals and history"`

### Task 5: Control routes, watcher wiring, config, docs

**Files:**
- Modify: `src/server/control.ts`, `src/cli/index.ts` (`watch`), `src/services/watcher.ts` (call `worker.expire()` + `worker.tick()` each cycle; wait for `worker.idle()` before returning on abort), `src/prfix/config.ts` (`PRFIX_APPROVAL_TTL_HOURS`, positive number, default 24), `docker-compose.example.yml` (`stop_grace_period: 2m`), `README.md` (fix-pr section: "From the dashboard"), `.env.example`, `CLAUDE.md` (one paragraph under fix-pr)
- Test: `tests/server/control.test.ts`, `tests/prfix/config.test.ts`

**Interfaces:**
- Consumes: `PrFixWorker` (Task 4).
- Produces: `ControlDeps.prFix?: PrFixWorker`. Routes:
  - `GET /status` → `{ signIn, prFix: worker.status() | null }`.
  - `POST /queue` `{ repo, prId }` → 200 `{ queue }` or the worker's code + `{ error }`; `repo !== status().repo` → 400.
  - `DELETE /queue/<repo>/<prId>` → 200 or 404.
  - `POST /approve` / `POST /reject` `{ repo, prId }` → 202 / 200, or 404.
  - `GET /stats` → `{ jobs: store.history() }`.
  - Without `prFix`, all five answer 404 `{ error: 'PR fixer not configured' }`.

- [ ] **Step 1: Failing tests** in `control.test.ts`: `queue passes X-Remote-User to the worker`; `queue with another repo is 400`; `approve unknown PR is 404`; `status includes prFix`; `routes are 404 without a worker`; `body over 4 KB is rejected` (already covered by `maxRequestBodySize`; assert the existing behaviour). In `config.test.ts`: `PRFIX_APPROVAL_TTL_HOURS defaults to 24 and rejects 0`.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement.** In `watch`:
  - build one `createGitLock()` and pass it to the processor's worktree manager and the PR fixer's `PrFixGit`;
  - try `loadPrFixConfig(process.env)`; on throw, `unavailableReason` = its message;
  - otherwise `unavailableReason` = `'DRY_RUN is set'` / `'SKIP_BUILD_TEST is set: fix-pr would push an unverified rebase'` when those apply;
  - `runJob` = `fixPr({ …same deps as runFixPrCommand, holdBeforePush: true, keepEnv: false, abortFlag: deps.abortFlag, onProgress })` with `buildPrFixPipeline({ …, holdBeforePush: true })`;
  - `approve` / `reject` = `approvePrFix` / `rejectPrFix` with the same deps (`finishStages: buildPrFixFinishStages(...)`);
  - `cleanupInterrupted` deletes env `wi-<id>-pr-<id>` from the saved state's `outputs.environment` (name-checked as `cleanUp` does) and releases unpushed reserved IDs;
  - `wiRunningForPr(prId)` = any `store.listAll()` WI state with `outputs.draftPr?.id === prId`, `currentStage != null`, no `terminalError`, not `cancelled`;
  - `catalog.refresh()` every 2 minutes (setInterval, cleared when the loop ends);
  - `await worker.recover()` before the loop.
- [ ] **Step 4:** `bun test && bun run typecheck` → pass. Local smoke: `CONTROL_PORT=8099 bun run start` with `DRY_RUN=true` → `curl localhost:8099/status` shows `prFix.available: false`, reason `DRY_RUN is set`.
- [ ] **Step 5:** `git commit -m "feat: control API queues fix-pr jobs and approves held results"`
