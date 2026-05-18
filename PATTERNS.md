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

`createAdoClient(config, fetchImpl?, retryDelaysMs?)` returns an `AdoClient` interface (queryWorkItemsByTag, getWorkItem, addTagToWorkItem, removeTagFromWorkItem, addWorkItemComment). `fetchImpl` defaults to `globalThis.fetch.bind(globalThis)` so unit tests pass a mock without monkey-patching globals. Auth: `Basic <base64(":" + pat)>` per request. Retry: 5xx retries up to `retryDelaysMs.length + 1` attempts; 4xx is fatal. Tag I/O round-trips `System.Tags` (semicolon-separated string) — fetch, split, filter, PATCH back, case-insensitive matching, no-op when nothing changes.

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

`buildPipeline(deps)` returns the `Stage[]` for one WI. Plan 3 returns `[analyzer]`; Plans 4-5 will append `[..., worktreeSetup, coder, revisionLoop(coder, reviewer), testAuthor, draftPrCreator, worktreeTeardown]`. Production calls use defaults (real `createClaudeAgentRunner`, real `discoverTargetRepoSkills`, `readFileSync('src/prompts/analyzer.md')`); tests override `runner` / `discoveredSkills` / `analyzerPromptTemplate` so they don't hit Claude or the filesystem.

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
