---
name: spec-to-tasklist
description: Decomposes a Business-Central / AL design document (typically produced by 'requirement-to-spec') into an ordered, dependency-aware task list optimized for parallel agentic execution. Each task is sized to a single AL object and carries explicit inputs, outputs, and acceptance criteria so an orchestrator can dispatch waves directly. Use whenever a BC design doc is ready to be built, or the user says "break this down," "plan the build," "what's the order of work," "let's parallelize this," or "decompose this spec."
---

# Spec → Task List

Turn a finished BC/AL design document into a **dependency-aware, wave-grouped JSON task list** that an orchestrator can dispatch in parallel. One task ≈ one AL object. The output is data, not prose: it is meant to be read by a builder/orchestrator, not a human report.

## When to use

- A design doc (ideally from `requirement-to-spec`) exists and is ready to build.
- The user says "break this down," "plan the build," "what's the order of work," "let's parallelize this," "decompose this spec."

If no design doc exists yet, stop and point the user at `requirement-to-spec` first — this skill does not invent requirements, it only decomposes an existing spec.

## Inputs

- **Path to the design doc** (markdown). Required.
- **Output path** for the JSON. Ask the user; default to a scratch location next to the source doc (e.g. `<docname>.tasklist.json`) if not given.

## Granularity rule

**One task = one AL object** — one enum, table, table extension, codeunit, page, page extension, interface, permission set, or enum/interface registration edit. If a "task" would create two objects, split it. If a single object needs a follow-up edit by another object (e.g. registering an enum value, adding a table to permission sets), that edit is its own task that depends on the objects it references.

Grounding example — a new bank integration decomposes to ≈8–12 objects: Auth, AuthItem, IsAuthValid, Export, Import, UrlValue, Setup codeunit, Setup page, plus the `CommunicationType` enum-registration edit and (often) a permission-set update.

**One task = one pseudo-test** (when the design doc has a **Test Plan** section). Each pseudo-test (Scenario / Given / When / Then) becomes its own task — a single `[Test]` procedure. The test codeunit that holds them is its own (small) **scaffold** task. So a Test Plan with 4 codeunits and 30 pseudo-tests → 4 scaffold tasks + 30 per-test tasks. See "Test tasks" below for dependencies and the shared-file rule.

## Process

Work the design doc deterministically:

1. **Extract objects.** Read the design doc's **Object Inventory** section. Each row → one task. Capture object `type`, reserved `id`, `name`, and target file path. If the doc has no explicit inventory, derive objects from the Flows + Field Mapping sections and flag in `parallelismNotes` that the inventory was inferred. **If the doc has a Test Plan section**, also extract each test codeunit (→ scaffold task) and each pseudo-test (→ per-test task) — see "Test tasks" below.
2. **Derive dependencies (`dependsOn`).** A task depends on another when its object *references* the other at compile time or by contract:
   - A codeunit/page that uses an enum, table, or interface → depends on those objects' tasks.
   - An interface *implementation* codeunit → depends on the interface task (if the interface is new).
   - A registration/wiring edit (e.g. adding a value to `CommunicationType.Enum.al`, adding a table to permission sets) → depends on every object it wires.
   - A page → depends on the table/extension it is bound to.
   - Use LSP/Grep on the *existing* codebase only to confirm whether a referenced object already exists (existing objects are not tasks and create no dependency).
3. **Layer into waves (topological sort, longest-path layering).** `wave(task) = 1 + max(wave(d) for d in dependsOn)`, or `1` if no deps. All tasks in the same wave are dependency-independent and may run concurrently. Record each wave's `taskIds`, `dependsOnWaves` (distinct waves its tasks depend on), and a one-line `rationale`.
4. **Compute summary metrics** (definitions below).
5. **Write the JSON** to the output path and validate it against the schema in `references/schema.md`.
6. **Self-check** (see Validation) before reporting done.

## Test tasks (when the design doc has a Test Plan section)

If the design doc has a **Test Plan** section (pseudo-tests in `scenario / given / when / then / type / covers` shape, grouped by test codeunit), emit test tasks alongside the object tasks:

1. **One scaffold task per test codeunit** — creates the empty `[Test]`-subtype codeunit + shared fixtures. `objects` = `{ type: "Codeunit", id, name }` (the test-codeunit ID reserved in the design doc against the `*-test` app). It depends on the production objects whose behavior the codeunit broadly exercises (so it can reference their types).
2. **One task per pseudo-test** — implements a single `[Test]` procedure. Derive its dependencies from the test:
   - depends on the **production object task(s) it `covers`** (you cannot test what isn't built — map the pseudo-test's `covers` to the object tasks), **and**
   - depends on its **test-codeunit scaffold task**.
   - `acceptanceCriteria` = the pseudo-test's `then` assertions **plus** "test is observed failing before the implementation makes it pass" (red-first).
   - `inputs` carry the `given` (fixtures / fake + canned response) and the `scenario`; `designDocReferences` point at the Test Plan entry id (e.g. `T-Auth-01`).
3. **Shared-file serialization (critical).** Every per-test task for the same codeunit writes the **same `.al` file**. Set that file as a shared `touchPoint` on the scaffold task **and every one of its per-test tasks**, exactly like the `CommunicationType.Enum.al` registration file — so the orchestrator never parallel-edits one codeunit. Because of this, per-test tasks for one codeunit do **not** all collapse into a single wave even though their dependencies allow it; note in `parallelismNotes` that same-codeunit tests are serialized on the shared file (this caps the parallelism the finer granularity would otherwise buy).
4. A per-test task is `"Blocked"` if the behavior it `covers` is itself blocked on an Open Question; otherwise `"Ready"`.

## Output

A single JSON file. Full field-by-field schema and a worked banking example live in **[references/schema.md](references/schema.md)**. Shape:

```jsonc
{
  "source": "<path to design doc>",
  "summary": {
    "waveCount": 4,
    "taskCount": 11,
    "criticalPathLength": 4,
    "sequentialFloor": 4,
    "parallelismPossible": true,
    "parallelismNotes": "Enum, interface, and foundation tasks fan out in wave 1; only the enum-registration edit is fully serialized at the end."
  },
  "waves": [
    { "wave": 1, "taskIds": [1, 2, 3], "dependsOnWaves": [], "rationale": "Enum, interface, and foundation table — no dependencies." }
  ],
  "tasks": [
    {
      "id": 1,
      "title": "Create enum CommunicationType value scaffolding",
      "wave": 1,
      "status": "Ready",
      "dependsOn": [],
      "designDocReferences": ["§3.3"],
      "objects": [{ "type": "Enum", "id": 71553577, "name": "CTS-CB Communication Type" }],
      "estimatedComplexity": "small",
      "inputs": ["Enum values from §3.3"],
      "outputs": ["Bank Communication/Enums/CommunicationType.Enum.al"],
      "acceptanceCriteria": ["Compiles with no AL warnings", "Value present with correct ordinal"],
      "touchPoints": ["Bank Communication/Enums/CommunicationType.Enum.al"]
    }
  ]
}
```

### Metric definitions (compute exactly)

- **`taskCount`** — number of tasks.
- **`waveCount`** — number of waves produced.
- **`criticalPathLength`** — number of tasks on the longest dependency chain.
- **`sequentialFloor`** — minimum waves required even with unlimited parallel agents. Under pure longest-path layering this equals `criticalPathLength` (and `waveCount`). It only diverges from `waveCount` if you deliberately cap per-wave parallelism — if you do, say so in `parallelismNotes`.
- **`parallelismPossible`** — `true` when `taskCount > criticalPathLength` (i.e. at least one wave has >1 task).
- **`parallelismNotes`** — one or two sentences a human can read: where the work fans out, what serializes it, any inferred-inventory caveat.

### Per-task field rules

- **`status`** — `"Ready"` if all `dependsOn` are themselves buildable from the spec; `"Blocked"` if it depends on an unresolved Open Question in the design doc (note which one in `inputs`).
- **`dependsOn`** — task `id`s only; never wave numbers.
- **`designDocReferences`** — section anchors (`§3.3`) so a builder can re-read the authoritative requirement.
- **`objects`** — usually one entry `{type, id, name}`. `id` comes straight from the design doc's reserved IDs (do **not** invent or re-reserve here — ID reservation happened upstream).
- **`estimatedComplexity`** — `small` / `medium` / `large`, by procedure count and branching, not line count.
- **`inputs`** — what the builder needs before starting (spec sections, upstream outputs, fixtures).
- **`outputs`** — the file(s) this task produces.
- **`acceptanceCriteria`** — always include "compiles with no AL warnings"; add behavioral assertions drawn from the spec (interfaces implemented, fields mapped, status transitions). These are what a verifier/test checks.
- **`touchPoints`** — files this task creates or edits (a registration task touches a shared file; flag shared touch points so the orchestrator avoids parallel edits to the same file).

## Validation (self-check before reporting)

- JSON parses and matches `references/schema.md`.
- Every `dependsOn` id exists; **no cycles** (a cycle means the dependency derivation is wrong — re-examine).
- **Wave invariant:** no task in wave *N* depends on a task in wave ≥ *N*.
- `summary.taskCount` == `tasks.length`; `summary.waveCount` == `waves.length`; every task's `id` appears in exactly one wave's `taskIds`.
- Each task is single-object, an explicit wiring/registration edit, a test-codeunit scaffold, or a single pseudo-test; every task has non-empty `acceptanceCriteria`.
- Shared-file touch points (e.g. the enum file, permission sets) are isolated into their own late-wave tasks, never duplicated across **parallel** tasks. **Exception — test codeunits:** the per-test tasks for one codeunit deliberately share its file; that's allowed *because* the shared touch point forces the orchestrator to serialize them. Confirm `parallelismNotes` states this so the shared file isn't mistaken for a parallel-edit bug.

## Boundaries

- Does **not** reserve object IDs (that is `requirement-to-spec`'s job) and does **not** write AL code.
- Does **not** re-derive requirements — if the spec is ambiguous, reflect it as a `"Blocked"` task pointing at the relevant Open Question rather than guessing.
