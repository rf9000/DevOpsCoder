# Plan 14 — A dedicated fix-findings step, and verification inside the revision loop

## Context

WI 82205 exhausted the revision loop on 2026-09-17: three rounds, $20.61, and a
terminal `reviewer rejected 3 times — exhausted revision loop` carrying seven
unresolved findings. Two were `blocking`, and they were the *same rule* in two
different files:

```
blocking import/Importing/ImportReconMgt.Codeunit.al:69  — [TryFunction] procedure performs a database Modify
blocking import/Matching/MatchReconTelemetrySub.Codeunit.al:55 — [TryFunction] procedure performs a database Modify
major    import/Importing/ImportReconMgt.Codeunit.al:75  — Duplicate LogTelemetryEmissionFailed helper across two codeunits
```

A rule violated once, then a `major` saying the helper carrying it was
*duplicated into a second codeunit*. The loop did not fail to fix the finding;
it propagated it. Three separate defects produced that outcome.

### 1. There is no revision task — rounds 2+ re-implement the change

`createCoderStage` builds its prompt with `buildCoderUserPrompt`
(`src/pipeline/stages/coder.ts`) identically on every round: analyzer framing,
full WI description, repro steps, acceptance criteria, the entire comment
history, the skill advertisement — with the reviewer findings appended at the
bottom. Worse, the plan step re-runs from scratch whenever findings exist
(`coder.ts`, the `previousFindings?.length ?? 0 > 0` clause), so each revision
round begins by re-deriving the whole approach.

The ledger shows what that costs. Per round:

| round | `coder-plan` | `coder` |
|---|---|---|
| 1 | $2.12 (53 turns) | $5.96 (148 turns) |
| 2 | $0.83 (27 turns) | $1.13 (45 turns) |
| 3 | $0.66 (25 turns) | $1.29 (50 turns) |

Rounds 2 and 3 spent $3.90 and 147 turns. Not on "fix seven findings" — on
re-planning and re-walking a change that was already written.

### 2. The reviewer has no memory between rounds

`buildReviewerUserPrompt` (`src/pipeline/stages/reviewer.ts`) never includes the
previous round's findings. Six fresh agents re-read `baseSha..HEAD` each round
with no knowledge of what was raised before or what the coder did about it. A
finding the coder addressed can be re-raised verbatim; a finding the coder
*declined* is guaranteed to be.

### 3. A declined finding has no exit

The coder prompt says to "fix the issue **OR** explain in your summary why the
finding doesn't apply." But `approved` is computed purely from a fresh reviewer
run:

```ts
const approved = !findings.some((f) => f.severity === 'blocking' || f.severity === 'critical');
```

There is no path from *justified* to *approved*. If the model believes a
`blocking` finding is wrong, it burns every remaining round by construction, and
no choice of model changes that.

### 4. The reviewer judges code that was never compiled

`build-and-test` runs **after** the revision loop exits. Across three rounds the
six-axis fan-out spent $8.19 reading a diff that had never been through `alc`.
The environment `env-provision` booted at 20:00:01 sat idle for the whole
43-minute loop.

---

## Decisions locked

1. **Fix-only. No waiver mechanism in this plan.** The fix step edits code; it
   cannot mark a finding waived in a way that unblocks approval. Defect 3 stays
   open deliberately — `findingsAddressed[]` (below) gives us the evidence to
   decide later whether waivers are worth the trust surface they cost.
2. **Verification runs after every round, including round 1.** Not only after
   fix rounds. Identical machinery either way, and it stops the reviewer
   spending $2–4 per round on code that does not compile.
3. **No re-planning on revision rounds.** `state.outputs.coderPlan` is passed to
   the fix step as context and never regenerated.
4. **The fix step is on by default once shipped** — it is wired in
   `buildPipeline`, not gated behind a configured model. This deliberately does
   *not* follow `planModelFor`'s "undefined = off" convention: the plan split is
   a genuine trade-off an operator may decline, whereas re-implementing a change
   in order to fix seven findings is never the better option.
5. **Findings carry forward per-axis, never merged.** Each axis sees only its
   own prior findings. Handing `naming-style` the `safety-correctness` findings
   would couple six deliberately independent agents.
6. **Red verification is the existing `test-fixer`'s job, not the fix step's.**
   `fix-findings` answers reviewer findings; `test-fixer` answers compile errors
   and red tests. Both already have the right prompt for their signal.

---

## Architecture overview

Today:

```
analyzer → worktree-setup → env-provision
         → revisionLoop( coder-plan → coder , reviewer )
         → test-author → build-and-test → draft-pr-creator → worktree-teardown
```

After:

```
round 1:  coder-plan → coder   → verify → reviewer
round 2+: fix-findings         → verify → reviewer
```

with `verify` = `runVerificationRound` plus a bounded `test-fixer` loop, and
`reviewer` now carrying each axis's own prior findings.

`revisionLoop` gains a second producer. `RevisionLoopConfig.producer` is renamed
`initialProducer` and joined by an optional `reviseProducer`; when
`reviseProducer` is absent the loop behaves exactly as it does today, which is
what keeps every existing test meaningful and lets the change land in stages.

The verification machinery is extracted from `build-and-test`'s 330-line
`execute` into `src/pipeline/stages/_verification.ts`, shared by both call
sites. The **mechanism** is shared; the **policy** differs and lives at the call
sites:

| situation | final `build-and-test` | in-loop gate |
|---|---|---|
| no test codeunits discovered | `VerificationFailedError` | log warning, skip the round's verify |
| no codeunits selected for the change | `VerificationFailedError` | log warning, skip the round's verify |
| deploy failed, `findEnvironmentDeployFailure` hit | throw (env problem) | log warning, skip the round's verify |
| compile failed / tests red | `test-fixer` loop, then `VerificationFailedError` | `test-fixer` loop, then round ends red and the reviewer runs anyway |

The first three degrade mid-loop because they are not statements about the code.
`test-author` has not run yet, so a change touching files no existing codeunit
covers is the ordinary case, not a defect — and an environment fault must not be
able to hold the code-quality loop hostage when the final gate will catch it
authoritatively anyway.

### Caching, and the trap in it

`prepareVerification` splits into work that is safe to cache per work item and
work that is not:

- **Cacheable (environment-side, expensive, idempotent):** `waitForRunning`, the
  activation-app install, the localization deps install, and the per-`appPath`
  deps install. Recorded in `state.outputs.verificationSetup` as
  `{ activationInstalled: boolean, localizationInstalled: boolean, depsInstalled: string[] }`.
- **NOT cacheable (must be re-derived every round):** the app graph scan,
  `getChangedFiles`, `selectTestCodeunits`, and `resolveAppPaths`. All four
  depend on what the worktree currently contains, and the fix step changes that.
  Caching the selection would mean a round that touched a new app deploys the
  *previous* round's deploy set and tests the previous round's codeunits — a
  green result that verified the wrong thing.

An `appPath` appearing in a later round that is not yet in `depsInstalled` gets
its deps install then, and is added.

---

## File / function changes

### `src/pipeline/stages/_verification.ts` (new)

Extracted from `build-and-test.ts` with no behaviour change to the final gate.

```ts
export interface VerificationSetup {
  env: EnvironmentOutput;
  appPaths: string[];
  codeunits: DiscoveredTestCodeunit[];
  /** Non-fatal reason this round cannot verify. Callers choose throw vs. skip. */
  skipReason?: string;
}

export interface VerificationRoundResult {
  output: VerificationOutput;
  failure?: VerificationFailure;
  /** Deploy failed for a reason no source edit can address. */
  environmentBlocker?: DeployAppResult;
}

export async function prepareVerification(args: PrepareVerificationArgs): Promise<VerificationSetup>;
export async function runVerificationRound(args: RunVerificationRoundArgs): Promise<VerificationRoundResult>;
export async function runFixCall(args: RunFixCallArgs): Promise<void>;  // the existing test-fixer call
```

`prepareVerification` **returns** `skipReason` where today's code throws
`VerificationFailedError`, and **returns** `environmentBlocker` where today's
code throws. Both throw sites move into `createBuildAndTestStage`, so its
external behaviour is byte-identical.

### `src/pipeline/stages/build-and-test.ts`

`createBuildAndTestStage` keeps its name, its `Stage` contract, its config keys
and every error it throws. Its body becomes: `prepareVerification` → throw on
`skipReason` → the attempt loop over `runVerificationRound` → throw on
`environmentBlocker` → `runFixCall` → `VerificationFailedError`. `buildFixPrompt`,
`resolveAppPaths` and `findEnvironmentDeployFailure` stay exported from here;
`_verification.ts` imports them.

### `src/pipeline/stages/fix-findings.ts` (new)

Modelled on the `test-fixer` call inside `build-and-test`, which is the same
shape with a different red signal.

```ts
export const fixFindingsOutputSchema = coderOutputSchema.extend({
  findingsAddressed: z.array(z.object({
    file: z.string(),
    line: z.number().optional(),
    action: z.enum(['fixed', 'declined']),
    reason: z.string(),
  })).optional(),
});

export function buildFixFindingsPrompt(args: {
  findings: Finding[];
  diff: string;
  worktree: WorktreeContext;
  wiCtx: WorkItemContext;   // id + title ONLY
  plan?: PlanOutput;
  skills: DiscoveredSkill[];
  attempt: number;
  maxAttempts: number;
}): string;

export function createFixFindingsStage(deps: FixFindingsStageDeps): Stage;  // name: 'fix-findings'
```

The prompt contains: the findings grouped by severity (same `SEVERITY_ORDER` as
the coder), `git diff <baseSha>..HEAD`, the stored plan, the skill
advertisement, and the worktree rules. It **omits** the WI description, repro
steps, acceptance criteria, comment history and analyzer framing. That omission
is the substance of this plan, not an optimisation — those sections are what
turn a revision into a re-implementation.

Runner call mirrors the coder exactly: `tools: ['Read','Grep','Glob','Bash','Skill','Edit','Write']`,
`disallowedTools: ['NotebookEdit', ...STRUCTURED_OUTPUT_DENIED_TOOLS]`,
`canUseTool` = `createBashAllowlist({ allow: CODER_BASH_ALLOW, deny: CODER_BASH_DENY })`
composed with `createPathEscapeFilter(worktree.path)`, `settingSources: ['project']`,
reset-to-baseline and `MAX_TRANSIENT_RETRIES` on `AgentOutputParseError`.

Writes `state.outputs.coder` (so downstream stages are unchanged) and
`state.outputs.findingsAddressed`.

### `src/pipeline/stages/_verify-gate.ts` (new)

The in-loop gate, wrapping `_verification.ts` with the degrade-not-throw policy
and its own smaller fix budget.

```ts
export function createVerifyGateStage(deps: VerifyGateDeps): Stage;  // name: 'verify'
```

Returns early and logs when `config.skipBuildTest` is set, when `skipReason` is
present, or when `environmentBlocker` is hit. Runs `runFixCall` up to
`config.maxInLoopFixAttempts` times on a fixable red. Persists
`state.outputs.verification` either way, so the exhaustion comment can report
it.

### `src/pipeline/revision-loop.ts`

```ts
export interface RevisionLoopConfig {
  name: string;
  initialProducer: Stage;      // was `producer`
  reviseProducer?: Stage;      // absent → initialProducer every round (today's behaviour)
  verify?: Stage;              // absent → no in-loop verification
  reviewer: Stage;
  maxAttempts: number;
  isApproved: (state: PipelineState) => boolean;
  onExhausted?: (state: PipelineState, ctx: PipelineContext) => Promise<PipelineState>;
}
```

Round body becomes producer → `assertWithinCostCap` → verify → `assertWithinCostCap`
→ reviewer, with the existing `ctx.abortFlag.aborted` check before each. The cost
gate gains a third call site because `verify` can now contain `test-fixer` calls.

### `src/pipeline/stages/reviewer.ts`

- `buildReviewerUserPrompt` takes `previousFindings?: Finding[]` (this axis only)
  and `findingsAddressed?: FindingAddressed[]`, rendering a
  `## Previously raised by this axis` section with, per finding, the coder's
  reported action. The instruction is explicit: *re-raise only what the current
  diff still exhibits; do not carry a finding forward on the strength of having
  raised it before.*
- `ReviewerOutput` gains `byAxis: Record<ReviewAxis, Finding[]>`, populated from
  the axis that **actually ran** — the same rule the severity clamp already
  follows, because the model-supplied `axis` field is part of what is policed.
  `findings` keeps its current meaning and shape.
- The prompt is built per-axis rather than once for all six.

**Known risk: anchoring.** Feeding a model its own prior output invites restating
over re-deriving. Each axis still runs `git diff` itself, and the instruction is
explicit, but if a live run shows findings surviving by inertia the fallback is
to carry forward only findings the coder reported `fixed` and let unaddressed
ones be re-derived cold.

### `src/utils/model-selection.ts`

`PipelineStep` gains `'fix-findings'`. No other change — `modelFor` already
routes anything in that union.

### `src/config/index.ts`

| key | default | purpose |
|---|---|---|
| `CLAUDE_MODEL_FIX_FINDINGS` | → `CLAUDE_MODEL` | the per-step model knob |
| `FIX_FINDINGS_MAX_TURNS` | → `CODER_MAX_TURNS` | narrower task, but AL fixes sprawl |
| `STAGE_TIMEOUT_MS_FIX_FINDINGS` | → `STAGE_TIMEOUT_MS_CODER` | per-round budget |
| `MAX_INLOOP_FIX_ATTEMPTS` | `1` | in-loop `test-fixer` budget, separate from `MAX_TEST_FIX_ATTEMPTS` |

`MAX_INLOOP_FIX_ATTEMPTS` is separate and smaller on purpose: without it the
worst case is `MAX_REVISIONS × MAX_TEST_FIX_ATTEMPTS` fix calls inside the loop
*plus* the final gate's own budget.

The `revision-loop` timeout default becomes:

```
MAX_REVISIONS × (coderPlanBudget + STAGE_TIMEOUT_MS_CODER
                 + inLoopVerifyBudget + STAGE_TIMEOUT_MS_REVIEWER)
```

where `inLoopVerifyBudget` is `0` when `SKIP_BUILD_TEST=true`, else
`(MAX_INLOOP_FIX_ATTEMPTS + 1) × STAGE_TIMEOUT_MS_VERIFY_PASS
 + MAX_INLOOP_FIX_ATTEMPTS × STAGE_TIMEOUT_MS_CODER`, reusing the existing
`STAGE_TIMEOUT_MS_VERIFY_PASS`.

### `src/services/pipeline-builder.ts`

Reads `src/prompts/fix-findings.md`, constructs `createFixFindingsStage` and
`createVerifyGateStage`, and wires them as `reviseProducer` and `verify`.
`SKIP_BUILD_TEST=true` omits `verify` entirely, alongside the existing removal
of `env-provision` and `build-and-test`.

### `src/prompts/fix-findings.md` (new)

System prompt. Its job statement is *fix the listed findings and change nothing
else*. Carries the same worktree rules as `test-fixer.md` (stage specific files,
commit, never push, never weaken a test to pass), plus:

- Fix the finding at its source. If the same rule is violated in another file
  you are touching, fix it there too — **never** copy the pattern forward.
  (Direct response to the duplicate-helper `major` in WI 82205.)
- If you believe a finding is wrong, record it as `declined` with a reason. Do
  not restructure the change to work around it.
- Do not re-architect. The approved plan already ran; you are correcting it.

### `src/types/index.ts`

`FindingAddressed` interface, and `ReviewerOutput.byAxis`. `state.outputs` is
`Record<string, unknown>` with documented reserved keys rather than a typed
interface, so `findingsAddressed` and `verificationSetup` are added to that
doc comment alongside `cost`, `coderPlan` and `verification`.

### `src/services/processor.ts`

The exhaustion comment gains the last verification result when one exists, so
"Review not passed (3×)" can no longer conceal "…and it also never compiled".

### Docs cascade

`README.md`, `CLAUDE.md`, `.env.example` — the four new env vars, the revised
stage chain, and the per-round structure.

---

## Testing

### `tests/pipeline/stages/fix-findings.test.ts` (new)
- `buildFixFindingsPrompt` includes every finding grouped severity-descending,
  the diff, and the plan.
- It **excludes** `wiCtx.description`, `.reproSteps`, `.acceptanceCriteria` and
  `.comments`. This is the regression test for the defect this plan exists to
  fix — assert absence explicitly, not by snapshot.
- Stage resets to baseline and retries once on `AgentOutputParseError`, then
  rethrows.
- Cost and tool usage bill to the `fix-findings` key.

### `tests/pipeline/revision-loop.test.ts`
- Round 1 runs `initialProducer`; rounds 2+ run `reviseProducer`.
- No `reviseProducer` ⇒ `initialProducer` every round (today's behaviour, and
  every existing case in this file must still pass unchanged).
- `verify` runs between producer and reviewer, and is skipped when absent.
- `assertWithinCostCap` is called before the producer, before verify and before
  the reviewer.

### `tests/pipeline/stages/_verification.test.ts` (new)
- `prepareVerification` returns `skipReason` (not throws) for empty discovery
  and empty selection.
- `runVerificationRound` returns `environmentBlocker` (not throws) for a
  non-fixable deploy code.
- Deps install is skipped for an `appPath` already in `depsInstalled`, and runs
  for one that is not.

### `tests/pipeline/stages/_verify-gate.test.ts` (new)
- Skips and logs on `skipBuildTest`, on `skipReason`, on `environmentBlocker`.
- Runs `test-fixer` at most `MAX_INLOOP_FIX_ATTEMPTS` times, then returns red
  without throwing.
- Persists `state.outputs.verification` on every path.

### `tests/pipeline/stages/build-and-test.test.ts`
Must pass **unchanged**. That is the parity check for the extraction — if a case
needs editing, the extraction changed behaviour it was not supposed to.

### `tests/pipeline/stages/reviewer.test.ts`
- Each axis prompt carries that axis's prior findings and no other axis's.
- `byAxis` is keyed on the axis that ran, not on the model-supplied `axis` field
  (feed a finding whose `axis` disagrees and assert the key).

### `tests/config/index.test.ts`
- The four new keys and their fallbacks.
- The `revision-loop` derived timeout, with and without `SKIP_BUILD_TEST`.

### `tests/integration/`
A two-round loop with a mocked `AgentRunner` and mocked `ContiniaCli`: round 1
coder → verify green → reviewer rejects → round 2 `fix-findings` → verify green
→ reviewer approves. Assert `coder-plan` was called **once**, and that the
`fix-findings` prompt contained the round-1 findings.

---

## Out of scope (explicit non-goals)

- **Waivers.** No mechanism by which a declined finding stops blocking approval.
  `findingsAddressed[]` is recorded and rendered; it does not gate. Defect 3
  above remains open, deliberately, pending evidence from these records.
- **Moving `test-author` into the revision loop.** Considered and rejected: it
  multiplies the most expensive stage by `MAX_REVISIONS` and rewrites tests
  against a diff that is still moving.
- **Retuning `AXIS_SEVERITY_CEILING` or the severity rubric.** Orthogonal, and
  recently changed.
- **A separate fix-findings plan step.** Rounds 2+ deliberately do not plan.
- **Changing `approved = !any(blocking|critical)`.**

---

## Success criteria

1. A WI that needs revisions shows `fix-findings` in `formatSpendLine`, and
   `coder-plan` with `calls: 1` rather than one per round.
2. Total spend for a three-round WI falls relative to the $20.61 baseline, and
   the fall is visible in `perStage` as the removal of the round-2/3
   `coder-plan` + `coder` pairs.
3. A finding fixed in round *n* is not re-raised verbatim in round *n+1*.
4. Code that does not compile is caught before the six-axis fan-out reads it.
5. `tests/pipeline/stages/build-and-test.test.ts` passes unchanged.
