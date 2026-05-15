# Plan 3 — Analyzer Stage (Readiness Gate)

## Context

DevopsCoder is at the milestone-3 stage after Plan 2 (`docs/superpowers/plans/2026-05-15-plan-2-ado-client-and-watcher.md` — done). `bun run start` polls Azure DevOps for work items tagged `agent implement`, runs each through an **empty** pipeline that immediately marks `completedAt`, and removes the trigger tag. The transport is wired end-to-end, but the pipeline body does no real work.

Plan 3 inserts the first real stage: the **analyzer**, a readiness gate that reads the WI title / description / acceptance criteria / comment history (and, via injected `.claude/skills/` discovery, the target repo's AL skill catalog) and produces a verdict `proceed | reject` with structured reasons. On reject, the processor posts a "what's missing" markdown comment, removes the trigger tag, adds `need-input`, and increments `state.rejectCount`. After `MAX_REJECT_CYCLES` (default 3) total rejects the WI is hard-blocked: `blockedTag` added, only recoverable via `bun run src/cli/index.ts reset-state <id>`.

**Out of scope (Plan 4+):** worktree manager (`git worktree add/remove`), coder/test-author/reviewer stages, draft-PR creator, multimodal image-as-content-block payloads.

**Acceptance:** After Plan 3, pointing `bun run start` at a real ADO project with a tagged WI should (a) fetch the WI fully, (b) call Claude with the target repo's skill catalog in context, (c) post either a reject comment + need-input tag, or proceed → pause (no more stages until Plan 4). End-to-end smoke = WI with a vague description gets a sensible reject comment.

## Decisions locked

These resolve the design ambiguities surfaced during the Plan agent's critique. Implementation must follow these exactly.

| Decision | Choice |
|---|---|
| Plan 3 scope | Analyzer only — no worktree manager (moves to Plan 4). |
| Reject re-entry | Soft. State file persists with `rejectCount`. Human re-adds trigger tag → cycle picks up. `rejectCount` resets to 0 on a successful `proceed`. |
| MAX_REJECT_CYCLES hit | Hard block. `blockedTag` added, only recoverable via `reset-state` CLI. Re-adding the trigger tag does NOT clear the block. |
| Block enforcement | **Processor decides**, not the analyzer. Analyzer schema is `proceed \| reject` only. Processor sees `rejectCount + 1 >= MAX_REJECT_CYCLES` and escalates to `blocked` severity (different comment template + tag). |
| Reject flow contract | New `PipelineRejectError` sibling to `PipelinePauseError`. Orchestrator catches it, writes history entry with `outcome: 'reject'`, persists `state.rejection`, returns. Processor branches on `state.rejection` after `runPipeline` returns. |
| Analyzer factory | Hand-rolled `Stage` (NOT the `agentStage` factory). The factory is for transparent run-and-stash stages; the analyzer has flow control that doesn't fit. Keep `agentStage` clean for the coder/reviewer in Plan 4. |
| WI-context fetch | Inline in the analyzer's `execute()`, but via a pure helper `fetchWiContext(ado, id)` in `src/services/wi-context.ts` for testability. NOT a separate Stage. |
| Image attachments | Surface URLs as text references in the prompt. Let the analyzer's `Read` tool fetch on demand. Defer multimodal content-block payloads to Plan 4. |
| Runner extension | Minimal — only `cwd`, `disallowedTools`, `maxTurns`, `canUseTool`, `systemPromptAppend`, `settingSources`. Always use `claude_code` preset with combined append (existing `STRUCTURED_OUTPUT_INSTRUCTION` + caller's append). Extract `buildQueryOptions` as a pure helper for testability. |
| `rejectCount` persistence order | Persist `rejectCount` BEFORE the tag/comment writes. Idempotency: on processor entry, if `state.rejection` is set AND the WI is still in the trigger-tag query, treat as a recovery cycle — retry tag ops, don't re-run pipeline. |
| `state.rejection` clearing | Cleared by the processor at entry when the WI is being re-attempted (i.e. when `rejectCount < MAX_REJECT_CYCLES` and the human has re-added the trigger tag). The orchestrator only writes `rejection`, never clears it. |
| Plan 2 tag-removal verb | Verify whether JSON Patch `add` on `System.Tags` actually merges (per sibling repo's explicit warning). If broken, fix to `replace`. Test in Plan 3 Task 3. |

## Architecture overview

```
Watcher poll cycle
  → Processor.processWorkItem(id)
    → if state.rejection && tagged: idempotent recovery (retry tag/comment ops, return)
    → otherwise: clear state.rejection, run pipeline
    → runPipeline([fetchContextHelper-not-a-stage, analyzerStage])
       → analyzer.execute(state, ctx)
          → fetchWiContext(ado, id) → { title, description, ac, comments, imageUrls, workItemType }
          → discoveredSkills (injected at pipeline-builder time)
          → buildAnalyzerPrompt(context, skills) → string
          → runner.run<AnalyzerOutput>({ prompt, schema, cwd: targetRepoPath, tools, systemPromptAppend, ... })
          → if verdict === 'proceed': state.outputs.analyzer = output; return state
          → if verdict === 'reject': throw new PipelineRejectError({ reasons, summary })
    → orchestrator catches PipelineRejectError: state.rejection = { ... }; save; return state
  → Processor sees state.rejection:
    → newCount = (state.rejectCount ?? 0) + 1
    → severity = newCount >= MAX_REJECT_CYCLES ? 'blocked' : 'reject'
    → state.rejectCount = newCount; state.rejectedAt = now; save (BEFORE writes)
    → post markdown comment (rendered via `marked`, template depends on severity)
    → remove triggerTag
    → add (needInputTag | blockedTag) per severity
    → return { kind: 'rejected', workItemId, severity, rejectCount: newCount }

Watcher aggregates `'rejected'` outcomes into a new CycleStats.rejected counter.
```

## Critical files to modify or create

**Modify:**
- `src/pipeline/stage.ts` — add `PipelineRejectError`, extend `StageOutcome` with `'reject'`.
- `src/pipeline/orchestrator.ts` — catch `PipelineRejectError` sibling to the pause branch; persist `state.rejection`.
- `src/types/index.ts` — add `PipelineRejection`, `WorkItemContext` types; extend `PipelineState` with `rejection?` and `rejectCount?`; extend `WorkItemFields` with optional `System.Description`, `Microsoft.VSTS.TCM.ReproSteps`, `Microsoft.VSTS.Common.AcceptanceCriteria`, `System.WorkItemType`; extend `ProcessOutcome` with `'rejected'` variant; extend `CycleStats` with `rejected`.
- `src/services/claude-agent-runner.ts` — add `cwd`, `disallowedTools`, `maxTurns`, `canUseTool`, `systemPromptAppend`, `settingSources` to `AgentRunArgs`. Always use `claude_code` preset; combine `STRUCTURED_OUTPUT_INSTRUCTION` with caller's append. Extract a pure `buildQueryOptions(args, deps)` helper.
- `src/pipeline/agent-stage.ts` — extend `AgentStageConfig` to forward the new runner options.
- `src/sdk/azure-devops-client.ts` — change `getWorkItem` URL to use `$expand=all` (drop the `fields=` whitelist). Add `getWorkItemComments(id)`. Verify tag-removal verb (`add` vs `replace`); fix if broken.
- `src/state/state-store.ts` — `listResumable` filter excludes states with `rejection` set.
- `src/services/processor.ts` — verdict-based dispatch (see architecture). Idempotent recovery at entry. Persist `rejectCount` before writes.
- `src/services/pipeline-builder.ts` — discover skills via `discoverTargetRepoSkills`, build analyzer stage, return `[analyzer]`.
- `src/services/watcher.ts` — handle the new `'rejected'` ProcessOutcome variant in the switch + CycleStats.
- `src/cli/index.ts` — already prints outcome JSON; the new `'rejected'` variant just rides along (no change needed beyond what's already wired).
- `package.json` — add `marked` dep.
- `README.md`, `CLAUDE.md`, `PATTERNS.md` — analyzer + reject lifecycle + tag-removal fix notes.

**Create:**
- `src/services/skill-loader.ts` — port from `C:\GeneralDev\DevOpsPullers\DevOpsInvestigateWorkItems\src\services\skill-loader.ts` verbatim. `discoverTargetRepoSkills(path) → DiscoveredSkill[]`.
- `src/utils/html.ts` — port from sibling. `stripHtmlToText(html)` and `extractImageUrls(html, limit=5)`.
- `src/services/wi-context.ts` — `fetchWiContext(ado, id): Promise<WorkItemContext>` calls `getWorkItem` + `getWorkItemComments`, strips HTML, extracts image URLs.
- `src/prompts/analyzer.md` — system-prompt template. Describes role (readiness gate, not a planner), output JSON schema, "use previous analyzer comments to avoid repeating yourself" rule, skill-usage instructions.
- `src/pipeline/stages/analyzer.ts` — hand-rolled Stage. `createAnalyzerStage({ runner, ado, discoveredSkills, promptTemplate, config })`.

**Test files** (mirror layout, one per source file):
- `tests/services/claude-agent-runner.test.ts` — extend existing 5 tests with ~6 for the new option pass-through and `buildQueryOptions` shape.
- `tests/sdk/azure-devops-client.test.ts` — extend with ~6 tests: full WI fetch, comments endpoint, **tag-removal verb verification**.
- `tests/services/skill-loader.test.ts` — ~6 tests including empty-dir edge case.
- `tests/utils/html.test.ts` — ~5 tests.
- `tests/services/wi-context.test.ts` — ~4 tests.
- `tests/pipeline/stages/analyzer.test.ts` — ~7 tests: proceed path, reject path, skill list in prompt, reasons forwarded, runner errors propagate, etc.
- `tests/services/pipeline-builder.test.ts` — extend (currently 1 test for empty array) with ~2 tests for the analyzer wiring.
- `tests/pipeline/orchestrator.test.ts` — extend with ~3 tests for the reject branch.
- `tests/state/state-store.test.ts` — extend with ~1 test for rejection-aware `listResumable`.
- `tests/services/processor.test.ts` — extend with ~6 tests for reject / blocked / idempotent-recovery / rejectCount-reset-on-proceed.
- `tests/services/watcher.test.ts` — extend with ~1 test for the new outcome counter.
- `tests/integration/analyzer-e2e.test.ts` — ~3 tests: reject → re-tag → reject → blocked end-to-end.

**Expected final test count:** ~140 across ~22 files (up from 94/16).

## Existing utilities to reuse (DO NOT REIMPLEMENT)

- `runPipeline` and `createInitialState` from `src/pipeline/orchestrator.ts`
- `PipelineStateStore` from `src/state/state-store.ts`
- `createClaudeAgentRunner` from `src/services/claude-agent-runner.ts` (extend its options, don't replace)
- `slugify` from `src/utils/slug.ts`
- `runPool` from `src/utils/pool.ts`
- `createProcessor` shape from `src/services/processor.ts` (extend, don't rewrite)
- `createAdoClient`, `AzureDevOpsError`, `splitTags`, `joinTags`, `hasTagCi` helpers from `src/sdk/azure-devops-client.ts`
- The sibling repo's `skill-loader.ts` and `html.ts` — verbatim port (per `CLAUDE.md`: "Mirror its file layout and patterns. Reimplement, don't import.")

## Task list (execution order; dependencies in parens)

Targeting same structure as Plan 1/2: full task manifest will live at `docs/superpowers/plans/<date>-plan-3-tasks.json` once execution starts.

1. **Orchestrator reject flow** — add `PipelineRejectError`, extend `StageOutcome`, extend `PipelineState` (`rejection`, `rejectCount`), update `runPipeline` to catch and persist. ~5 tests. *No deps; everything else depends on it.*
2. **`claude-agent-runner` option pass-through** — extend `AgentRunArgs`, extract `buildQueryOptions`, switch to preset-with-append. ~6 tests. (depends on 1 only for type harmony)
3. **ADO client: full WI fetch + comments + tag-verb verification** — `getWorkItem` to `$expand=all`, add `getWorkItemComments`, add a test that PATCH verb actually removes a tag (fix to `replace` if `add` merges). ~6 tests. (1)
4. **Skill loader** — port from sibling. ~6 tests. (independent)
5. **HTML helpers** — port from sibling. ~5 tests. (independent)
6. **WI-context fetcher** — `src/services/wi-context.ts`. ~4 tests. (3, 5)
7. **Analyzer prompt template** — `src/prompts/analyzer.md`. No tests; copy/edit pass.
8. **Analyzer stage** — `src/pipeline/stages/analyzer.ts`. Hand-rolled Stage. ~7 tests. (1, 2, 6, 7)
9. **Pipeline builder wiring** — discover skills, instantiate runner, return `[analyzer]`. Update existing test. ~2 tests. (4, 8)
10. **State-store rejection filter** — extend `listResumable`. ~1 test. (1)
11. **Processor verdict dispatch** — idempotent recovery + rejectCount + escalation + comment rendering (via `marked`). ~6 tests. (1, 3, 8, 10)
12. **Watcher outcome counter** — extend `CycleStats.rejected` + switch statement. ~1 test. (11)
13. **Integration e2e** — reject → re-tag → reject → blocked. ~3 tests. (11, 12)
14. **Docs** — README/CLAUDE.md/PATTERNS.md.

## Verification

End-to-end checks at plan completion. Run from repo root in PowerShell.

**Unit + integration:**
```powershell
bun install ; bun run typecheck ; bun test
```
Expected: ~140 tests across ~22 files, 0 fail, exit 0.

**CLI smoke tests** (no ADO needed):
```powershell
bun run src/cli/index.ts help
bun run src/cli/index.ts version
bun run src/cli/index.ts garbage   # exits 1
```

**Real ADO smoke tests** (requires `.env` with valid PAT pointing at a sandbox project; run against a known WI tagged `agent implement` with a vague description that should reject):
```powershell
bun run src/cli/index.ts debug-tags                 # confirms tag query works
bun run src/cli/index.ts run-wi <id> -- --dry-run   # exercises full analyzer path; no ADO writes
bun run src/cli/index.ts run-wi <id>                # for real: expect reject comment + need-input tag in ADO
```
Confirm in the ADO web UI: comment appears with reasons, `agent implement` tag removed, `need-input` tag present.

**Re-entry test (manual, in ADO UI):**
1. After a reject, re-add `agent implement` tag.
2. `bun run src/cli/index.ts run-once` → expect reject #2; state file shows `rejectCount: 2`.
3. Re-add tag again. `run-once` → expect reject #3 with `severity: 'blocked'`; state file shows `rejectCount: 3`; `blockedTag` set in ADO.
4. Re-add `agent implement` after the block → expect immediate `'rejected'` outcome with severity `blocked` (idempotent recovery), no new comment.
5. `bun run src/cli/index.ts reset-state <id>` → state file deleted.
6. Re-add tag → analyzer runs fresh.

**Idempotency check (manual, by killing mid-cycle):**
1. With `MAX_REJECT_CYCLES=10` (env override), trigger a reject.
2. Use a network blocker to make `removeTagFromWorkItem` fail after the comment is posted.
3. Next cycle should be a recovery: no new comment, tag removed cleanly.

## Open items being intentionally deferred to later plans

- **Multimodal images as content blocks** → Plan 4 when the coder needs them.
- **Worktree manager** → Plan 4.
- **Coder / test-author / reviewer / draft-PR stages** → Plans 4-5.
- **`PoolResult.errors` consumer** → not actionable in Plan 3.
- **`ProcessOutcome.aborted` as a distinct kind** → revisit if it becomes confusing in practice.

## References for executors

- Plan 1: `docs/superpowers/plans/2026-05-04-plan-1-skeleton-and-stage-orchestrator.md`
- Plan 2: `docs/superpowers/plans/2026-05-15-plan-2-ado-client-and-watcher.md`
- Sibling investigator (architectural template): `C:\GeneralDev\DevOpsPullers\DevOpsInvestigateWorkItems\src\services\investigator.ts`
- Sibling skill-loader (verbatim port source): `C:\GeneralDev\DevOpsPullers\DevOpsInvestigateWorkItems\src\services\skill-loader.ts`
- Sibling html utils (verbatim port source): `C:\GeneralDev\DevOpsPullers\DevOpsInvestigateWorkItems\src\utils\html.ts`
- Project memory on the human-gated flow: `C:\Users\rf\.claude\projects\C--GeneralDev-DevOpsPullers-DevOpsCoder\memory\project_devopscoder_role.md`
