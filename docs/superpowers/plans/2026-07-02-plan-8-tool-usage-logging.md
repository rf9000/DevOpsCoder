# Plan 8 — Per-WI tool usage in outcome logs

## Context

Plan 7 made per-WI cost visible in the watcher's outcome log lines (`WI 123: completed (cost: $0.42)`). An operator tailing `docker compose logs -f devops-coder` can now answer "what did that WI cost?" but still cannot answer "what did the agent actually *do*?" — which tools (`Edit`, `Write`, `Bash`, etc.) the coder/analyzer/reviewer/test-author stages invoked, and how many times each.

`claude-agent-runner.ts` already iterates every SDK message for a `query()` call to extract `total_cost_usd` off `type: 'result'` messages. It never inspects `type: 'assistant'` messages, so tool-call data that flows through the SDK today is discarded. Plan 8 captures it and threads it through the same pipeline that Plan 6/7 built for cost: `AgentRunner.run<T>` → per-stage tracker → `state.outputs` → `ProcessOutcome` → watcher log line.

End state after Plan 8: `WI 123: completed (cost: $0.42, tools: Edit×5, Bash×2, Write×1)`.

## Decisions locked

| Decision | Choice |
|---|---|
| Granularity | Aggregated per WI, appended to the existing per-WI outcome log line. No cycle-level rollup, no per-stage breakdown in logs (matches the Plan 7 precedent of total-only, not per-stage, in logs). |
| Data source | `BetaMessage.content` blocks of type `tool_use` on `type: 'assistant'` SDK messages, tallied by `.name`. Never resets on retry — tool calls from every coder/reviewer revision-loop attempt count, same monotonic-accumulation rule as cost. |
| Storage shape | `state.outputs.toolUsage: Record<string, number>` — flat map, no per-stage breakdown (unlike `PipelineCostInfo.perStage`, which exists only because the cost-exhaustion WI comment renders it; nothing renders a tool breakdown anywhere, so YAGNI applies). |
| Tracker | New `src/utils/tool-usage-tracker.ts`, `createToolUsageTracker(state)`, a direct structural sibling of `createCostTracker` — `add(stage, usage)` merges counts into `state.outputs.toolUsage`, `total()` returns a defensive copy. |
| Reviewer aggregation | The 6 parallel axis sub-agents' tool maps are merged into one before a single `createToolUsageTracker(state).add('reviewer', merged)` call — mirrors how `reviewer.ts` already sums `costUsd` from `axisResults` before one `createCostTracker(state).add('reviewer', totalCostUsd)` call. |
| `ProcessOutcome` | Add `toolUsage: Record<string, number>` to the same 4 non-skipped variants that got `costUsd` in Plan 7: `completed`, `paused`, `failed`, `rejected`. `skipped` stays unchanged, same reasoning as Plan 7 (skipped lines are signal lines, not activity reports). |
| Log line format | Sorted by count descending, `Edit×5, Bash×2, Write×1`. Appended after the existing cost suffix inside the same parens: `(cost: $0.42, tools: Edit×5, Bash×2)`. When the map is empty, the `, tools: ...` fragment is omitted entirely — the line looks exactly like it does today. |
| Missing/undefined tool usage | `state.outputs.toolUsage ?? {}` at every processor read site — a WI that fails before any stage runs an agent has an empty map, same fallback shape as cost's `?? 0`. |
| Out of scope | No cycle-level tool aggregation, no per-stage tool breakdown anywhere (logs or comments), no tool usage in WI comments or PR descriptions. Pure log-line addition. |

## Architecture overview

```
claude-agent-runner.ts (run<T>):
  for await (const message of query(...)):
    if message.type === 'assistant':
      for (const block of message.message.content):
        if (block.type === 'tool_use'):
          toolUsage[block.name] = (toolUsage[block.name] ?? 0) + 1
    if message.type === 'result':
      ...existing costUsd extraction...
  return { value, costUsd, toolUsage }

coder.ts / analyzer.ts / test-author.ts (single-agent stages):
  const { value: output, costUsd, toolUsage } = await deps.runner.run<X>({...})
  createCostTracker(state).add('<stage>', costUsd)
  createToolUsageTracker(state).add('<stage>', toolUsage)

reviewer.ts (6-axis parallel stage):
  const axisResults = await Promise.all([...6 runner.run calls...])
  const totalCostUsd = axisResults.reduce((sum, r) => sum + r.costUsd, 0)
  const mergedToolUsage = mergeToolUsage(axisResults.map(r => r.toolUsage))
  createCostTracker(state).add('reviewer', totalCostUsd)
  createToolUsageTracker(state).add('reviewer', mergedToolUsage)

processor.ts (4 non-skipped return sites — same sites Plan 7 touched):
  const toolUsage = <state-ref>.outputs.toolUsage ?? {}
  return { kind: '<...>', ..., costUsd, toolUsage }

watcher.ts (runPollCycle, same 4 branches Plan 7 touched):
  const suffix = formatToolUsage(outcome.toolUsage)   // '' | ', tools: Edit×5, Bash×2'
  logger.info(`WI ${id}: completed (cost: $${outcome.costUsd.toFixed(2)}${suffix})`)
```

`formatToolUsage` and `mergeToolUsage` are pure helpers (likely colocated in `tool-usage-tracker.ts` or a small `src/utils/format-tool-usage.ts`, decided during planning) — sort entries by count descending, join as `Name×N`, return `''` for an empty map so callers can string-concat unconditionally.

## File / function changes

### `src/pipeline/agent-stage.ts`
- Extend `AgentRunResult<T>`: add `toolUsage: Record<string, number>`.

### `src/services/claude-agent-runner.ts`
- In `run<T>`'s message loop, add an `if (message.type === 'assistant')` branch that tallies `tool_use` blocks from `message.message.content` into a local `toolUsage` accumulator.
- Include `toolUsage` in the returned `{ value, costUsd, toolUsage }`.

### `src/utils/tool-usage-tracker.ts` (new)
- `createToolUsageTracker(state: PipelineState): ToolUsageTracker` — `add(stage, usage)`, `total()`. Initializes `state.outputs.toolUsage = {}` on first use, otherwise reuses the existing map (resume-safe, same idempotency guarantee as `createCostTracker`).
- A `mergeToolUsage(maps: Record<string, number>[]): Record<string, number>` pure helper for the reviewer's 6-way merge.
- A `formatToolUsage(usage: Record<string, number>): string` pure helper for the watcher's log suffix (returns `''` when empty, else `, tools: Edit×5, Bash×2` sorted by count descending, ties broken alphabetically).

### `src/pipeline/stages/coder.ts`, `analyzer.ts`, `test-author.ts`
- Destructure `toolUsage` alongside `value`/`costUsd` from each `runner.run()` call; add one `createToolUsageTracker(state).add('<stage>', toolUsage)` line next to the existing cost-tracker call.

### `src/pipeline/stages/reviewer.ts`
- After the existing `totalCostUsd` reduce, merge all 6 `axisResults[i].toolUsage` maps via `mergeToolUsage` and call `createToolUsageTracker(state).add('reviewer', merged)`.

### `src/types/index.ts`
- `PipelineState.outputs.toolUsage?: Record<string, number>` (optional — absent until the first agent-calling stage runs).
- Extend `ProcessOutcome`'s `completed` / `paused` / `failed` / `rejected` variants with `toolUsage: Record<string, number>`. `skipped` unchanged.

### `src/services/processor.ts`
- At the same 4 return sites Plan 7 touched, add `toolUsage: <state-ref>.outputs.toolUsage ?? {}` next to the existing `costUsd` line.

### `src/services/watcher.ts`
- In `runPollCycle`'s switch, use `formatToolUsage(outcome.toolUsage)` to build the suffix and splice it into the same 4 log lines Plan 7 modified, right after the cost segment and before the closing paren.

## Testing

### `tests/services/claude-agent-runner.test.ts`
- Mocked multi-message stream with 2+ `tool_use` blocks across 1+ assistant messages → `run()` result's `toolUsage` has correct per-tool counts.
- No tool_use blocks in the stream → `toolUsage` is `{}`.

### `tests/utils/tool-usage-tracker.test.ts` (new)
- `add` initializes `state.outputs.toolUsage` on first call.
- `add` accumulates across multiple calls (same stage and different stages).
- Resume case: pre-existing `state.outputs.toolUsage` is reused, not clobbered.
- `mergeToolUsage` sums counts across multiple maps, including disjoint keys.
- `formatToolUsage`: empty map → `''`; single entry → `, tools: Edit×1`; multiple entries sorted by count descending; tie-break alphabetically.

### `tests/services/processor.test.ts`
- Extend the existing Plan 7 cost-outcome tests (or add parallel ones) so each of the 4 non-skipped outcome kinds also asserts `toolUsage` matches seeded `state.outputs.toolUsage`.
- Missing-toolUsage fallback (`state.outputs.toolUsage` undefined) → outcome's `toolUsage` is `{}`.

### `tests/services/watcher.test.ts`
- For each non-skipped outcome kind, seed `toolUsage: { Edit: 5, Bash: 2 }` and assert the log line includes `tools: Edit×5, Bash×2` after the cost segment.
- Empty `toolUsage: {}` → log line has no `tools:` fragment at all (same shape as today).

### `tests/pipeline/stages/*.test.ts` (coder, analyzer, test-author, reviewer)
- Each stage's existing cost-tracker assertion gets a parallel tool-usage assertion: mock `runner.run` to return a non-empty `toolUsage`, assert `state.outputs.toolUsage` reflects it after the stage runs.
- Reviewer: 6 axis mocks each return distinct tool maps → assert the merged result in `state.outputs.toolUsage`.

### Cascade work (mechanical, not new behavior)
- Every existing `AgentRunner` mock across the ~15 test files that construct `{ value, costUsd }` literals needs `toolUsage: {}` added (same cascade Plan 7 did for `costUsd: 0` in `watcher.test.ts`, but larger since it touches the runner's return shape directly rather than just `ProcessOutcome`).
- No new integration tests — `tests/integration/*.test.ts` exercises the full stage chain already; tool usage flows through the same seams cost does, so existing e2e tests catch wiring breaks once their fixtures are cascaded.

## Out of scope (explicit non-goals)

- Cycle-level tool aggregation (a `toolUsage` rollup in `CycleStats` or the cycle-done summary line)
- Per-stage tool breakdown anywhere visible (logs, WI comments, PR descriptions) — only the flat per-WI total
- Tool usage surfaced in the reviewer-findings or cost-exhaustion WI comments
- Any change to which tools stages are allowed to use — this only observes and logs, it does not gate or restrict tool calls
- Structured/JSON log output — stays plain-text `logger.info`/`logger.error`, same as Plan 7

If cycle-level or per-stage detail turns out to matter operationally, it becomes a later plan candidate — same deferral pattern as Plan 7's non-goals list.
