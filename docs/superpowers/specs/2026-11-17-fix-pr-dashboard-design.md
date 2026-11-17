# fix-pr from the dashboard: design

Date: 2026-11-17
Repos: DevOpsCoder (control API, job runner) and monitor-the-situation (panel, routes, roles)

## Intent

`fix-pr <prId>` (Plans 15–16) works, but it can only be started over SSH on the VM:
`docker compose run --rm devops-coder bun run src/cli/index.ts fix-pr 61400`. The owner wants
to pick a PR on the monitor dashboard, press one button, watch it run, and read the result
there. For now only the owner uses it, on their own PRs. Later the team may use it, and the
flow may change (for example a dry run before the push), so nothing here should block that.

## Goals

- The Coder card on the monitor shows a **PR fixer** panel: the active PRs of the Banking
  repo, each with its last fix-pr result, and a **Fix** button.
- Fix queues the PR. DevOpsCoder runs queued PRs one at a time, as a real run (push), in the
  long-running watcher container. No new container, no SSH.
- While a job runs, the panel shows which stage it is in (chips, as for work items).
- When it ends, the row shows the outcome: status, conflicts resolved, IDs renumbered,
  cost, error. The full `PrFixOutcome` is kept.
- Only the **admin** role sees the panel and can press Fix (see Roles).

## Non-goals

- No dry-run option on the dashboard. Fix always pushes. (The CLI keeps `--dry-run`.)
- No cancel of a running job. A queued job can be removed (unqueue).
- No "Mine" filter or author mapping. Only the admin uses it and the list is short.
- No phase 2/3 (review comments, pipeline failures). The panel shows whatever `fixPr` does.
- No change to what the `fix-pr` pipeline does (stages, push, comment, Ninja, env cleanup).
  Two additive hooks are allowed: an optional stage/progress callback on `FixPrDeps`
  (see Progress) and an optional `gitLock` (see Concurrency).
- No cost-ledger line and no `WI<id>.log` for fix-pr jobs. `fixPr` uses the PR id as the
  state id, so PR 61400 would collide with WI 61400 in the ledger, the monitor's Usage
  panel and the log name. `history.jsonl` is the record. (Decided by the designer; revisit
  when the team uses it and Usage should count it.)

## Anti-goals

- A dashboard press must never overwrite a developer push. The existing lease push
  (`--force-with-lease` against the pre-rebase head) already guarantees this; the queued
  job must not weaken it (for example by reading the head at queue time and using it later).
- A fix-pr job must not break or stall work-item processing in the same container, and a
  work item must not break a fix-pr job (see Concurrency).
- The monitor must not get an ADO token or any write path to the repo. It only forwards.
- A user without the admin role must never see the list or reach the routes (403).

## Constraints

- Follow the existing pattern: mutant-fixer and agent-tester expose `GET /status`,
  `POST /queue`, `DELETE /queue/<repo>/<prId>`, `GET /stats` on their control API, and the
  monitor reads them through `PrQueueLink` (`src/pr-queue-link.ts`) and `prQueueRoutes`
  (`src/server.ts`). Reuse that class and route helper; do not write a second copy.
- DevOpsCoder's control API (`src/server/control.ts`) already serves `GET /status`
  (`{ signIn }`) and `POST /signin` on `CONTROL_PORT` (compose: 8080), reachable only over the
  `agent-control` network. The new routes go on the same server. `/status` keeps `signIn`
  and gains the PR-fixer fields, so the existing sign-in note keeps working unchanged.
- No authentication on the control API (compose network only); the monitor checks roles
  and passes the user as `X-Remote-User`, which DevOpsCoder records as `triggeredBy`.
- Body limit stays 4 KB.
- The fix-pr config is loaded with `loadPrFixConfig`. If it fails at watcher start (for
  example `BOT_GIT_NAME` missing), the watcher still runs work items; the PR fixer reports
  itself unavailable with the config error, and `/queue` answers 409 with that error.
- While DemoPortal sign-in is needed (`demoPortal.status().needed`), queued jobs wait and
  `/status` says so, same as work items. A queued job is never failed for it.
- Dry-run watcher (`DRY_RUN`): the PR fixer is off (`/queue` 409), so a rehearsal never pushes.
- `SKIP_BUILD_TEST=true` watcher: the PR fixer is off too (unavailable reason says so),
  because without the gate it would push an unverified rebase.
- The fix-pr config comes from `loadPrFixConfig(process.env)`, built once at watcher start
  from the same environment as the watcher's own config, so `stateDir`, worktree base and
  cost cap match. Its own pins (`maxTestFixAttempts: 0`) stay as the CLI has them.

## Approach

Considered:

1. **Mirror mutant-fixer: queue + worker inside the watcher process, monitor reuses
   `PrQueueLink`.** One process, one control API, one deploy. Chosen.
2. **Monitor writes a request file, host cron runs `docker compose run … fix-pr`** (the
   "Run check now" pattern). Works without changing DevOpsCoder's process, but no live stage
   progress, no queue view, and a cron script plus request directory to maintain. Rejected:
   the owner wants to watch it run.
3. **Separate `devops-coder-prfix` service.** Isolates the job from work items, but a second
   container with the same mounts, env and DemoPortal session to keep in step. Rejected as
   heavier than the risk it removes; revisit if concurrency (below) proves fragile.

## Design

### DevOpsCoder

**PR catalog.** A new ADO client call lists active PRs of `config.repositoryName`
(`GET .../pullrequests?searchCriteria.status=active`). A catalog refreshes it on a timer
(every 2 minutes, and right after a job ends), so `/status` never calls ADO. Listed: active,
has a head commit; drafts are listed too (DevOpsCoder's own PRs are drafts). fix-pr works on
its own branch `prfix/pr-<id>` in its own worktree, so it never collides with a WI worktree
on the PR's branch. But `/queue` answers 409 while a work item whose `draftPr` is this PR
is running in the watcher, so the two never write the same remote branch at once. Each row: `prId`, `title`, `author`, `isDraft`, `sourceBranch`, `targetBranch`,
`headCommit`, `url`, `lastRun`, `state`.

**Queue and history.** Persisted under `.state/prfix/`:

- `queue.json`: `[{ prId, queuedBy, queuedAt }]`, FIFO. Queuing a PR already queued or
  running answers 409.
- `history.jsonl`: one line per finished job: `{ at, prId, title, triggeredBy, durationMs,
  outcome: PrFixOutcome }`. `lastRun` for a row is the newest line for that PR. `/stats`
  returns all lines, newest first.
- `history.jsonl` keeps the newest 500 lines (trimmed on append).
- A job running when the process stops is recorded on restart as `status: 'failed'`,
  `error: 'interrupted (container restarted)'`, and is not re-run. On that restart the
  worker also cleans up what `fixPr`'s own cleanup would have done, best-effort and logged:
  deletes the environment `wi-<prId>-pr-<prId>` and, unless the state shows the push
  happened, releases every ID in `state.outputs.renumber.reserved` (same rules as
  `releaseReservedIds`). The marker for "a job was running" is an `active.json` written at
  job start and removed at job end. The worktree and `.state/prfix/<prId>.json` stay for
  inspection as for any failed run.

**Worker.** One job at a time, started from the queue head whenever no job runs, the config
loaded, and sign-in not needed. It calls `fixPr()` with the same deps the CLI builds
(`keepEnv: false`, the watcher's `abortFlag`, `triggeredBy` logged). The job reads the PR's
head at start (`pr-intake`), never at queue time. A cost-ledger line is written as the CLI
does for a non-dry run, with `triggeredBy`, so the monitor's Usage and history pick it up.

**Progress.** `/status.activeJob = { prId, startedAt, phase, phaseDetail, phaseSince,
phasesDone }`. `phase` is the running stage name (`pr-intake`, `pr-worktree`,
`rebase-onto-target`, `renumber-collisions`, `env-provision`, `build-and-test`,
`push-rebased`, `pr-comment`). `fixPr` builds its own state and `runPipeline` call, so
`FixPrDeps` gains an optional `onProgress(stage, detail | null)`, wired to the orchestrator's
existing stage-start and `reportProgress` points. The CLI passes none.

**Concurrency with work items.** A fix-pr job and a work item can run at the same time in
one container. They share the target repo clone (`TARGET_REPO_PATH`) but use separate
worktrees. Git commands that touch the shared `.git` can collide on lock files. Requirement: every
such command — fetch, `worktree add`/`remove`, branch create/delete/update, and the overlay's
writes to `info/exclude` — in both `worktree-manager` and `PrFixGit` goes through one
process-wide async mutex (a small shared module both import), so they never run at the same
time. Commands that only touch one worktree's index and files (rebase, commit, `clean`,
`reset`, push) need no lock. The CLI paths get a no-op or their own lock; behaviour there
is unchanged. The
DemoPortal quota and the cost cap are per job, as today.

**Shutdown.** SIGTERM sets `abortFlag`; the running job aborts through it as the CLI run
would, and the watcher waits for it to settle (env delete, Ninja release) before exiting.
Docker's default 10 s grace is too short for that, so the devops-coder compose service gets
`stop_grace_period: 2m` (in DevOpsCoder's `docker-compose.example.yml`, the monitor's
`compose.snippet.yml` and the live VM compose). If the grace still runs out, the restart
cleanup above catches it.

**Control API routes** (added to `src/server/control.ts`):

- `GET /status` → `{ signIn, prFix: { available, unavailableReason, repo, prs, prsAt,
  prsError, queue, activeJob, waiting } }`. `waiting`: `'signin'` when the queue head waits
  for sign-in, else null.
- `POST /queue` `{ repo, prId }` → 200 with the queue; 409 if unavailable, already queued,
  running, or the PR is not in the catalog; 400 on a bad body.
- `DELETE /queue/<repo>/<prId>` → 200, or 404 if not queued.
- `GET /stats` → `{ jobs: [...] }` from `history.jsonl`, newest first.

`repo` is accepted for shape-compatibility with `PrQueueLink`; it must equal
`config.repositoryName` (400 otherwise).

### monitor-the-situation

- **Link.** `CoderLink` replaces today's `SignInLink` for devops-coder: a `PrQueueLink`
  subclass with a zod schema for the `/status` above (every new field `.optional()`, so an
  older DevOpsCoder without the PR fixer still parses and the sign-in note keeps working).
  `CODER_URL` stays the switch.
- **Roles.** New panel name `coder-fixpr`. Only views with it (and the `devops-coder` agent)
  get the PR fixer data in the snapshot and reach the routes; for everyone else the
  snapshot omits `prFix` entirely and the routes answer 403. The sign-in note and button
  stay gated by `signin-admin` exactly as now; the two gates are independent. The live roles file grants it only to admin, which already has `"panels": "*"`, so
  no roles-file change is needed. Deploy the monitor before naming `coder-fixpr` anywhere in
  the roles file (an older monitor rejects unknown names).
- **Routes.** `prQueueRoutes` with prefix `/api/coder`, actions `coder-fixpr-queue`,
  `coder-fixpr-unqueue` (logged to `actions.jsonl` as other actions). `/api/coder/signin`
  keeps working as now.
- **Panel.** On the Coder card, below the sign-in note:

  ```
  PR fixer
  61400  Ponto feature gate      rf   rebased · 1 conflict · 1 ID · $0.05 · 23:26   [Fix]
  61512  CSV import refactor     kj   —                                             [Fix]
  queued: 61388 (rf, 23:30)                                               [Remove]
  running: 61377 · build-and-test · 4m                        [chips: intake … comment]
  ```

  PR id links to the PR. Fix is a single click (a real push; only the admin has it).
  A failed last run shows the status and the first line of `error`, full text on hover.
  `unavailable` shows the reason instead of the list. Waiting for sign-in shows the same
  note as work items.
- **Stats/history.** The `/stats` jobs feed a "Runs" overlay like agent-tester's, if cheap;
  otherwise left out (builder's call).

## Left to the builder

- Exact zod schemas, file names inside each repo, test layout (mirror the mutant/tester code).
- The mutex implementation and which exact call sites it wraps, provided the requirement
  under Concurrency holds and is tested (two concurrent `worktree add` calls serialize).
- Catalog refresh interval within 1–5 minutes.
- Panel styling, following the mutant/tester panels.
