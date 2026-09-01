# CLAUDE.md

Guidance for Claude Code working in this repository.

## Project Overview

DevopsCoder is the implement-tagged work-item pipeline for our Azure DevOps automation suite. It is the first agent that writes to the target repo (branches, commits, push, draft PR). It deploys as a Docker container alongside the existing 4 read-only agents.

The repo is at the **milestone-11 stage** (Plans 1-8, 10-11 done): full end-to-end pipeline with cost and safety rails, operationally observable (per-WI cost + tool usage in the watcher log lines), and a real verification gate. After the analyzer accepts a WI, the orchestrator provisions a per-WI git worktree via `worktree-manager` (state-driven idempotent reuse off fresh `origin/main`), then runs `revisionLoop(coder, reviewer)` — the coder uses Claude with `Edit`/`Write`/`Bash` against the worktree, guarded by a strict Bash allowlist + path-escape filter, with retry-on-transient and per-attempt baseline reset on error. The reviewer is now real: 6 independent Claude agents run in parallel (`Promise.all`) across axes safety-correctness, performance, code-structure, naming-style, security, and integration; findings are deduplicated by file:line and sorted severity-descending. `approved = !any(blocking|critical)`. If approved, the test-author writes tests, then the draft-PR creator pushes the branch and calls `ado.createPullRequest` to open a draft PR. On success the worktree is torn down; on failure paths the worktree is intentionally left for inspection. See `docs/superpowers/plans/2026-05-18-plan-5-reviewer-pr-teardown.md` for the Plan 5 design.

Plan 6 adds safety rails: `AgentRunner.run<T>` returns `{ value, costUsd, toolUsage }`; each LLM stage calls `tracker.add(stageName, costUsd)` to accumulate cost into `state.outputs.cost: PipelineCostInfo`; the orchestrator checks the cap before each top-level stage (`CostExceededError`) and wraps each stage in a `setTimeout` race (`StageTimeoutError`). The coder/reviewer run nested inside the top-level `revision-loop` stage, whose timeout defaults to `MAX_REVISIONS × (STAGE_TIMEOUT_MS_CODER + STAGE_TIMEOUT_MS_REVIEWER)` (pin with `STAGE_TIMEOUT_MS_REVISION_LOOP`). An `AbortSignal` is threaded through `PipelineContext.signal` per stage and forwarded to the runner and ADO client. External abort sets `state.cancelled` (resumable); cost-cap and timeout set `state.terminalError` with a formatted WI comment. See `docs/superpowers/plans/2026-05-19-plan-6-cost-safety-rails.md`.

Plan 7 ships the Docker deployment artifacts (`Dockerfile`, `docker-compose.example.yml`, README `## VM Deployment (Docker)`) and appends `(cost: $X.XX)` to the watcher's non-skipped outcome log lines. Plan 8 adds `tools: Edit×5, Bash×2` to the same lines — per-stage tool tallies (6 reviewer axes merged) accumulate in `state.outputs.toolUsage` via `createToolUsageTracker`.

Plan 10 adds the verification gate via `.tools/continia.exe` (wrapped in the injectable `ContiniaCli`, `src/services/continia-cli.ts`). `env-provision` (after worktree-setup) creates + starts a per-WI BC environment fire-and-forget — the 1-3 min boot overlaps the revision loop; environments are **never torn down** (DemoPortal auto-deletes after ~10 days) and the env URL lands in the PR description (`{{environment-id}}`/`{{environment-url}}`). `build-and-test` (after test-author) waits for Running, installs deps, discovers AL test codeunits (`Subtype = Test`), deploys each `CONTINIA_APP_PATHS` entry, and runs every test codeunit sequentially; red results feed a bounded coder fix loop (`MAX_TEST_FIX_ATTEMPTS`, prompt `test-fixer.md`, same allowlist/reset machinery as the coder). Still-red throws `VerificationFailedError` (`'verification failed'` routes the processor's comment — checked BEFORE reviewer findings). Requires `CONTINIA_ENV_PROFILE_ID`, `CONTINIA_API_TOKEN`, `CONTINIA_APP_PATHS` in env (required unless `SKIP_BUILD_TEST=true` — see Plan 11).

Plan 11 hardens the verification gate against sibling-repo drift and adds WI-linked, Docker-deployable PRs. The deploy invocation is `continia deploy <envId> <absolute app dir> --allow-downgrade --json` from the worktree root — naming one app path is what scopes the run (deploy discovers siblings but builds only the app named), `--allow-downgrade` tolerates a lower-versioned reinstall, and `--with-deps` is deliberately NOT passed (it would recompile dependency apps unnecessarily). `--workspace-root` is deliberately NOT passed either: the CLI resolves the positional app path *against* workspace-root rather than cwd, so passing the same relative path in both slots joined it onto itself (`permission-sets/permission-sets` -> "No app.json found"), and scoping discovery to one app also hides the siblings the unpublished-dependency gate needs to see (see `.claude/skills/continia-deploy`). The app dir is passed absolute so the call does not depend on cwd. The Continia activation app (GUID `c3755ece-dab0-4d16-987d-040661f18522`) is auto-installed on the environment via `deps install-by-id` before any deploy; deps-install skip/symbol-gap counts (`DepsInstallInfo`) are logged as warnings rather than silently swallowed. Test-result parsing now uses a strict Zod schema — malformed CLI JSON throws instead of green-washing a run. `CONTINIA_TEST_TIMEOUT_S` (default 600) is passed as `--timeout` to each `continia test run`. Draft PRs are now linked to their work item via `workItemRefs`, and the description is capped at `MAX_PR_DESCRIPTION_LENGTH` (4000 chars — ADO rejects longer descriptions with a 400) with the `## Test environment` section preserved and a truncation notice on earlier sections; `createdAt` comes from an injected clock and the abort signal is threaded through. Git auth is now per-invocation: `src/utils/git-auth.ts` builds an `http.extraHeader=Authorization: Basic ...` arg from the PAT for every fetch/push (never written to `.git/config`, so the origin URL should be credential-free) and redacts the PAT out of any git error text before it reaches logs or WI comments; pushes use `--force-with-lease`. `src/services/skill-wiring.ts` symlinks (junction, directories only, no-clobber) an orchestrator-owned skills tree into each worktree's `.claude/` when `SKILLS_SOURCE_DIR` is set, and skill advertisement merges target-repo + orchestrator skills with the target repo winning on name conflicts. `SKIP_BUILD_TEST` (default false) bypasses `env-provision` and `build-and-test` entirely for harness smoke runs, making the three `CONTINIA_*` verification vars optional. Docker changes: the Linux `continia` CLI binary is baked onto `PATH`, `/opt/al/bin` is bind-mounted read-only for the AL compiler, and `CONTINIA_AUTO_INSTALL_ALC=0` disables the CLI's own (broken) compiler auto-install in favor of that mount.

## Architecture

- **Runtime:** Bun (TypeScript)
- **Validation:** Zod for env config and agent output schemas
- **AI:** `@anthropic-ai/claude-agent-sdk` — `query()` is wrapped in an injectable `AgentRunner` interface (`src/pipeline/agent-stage.ts`). `AgentRunner.run<T>` returns `{ value, costUsd, toolUsage }` — cost and tool usage are first-class. The production runner (`src/services/claude-agent-runner.ts`) uses the `claude_code` system prompt preset with a JSON-only structured-output instruction appended, then validates the result against the per-stage Zod schema. Supports `cwd`, `disallowedTools`, `maxTurns`, `canUseTool`, `settingSources`, `systemPromptAppend`, `signal` for per-stage tuning.
- **Markdown:** `marked` for rendering reject-comment markdown into HTML for ADO comment posts.
- **Testing:** `bun:test`
- **State:** per-work-item JSON files under `.state/{workItemId}.json`
- **Pipeline:** stage-based orchestrator. Each stage is a `Stage` (`name`, `canRun`, `execute`). Stages signal flow via three error sentinels: `PipelinePauseError` (halt and wait), `PipelineRejectError` (analyzer says WI isn't ready — populates `state.rejection`), or a regular `Error` (terminal failure). The only stage factory is `revisionLoop`; all concrete stages are hand-rolled (each needed bespoke flow — branching, retries, or fan-out). Full 8-stage chain (6 when `SKIP_BUILD_TEST=true`, which drops `env-provision` and `build-and-test`): `[analyzer, worktree-setup, env-provision, revisionLoop(coder, reviewer), test-author, build-and-test, draft-pr-creator, worktree-teardown]`.

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
- `src/services/` — Claude SDK wrapper, watcher, processor, pipeline-builder, wi-context fetcher, skill-loader, skill-wiring, worktree-manager, continia-cli
- `src/state/` — `PipelineStateStore`
- `src/types/` — shared interfaces
- `src/utils/` — logger, slugify, runPool, html helpers, bash-allowlist, path-escape-filter, al-test-discovery, git-auth
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
