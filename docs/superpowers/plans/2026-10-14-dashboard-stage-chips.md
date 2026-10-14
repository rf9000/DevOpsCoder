# Dashboard Stage Chips Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show DevOpsCoder work items on the monitor-the-situation dashboard as stage chips with a live stage timer and in-stage progress, the way mutant-fixer and ADONewDirectCombuilder already appear.

**Architecture:** Copy the ADONewDirectCombuilder pattern: no HTTP endpoint. DevOpsCoder's per-WI state file gains `stageSince` (set when a stage starts) and `stageDetail` (what the running stage is doing). The monitor already reads that file through a read-only volume (`src/state/coder.ts`); it gains a `coderStages()` builder that turns the stage order, `history` and the two new fields into `StageChip[]`, which `public/app.js` `itemStagesHtml` already draws.

**Tech Stack:** Bun, TypeScript, Zod, `bun:test`. Two repos: `C:\GeneralDev\DevOpsPullers\DevOpsCoder` and `C:\GeneralDev\DevOpsPullers\monitor-the-situation`.

**Spec:** No separate spec. The design was agreed in conversation on 2026-10-14: Combuilder pattern (state file + monitor reader), not mutant-fixer's `GET /status`.

## Global Constraints

- Resume semantics must not change. A progress save writes the state **as it was at stage entry** plus the progress fields, never half-finished stage outputs. A crash mid-stage resumes exactly as before.
- `PipelineContext.reportProgress` is optional. Contexts built outside the orchestrator (tests, `experiment-runner`) need not supply it. Stages call it as `ctx.reportProgress?.(...)`.
- A progress save happens only when the detail changes. A report that arrives after the stage ended is ignored, so it cannot overwrite the end-of-stage save.
- The monitor must still read state files written before this change (no `stageSince` or `stageDetail`): it falls back to the history entry, then to `updatedAt`.
- Nothing in the pipeline reads `stageSince` or `stageDetail`. They exist for the dashboard only.

## Review Focus

1. A stage that reports progress after it returned (late callback): the end-of-stage save must win. Test in Task 1.
2. A crash mid-stage: the file on disk must hold the entry-state outputs, not partial ones. Test in Task 1 (progress save carries entry outputs while the live state already has new ones).
3. A WI run with `SKIP_BUILD_TEST=true`: `env-provision` and `build-and-test` never appear in history. Their chips before the current one must read `skipped`, not `done`. Test in Task 3.
4. An old state file with no `stageSince`: the timer falls back to the history entry, then `updatedAt`. Test in Task 3 (existing 90001 fixture).
5. A `currentStage` the monitor does not know (a future stage name): no chips, and the item still shows with its stage text. Test in Task 3.

---

### Task 1: DevOpsCoder — stage start time and progress channel

**Files:**
- Modify: `src/types/index.ts` (`PipelineState`)
- Modify: `src/pipeline/stage.ts` (`PipelineContext`)
- Modify: `src/pipeline/orchestrator.ts`
- Test: `tests/pipeline/orchestrator.test.ts`

**Interfaces:**
- Produces: `PipelineState.stageSince?: string`, `PipelineState.stageDetail?: string`, `PipelineContext.reportProgress?: (detail: string) => void`.

- [ ] **Step 1: Write the failing tests** (append to `tests/pipeline/orchestrator.test.ts`)

```ts
describe('runPipeline dashboard progress', () => {
  it('saves stageSince at stage entry and clears progress fields when the stage ends', async () => {
    const store = makeMockStore();
    const seen: PipelineState[] = [];
    store.save.mockImplementation((s: PipelineState) => { seen.push(structuredClone(s)); });
    const state = createInitialState(1, 'wi-1', FIXED_NOW);
    await runPipeline({ stages: [makeStage('a')], state, context: makeContext(), store });
    expect(seen[0]?.currentStage).toBe('a');
    expect(seen[0]?.stageSince).toBe(FIXED_NOW.toISOString());
    const last = seen[seen.length - 1]!;
    expect(last.stageSince).toBeUndefined();
    expect(last.stageDetail).toBeUndefined();
  });

  it('saves the entry state plus the detail on each changed progress report', async () => {
    const store = makeMockStore();
    const seen: PipelineState[] = [];
    store.save.mockImplementation((s: PipelineState) => { seen.push(structuredClone(s)); });
    const stage = makeStage('a', async (s, c) => {
      s.outputs.partial = 'half-done';
      c.reportProgress?.('round 1/3 · coding');
      c.reportProgress?.('round 1/3 · coding');
      c.reportProgress?.('round 1/3 · review');
      return s;
    });
    await runPipeline({ stages: [stage], state: createInitialState(1, 'wi-1', FIXED_NOW), context: makeContext(), store });
    const progress = seen.filter((s) => s.stageDetail !== undefined);
    expect(progress.map((s) => s.stageDetail)).toEqual(['round 1/3 · coding', 'round 1/3 · review']);
    // Resume safety: a progress save never carries half-finished outputs.
    expect(progress.every((s) => s.outputs.partial === undefined)).toBe(true);
  });

  it('ignores a progress report that arrives after the stage ended', async () => {
    const store = makeMockStore();
    let late: ((d: string) => void) | undefined;
    const stage = makeStage('a', async (s, c) => { late = c.reportProgress; return s; });
    await runPipeline({ stages: [stage], state: createInitialState(1, 'wi-1', FIXED_NOW), context: makeContext(), store });
    const saves = store.save.mock.calls.length;
    late?.('too late');
    expect(store.save.mock.calls.length).toBe(saves);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test tests/pipeline/orchestrator.test.ts`
Expected: the three new tests FAIL (`stageSince` undefined, no progress saves).

- [ ] **Step 3: Implement**

`src/types/index.ts`, in `PipelineState` after `currentStage`:

```ts
  /**
   * When the running stage started. Set on stage entry, cleared when it ends.
   * Dashboard-only (monitor-the-situation's stage timer); the pipeline never reads it.
   */
  stageSince?: string;
  /** What the running stage is doing now, e.g. `round 2/3 · review`. Dashboard-only, like `stageSince`. */
  stageDetail?: string;
```

`src/pipeline/stage.ts`, in `PipelineContext`:

```ts
  /**
   * Tell the dashboard what the running stage is doing (e.g. `round 2/3 · review`).
   * The orchestrator supplies it; contexts built elsewhere may not, so call it
   * as `ctx.reportProgress?.(...)`.
   */
  reportProgress?: (detail: string) => void;
```

`src/pipeline/orchestrator.ts`:
- `appendHistory` also deletes `state.stageSince` and `state.stageDetail` (every stage end appends history, so this is the one place they clear).
- After the `canRun` skip branch: set `state.stageSince = startedAt`, save, deep-clone the state as `entry`, and build `reportProgress` that sets `entry.stageDetail` and saves `entry` only when the detail changed and the stage is still live.
- `stageCtx` gets `reportProgress`; the `finally` block sets `live = false`.

- [ ] **Step 4: Run tests**

Run: `bun test tests/pipeline && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/types/index.ts src/pipeline/stage.ts src/pipeline/orchestrator.ts tests/pipeline/orchestrator.test.ts
git commit -m "feat: record stage start and in-stage progress in the WI state file for the dashboard"
```

### Task 2: DevOpsCoder — stages report progress

**Files:**
- Modify: `src/pipeline/revision-loop.ts`
- Modify: `src/pipeline/stages/build-and-test.ts`
- Modify: `src/pipeline/stages/final-review.ts`
- Test: `tests/pipeline/revision-loop.test.ts`

**Interfaces:**
- Consumes: `PipelineContext.reportProgress` from Task 1.
- Produces detail strings: revision loop `round N/M · coding` (round 1, or every round with no `reviseProducer`), `round N/M · fixing findings`, `round N/M · build + tests`, `round N/M · review`; build-and-test `waiting for environment`, `build + tests`, `fix K/M`, `build + tests after fix K/M`; final-review `review`, `fixing N blocker(s)`.

- [ ] **Step 1: Write the failing test** (append to `tests/pipeline/revision-loop.test.ts`)

```ts
describe('revisionLoop progress', () => {
  it('reports round and part of round to the dashboard', async () => {
    const details: string[] = [];
    let reviews = 0;
    const stage = revisionLoop({
      name: 'revision-loop',
      initialProducer: makeStage('coder', async (s) => s),
      reviseProducer: makeStage('fix-findings', async (s) => s),
      verify: makeStage('verify', async (s) => s),
      reviewer: makeStage('reviewer', async (s) => { reviews++; return s; }),
      maxAttempts: 3,
      isApproved: () => reviews >= 2,
    });
    await stage.execute(mockState(), mockContext({ reportProgress: (d) => details.push(d) }));
    expect(details).toEqual([
      'round 1/3 · coding', 'round 1/3 · build + tests', 'round 1/3 · review',
      'round 2/3 · fixing findings', 'round 2/3 · build + tests', 'round 2/3 · review',
    ]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/pipeline/revision-loop.test.ts`
Expected: FAIL (`details` is empty).

- [ ] **Step 3: Implement** the `ctx.reportProgress?.(...)` calls at the points listed under Interfaces: in `revisionLoop` before the producer, the verify gate and the reviewer; in `build-and-test` before `prepareVerification`, before each fix call and before each verification round; in `final-review` before the review and before `fixFindings`.

- [ ] **Step 4: Run tests**

Run: `bun test && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/revision-loop.ts src/pipeline/stages/build-and-test.ts src/pipeline/stages/final-review.ts tests/pipeline/revision-loop.test.ts
git commit -m "feat: revision loop, build-and-test and final-review report progress for the dashboard"
```

### Task 3: monitor-the-situation — DevOpsCoder stage chips

**Files:**
- Modify: `src/state/coder.ts`
- Modify: `tests/state.test.ts`
- Create: `tests/fixtures/state/coder/90004.json`

**Interfaces:**
- Consumes: DevOpsCoder state fields `currentStage`, `history[].{stage,outcome}`, `stageSince?`, `stageDetail?`.
- Produces: `export function coderStages(s: { currentStage: string | null; history: { stage: string; outcome?: string }[]; stageDetail?: string }, since: string): StageChip[] | undefined`; `readCoderState` items gain `stages` when `currentStage` is known.

Chip map (pipeline order; one chip may cover several stages):

| Chip | Stages |
|---|---|
| Analyze | `analyzer` |
| Setup | `worktree-setup`, `env-provision` |
| Code + review | `revision-loop` |
| Tests | `test-author` |
| Build + test | `build-and-test` |
| Final review | `final-review` |
| PR | `draft-pr-creator`, `worktree-teardown` |

A chip before the current one is `skipped` when none of its stages has a history entry other than `skip`; otherwise `done`. The current chip's label gets ` · <stageDetail>` when set, and `since` = `stageSince ?? <history startedAt of currentStage> ?? updatedAt`.

- [ ] **Step 1: Write failing tests** — update the 90001 expectation to include `stages`, add fixture 90004 (SKIP_BUILD_TEST run at `final-review` with `stageSince` and `stageDetail`), and a unit test that an unknown `currentStage` yields `undefined`.

- [ ] **Step 2: Run to verify they fail**

Run: `bun test tests/state.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** `coderStages()` and wire it into `readCoderState`; extend the `Pipeline` zod schema with `stageSince`, `stageDetail` (optional) and `outcome` (optional) on history entries.

- [ ] **Step 4: Run tests**

Run: `bun test && bun run typecheck` (in monitor-the-situation)
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/state/coder.ts tests/state.test.ts tests/fixtures/state/coder/90004.json
git commit -m "feat: show DevOpsCoder work items as stage chips with in-stage progress"
```
