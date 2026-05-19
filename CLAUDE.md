# CLAUDE.md

Guidance for Claude Code working in this repository.

## Project Overview

DevopsCoder is the implement-tagged work-item pipeline for our Azure DevOps automation suite. It is the first agent that writes to the target repo (branches, commits, push, draft PR). It deploys as a Docker container alongside the existing 4 read-only agents.

The repo is at the **milestone-6 stage** (Plan 5 done): full end-to-end pipeline. After the analyzer accepts a WI, the orchestrator provisions a per-WI git worktree via `worktree-manager` (state-driven idempotent reuse off fresh `origin/main`), then runs `revisionLoop(coder, reviewer)` — the coder uses Claude with `Edit`/`Write`/`Bash` against the worktree, guarded by a strict Bash allowlist + path-escape filter, with retry-on-transient and per-attempt baseline reset on error. The reviewer is now real: 6 independent Claude agents run in parallel (`Promise.all`) across axes safety-correctness, performance, code-structure, naming-style, security, and integration; findings are deduplicated by file:line and sorted severity-descending. `approved = !any(blocking|critical)`. If approved, the test-author writes tests, then the draft-PR creator pushes the branch and calls `ado.createPullRequest` to open a draft PR. On success the worktree is torn down; on failure paths the worktree is intentionally left for inspection. See `docs/superpowers/plans/2026-05-18-plan-5-reviewer-pr-teardown.md` for the Plan 5 design.

## Architecture

- **Runtime:** Bun (TypeScript)
- **Validation:** Zod for env config and agent output schemas
- **AI:** `@anthropic-ai/claude-agent-sdk` — `query()` is wrapped in an injectable `AgentRunner` interface (`src/pipeline/agent-stage.ts`). The production runner (`src/services/claude-agent-runner.ts`) uses the `claude_code` system prompt preset with a JSON-only structured-output instruction appended, then validates the result against the per-stage Zod schema. Supports `cwd`, `disallowedTools`, `maxTurns`, `canUseTool`, `settingSources`, `systemPromptAppend` for per-stage tuning.
- **Markdown:** `marked` for rendering reject-comment markdown into HTML for ADO comment posts.
- **Testing:** `bun:test`
- **State:** per-work-item JSON files under `.state/{workItemId}.json`
- **Pipeline:** stage-based orchestrator. Each stage is a `Stage` (`name`, `canRun`, `execute`). Stages signal flow via three error sentinels: `PipelinePauseError` (halt and wait), `PipelineRejectError` (analyzer says WI isn't ready — populates `state.rejection`), or a regular `Error` (terminal failure). Factories: `agentStage`, `revisionLoop`, `checkpoint` — but stages with branching flow (like `analyzer`) are hand-rolled. Full 6-stage chain: `[analyzer, worktree-setup, revisionLoop(coder, reviewer), test-author, draft-pr-creator, worktree-teardown]`.

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
- `bun run src/cli/index.ts debug-pr <id>` — print the draft-PR record stored in state for a WI

## File Layout

- `src/cli/` — CLI entry point (+ `--keep-worktree` flag for `reset-state`)
- `src/config/` — Zod env validation (incl. `coderMaxTurns`, `testAuthorMaxTurns`)
- `src/pipeline/` — Stage interface + orchestrator + factories
- `src/pipeline/stages/` — analyzer, worktree-setup, coder, reviewer, test-author, draft-pr-creator, worktree-teardown
- `src/prompts/` — Claude system-prompt templates (analyzer.md, coder.md, test-author.md, reviewer-shared.md, reviewers/*.md, draft-pr-description.md)
- `src/sdk/` — Azure DevOps REST client (PAT auth, retries, WIQL, tag/comment ops, createPullRequest)
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
`C:\GeneralDev\DevOpsPullers\DevOpsCodeReviewer` — reference for parallel-subagent review fan-out patterns (the reviewer stage follows the same 6-axis Promise.all approach).
