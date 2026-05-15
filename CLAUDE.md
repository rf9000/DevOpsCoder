# CLAUDE.md

Guidance for Claude Code working in this repository.

## Project Overview

DevopsCoder is the implement-tagged work-item pipeline for our Azure DevOps automation suite. It is the first agent that writes to the target repo (branches, commits, push, draft PR). It deploys as a Docker container alongside the existing 4 read-only agents.

The repo is at the **milestone-3 stage** (Plan 2 done): orchestrator + ADO REST client + polling watcher are wired and run end-to-end on real work items. The pipeline itself is still empty — real stages (analyzer, coder, test-author, reviewer, draft-PR-creator) and the worktree manager land in Plans 3-5 (see `docs/superpowers/plans/`).

## Architecture

- **Runtime:** Bun (TypeScript)
- **Validation:** Zod for env config and agent output schemas
- **AI:** `@anthropic-ai/claude-agent-sdk` — `query()` is wrapped in an injectable `AgentRunner` interface (`src/pipeline/agent-stage.ts`). The production runner (`src/services/claude-agent-runner.ts`) instructs the model to return JSON only, extracts the JSON from the streamed `result` message, and validates it against the per-stage Zod schema before handing it to the stage's `applyOutput`. Mirrors `src/services/ai-generator.ts` from `DevOpsPullTemplate`.
- **Testing:** `bun:test`
- **State:** per-work-item JSON files under `.state/{workItemId}.json`
- **Pipeline:** stage-based orchestrator. Each stage is a `Stage` (`name`, `canRun`, `execute`). Three factories compose pipelines: `agentStage`, `revisionLoop`, `checkpoint`.

## Key patterns

- **Dependency injection** via interfaces on every external dep (logger, AgentRunner, state store, ADO client when added).
- **Per-WI state** persisted after every stage transition; a `PipelinePauseError` from a stage signals "halt and wait for human" rather than a terminal error.
- **Test fixtures** built with small factory functions (`makeContext`, `makeState`) and `bun:test`'s `mock(...)`.
- **Conventions:** `.ts` extensions in imports (`verbatimModuleSyntax: true`); `type` imports use the `type` keyword.

## Commands

- `bun test` — run all tests
- `bun run typecheck` — TypeScript type checking
- `bun run start` — start the watcher (placeholder)
- `bun run once` — single poll cycle (placeholder)

## File Layout

- `src/cli/` — CLI entry point
- `src/config/` — Zod env validation
- `src/pipeline/` — Stage interface + orchestrator + factories
- `src/sdk/` — Azure DevOps REST client (PAT auth, retries, WIQL, tag/comment ops)
- `src/services/` — Claude SDK wrapper, watcher, processor, pipeline-builder
- `src/state/` — `PipelineStateStore`
- `src/types/` — shared interfaces
- `src/utils/` — logger, slugify, runPool
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
