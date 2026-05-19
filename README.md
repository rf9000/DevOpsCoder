# DevopsCoder

The fifth agent in our Azure DevOps automation suite, and the first that **writes** to the target repo and opens draft PRs. DevopsCoder picks up work items tagged `agent implement`, runs a full analyzer → coder/reviewer → test-author → draft-PR pipeline against a per-WI git worktree, then tears down the worktree on success.

The repo is at the **milestone-7 stage** (Plans 1-6 done): full end-to-end pipeline with cost and safety rails. After the analyzer accepts a WI, the orchestrator provisions a per-WI git worktree off a fresh `origin/main`, runs the coder inside a `revisionLoop` paired with the real parallel reviewer (6 axes: safety-correctness, performance, code-structure, naming-style, security, integration — each run as an independent Claude agent via `Promise.all`, findings aggregated and deduplicated). If the reviewer approves, the test-author writes tests, then the draft-PR creator pushes the branch and calls `ado.createPullRequest` to open a draft PR. On success, the worktree is torn down. On any failure path the worktree is intentionally left in place for inspection. The `code-review` label is not applied — that remains a human action.

Plan 6 adds safety rails: a per-WI cumulative cost cap (`MAX_COST_USD_PER_WI`), per-stage wall-clock timeouts (7 configurable `STAGE_TIMEOUT_MS_*` env vars), and mid-stage abort propagation via `AbortSignal` threaded through `PipelineContext`. Exceeding the cost cap or a stage timeout records a `terminalError`, posts a formatted WI comment, and adds the blocked tag. An external abort (SIGINT) sets `state.cancelled` instead — resumable, no blocked tag.

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

## Docker

`docker build -t devops-coder:dev .` produces an image patterned on the sibling agents — `oven/bun:1` base, non-root `claude` user, persistent volumes for `.state` and the Claude Code auth directory. The entrypoint validates `TARGET_REPO_PATH` and `WORKTREE_BASE`, generates `/app/repo-paths.json` from any extra mounts under `/repos/`, and drops to the `claude` user before starting the app.

See `PATTERNS.md` for a quick reference of the architectural patterns used.
