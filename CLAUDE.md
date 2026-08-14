# CLAUDE.md

Guidance for Claude Code working in this repository.

## Project Overview

DevopsCoder is the implement-tagged work-item pipeline for our Azure DevOps automation suite. It is the first agent that writes to the target repo (branches, commits, push, draft PR). It deploys as a Docker container alongside the existing 4 read-only agents.

The repo is at the **milestone-10 stage** (Plans 1-8 + 10 done): full end-to-end pipeline with cost and safety rails, operationally observable (per-WI cost + tool usage in the watcher log lines), and a real verification gate. After the analyzer accepts a WI, the orchestrator provisions a per-WI git worktree via `worktree-manager` (state-driven idempotent reuse off fresh `origin/main`), then runs `revisionLoop(coder, reviewer)` — the coder uses Claude with `Edit`/`Write`/`Bash` against the worktree, guarded by a strict Bash allowlist + path-escape filter, with retry-on-transient and per-attempt baseline reset on error. The reviewer is now real: 6 independent Claude agents run in parallel (`Promise.all`) across axes safety-correctness, performance, code-structure, naming-style, security, and integration; findings are deduplicated by file:line and sorted severity-descending. `approved = !any(blocking|critical)`. If approved, the test-author writes tests, then the draft-PR creator pushes the branch and calls `ado.createPullRequest` to open a draft PR. On success the worktree is torn down; on failure paths the worktree is intentionally left for inspection. See `docs/superpowers/plans/2026-05-18-plan-5-reviewer-pr-teardown.md` for the Plan 5 design.

Plan 6 adds safety rails: `AgentRunner.run<T>` returns `{ value, costUsd, toolUsage }`; each LLM stage calls `tracker.add(stageName, costUsd)` to accumulate cost into `state.outputs.cost: PipelineCostInfo`; the orchestrator checks the cap before each top-level stage (`CostExceededError`) and wraps each stage in a `setTimeout` race (`StageTimeoutError`). The coder/reviewer run nested inside the top-level `revision-loop` stage, whose timeout defaults to `MAX_REVISIONS × (STAGE_TIMEOUT_MS_CODER + STAGE_TIMEOUT_MS_REVIEWER)` (pin with `STAGE_TIMEOUT_MS_REVISION_LOOP`). An `AbortSignal` is threaded through `PipelineContext.signal` per stage and forwarded to the runner and ADO client. External abort sets `state.cancelled` (resumable); cost-cap and timeout set `state.terminalError` with a formatted WI comment. See `docs/superpowers/plans/2026-05-19-plan-6-cost-safety-rails.md`.

Plan 7 ships the Docker deployment artifacts (`Dockerfile`, `docker-compose.example.yml`, README `## VM Deployment (Docker)`) and appends `(cost: $X.XX)` to the watcher's non-skipped outcome log lines. Plan 8 adds `tools: Edit×5, Bash×2` to the same lines — per-stage tool tallies (6 reviewer axes merged) accumulate in `state.outputs.toolUsage` via `createToolUsageTracker`.

Plan 10 adds the verification gate via `.tools/continia.exe` (wrapped in the injectable `ContiniaCli`, `src/services/continia-cli.ts`). `env-provision` (after worktree-setup) creates + starts a per-WI BC environment fire-and-forget — the 1-3 min boot overlaps the revision loop; environments are **never torn down** (DemoPortal auto-deletes after ~10 days) and the env URL lands in the PR description (`{{environment-id}}`/`{{environment-url}}`). `build-and-test` (after test-author) waits for Running, installs deps, discovers AL test codeunits (`Subtype = Test`), deploys each `CONTINIA_APP_PATHS` entry, and runs every test codeunit sequentially; red results feed a bounded coder fix loop (`MAX_TEST_FIX_ATTEMPTS`, prompt `test-fixer.md`, same allowlist/reset machinery as the coder). Still-red throws `VerificationFailedError` (`'verification failed'` routes the processor's comment — checked BEFORE reviewer findings). Requires `CONTINIA_ENV_PROFILE_ID`, `CONTINIA_API_TOKEN`, `CONTINIA_APP_PATHS` in env.

## Architecture

- **Runtime:** Bun (TypeScript)
- **Validation:** Zod for env config and agent output schemas
- **AI:** `@anthropic-ai/claude-agent-sdk` — `query()` is wrapped in an injectable `AgentRunner` interface (`src/pipeline/agent-stage.ts`). `AgentRunner.run<T>` returns `{ value, costUsd, toolUsage }` — cost and tool usage are first-class. The production runner (`src/services/claude-agent-runner.ts`) uses the `claude_code` system prompt preset with a JSON-only structured-output instruction appended, then validates the result against the per-stage Zod schema. Supports `cwd`, `disallowedTools`, `maxTurns`, `canUseTool`, `settingSources`, `systemPromptAppend`, `signal` for per-stage tuning.
- **Markdown:** `marked` for rendering reject-comment markdown into HTML for ADO comment posts.
- **Testing:** `bun:test`
- **State:** per-work-item JSON files under `.state/{workItemId}.json`
- **Pipeline:** stage-based orchestrator. Each stage is a `Stage` (`name`, `canRun`, `execute`). Stages signal flow via three error sentinels: `PipelinePauseError` (halt and wait), `PipelineRejectError` (analyzer says WI isn't ready — populates `state.rejection`), or a regular `Error` (terminal failure). The only stage factory is `revisionLoop`; all concrete stages are hand-rolled (each needed bespoke flow — branching, retries, or fan-out). Full 8-stage chain: `[analyzer, worktree-setup, env-provision, revisionLoop(coder, reviewer), test-author, build-and-test, draft-pr-creator, worktree-teardown]`.

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
- `src/config/` — Zod env validation (incl. `coderMaxTurns`, `testAuthorMaxTurns`, `maxCostUsdPerWi`, `stageTimeoutMs`)
- `src/pipeline/` — Stage interface + orchestrator + factories
- `src/pipeline/stages/` — analyzer, worktree-setup, env-provision, coder, reviewer, test-author, build-and-test, draft-pr-creator, worktree-teardown
- `src/prompts/` — Claude system-prompt templates (analyzer.md, coder.md, test-author.md, test-fixer.md, reviewer-shared.md, reviewers/*.md, draft-pr-description.md)
- `src/sdk/` — Azure DevOps REST client (PAT auth, retries, WIQL, tag/comment ops, createPullRequest)
- `src/services/` — Claude SDK wrapper, watcher, processor, pipeline-builder, wi-context fetcher, skill-loader, worktree-manager, continia-cli
- `src/state/` — `PipelineStateStore`
- `src/types/` — shared interfaces
- `src/utils/` — logger, slugify, runPool, html helpers, bash-allowlist, path-escape-filter, al-test-discovery
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
