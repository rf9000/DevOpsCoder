# CLAUDE.md

Guidance for Claude Code working in this repository.

## Project Overview

DevopsCoder is the implement-tagged work-item pipeline for our Azure DevOps automation suite. It is the first agent that writes to the target repo (branches, commits, push, draft PR). It deploys as a Docker container alongside the existing 4 read-only agents.

The repo is at the **milestone-5 stage** (Plan 4 done): full write-side pipeline. After the analyzer accepts a WI, the orchestrator provisions a per-WI git worktree via `worktree-manager` (state-driven idempotent reuse off fresh `origin/main`), then runs `revisionLoop(coder, reviewer-stub)` — the coder uses Claude with `Edit`/`Write`/`Bash` against the worktree, guarded by a strict Bash allowlist + path-escape filter, with retry-on-transient and per-attempt baseline reset on error. The reviewer is a Plan 4 stub that always approves (Plan 5 will replace the body in-place — file name and factory name are stable). Test-author follows the same pattern with a test-runner allowlist. Both stages emit structured Zod-validated JSON. The pipeline still does not push or open a PR — Plan 5 adds the real reviewer, draft-PR creator, and worktree teardown.

## Architecture

- **Runtime:** Bun (TypeScript)
- **Validation:** Zod for env config and agent output schemas
- **AI:** `@anthropic-ai/claude-agent-sdk` — `query()` is wrapped in an injectable `AgentRunner` interface (`src/pipeline/agent-stage.ts`). The production runner (`src/services/claude-agent-runner.ts`) uses the `claude_code` system prompt preset with a JSON-only structured-output instruction appended, then validates the result against the per-stage Zod schema. Supports `cwd`, `disallowedTools`, `maxTurns`, `canUseTool`, `settingSources`, `systemPromptAppend` for per-stage tuning.
- **Markdown:** `marked` for rendering reject-comment markdown into HTML for ADO comment posts.
- **Testing:** `bun:test`
- **State:** per-work-item JSON files under `.state/{workItemId}.json`
- **Pipeline:** stage-based orchestrator. Each stage is a `Stage` (`name`, `canRun`, `execute`). Stages signal flow via three error sentinels: `PipelinePauseError` (halt and wait), `PipelineRejectError` (analyzer says WI isn't ready — populates `state.rejection`), or a regular `Error` (terminal failure). Factories: `agentStage`, `revisionLoop`, `checkpoint` — but stages with branching flow (like `analyzer`) are hand-rolled.

## Key patterns

- **Dependency injection** via interfaces on every external dep (logger, AgentRunner, state store, ADO client when added).
- **Per-WI state** persisted after every stage transition; a `PipelinePauseError` from a stage signals "halt and wait for human" rather than a terminal error.
- **Test fixtures** built with small factory functions (`makeContext`, `makeState`) and `bun:test`'s `mock(...)`.
- **Conventions:** `.ts` extensions in imports (`verbatimModuleSyntax: true`); `type` imports use the `type` keyword.

## Commands

- `bun test` — run all tests
- `bun run typecheck` — TypeScript type checking
- `bun run start` — start the long-running watcher
- `bun run once` — single poll cycle, prints cycle stats as JSON
- `bun run src/cli/index.ts run-wi <id>` — process one work item by ID
- `bun run src/cli/index.ts reset-state <id>` — delete `.state/{id}.json`
- `bun run src/cli/index.ts debug-tags` — list WI IDs tagged with `TRIGGER_TAG`

## File Layout

- `src/cli/` — CLI entry point (+ `--keep-worktree` flag for `reset-state`)
- `src/config/` — Zod env validation (incl. `coderMaxTurns`, `testAuthorMaxTurns`)
- `src/pipeline/` — Stage interface + orchestrator + factories
- `src/pipeline/stages/` — analyzer, worktree-setup, coder, reviewer (stub), test-author
- `src/prompts/` — Claude system-prompt templates (analyzer.md, coder.md, test-author.md)
- `src/sdk/` — Azure DevOps REST client (PAT auth, retries, WIQL, tag/comment ops)
- `src/services/` — Claude SDK wrapper, watcher, processor, pipeline-builder, wi-context fetcher, skill-loader, worktree-manager
- `src/state/` — `PipelineStateStore`
- `src/types/` — shared interfaces
- `src/utils/` — logger, slugify, runPool, html helpers, bash-allowlist, path-escape-filter
- `tests/` — mirrors `src/` layout; `tests/integration/` for cross-cutting tests

## Out of scope (do not introduce)

- Plan-stage / human plan-approval gate
- Self-research analyzer mode
- Multi-target-repo support
- Migration of the existing 4 agents
- Test-suggestion functionality (lives in the separate `DevopsTestSuggester` repo)

## Sibling references

`C:\GeneralDev\DevOpsPullers\DevOpsInvestigateWorkItems` — closest sibling. Mirror its file layout and patterns. Reimplement, don't import.
`C:\GeneralDev\DevOpsPullers\DevOpsCodeReviewer` — for the parallel-subagent review fan-out (used by the reviewer stage in a later plan).
