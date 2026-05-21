# DevopsCoder

The fifth agent in our Azure DevOps automation suite, and the first that **writes** to the target repo and opens draft PRs. DevopsCoder picks up work items tagged `agent implement`, runs a full analyzer → coder/reviewer → test-author → draft-PR pipeline against a per-WI git worktree, then tears down the worktree on success.

The repo is at the **milestone-7 stage** (Plans 1-7 done): full end-to-end pipeline with cost and safety rails, operationally observable. After the analyzer accepts a WI, the orchestrator provisions a per-WI git worktree off a fresh `origin/main`, runs the coder inside a `revisionLoop` paired with the real parallel reviewer (6 axes: safety-correctness, performance, code-structure, naming-style, security, integration — each run as an independent Claude agent via `Promise.all`, findings aggregated and deduplicated). If the reviewer approves, the test-author writes tests, then the draft-PR creator pushes the branch and calls `ado.createPullRequest` to open a draft PR. On success, the worktree is torn down. On any failure path the worktree is intentionally left in place for inspection. The `code-review` label is not applied — that remains a human action.

Plan 6 adds safety rails: a per-WI cumulative cost cap (`MAX_COST_USD_PER_WI`), per-stage wall-clock timeouts (7 configurable `STAGE_TIMEOUT_MS_*` env vars), and mid-stage abort propagation via `AbortSignal` threaded through `PipelineContext`. Exceeding the cost cap or a stage timeout records a `terminalError`, posts a formatted WI comment, and adds the blocked tag. An external abort (SIGINT) sets `state.cancelled` instead — resumable, no blocked tag.

Plan 7 makes per-WI cost operationally visible: every non-skipped watcher outcome log line now ends with `(cost: $X.XX)`, so an operator tailing `docker compose logs -f` can see spend without opening state JSON. Ships with `docker-compose.example.yml` and a full `## VM Deployment (Docker)` section below.

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
    stages/        — concrete stages: analyzer, worktree-setup, coder, reviewer, test-author, draft-pr-creator, worktree-teardown
    agent-stage.ts, revision-loop.ts, checkpoint.ts — factories
  prompts/         — Claude system-prompt templates (analyzer.md, coder.md, test-author.md, reviewer-shared.md, reviewers/*.md, draft-pr-description.md)
  sdk/             — Azure DevOps REST client
  services/        — Claude SDK wrapper, watcher, processor, pipeline-builder,
                     wi-context fetcher, skill-loader, worktree-manager
  state/           — Per-work-item PipelineStateStore
  types/           — Shared types
  utils/           — Logger, slugify, runPool, html helpers, bash-allowlist, path-escape-filter
tests/             — mirrors src/ layout; integration/ for cross-cutting tests
docs/
  superpowers/plans/ — implementation plans (Plans 1–6 done)
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
    DevOpsCoder/                    # This repo (cloned)
```

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
   The origin URL must embed a PAT or use a credential helper so `git push` works non-interactively — see [Push auth](#push-auth) below.

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

6. Configure `.env.devops-coder` from `.env.example`. At minimum fill in `AZURE_DEVOPS_PAT`, `AZURE_DEVOPS_ORG`, `AZURE_DEVOPS_PROJECT`, `ADO_REPOSITORY_NAME`, `TARGET_REPO_PATH`, `WORKTREE_BASE`, and `MAX_COST_USD_PER_WI` — this last variable is **required with no default**; the pipeline will refuse to start without it.

7. Copy `docker-compose.example.yml` from this repo into `~/teams/<team-name>/docker-compose.yml` and replace the `<target-repo>` placeholder with the real repo name:
   ```bash
   cp ~/teams/<team-name>/DevOpsCoder/docker-compose.example.yml ~/teams/<team-name>/docker-compose.yml
   # then edit the file to set <target-repo>
   ```

8. Build and start:
   ```bash
   cd ~/teams/<team-name>
   docker compose build --no-cache devops-coder
   docker compose up -d devops-coder
   ```

### Environment Variables

See `.env.example` in this repo for the full annotated list. Key callouts:

| Variable | Required | Default | Notes |
|----------|----------|---------|-------|
| `MAX_COST_USD_PER_WI` | **yes** | **none** | Pipeline refuses to start without this; set it consciously |
| `STAGE_TIMEOUT_MS_ANALYZER` | no | 300000 (5 min) | |
| `STAGE_TIMEOUT_MS_WORKTREE_SETUP` | no | 60000 (1 min) | |
| `STAGE_TIMEOUT_MS_CODER` | no | 1800000 (30 min) | |
| `STAGE_TIMEOUT_MS_REVIEWER` | no | 900000 (15 min) | |
| `STAGE_TIMEOUT_MS_TEST_AUTHOR` | no | 1200000 (20 min) | |
| `STAGE_TIMEOUT_MS_DRAFT_PR_CREATOR` | no | 120000 (2 min) | |
| `STAGE_TIMEOUT_MS_WORKTREE_TEARDOWN` | no | 60000 (1 min) | |
| `MAX_REVISIONS` | no | 3 | Max coder/reviewer iterations per WI |
| `MAX_REJECT_CYCLES` | no | 3 | Max analyzer reject cycles before need-input lockout |
| `POLL_INTERVAL_MINUTES` | no | 5 | |
| `CONCURRENCY` | no | 1 | Max concurrent WI pipelines |

### Common Commands

Run these from `~/teams/<team-name>/`:

| Command | Description |
|---------|-------------|
| `docker compose logs -f devops-coder` | Follow live logs |
| `docker compose restart devops-coder` | Restart the service |
| `docker compose exec devops-coder bash` | Shell into the container |
| `docker compose exec devops-coder claude -p 'hello'` | Test Claude Code inside the container |
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

The draft-PR-creator stage runs `git push origin <branch>` from inside the per-WI worktree, which inherits the target repo's origin URL. The host clone at `~/repos/<target-repo>` must have an origin URL that authenticates non-interactively — either by embedding the PAT (`https://<pat>@dev.azure.com/<org>/<project>/_git/<repo>`) or by using a configured credential helper. Embedding the PAT in the URL is the simpler option and is the recommended pattern for this setup.

If push auth is not configured, `git push` will hang waiting for a credential prompt. The stage will eventually time out on `STAGE_TIMEOUT_MS_DRAFT_PR_CREATOR` (default 2 min), the WI will receive the blocked tag, and the stage-timeout comment will appear on the work item. If you see that pattern, check your origin URL first.

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
- The origin URL on `~/repos/<target-repo>` does not authenticate non-interactively. Embed the PAT in the URL or configure a credential helper — see [Push auth](#push-auth) above.

**"git worktree add: cannot create directory ... permission denied"**
- The target repo or the worktree base is mounted `:ro`. Both must be `:rw` — see [Writable target repo gotcha](#writable-target-repo-gotcha) above.

**Paused WI fails to resume after container restart**
- The worktree base mount (`~/repos/.worktrees`) is not persistent across restarts (e.g., it is an anonymous volume or tmpfs). Use a named bind mount so the directory survives restarts.

## See also

See `PATTERNS.md` for a quick reference of the architectural patterns used.
