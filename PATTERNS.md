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
