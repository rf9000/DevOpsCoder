# DevopsCoder

The fifth agent in our Azure DevOps automation suite, and the first that **writes** to the target repo. DevopsCoder picks up work items tagged `agent implement`, runs an analyzer/coder/test-author/reviewer pipeline against a per-WI git worktree, and opens a draft PR.

The repo is at the **milestone-3 stage** (Plan 2 done): the orchestrator, the Azure DevOps REST client, and the polling watcher are all wired. `bun run start` connects to ADO, finds work items tagged `agent implement`, runs each through the pipeline (currently empty), removes the trigger tag on completion, and persists per-WI state under `.state/`. Real stages (analyzer, coder, test-author, reviewer, draft-pr-creator) and the worktree manager land in Plans 3-5 under `docs/superpowers/plans/`.

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
| `bun run src/cli/index.ts reset-state <id>` | Delete `.state/{id}.json` |
| `bun run src/cli/index.ts debug-tags` | List work item IDs tagged TRIGGER_TAG |

## Layout

```
src/
  cli/        — CLI entry point
  config/     — Zod env schema + loader
  pipeline/   — Stage interface, orchestrator, agentStage / revisionLoop / checkpoint factories
  services/   — Claude SDK wrapper (claude-agent-runner.ts) — production AgentRunner impl
  state/      — Per-work-item PipelineStateStore
  types/      — Shared types (AppConfig, PipelineState, ...)
  utils/      — Logger, slugify
tests/
  config/, pipeline/, services/, state/, utils/  — unit tests
  integration/                                   — end-to-end mock-stage pipeline test
docs/
  superpowers/plans/                             — implementation plans
```

## Local setup

1. Copy `.env.example` to `.env` and fill in the Azure DevOps PAT, org, project, and `TARGET_REPO_PATH` / `WORKTREE_BASE`.
2. `bun install`
3. `bun test`

## Docker

`docker build -t devops-coder:dev .` produces an image patterned on the sibling agents — `oven/bun:1` base, non-root `claude` user, persistent volumes for `.state` and the Claude Code auth directory. The entrypoint validates `TARGET_REPO_PATH` and `WORKTREE_BASE`, generates `/app/repo-paths.json` from any extra mounts under `/repos/`, and drops to the `claude` user before starting the app.

See `PATTERNS.md` for a quick reference of the architectural patterns used.
