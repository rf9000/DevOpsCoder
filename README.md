# DevopsCoder

The fifth agent in our Azure DevOps automation suite, and the first that **writes** to the target repo. DevopsCoder picks up work items tagged `agent implement`, runs an analyzer/coder/test-author/reviewer pipeline against a per-WI git worktree, and opens a draft PR.

The repo is at the **milestone-5 stage** (Plan 4 done): the pipeline now writes to the target repo. After the analyzer accepts a WI, the orchestrator provisions a per-WI git worktree off a fresh `origin/main`, runs the coder (Claude with full edit tooling + strict Bash allowlist + path-escape filter) inside a `revisionLoop` (Plan 4 stubs the reviewer to always-approve; Plan 5 swaps in the real parallel-fanout reviewer), and then runs the test-author to add tests for the work. Both stages have retry-on-transient + baseline-reset semantics so a mid-cycle crash doesn't leave a dirty worktree. The pipeline still does not push or open a PR — that lands in Plan 5 along with the real reviewer and worktree teardown.

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

## Layout

```
src/
  cli/             — CLI entry point
  config/          — Zod env schema + loader
  pipeline/
    stage.ts       — Stage interface, PipelinePauseError, PipelineRejectError
    orchestrator.ts — runPipeline with pause + reject + terminal-error branches
    stages/        — concrete stages: analyzer, worktree-setup, coder, reviewer (stub), test-author
    agent-stage.ts, revision-loop.ts, checkpoint.ts — factories
  prompts/         — Claude system-prompt templates (analyzer.md, coder.md, test-author.md)
  sdk/             — Azure DevOps REST client
  services/        — Claude SDK wrapper, watcher, processor, pipeline-builder,
                     wi-context fetcher, skill-loader, worktree-manager
  state/           — Per-work-item PipelineStateStore
  types/           — Shared types
  utils/           — Logger, slugify, runPool, html helpers, bash-allowlist, path-escape-filter
tests/             — mirrors src/ layout; integration/ for cross-cutting tests
docs/
  superpowers/plans/ — implementation plans (Plan 1 done, Plan 2 done, Plan 3 done, Plan 4 done)
```

## Local setup

1. Copy `.env.example` to `.env` and fill in the Azure DevOps PAT, org, project, and `TARGET_REPO_PATH` / `WORKTREE_BASE`.
2. `bun install`
3. `bun test`

## Docker

`docker build -t devops-coder:dev .` produces an image patterned on the sibling agents — `oven/bun:1` base, non-root `claude` user, persistent volumes for `.state` and the Claude Code auth directory. The entrypoint validates `TARGET_REPO_PATH` and `WORKTREE_BASE`, generates `/app/repo-paths.json` from any extra mounts under `/repos/`, and drops to the `claude` user before starting the app.

See `PATTERNS.md` for a quick reference of the architectural patterns used.
