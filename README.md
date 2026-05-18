# DevopsCoder

The fifth agent in our Azure DevOps automation suite, and the first that **writes** to the target repo. DevopsCoder picks up work items tagged `agent implement`, runs an analyzer/coder/test-author/reviewer pipeline against a per-WI git worktree, and opens a draft PR.

The repo is at the **milestone-4 stage** (Plan 3 done): orchestrator + ADO REST client + polling watcher + the first real stage, the **analyzer** (a readiness gate). `bun run start` polls ADO for work items tagged `agent implement`, fetches the full WI (description, acceptance criteria, comment history, attached image URLs) and the target repo's `.claude/skills/` catalog, then asks Claude to verdict `proceed` or `reject`. On reject, DevopsCoder posts a markdown "what's missing" comment, removes the trigger tag, and adds `need-input`; after `MAX_REJECT_CYCLES` (default 3) cumulative rejects the WI is hard-blocked (`agent-blocked` tag) and only recoverable via `reset-state`. On proceed, the pipeline currently pauses (no more stages until Plan 4). Worktree manager + coder + test-author + reviewer + draft-PR-creator land in Plans 4-5 under `docs/superpowers/plans/`.

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
  cli/             — CLI entry point
  config/          — Zod env schema + loader
  pipeline/
    stage.ts       — Stage interface, PipelinePauseError, PipelineRejectError
    orchestrator.ts — runPipeline with pause + reject + terminal-error branches
    stages/        — concrete stages (analyzer; coder/reviewer/etc. in Plans 4-5)
    agent-stage.ts, revision-loop.ts, checkpoint.ts — factories
  prompts/         — Claude system-prompt templates (analyzer.md)
  sdk/             — Azure DevOps REST client
  services/        — Claude SDK wrapper, watcher, processor, pipeline-builder,
                     wi-context fetcher, skill-loader
  state/           — Per-work-item PipelineStateStore
  types/           — Shared types
  utils/           — Logger, slugify, runPool, html helpers
tests/             — mirrors src/ layout; integration/ for cross-cutting tests
docs/
  superpowers/plans/ — implementation plans (Plan 1 done, Plan 2 done, Plan 3 done)
```

## Local setup

1. Copy `.env.example` to `.env` and fill in the Azure DevOps PAT, org, project, and `TARGET_REPO_PATH` / `WORKTREE_BASE`.
2. `bun install`
3. `bun test`

## Docker

`docker build -t devops-coder:dev .` produces an image patterned on the sibling agents — `oven/bun:1` base, non-root `claude` user, persistent volumes for `.state` and the Claude Code auth directory. The entrypoint validates `TARGET_REPO_PATH` and `WORKTREE_BASE`, generates `/app/repo-paths.json` from any extra mounts under `/repos/`, and drops to the `claude` user before starting the app.

See `PATTERNS.md` for a quick reference of the architectural patterns used.
