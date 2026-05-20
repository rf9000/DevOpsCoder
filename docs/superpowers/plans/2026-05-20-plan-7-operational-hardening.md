# Plan 7 — Operational hardening

## Context

After Plan 6 the pipeline is feature-complete and bounded: every WI has a hard cost cap, every stage has a wall-clock timeout, and SIGINT propagates cleanly. The Dockerfile and entrypoint were laid down during Plans 1–6 work and already mirror the read-only sibling agents in `C:\GeneralDev\DevOpsPullers\`. What is missing is the *operational* surface:

1. **Per-WI cost is recorded but never visible at runtime.** `state.outputs.cost.total` is set by every stage via the Plan 6 cost-tracker, but the watcher's per-WI outcome line (`WI 123: completed`) and the cycle-stats summary line both omit cost. An operator tailing `docker compose logs -f devops-coder` sees outcomes but cannot answer "what did that work item cost me?" without opening `.state/{id}.json`.
2. **No deploy artifact ships with the repo.** Sibling repos document a manual `~/teams/<team>/docker-compose.yml` + `git pull && docker compose build --no-cache && docker compose up -d` flow. DevopsCoder needs the same documentation plus an example compose snippet, calling out the three things it does differently from the read-only siblings (writable target repo, writable persistent WORKTREE_BASE, push auth wired into the host clone).

Plan 7 closes those two gaps with one small code change and two documentation deliverables. Everything else from the original "operational hardening" framing — healthchecks, structured logs, metrics endpoints, CI/CD — is explicitly deferred. The deploy model stays manual, matching the siblings.

End state after Plan 7: an operator can see per-WI spend in `docker compose logs` without leaving the terminal, and a fresh deploy onto the existing Azure VM follows a README section that mirrors the sibling pattern.

## Decisions locked

| Decision | Choice |
|---|---|
| Deploy model | Match siblings exactly: Azure VM, `~/teams/<team>/docker-compose.yml`, manual `git pull && docker compose build --no-cache && docker compose up -d`. No CI/CD, no orchestration upgrades. |
| Observability scope | Per-WI total cost only, appended to the existing per-WI outcome log line. No per-stage duration logging, no cycle-total cost in `CycleStats`, no structured JSON, no error-rate counters. |
| Cost log line shape | `WI 123: completed (cost: $0.42)` — extend the existing outcome line, do not add a second line. Cost suffix on `completed` / `paused` / `failed` / `rejected`; skipped outcomes have no cost suffix. |
| Per-stage breakdown | Stays in `state.outputs.cost.perStage` and in the cost-exhaustion WI comment rendered by `renderCostExhaustionMarkdown`. Not duplicated into logs. |
| Cost source | `state.outputs.cost?.total ?? 0` read from the final persisted state inside the processor. Missing cost (e.g., a WI that fails before any stage runs) → `costUsd: 0`. |
| Cost on `ProcessOutcome` | Add `costUsd: number` to `completed` / `paused` / `failed` / `rejected` variants. `skipped` stays unchanged — skipped lines (not-found, closed-state, aborted, cancelled) are signal lines about *why* the WI didn't process to a real outcome, not spend reports. A cancelled skip can have spent money; we surface that on the next cycle when the WI completes or fails, not on the skip line. |
| Healthcheck / restart policy | Not added. `restart: unless-stopped` is *suggested* in the example compose file as a comment, not enforced by code. No Docker HEALTHCHECK directive. |
| Structured logs / log sinks | Not added. stdout via `docker compose logs` remains the only sink. Logger interface unchanged. |
| Metrics / health endpoint | Not added. No HTTP server. |
| CI/CD | Not added. Manual deploy stays. |
| docker-compose surface | Ship `docker-compose.example.yml` at repo root. Operators copy it into `~/teams/<team>/` and adapt (or add a `devops-coder` service block to an existing team compose file alongside the read-only siblings). Repo does not ship a real `docker-compose.yml`. |
| README deploy section | New `## VM Deployment (Docker)` section mirroring `DevOpsInvestigateWorkItems/README.md`'s structure. Directory layout, initial setup, common commands, troubleshooting. Plus a "Deploying alongside read-only siblings" subsection and a push-auth note. |
| DevopsCoder-specific deploy gotchas | Three callouts: (a) `TARGET_REPO_PATH` mount must be `:rw` because git worktree writes into `.git/worktrees/`; (b) `WORKTREE_BASE` mount must be `:rw` and persistent across container restarts because a paused WI resumes against an existing worktree; (c) push auth depends on the host clone — origin URL must embed the PAT or a credential helper must be configured. |
| Required env in deploy doc | Call out `MAX_COST_USD_PER_WI` as required with no default (Plan 6 deliberate choice). Reference `.env.example` for the rest. |
| Test scope | Unit tests only — processor returns cost on each outcome kind, watcher logs the suffix on each non-skipped outcome kind. No new integration tests; existing e2e tests already cover the cost-tracker flow. |

## Architecture overview

```
processor.processWorkItem(id):
  ...existing flow (analyzer reject / cancelled / completed / paused / failed)...

  // At every return site that is NOT 'skipped':
  const costUsd = persisted?.outputs.cost?.total ?? 0;
  return { kind: '<...>', workItemId: id, costUsd, ...rest };

watcher.runPollCycle:
  for each outcome in pool:
    switch outcome.kind:
      case 'completed': logger.info(`WI ${id}: completed (cost: $${outcome.costUsd.toFixed(2)})`)
      case 'paused':    logger.info(`WI ${id}: paused at ${outcome.stage} (cost: $${outcome.costUsd.toFixed(2)})`)
      case 'failed':    logger.error(`WI ${id}: failed at ${outcome.error.stage}: ${outcome.error.message} (cost: $${outcome.costUsd.toFixed(2)})`)
      case 'rejected':  logger.info(`WI ${id}: rejected (${outcome.severity}, count=${outcome.rejectCount}, cost: $${outcome.costUsd.toFixed(2)})`)
      case 'skipped':   logger.info(`WI ${id}: skipped (${outcome.reason})`)   // unchanged
```

The processor reads cost from the **final persisted state** rather than tracking it in memory. The cost-tracker already writes through to `state.outputs.cost` on every stage transition (Plan 6), so by the time the processor returns, the latest cost is on disk. This keeps the processor stateless and avoids a parallel cost path.

`CycleStats` is untouched. The cycle-done summary line in `startWatcher` continues to read:

```
cycle done: considered=N completed=N paused=N rejected=N failed=N skipped=N
```

## File / function changes

### `src/types/index.ts`
- Extend `ProcessOutcome`: add `costUsd: number` to the `completed`, `paused`, `failed`, `rejected` variants. Leave `skipped` unchanged.

### `src/services/processor.ts`
- In `processWorkItem`, before each non-skipped return, compute `const costUsd = <state>.outputs.cost?.total ?? 0` (using whichever state reference is in scope at that return site — `state`, `final`, or `persisted`) and add `costUsd` to the returned outcome object.
- Six return sites total; four need touching:
  - **Needs `costUsd`:** completed path, paused path, catch-block failed path, `dispatchRejection`'s `'rejected'` return.
  - **No change:** cancelled-via-`final.cancelled` (returns `'skipped'`), catch-block cancelled-via-`persisted` (returns `'skipped'`), plus the early-exit `'skipped'` returns for aborted/not-found/closed-state.
- `dispatchRejection` needs `costUsd` on its return; compute it from the `state` argument it already receives.

### `src/services/watcher.ts`
- In `runPollCycle`'s switch on `outcome.kind`, change the four non-skipped log lines to include `(cost: $X.XX)`. Use `.toFixed(2)` for two-decimal cents. Leave skipped untouched.

### `src/cli/index.ts`
- No changes. The `run-wi` and `run-once` commands print outcomes as JSON; `costUsd` will appear automatically in the JSON output.

### `docker-compose.example.yml` (new)
- Single-service example named `devops-coder`. Build from `./DevOpsCoder` (matching sibling layout under `~/teams/<team>/`).
- Volumes (with inline comments explaining the `:rw` requirements):
  - `${HOME}/.claude:/home/claude/.claude` (OAuth, same as siblings)
  - `${HOME}/repos/<target-repo>:/repos/<target-repo>:rw` — note `:rw` is required; worktree creation writes into `.git/worktrees/`
  - `${HOME}/repos/.worktrees:/repos/.worktrees:rw` — persistent worktree base; survives container restarts so paused WIs can resume
  - Optional read-only dependency repo mounts (same pattern as siblings)
  - Named volume `devops-coder-state:/app/.state`
- `env_file: .env.devops-coder`
- Commented suggestion: `# restart: unless-stopped` (not enforced — matches siblings)
- Top-level `volumes:` block declaring `devops-coder-state:`

### `README.md`
- Add `## VM Deployment (Docker)` section between the existing `## Docker` short blurb and `PATTERNS.md` reference. Structure mirrors `DevOpsInvestigateWorkItems/README.md`:
  - Directory layout diagram (`~/repos/`, `~/teams/<team>/`)
  - Initial setup steps (SSH, clone, Claude Code install on host, OAuth login, env config)
  - Required + optional env vars table (cite `.env.example` rather than duplicate everything; explicitly flag `MAX_COST_USD_PER_WI` as required with no default)
  - Common commands table (`docker compose logs -f`, `docker compose restart`, `docker compose exec`, etc.)
  - Troubleshooting subsection (re-auth Claude Code, EACCES on volumes, push auth failures)
- Plus DevopsCoder-specific subsections that siblings don't need:
  - **"Deploying alongside read-only siblings"** — explains that DevopsCoder is just another service block in the same `~/teams/<team>/docker-compose.yml`, sharing the OAuth bind-mount with the existing 4 services.
  - **"Push auth"** — the draft-PR creator runs `git push origin <branch>` inside the worktree, which inherits the target repo's origin URL. The host clone (`~/repos/<target-repo>`) must have an origin URL that either embeds the PAT (`https://<pat>@dev.azure.com/...`) or be backed by a configured credential helper. Recommend the embedded-PAT pattern for simplicity; document the failure mode (push hangs waiting for credential prompt, eventually fails the stage on the timeout).
  - **"Writable target repo gotcha"** — siblings can mount `/repos/<repo>:ro`. DevopsCoder cannot. Spell out why (worktree internals).

### `.dockerignore`
- No changes needed. Already excludes `.state/`, `.env`, `.env.*.local`, `node_modules`, `.git/`.

## Testing

### `tests/services/processor.test.ts`
- Add cases that seed state with `outputs.cost = { total: 0.42, perStage: { coder: 0.40, reviewer: 0.02 } }` and assert:
  - Completed outcome has `costUsd: 0.42`
  - Failed outcome has `costUsd: 0.42`
  - Paused outcome has `costUsd: 0.42`
  - Rejected outcome (both fresh + recovery dispatch) has `costUsd: 0.42`
  - Outcome with no cost in state has `costUsd: 0` (missing-cost fallback)
  - Skipped outcome has no `costUsd` field (type-level guarantee + runtime check)

### `tests/services/watcher.test.ts`
- For each non-skipped outcome kind, assert the captured log line includes `(cost: $0.42)`.
- For skipped, assert the log line does NOT include `cost:`.
- Existing cycle-done summary assertions should continue to pass unchanged (CycleStats untouched).

### What we are NOT testing
- No integration test of the new log line in an end-to-end pipeline. The existing `tests/integration/cost-cap.test.ts` already exercises cost accumulation through to terminal failure; the per-WI log line is a thin glue layer that unit tests cover.
- No tests of `docker-compose.example.yml` or README content. They are reviewed by hand and validated at deploy time.

## Out of scope (explicit non-goals)

These were considered during brainstorming and deliberately deferred. Calling them out so they do not creep into Plan 7 implementation:

- Docker HEALTHCHECK directive
- `restart: unless-stopped` enforced anywhere (suggested in compose example as a comment only)
- Structured JSON log lines
- Log file sinks / external sinks (Loki, syslog, Application Insights, etc.)
- Per-stage duration logging (wall-clock or otherwise)
- `cycleCostUsd` field in `CycleStats`
- Cycle-total cost in the cycle-done summary line
- Rolling error/reject rate counters
- GitHub Actions workflow / any CI surface
- Prometheus `/metrics` endpoint
- HTTP `/health` endpoint
- Orchestration platforms (k8s, Nomad, Swarm, etc.)
- Centralized log shipping
- Alerting / paging

If any of these turn out to matter operationally after Plan 7 ships, they become Plan 9 candidates.
