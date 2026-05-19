# Patterns Reference

Quick reference for the patterns used in this repo. Each links to the source file where it's implemented.

## Zod Config Validation

**File:** `src/config/index.ts`

Env variables are validated at startup using a Zod schema. Required vars throw a descriptive `Invalid configuration:\n  - field: message` error. Optional vars use `.default(...)`. Numeric vars use `.coerce.number()`. `loadConfig()` accepts an optional `env` parameter for testing.

## Per-Work-Item State Store

**File:** `src/state/state-store.ts`

`PipelineStateStore` persists one JSON file per work item under `STATE_DIR`. `save()` updates `updatedAt` on every write. `listResumable()` filters out completed, terminal-failed, and cancelled states — used by the watcher (in a later plan) for crash recovery.

## Stage Interface

**File:** `src/pipeline/stage.ts`

A `Stage` is `{ name, canRun(state), execute(state, ctx) }`. `PipelineContext` carries the shared `config`, `logger`, `abortFlag`, and `now()` accessor. `PipelinePauseError` is the sentinel for "halt and wait for human" — distinct from a thrown `Error`, which the orchestrator records as a terminal failure.

## Pipeline Orchestrator

**File:** `src/pipeline/orchestrator.ts`

`runPipeline({ stages, state, context, store })` iterates stages in order. After each `execute()` it appends a history entry, increments `attempts[stage.name]`, and persists state via the store. `PipelinePauseError` is caught and turned into a `pause` outcome that exits cleanly — no terminal error. Other thrown errors become a terminal-error record and re-throw.

## agentStage Factory

**File:** `src/pipeline/agent-stage.ts`

Wraps a Claude SDK call into a `Stage`. The factory is parameterised by an `AgentRunner` interface (`run<T>({ prompt, schema, tools?, model? })`), keeping the Claude SDK boundary thin and tests trivial — pass a mock runner that returns the parsed shape.

## Production AgentRunner (Claude SDK wrapper)

**File:** `src/services/claude-agent-runner.ts`

`createClaudeAgentRunner({ config, logger })` returns an `AgentRunner` that calls `query()` from `@anthropic-ai/claude-agent-sdk` with `permissionMode: 'bypassPermissions'`, streams the messages, logs cost/tokens on each `result`, then runs `extractJson()` + `JSON.parse` + `schema.safeParse()` on the final text. `extractJson()` strips ` ```json ` fences and surrounding prose. `AgentOutputParseError` carries the raw model output so the caller can attach it to the work item if useful. Pattern mirrors `src/services/ai-generator.ts` in `DevOpsPullTemplate`; only the pure `extractJson` helper is unit-tested.

## revisionLoop Factory

**File:** `src/pipeline/revision-loop.ts`

Pairs a producer stage with a reviewer stage and loops up to `maxAttempts`. `isApproved(state)` is the success predicate. Optional `onExhausted` hook lets the caller post a comment / set a tag when the loop runs out of attempts.

## checkpoint Factory

**File:** `src/pipeline/checkpoint.ts`

A `Stage` whose `detect()` returns whether a human-action gate has cleared. If not cleared, throws `PipelinePauseError` to halt the pipeline; on the next run the orchestrator resumes from the same checkpoint and re-runs `detect()`.

## Logger

**File:** `src/utils/logger.ts`

`createLogger(prefix?)` returns `{ info, error }`. Every line is prefixed with an ISO-second timestamp; `error()` appends `:: <message>` if an `Error`/value is passed.

## Slug

**File:** `src/utils/slug.ts`

`slugify(input, maxLen=40)` for branch names. Lowercases, replaces non-alnum with `-`, trims hyphens, truncates and re-trims. Falls back to `'wi'` for inputs with no alphanumerics.

## Test fixtures

**Convention:** small factory functions (`makeContext`, `makeState`, `mockState`) per test file; `bun:test`'s `mock()` for stub functions; `mkdtempSync(join(tmpdir(), 'prefix-'))` for filesystem fixtures. No global mocking, no module mocking.

## ADO REST client

**File:** `src/sdk/azure-devops-client.ts`

`createAdoClient(config, fetchImpl?, retryDelaysMs?)` returns an `AdoClient` interface (queryWorkItemsByTag, getWorkItem, addTagToWorkItem, removeTagFromWorkItem, addWorkItemComment, createPullRequest). `fetchImpl` defaults to `globalThis.fetch.bind(globalThis)` so unit tests pass a mock without monkey-patching globals. Auth: `Basic <base64(":" + pat)>` per request. Retry: 5xx retries up to `retryDelaysMs.length + 1` attempts; 4xx is fatal. Tag I/O round-trips `System.Tags` (semicolon-separated string) — fetch, split, filter, PATCH back, case-insensitive matching, no-op when nothing changes. `createPullRequest` posts to the ADO Git REST API (`/_apis/git/repositories/{repositoryName}/pullrequests`) with `isDraft: true`; returns `{ id, url }`.

## Concurrency pool

**File:** `src/utils/pool.ts`

`runPool(items, n, worker)` spawns up to `n` workers that drain a shared queue. Worker errors are caught and returned in `result.errors` rather than aborting the pool. Used by the watcher to dispatch processor calls under `config.concurrency`.

## Watcher loop

**File:** `src/services/watcher.ts`

`runPollCycle(deps)` is one cycle; `startWatcher(deps)` is the long-running form. Both share an injected `AbortFlag`. `startWatcher` registers SIGINT/SIGTERM to flip the flag and uses `sleepInterruptible` to wake on shutdown rather than wait the full poll interval. Each cycle queries ADO for `triggerTag` WIs, unions with `store.listResumable()`, dedups, dispatches the union through the processor. A pipeline started in cycle N continues in cycle N+1 even if the human removed the tag in between.

## Per-WI processor

**File:** `src/services/processor.ts`

`createProcessor(deps)` returns `{ processWorkItem(id) }`. For each WI: load-or-create state → clear any stale `state.rejection` (re-entry after a previous reject cycle) → run pipeline → dispatch outcome:

- `state.rejection` set (analyzer threw `PipelineRejectError`) → increment cumulative `state.rejectCount`. Severity is `'blocked'` if `newCount >= config.maxRejectCycles` else `'reject'`. State saved BEFORE writes. Render markdown via `marked`, post as HTML. Remove `triggerTag`. Add `needInputTag` or `blockedTag` per severity. Return `'rejected'` outcome carrying severity + rejectCount.
- `state.completedAt` set → reset `rejectCount` to 0 if it was non-zero (analyzer accepted a previously-rejected WI). Remove `triggerTag`. Return `'completed'`.
- Pause → return `'paused'` (no ADO write).
- Terminal error → add `blockedTag`. Return `'failed'`.

`config.dryRun` suppresses all ADO writes on every path; state is still persisted. ADO ops in the reject dispatch are wrapped in `safeAdoOp` so one failure doesn't mask the others.

## Pipeline builder

**File:** `src/services/pipeline-builder.ts`

`buildPipeline(deps)` returns the full Plan 5 stage chain: `[analyzer, worktree-setup, revisionLoop(coder, reviewer, onExhausted), test-author, draft-pr-creator, worktree-teardown]`. On revision-loop exhaustion (`onExhausted`) the hook throws, the orchestrator records `terminalError`, and the processor catches it — posting reviewer findings as a WI comment and adding the blocked tag. On all failure paths (analyzer reject, coder/test-author error, reviewer exhaustion, draft-PR creation failure), `worktree-teardown` is intentionally NOT run; humans inspect what was left behind.

Production injection points: `runner`, `worktreeManager`, `discoveredSkills`, `analyzerPromptTemplate`, `coderPromptTemplate`, `testAuthorPromptTemplate`, `reviewerSharedPromptTemplate`, `reviewerAxisPromptTemplates`, `prDescriptionTemplate`, `pushBranch`, `getCurrentHeadSha`, `resetWorktree`, `canUseTool`. All default to real implementations; tests inject mocks so they don't hit Claude, git, or the filesystem.

## Analyzer stage (readiness gate)

**File:** `src/pipeline/stages/analyzer.ts`

Hand-rolled Stage (intentionally NOT via `agentStage` factory) because of its branching flow. Fetches WI context via `fetchWiContext`, builds a markdown user prompt with the description / AC / repro / comments / images / skills sections, calls the runner with `cwd: targetRepoPath`, `tools: [Read, Grep, Glob, Bash, Skill]`, `disallowedTools: [Edit, Write, NotebookEdit]`, `settingSources: ['project']`, `maxTurns: 20`, `systemPromptAppend: <analyzer.md>`. The Zod schema is `{ verdict: 'proceed' | 'reject', summary, reasons[], questions? }`. On `proceed` the output goes into `state.outputs.analyzer`; on `reject` the stage throws `PipelineRejectError`, which the orchestrator catches to populate `state.rejection`. Blocked escalation is the processor's concern, not the analyzer's.

## WI-context fetcher

**File:** `src/services/wi-context.ts`

`fetchWiContext(ado, workItemId)` does the rich-text plumbing: parallel `getWorkItem` + `getWorkItemComments`, strips HTML from description / repro / acceptance criteria / each comment via `stripHtmlToText`, extracts ADO attachment image URLs (across all three rich-text fields) via `extractImageUrls`, returns a `WorkItemContext` with clean plain-text fields and an `images[]` array. Missing fields fall back to empty strings; missing title falls back to `wi-{id}`. Used inline by the analyzer Stage at the top of `execute`.

## Skill loader

**File:** `src/services/skill-loader.ts`

Verbatim port from the sibling `DevOpsInvestigateWorkItems` repo. `discoverTargetRepoSkills(targetRepoPath)` scans `.claude/skills/` and returns `{ name, description, skillDir }[]`, extracting the `description` from each `SKILL.md`'s YAML frontmatter. Returns `[]` if `.claude/skills` doesn't exist (target repos without skills are perfectly valid). Skills are surfaced to the analyzer as an "Available Invocable Skills" bullet list in the user prompt — the analyzer's `Skill` tool can then invoke them.

## HTML helpers

**File:** `src/utils/html.ts`

Verbatim port (with one bug fix). `stripHtmlToText` removes `<img>` tags entirely (images surfaced separately), converts block elements to newlines, `<li>` to bullet lines, decodes entities, collapses runs of blank lines. `extractImageUrls(html, limit=5)` parses `<img>` tags and filters to URLs matching `_apis/wit/attachments/` — the ADO attachment pattern.

## Worktree manager

**File:** `src/services/worktree-manager.ts`

`createWorktreeManager({ config })` returns `{ ensureWorktree, removeWorktree }`. First non-Claude-SDK shell-out in the codebase — wraps `Bun.spawn('git', [...])`. `ensureWorktree({ workItemId, slug, persistedWorktree? })` is state-driven idempotent: if `persistedWorktree` validates on disk + git registry + branch name, reuse as-is; otherwise prune stale registry, rm orphan dir, and recreate via `git worktree add ${path} -b ${branch} origin/main`. Branch name is locked at first creation (persisted in `state.outputs.worktree.branch` over recomputed slug) so a renamed WI title doesn't spawn a second branch. `removeWorktree` is best-effort: `git worktree remove --force` + `git branch -D` + fallback `rmSync` if the path is still on disk. Thrown `WorktreeError` carries `{ command, exitCode, stdout, stderr }`.

## Worktree-setup stage

**File:** `src/pipeline/stages/worktree-setup.ts`

Thin Stage wrapping `worktreeManager.ensureWorktree`. On entry, reads `state.outputs.worktree` (if present from a prior cycle) and passes it as `persistedWorktree` so the manager can reuse-on-validate. Stores the result back in `state.outputs.worktree = { path, branch, baseSha }`. `baseSha` (the SHA of `origin/main` at creation time) is the per-attempt baseline that the coder/test-author reset to on thrown errors.

## Coder stage

**File:** `src/pipeline/stages/coder.ts`

Hand-rolled Stage (intentionally NOT via `agentStage` factory) because of retry-on-transient + baseline-reset semantics. Reads `state.outputs.analyzer` / `.wiContext` / `.worktree` (throws if any missing). Records the current HEAD SHA via `Bun.spawn('git', ['rev-parse', 'HEAD'])` at the top of `execute` as the per-attempt baseline. Calls the runner with `cwd: worktree.path`, `tools: [Read, Grep, Glob, Bash, Skill, Edit, Write]`, `disallowedTools: [NotebookEdit]`, `maxTurns: config.coderMaxTurns`, `systemPromptAppend: <coder.md>`, `canUseTool: composeCanUseTool([bashAllowlist, pathEscapeFilter])`. The bash allowlist permits `git commit`, `git add <specific-path>`, `git status`, `bun run typecheck/build/lint` and similar; denies `git push`, `git checkout`, `git reset`, `git rebase`, `git merge`, `git stash drop`, `git clean -f`, `git commit --amend`, `rm`, `cd`, `bun add`, `npm install`. The path-escape filter rejects `Edit`/`Write` calls outside the worktree. On `AgentOutputParseError`: reset worktree (`git reset --hard ${baselineSha}` + `git clean -fd`) + retry up to `MAX_TRANSIENT_RETRIES` (=2). On any other throw: reset + re-throw immediately (no retry). Output schema: `{ summary, filesChanged: string[], commits: string[] }`. Stored in `state.outputs.coder`.

## Test-author stage

**File:** `src/pipeline/stages/test-author.ts`

Same shape as the coder stage. Differences: reads `state.outputs.coder` in addition (for context on what to test); output schema uses `testFilesChanged` instead of `filesChanged`; Bash allowlist adds test-runner commands (`bun test`, `npm test`, `npx vitest`, `jest`, `pytest`, `go test`); `maxTurns: config.testAuthorMaxTurns`. Stored in `state.outputs.testAuthor`.

## Reviewer stage (real, Plan 5)

**File:** `src/pipeline/stages/reviewer.ts`

Runs 6 per-axis Claude agents in parallel via `Promise.all`. Each axis (safety-correctness, performance, code-structure, naming-style, security, integration) gets the shared reviewer head (`reviewer-shared.md`) prepended to its own axis prompt (`reviewers/<axis>.md`). All 6 agents receive the same user prompt (WI context + coder/test-author summaries + worktree path + commit range). Tools: `Read, Grep, Glob, Bash` (read-only Bash allowlist; no `Edit`/`Write`). Each axis emits `{ findings: Finding[] }`. The flat list is passed to `aggregateReviewerFindings`; `approved = !any(blocking|critical)`. Intentionally NOT retried on transient errors — the reviewer is read-only, so there is nothing to reset. A thrown per-axis error propagates from `Promise.all` to the orchestrator's terminal-failure branch. Output stored in `state.outputs.reviewer` as `{ approved, findings, attempts }`.

## aggregateReviewerFindings helper

**File:** `src/pipeline/stages/_stage-helpers.ts`

Pure function. Deduplicates a flat `Finding[]` from all 6 axes by `file:line` key (file-level findings use `file:__file__` key). Within each group: highest-severity finding's `title`, `description`, `suggestion`, `file`, `line`, and `severity` are kept verbatim; `axis` becomes a comma-separated, deduped, insertion-order list of every axis that fired on that location. Result is sorted severity-descending (`blocking` first, `nit` last). No I/O, no logging, no mutation of input objects.

## Draft-PR creator stage

**File:** `src/pipeline/stages/draft-pr-creator.ts`

`createDraftPrCreatorStage(deps)` runs after the test-author succeeds. Steps: (1) push the branch via `Bun.spawn(['git', 'push', 'origin', branch])` (injectable `pushBranch` override for tests); (2) build the PR description from the template (`draft-pr-description.md`) with `{{placeholder}}` substitutions for WI context, analyzer/coder/test-author summaries, reviewer note, branch, and base SHA; (3) call `ado.createPullRequest({ repositoryName, sourceRefName, targetRefName: 'refs/heads/main', title: '[Agent] <wi-title>', description, isDraft: true })`. Output `{ id, url, branch, createdAt }` stored in `state.outputs.draftPr`. The `code-review` label is NOT applied — human action only. Both push errors and ADO errors propagate directly to the orchestrator's terminal-failure branch.

## Worktree-teardown stage

**File:** `src/pipeline/stages/worktree-teardown.ts`

`createWorktreeTeardownStage(deps)` is the last stage in the pipeline. Calls `worktreeManager.removeWorktree` and wraps it in try/catch — cleanup is best-effort. A teardown failure is logged as a warning and swallowed; it never re-throws. If `state.outputs.worktree` is undefined (pipeline failed before worktree-setup ran), the stage returns immediately with no log. The stage only runs when all prior stages succeeded — because the orchestrator exits on any thrown error, failure paths (analyzer reject, coder/test-author error, reviewer exhaustion, draft-PR creation failure) skip teardown entirely, leaving the worktree on disk for inspection.

## Exhaustion handling (revisionLoop)

When the revision loop reaches `maxRevisions` without approval, `onExhausted` throws `Error('reviewer rejected N times — exhausted revision loop')`. The orchestrator catches this, records `state.terminalError`, and re-throws. The processor catches the throw and, if there are reviewer findings in state, renders them as grouped-by-severity markdown, converts to HTML via `marked`, and posts as a WI comment. It then adds the `blockedTag` to the work item. The worktree is intentionally retained (teardown is skipped because the pipeline threw). To start over: `bun run src/cli/index.ts reset-state <id>`.

## Bash allowlist (canUseTool)

**File:** `src/utils/bash-allowlist.ts`

`createBashAllowlist({ allow: RegExp[], deny: RegExp[] })` returns a `CanUseToolFn`. Non-Bash tool calls are unconditionally allowed (compose with `createPathEscapeFilter` for `Edit`/`Write`). For Bash: deny matches first (deny takes precedence), then allow. Anything not matching an allow pattern is denied (strict allowlist semantics). Used by the coder, test-author, and reviewer stages with role-specific patterns.

## Path-escape filter (canUseTool)

**File:** `src/utils/path-escape-filter.ts`

`createPathEscapeFilter(cwd)` returns a `CanUseToolFn` that rejects `Edit`/`Write`/`NotebookEdit` calls whose `file_path` resolves outside `cwd`. Belt-and-suspenders against a runaway agent writing to the host's DevopsCoder source or system files (the SDK's `cwd` alone doesn't enforce this — `permissionMode: 'bypassPermissions'` is set in the runner). Compose with `createBashAllowlist` via the local `composeCanUseTool` helper in the coder/test-author stages.
