# DevopsCoder

The fifth agent in our Azure DevOps automation suite, and the first that **writes** to the target repo and opens draft PRs. DevopsCoder picks up work items tagged `agent implement`, runs a full analyzer → coder/reviewer → test-author → draft-PR pipeline against a per-WI git worktree, then tears down the worktree on success.

The repo is at the **milestone-11 stage** (Plans 1-8, 10-11 done): full end-to-end pipeline with cost and safety rails, operationally observable, gated by real deploy-and-test verification. After the analyzer accepts a WI, the orchestrator provisions a per-WI git worktree off a fresh `origin/main`, then runs a `revisionLoop` whose round structure differs by round: **round 1** is `coder-plan → coder → verify → reviewer`; **round 2+** is `fix-findings → verify → reviewer` — a narrower step that fixes the reviewer's findings against the stored plan and diff instead of re-planning and re-writing from scratch. `verify` deploys and tests the round's diff on the WI's Business Central environment after every round (not just at the end), so the reviewer judges code that has actually compiled; an environment problem it can't fix (nothing deployable yet, a dead environment, a CLI fault) degrades to a logged skip rather than failing the round — `build-and-test` is still the authoritative gate before any PR. The reviewer itself is real: 6 axes — safety-correctness, performance, code-structure, naming-style, security, integration — each run as an independent Claude agent via `Promise.all`, findings aggregated and deduplicated, each axis carrying its own prior findings forward round to round. If the reviewer approves, the test-author writes tests, then the draft-PR creator pushes the branch and calls `ado.createPullRequest` to open a draft PR. On success, the worktree is torn down. On any failure path the worktree is intentionally left in place for inspection. The `code-review` label is not applied — that remains a human action.

Plan 6 adds safety rails: a per-WI cumulative cost cap (`MAX_COST_USD_PER_WI`), per-stage wall-clock timeouts (11 configurable `STAGE_TIMEOUT_MS_*` env vars), and mid-stage abort propagation via `AbortSignal` threaded through `PipelineContext`. Exceeding the cost cap or a stage timeout records a `terminalError`, posts a formatted WI comment, and adds the blocked tag. An external abort (SIGINT) sets `state.cancelled` instead — resumable, no blocked tag.

### Tag lifecycle

| Outcome | Trigger tag | Other tag |
|---------|-------------|-----------|
| Completed (draft PR opened) | removed | — |
| Analyzer rejected | removed | `need-input` (or `agent-blocked` past `MAX_REJECT_CYCLES`) |
| Terminal failure (any stage) | **removed** | `agent-blocked` |
| External abort (SIGINT) | kept | — (resumes next cycle) |
| Paused | kept | — |

A blocked WI is never retried automatically: the trigger tag comes off with the blocked tag on, because polling a still-tagged failed WI re-enters the pipeline every cycle and a re-entry that reaches the revision loop costs real money. To retry, re-add the trigger tag — the run resumes at the failed stage, so a config-level fix does not re-pay for the coder. For a clean run from the top, `reset-state <id>` first.

Plan 7 makes per-WI cost operationally visible: every non-skipped watcher outcome log line now ends with `(cost: $X.XX)`, so an operator tailing `docker compose logs -f` can see spend without opening state JSON. Ships with `docker-compose.example.yml` and a full `## VM Deployment (Docker)` section below.

Plan 8 adds per-WI tool usage to the same log lines: each non-skipped outcome also reports the tools the agents invoked, e.g. `WI 123: completed (cost: $0.42, tools: Edit×5, Bash×2)`. Usage is tallied per stage (the 6 reviewer axes are merged) and persisted in `state.outputs.toolUsage`.

Plan 10 adds the **verification gate**: a per-WI Business Central environment is created via `continia.exe` right after worktree setup (it boots while the coder works; environments are never torn down — they auto-delete after ~10 days). After the test-author, a `build-and-test` stage deploys the apps this change actually needs (derived per WI from the changed files and the selected tests) and runs the test codeunits `TEST_SELECTION` picks — not the whole suite, which on a real AL repo is hundreds of sequential runs. Red compile or test results are fed back to a coder fix loop (up to `MAX_TEST_FIX_ATTEMPTS`); if still red, the pipeline fails with a WI comment listing the compile errors / failing tests and no PR is created. On green, the draft-PR description includes the environment link for manual testing. **Deployments must set `CONTINIA_API_TOKEN` (see `.env.example`) unless `SKIP_BUILD_TEST=true` (Plan 11) — config validation fails fast without it otherwise. `CONTINIA_APP_PATHS` is optional; leave it unset to let the deploy set be derived per work item.**

The BC version is derived per work item from the worktree's `app.json` `application`/`platform` fields: `env-provision` picks the lowest published DemoPortal profile that satisfies it, in the `CONTINIA_ENV_LOCALIZATION` localization. A mismatch fails at `env-provision`, before the revision loop spends anything.

Before deploying anything, `build-and-test` runs `continia deps install <envId> banking-<cc>` for the country app matching `CONTINIA_ENV_LOCALIZATION` (`base` → `banking-w1`). Since v29 only the country apps declare `Continia Finance`, so this is the only step that brings it onto the environment, and it must run before the deploy set's own dependency installs. The country app is deps-installed only — never compiled, symbol-downloaded or published.

### Where the money went

The watcher's outcome line reports the total; the line after it reports the split, so a spend spike can be read off `docker compose logs -f` without opening anything:

```
WI 77843: completed (cost: $17.36, tools: Bash×286, Edit×19, Grep×7)
WI 77843: spend — coder $8.21, reviewer $4.02 ×6, test-fixer $1.90, coder-plan $1.00, analyzer $0.13
```

Steps are the LLM call sites, not `Stage.name`s: the plan/write split bills to `coder-plan` / `coder`, each reviewer axis to `reviewer:<axis>`, the fixer nested inside `build-and-test` to `test-fixer`, and the PR-message call nested inside `draft-pr-creator` to `pr-message`. Lumping those under their stage is what makes a total unreadable — six reviewer axes and four fix rounds are exactly the spend worth seeing. On the log line, `prefix:sub` steps collapse to `prefix $sum ×N` so six near-identical reviewer entries do not crowd out everything else; the per-axis figures are kept in full in the WI log file and the ledger.

Each work item also gets **its own log file**, `logs/WI<id>.log` (`LOG_DIR`, bind-mounted in Docker). It collects every line the pipeline logged for that WI — including the per-call `agent: $0.2903 | 30 in / 4223 out | 16 turns | test-fixer (attempt 1 of 4)` lines — and appends a new `=== run <ts> ===` block on each cycle, so a resumed work item keeps the earlier cycle that banked most of its spend rather than losing it to the container's log rotation. Every run closes the file with a cost table:

```
=== outcome: completed · cost $17.3600 · 2026-09-01T07:56:40.000Z · PR !4821 https://... ===

| step | usd | calls | model | in / out | turns |
|---|---|---|---|---|---|
| coder | $8.2100 | 3 | claude-opus-5 | 412,033 / 38,120 | 96 |
| reviewer:security | $4.0200 | 1 | claude-sonnet-5 | 88,201 / 4,003 | 12 |
| test-fixer | $1.9000 | 4 | claude-sonnet-5 | 120,441 / 11,002 | 41 |
| **Total** | **$17.3600** | **14** | | | |

Tools: Bash×286, Edit×19, Grep×7
```

The same per-step breakdown — usd, calls, model and tokens — goes into the `COST_LOG_PATH` ledger, one JSONL record per finished WI, for totalling across runs. Log files and ledger are both best-effort: neither can fail a run, and dry runs write to neither.

### Pull request format

Draft PRs follow the team's PR house style, the same one the `fw-step4-pullRequest`
and `fw-create-pr` commands define for hand-made PRs — so a DevopsCoder PR reads
like any other:

- **Title and bullets** come from the **`pr-message` step**, a short read-only
  call nested in `draft-pr-creator` (`src/prompts/pr-message.md`, the automated
  port of `fw-step4-pullRequest`). It runs the same procedure the command does:
  read `git diff <base>..HEAD`, group the hunks by logical change, write one
  headline per group, then check the output against the command's validation
  list. Its context is the diff and nothing else — which is what keeps the
  description short. A stage asked to summarise its own work writes from memory
  of a long session instead, and the session leaks in ("Reviewer findings
  addressed: ...", "no compile check was possible").
- **Fallback chain** when that step is unwired or fails: the coder's own
  `prBullets`, then its prose `summary` plus the test-author's; the title falls
  back to the coder's `prTitle`, then the WI title (which states a request, not
  a change). Failures are logged and never lose a pushed branch.
- **Then** any non-blocking reviewer findings, then a `**Test Environment**`
  block — both added by the framework, not by any model.
- **Deliberately absent:** file-changed lists, per-stage agent narration, and
  any tool or agent attribution — all three are forbidden by those commands.
- **Test Environment** carries the environment name, URL, and the admin
  username/password read from `continia env users` at PR-creation time. Those
  credentials are short-lived DemoPortal sandbox logins and the PR description
  is where reviewers expect them; they are never written to a commit message,
  a work item comment, the state file, or a log line.

## Tech stack

- Bun (TypeScript)
- Zod for env validation and agent-output schemas
- `@anthropic-ai/claude-agent-sdk` for AI calls — `query()` wrapped in an injectable `AgentRunner` interface; production impl in `src/services/claude-agent-runner.ts` extracts JSON and validates against the per-stage Zod schema
- `bun:test` for tests
- Docker (`oven/bun:1`) for deployment

## Commands

| Command | Purpose |
|---------|---------|
| `bun install` | Install dependencies |
| `bun test` | Run the full test suite |
| `bun run typecheck` | TypeScript type checking |
| `bun run start` | Start the long-running watcher; polls every POLL_INTERVAL_MINUTES |
| `bun run once` | Run a single poll cycle and exit with the cycle stats as JSON |
| `bun run src/cli/index.ts run-wi <id>` | Process a single work item by ID |
| `bun run src/cli/index.ts reset-state <id>` | Delete `.state/{id}.json` + remove worktree + delete branch (`--keep-worktree` opt-out) |
| `bun run src/cli/index.ts debug-tags` | List work item IDs tagged TRIGGER_TAG |
| `bun run src/cli/index.ts debug-pr <id>` | Print the draft-PR record stored in state for a work item |

## Layout

```
src/
  cli/             — CLI entry point
  config/          — Zod env schema + loader
  pipeline/
    stage.ts       — Stage interface, PipelinePauseError, PipelineRejectError
    orchestrator.ts — runPipeline with pause + reject + terminal-error branches
    stages/        — concrete stages: analyzer, worktree-setup, env-provision, coder, reviewer, test-author, build-and-test, draft-pr-creator, worktree-teardown
    agent-stage.ts, revision-loop.ts — factories
  prompts/         — Claude system-prompt templates (analyzer.md, coder.md, test-author.md, test-fixer.md, pr-message.md, reviewer-shared.md, reviewers/*.md, draft-pr-description.md)
  sdk/             — Azure DevOps REST client
  services/        — Claude SDK wrapper, watcher, processor, pipeline-builder,
                     wi-context fetcher, skill-loader, skill-wiring, worktree-manager,
                     continia-cli
  state/           — Per-work-item PipelineStateStore
  types/           — Shared types
  utils/           — Logger, slugify, runPool, html helpers, bash-allowlist, path-escape-filter, al-test-discovery, git-auth
tests/             — mirrors src/ layout; integration/ for cross-cutting tests
docs/
  superpowers/plans/ — implementation plans (Plans 1–8, 10–11 done — milestone-11)
```

## Local setup

1. Copy `.env.example` to `.env` and fill in the Azure DevOps PAT, org, project, `ADO_REPOSITORY_NAME`, `TARGET_REPO_PATH` / `WORKTREE_BASE`, and `MAX_COST_USD_PER_WI` (required — no default; operator must consciously set this).
2. `bun install`
3. `bun test`

## VM Deployment (Docker)

DevopsCoder ships into the same Azure VM as the read-only sibling agents under `~/teams/<team-name>/`. The deploy model is manual: clone this repo onto the VM, build the Docker image with `docker compose build`, and restart the service. OAuth credentials are bind-mounted from `~/.claude` on the VM host — the same mount the sibling agents already use, so re-authentication benefits all services at once. Use `docker-compose.example.yml` (in the root of this repo) as the starting point for your `docker-compose.yml`.

### Prerequisites

- SSH access to the VM
- A Claude Code team subscription (for OAuth authentication)
- Docker and docker-compose installed on the VM host

### Directory Structure

```
~/repos/                            # Shared repos, cloned once on the host
  <target-repo>/                    # MUST be :rw (not :ro — see Writable target repo gotcha)
  .worktrees/                       # Per-WI git worktrees (DevopsCoder-specific; siblings don't need this)
~/teams/                            # Per-team service deployments
  <team-name>/
    docker-compose.yml
    .env.devops-coder
    logs/                           # Bind-mounted to /app/logs — one WI<id>.log per work item
    DevOpsCoder/                    # This repo (cloned)
```

Per-work-item logs are a bind mount rather than a named volume like `.state`, because they exist to be read: `cat ~/teams/<team-name>/logs/WI77843.log` answers what a work item did and what each step of it cost, without `docker cp` or a running container.

### Initial Setup

1. SSH into the VM:
   ```bash
   ssh -i "vm-devops-automation_key.pem" azureuser@<VM_IP>
   ```

2. Clone the target repo to the shared repos directory:
   ```bash
   mkdir -p ~/repos
   git clone <target-repo-url> ~/repos/<target-repo>
   ```
   The origin URL does not need to embed a PAT — pushes and fetches authenticate per-invocation, see [Push auth](#push-auth) below.

3. Create the worktree base directory:
   ```bash
   mkdir ~/repos/.worktrees
   ```

4. Install Claude Code CLI on the **VM host** (not inside Docker):
   ```bash
   curl -fsSL https://claude.ai/install.sh | bash
   source ~/.bashrc
   ```

5. Authenticate Claude Code. The VM has no browser, so use the interactive REPL:
   ```bash
   claude
   ```
   Inside the REPL, type `/login`, copy the URL it shows and open it in your local browser, authorize, then paste the code back into the VM terminal. Exit with `/exit`.

6. Configure `.env.devops-coder` from `.env.example`. At minimum fill in `AZURE_DEVOPS_PAT`, `AZURE_DEVOPS_ORG`, `AZURE_DEVOPS_PROJECT`, `ADO_REPOSITORY_NAME`, `TARGET_REPO_PATH`, `WORKTREE_BASE`, and `MAX_COST_USD_PER_WI` — this last variable is **required with no default**; the pipeline will refuse to start without it. The verification gate additionally requires `CONTINIA_API_TOKEN` (not `CONTINIA_ENV_PROFILE_ID` — the profile is derived per work item from `app.json`, and not `CONTINIA_APP_PATHS` — that is derived per work item too) — or set `SKIP_BUILD_TEST=true` to skip `env-provision` + `build-and-test` entirely for a first smoke bring-up (see step 10 below).

7. Copy `docker-compose.example.yml` from this repo into `~/teams/<team-name>/docker-compose.yml` and replace the `<target-repo>` placeholder with the real repo name:
   ```bash
   cp ~/teams/<team-name>/DevOpsCoder/docker-compose.example.yml ~/teams/<team-name>/docker-compose.yml
   # then edit the file to set <target-repo>
   ```

8. Copy the Linux Continia CLI binary into the repo checkout on the VM, before `docker compose build` — `.tools/` is gitignored, so this file is never in the clone, and the Dockerfile's `COPY .tools/continia-linux /usr/local/bin/continia` step fails the build without it:
   ```bash
   cp <source>/continia-linux ~/teams/<team-name>/DevOpsCoder/.tools/continia-linux
   ```
   Get the binary from the Continia CLI release share, or copy it from `ADONewDirectCombuilder/.tools/` if that repo is already checked out on the VM.

9. Provide the AL compiler for the container. `docker-compose.example.yml` bind-mounts `${HOME}/tools/al/al-ext/extension/bin:/opt/al/bin:ro`, and the image sets `CONTINIA_ALC_PATH=/opt/al/bin/linux/alc` + `CONTINIA_AUTO_INSTALL_ALC=0` so the Continia CLI uses that mount instead of its own auto-install path (broken upstream — resolves the wrong target-framework dir and extracts `alc` with the wrong file mode). Install the AL Language VS Code extension somewhere on the VM host — or copy its `bin/` directory there — so `~/tools/al/al-ext/extension/bin/linux/alc` exists before starting the container.

10. Build and probe before starting the full service:
    ```bash
    cd ~/teams/<team-name>
    docker compose build --no-cache devops-coder
    docker compose run --rm --entrypoint /usr/local/bin/continia devops-coder env list --json
    docker compose run --rm --entrypoint node devops-coder --version
    docker compose run --rm --entrypoint /opt/al/bin/linux/alc devops-coder /? | head -2
    docker compose run --rm --entrypoint bun devops-coder run once
    ```
    `--entrypoint` is required for these probes — the image's entrypoint always execs the watcher. Each command should return in seconds; a failure here (broken CLI/token, missing node runtime, bad AL-compiler mount, or a config error caught by `bun run once`) surfaces immediately instead of after tens of minutes into a real verification pass. Before running these, confirm `oven/bun:1` is still Debian-bookworm-based (the copied `node:22-bookworm-slim` binaries need matching glibc) and that the dynamic `libicu[0-9]+` apt resolution in the `Dockerfile` actually finds a package on the current base image.

11. Start the service:
    ```bash
    docker compose up -d devops-coder
    ```
    Note: `deploy.resources.limits.memory` in `docker-compose.example.yml` is a Swarm-oriented compose key — verify your installed `docker compose` version actually enforces it outside Swarm mode before relying on the 2G cap under load.

### Environment Variables

See `.env.example` in this repo for the full annotated list. Key callouts:

| Variable | Required | Default | Notes |
|----------|----------|---------|-------|
| `MAX_COST_USD_PER_WI` | **yes** | **none** | Pipeline refuses to start without this; set it consciously |
| `CONTINIA_API_TOKEN` | **yes\*** | **none** | Forwarded into the spawned continia.exe |
| `CONTINIA_ENV_PROFILE_ID` | no | **none** | Pins the DemoPortal profile, overriding derivation. Leave unset. |
| `CONTINIA_ENV_LOCALIZATION` | no | `base` | Localization of the derived profile (`base`, `dk`, `nl`, ...) |
| `CONTINIA_APP_PATHS` | no | derived | Pins the deploy set. Normally leave unset — build-and-test derives it per WI from the changed files plus the apps owning the selected tests, expanded over `app.json` dependencies and ordered dependency-first |
| `CONTINIA_CLI_PATH` | no | `.tools/continia.exe` | Relative → resolved against the worktree; set absolute if the target repo doesn't vendor the CLI |
| `CONTINIA_TEST_TIMEOUT_S` | no | 600 | Seconds passed as `--timeout` to each `continia test run` |
| `CONTINIA_ALC_PATH` | no | none | Read by the spawned Continia CLI itself (not validated by this service) — path to the AL compiler binary |
| `CONTINIA_AUTO_INSTALL_ALC` | no | none | Read by the spawned Continia CLI itself — set `0` to disable its auto-install path (broken upstream; Docker image bind-mounts `/opt/al/bin` instead) |
| `SKILLS_SOURCE_DIR` | no | none (Docker image sets `/app/.claude`) | Dir of orchestrator skills symlinked into each per-WI worktree's `.claude/`; target-repo skills win on name conflict |
| `CLAUDE_CODE_EXECUTABLE_PATH` | no | none (Docker image sets `/home/claude/.local/bin/claude`) | Forwarded to the Agent SDK as `pathToClaudeCodeExecutable`. Unset, the SDK probes for its own bundled native binary — under Bun on a glibc image it picks the `*-linux-x64-musl` package and fails |
| `SKIP_BUILD_TEST` | no | false | Skips `env-provision` + `build-and-test` entirely (6-stage chain instead of 8); when true the `CONTINIA_API_TOKEN` var marked `yes*` above becomes optional |
| `MAX_TEST_FIX_ATTEMPTS` | no | 2 | Coder fix attempts when deploy/tests are red |
| `TEST_SELECTION` | no | `related` | Which discovered test codeunits a round runs: `changed` (tests in files this run touched), `related` (those + tests referencing a changed AL object), `all`. Codeunits run strictly sequentially, so `all` on a real AL suite is hours and a guaranteed stage timeout |
| `COST_LOG_PATH` | no | `<STATE_DIR>/cost-ledger.jsonl` | Append-only JSONL spend log: one record per finished WI with `workItemId`, `outcome`, `costUsd`, `prId`, `prUrl`, and a per-step breakdown (usd, calls, model, tokens). Dry runs never write to it |
| `LOG_DIR` | no | `logs` | Directory holding one log file per work item, `WI<id>.log` — every line the pipeline logged for it, across cycles, closing with a per-step cost table. Bind-mount this in Docker. Dry runs never write to it |
| `CONTINIA_MAX_TEST_CODEUNITS` | no | 25 | Hard ceiling per round; 0 = unlimited. Dropped codeunits are logged as a WARNING — a capped green round does not mean everything passed |
| `CLAUDE_MODEL_PLANNING` | no | none | Model for both plan steps. **Setting it (or either var below) turns the plan-then-write split on**: the coder and test-author each get a read-only plan call on this model, then write on their own model. Unset → no plan step, single call per stage as before |
| `CLAUDE_MODEL_CODER_PLAN` | no | `CLAUDE_MODEL_PLANNING` | Overrides the planning model for the coder's plan step only |
| `CLAUDE_MODEL_TEST_AUTHOR_PLAN` | no | `CLAUDE_MODEL_PLANNING` | Overrides the planning model for the test-author's plan step only |
| `CLAUDE_MODEL_ANALYZER` | no | `CLAUDE_MODEL` | Readiness-gate call |
| `CLAUDE_MODEL_CODER` | no | `CLAUDE_MODEL` | The coder's write call (round 1 only, post-Plan 14 — see `CLAUDE_MODEL_FIX_FINDINGS`) |
| `CLAUDE_MODEL_FIX_FINDINGS` | no | `CLAUDE_MODEL` | Model for the fix-findings step (revision rounds 2+). This is the knob for spending more on fixing than on first-draft writing |
| `CLAUDE_MODEL_REVIEWER` | no | `CLAUDE_MODEL` | All 6 review axes. Multiplies by 6 — the single largest cost lever here |
| `CLAUDE_MODEL_TEST_AUTHOR` | no | `CLAUDE_MODEL` | The test-author's write call |
| `CLAUDE_MODEL_TEST_FIXER` | no | `CLAUDE_MODEL` | The build-and-test fix loop |
| `CLAUDE_MODEL_PR_MESSAGE` | no | `CLAUDE_MODEL` | The PR-message step nested in `draft-pr-creator`: reads the branch diff, writes the PR title and bullets. One short read-only call — a cheap model is usually right |
| `REVIEWER_MAX_TURNS` | no | 50 | Turn budget for **each** reviewer axis, not the fan-out as a whole; raise it if a run fails with "Reached maximum number of turns" (cost multiplies by six) |
| `PLAN_MAX_TURNS` | no | 30 | Turn budget for a plan call (read-only work, so well below `CODER_MAX_TURNS`) |
| `FIX_FINDINGS_MAX_TURNS` | no | `CODER_MAX_TURNS` | Turn budget for the fix-findings step |
| `MAX_INLOOP_FIX_ATTEMPTS` | no | 1 | test-fixer calls the in-loop `verify` gate may make per revision round. Deliberately smaller than `MAX_TEST_FIX_ATTEMPTS`: this budget is paid once per revision round, on top of the final `build-and-test` gate's own |
| `STAGE_TIMEOUT_MS_PLAN` | no | 600000 (10 min) | Per plan call. Added to `revision-loop` (× `MAX_REVISIONS`) and `test-author` only when that stage has a plan model |
| `STAGE_TIMEOUT_MS_ENV_PROVISION` | no | 300000 (5 min) | |
| `STAGE_TIMEOUT_MS_VERIFY_PASS` | no | 900000 (15 min) | Per deploy+test pass; sizes the derived `STAGE_TIMEOUT_MS_BUILD_AND_TEST` default and, per round, the in-loop `verify` gate folded into `revision-loop` |
| `STAGE_TIMEOUT_MS_BUILD_AND_TEST` | no | derived (105 min) | `(MAX_TEST_FIX_ATTEMPTS+1) × VERIFY_PASS + MAX_TEST_FIX_ATTEMPTS × CODER` |
| `STAGE_TIMEOUT_MS_ANALYZER` | no | 300000 (5 min) | |
| `STAGE_TIMEOUT_MS_WORKTREE_SETUP` | no | 60000 (1 min) | |
| `STAGE_TIMEOUT_MS_CODER` | no | 1800000 (30 min) | Per revision iteration; sizes the revision-loop default. Round 1 only, post-Plan 14 |
| `STAGE_TIMEOUT_MS_FIX_FINDINGS` | no | `STAGE_TIMEOUT_MS_CODER` | Wall-clock budget per fix-findings call (rounds 2+) |
| `STAGE_TIMEOUT_MS_REVIEWER` | no | 900000 (15 min) | Per revision iteration; sizes the revision-loop default |
| `STAGE_TIMEOUT_MS_REVISION_LOOP` | no | `MAX_REVISIONS × (PLAN? + max(CODER, FIX_FINDINGS) + IN-LOOP VERIFY + REVIEWER)` (135 min without a plan step or in-loop verify) | Wall-clock cap on the whole loop, now including the in-loop `verify` gate every round pays for (`(MAX_INLOOP_FIX_ATTEMPTS+1) × VERIFY_PASS + MAX_INLOOP_FIX_ATTEMPTS × CODER`, 0 when `SKIP_BUILD_TEST=true`) |
| `STAGE_TIMEOUT_MS_TEST_AUTHOR` | no | 1200000 (20 min) | |
| `STAGE_TIMEOUT_MS_DRAFT_PR_CREATOR` | no | 600000 (10 min) | Push + the nested PR-message call + the ADO calls |
| `STAGE_TIMEOUT_MS_WORKTREE_TEARDOWN` | no | 60000 (1 min) | |
| `MAX_REVISIONS` | no | 3 | Max coder/reviewer iterations per WI |
| `MAX_REJECT_CYCLES` | no | 3 | Max analyzer reject cycles before need-input lockout |
| `POLL_INTERVAL_MINUTES` | no | 5 | |
| `CONCURRENCY` | no | 1 | Max concurrent WI pipelines |

\* Required unless `SKIP_BUILD_TEST=true`, in which case these three are optional — see the `SKIP_BUILD_TEST` row above.

### Common Commands

Run these from `~/teams/<team-name>/`:

| Command | Description |
|---------|-------------|
| `docker compose logs -f devops-coder` | Follow live logs |
| `docker compose restart devops-coder` | Restart the service |
| `docker compose exec -u claude devops-coder bash` | Shell into the container |
| `docker compose exec -u claude devops-coder claude -p 'hello'` | Test Claude Code inside the container |
| `docker compose exec -u claude devops-coder bun run src/cli/index.ts reset-state <id>` | Clear state + worktree + branch for one WI |

**Use `-u claude` for operator commands.** `docker compose exec` defaults to root (the image keeps `USER root` so the entrypoint can chown mounts before dropping privileges), but everything the pipeline creates — the state files, the worktrees, the target-repo checkout — is owned by `claude`. Running `reset-state` as root makes its `git worktree remove` step fail, which leaves a stale state file and causes the next run to resume mid-pipeline instead of starting fresh. The image also sets `git config --system safe.directory '*'` so root-run git commands no longer abort with "detected dubious ownership", but `-u claude` remains the correct habit.
| `docker compose build --no-cache devops-coder && docker compose up -d devops-coder` | Full rebuild and restart |

### Deploying Service Changes

```bash
cd ~/teams/<team-name>/DevOpsCoder
git pull
cd ..
docker compose build --no-cache devops-coder
docker compose up -d devops-coder
```

### Deploying alongside read-only siblings

DevopsCoder is just an additional service block in the same `~/teams/<team-name>/docker-compose.yml` as the existing read-only agents (Investigate, CodeReviewer, etc.). They share the same `~/.claude` bind-mount for OAuth, so authenticating once on the host covers all services. Each service gets its own `.env.<service>` file and its own named state volume so there is no cross-service conflict.

### Push auth

Git pushes and fetches authenticate per-invocation with an
`http.extraHeader=Authorization: Basic base64(":"+AZURE_DEVOPS_PAT)` argument —
the PAT is never written to `.git/config`, so the target repo's origin URL
should be the plain `https://dev.azure.com/<org>/<project>/_git/<repo>` form.
A PAT embedded in the origin URL still works but is no longer needed; prefer
removing it (`git remote set-url origin <credential-free-url>`). Error
messages from failed git calls are PAT-redacted before they reach logs or
work-item comments.

### Writable target repo gotcha

Read-only sibling agents can mount `~/repos/<repo>:/repos/<repo>:ro`. DevopsCoder cannot — it must use `:rw`. When the pipeline provisions a per-WI worktree, `git worktree add` writes a pointer file into the parent repo's `.git/worktrees/` directory; a read-only mount causes that write to fail and the pipeline aborts at the worktree-setup stage.

The worktree base (`~/repos/.worktrees`) must also be `:rw` and must be backed by a persistent bind mount (not a tmpfs or anonymous volume) across container restarts. A WI paused mid-pipeline resumes against the existing worktree on the next poll cycle; if the mount is reset on restart, paused WIs fail to resume.

### Re-authenticating Claude Code

If the pipeline starts failing with "Claude Code process exited with code 1", the OAuth token may have expired. Re-authenticate on the VM host:

1. The Docker container's `claude` user takes ownership of `~/.claude/` via the bind mount, so first reclaim it:
   ```bash
   sudo chown -R azureuser:azureuser ~/.claude/
   ```

2. Launch Claude Code interactively and use `/login`:
   ```bash
   claude
   ```
   Inside the REPL, type `/login`, open the URL in your local browser, authorize, and paste the code back.

3. Exit the REPL (`/exit`) and restart the container:
   ```bash
   cd ~/teams/<team-name>
   docker compose restart devops-coder
   ```

The entrypoint runs `chown -R claude:claude /home/claude/.claude` inside the container on startup, so credentials remain accessible to both host and container.

### Troubleshooting

**"fatal: detected dubious ownership in repository at '/repos/...'"**
- You ran a git command as root via `docker compose exec` against a `claude`-owned repo. Add `-u claude`. Images built after the `safe.directory '*'` change do not hit this, but `reset-state` run as root on an older image fails at `git worktree remove` and leaves a stale state file — re-run it with `-u claude` and confirm with `docker compose exec -u claude devops-coder ls /app/.state/`.

**"Claude Code native binary not found at .../claude-agent-sdk-linux-x64-musl/claude"**
- The Agent SDK probed for its own bundled native binary and picked the musl build (Bun's libc detection on the glibc base image). Set `CLAUDE_CODE_EXECUTABLE_PATH=/home/claude/.local/bin/claude` — the image and `docker-compose.example.yml` both pin it, so this only bites an older image or a compose file that predates it. Verify with `docker compose exec devops-coder printenv CLAUDE_CODE_EXECUTABLE_PATH`.

**"Claude Code process exited with code 1" with no other details**
- Most likely an expired OAuth token. Re-authenticate on the VM host (see above).
- Run `docker compose exec devops-coder claude -p 'hello'` to test Claude Code directly inside the container.

**"--dangerously-skip-permissions cannot be used with root/sudo privileges"**
- The Agent SDK requires this flag, but Claude Code blocks it for root. The Dockerfile creates a non-root `claude` user and the entrypoint drops privileges before starting the app.

**"EACCES: permission denied, open" from the Agent SDK**
- Bind-mounted volumes retain host file ownership. The entrypoint runs `chown -R claude:claude` on mounted directories at startup.
- Also check that `HOME` is set correctly when using `su` — without a login shell, `HOME` stays as `/root`.

**Install script fails with a syntax error or installs silently fail**
- The Claude Code install script requires `bash`, not `sh`. Use `curl -fsSL https://claude.ai/install.sh | bash`.
- After install, `~/.local/bin` must be on `PATH` — run `source ~/.bashrc`.

**OAuth login doesn't accept input or times out on the VM**
- Use the interactive REPL instead of `claude auth login`: run `claude`, then type `/login` inside the REPL.
- If `~/.claude/` is owned by uid 1001 (the container's `claude` user), run `sudo chown -R azureuser:azureuser ~/.claude/` first.
- Open the auth URL in your local browser, authorize, and paste the code back into the VM terminal.

**`git push` fails or hangs, WI ends up with the blocked tag and a stage-timeout comment**
- Check that `AZURE_DEVOPS_PAT` is set and valid — pushes and fetches authenticate per-invocation via that PAT, not via the origin URL — see [Push auth](#push-auth) above.

**"git worktree add: cannot create directory ... permission denied"** / **"could not create leading directories of '.../.git': Permission denied"**
- The target repo or the worktree base is mounted `:ro`. Both must be `:rw` — see [Writable target repo gotcha](#writable-target-repo-gotcha) above.
- If both are `:rw`, it is host-uid ownership on the worktree base. The entrypoint chowns `$WORKTREE_BASE` explicitly at startup; an image built before that fix skips it, because the general `/repos/*/` chown loop does not match dot-directories like `.worktrees`. Rebuild, or fix it on the host: `sudo chown -R $(docker compose exec -T devops-coder id -u claude):$(docker compose exec -T devops-coder id -g claude) ~/repos/.worktrees`.

**Paused WI fails to resume after container restart**
- The worktree base mount (`~/repos/.worktrees`) is not persistent across restarts (e.g., it is an anonymous volume or tmpfs). Use a named bind mount so the directory survives restarts.

## See also

See `PATTERNS.md` for a quick reference of the architectural patterns used.
