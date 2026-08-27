# Task List JSON — Schema & Worked Example

The authoritative shape of the `spec-to-tasklist` output. Validate every generated file against this.

## Top-level object

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `source` | string | yes | Path to the design doc this task list was derived from. |
| `summary` | object | yes | Aggregate metrics — see below. |
| `waves` | array<Wave> | yes | Dependency layers, in execution order. |
| `tasks` | array<Task> | yes | Every task, flat. |

## `summary`

| Field | Type | Notes |
|-------|------|-------|
| `waveCount` | int | `== waves.length`. |
| `taskCount` | int | `== tasks.length`. |
| `criticalPathLength` | int | Tasks on the longest dependency chain. |
| `sequentialFloor` | int | Min waves with unlimited agents. Equals `criticalPathLength` under pure layering; only differs if per-wave parallelism is deliberately capped. |
| `parallelismPossible` | bool | `true` when `taskCount > criticalPathLength`. |
| `parallelismNotes` | string | Human-readable: where work fans out / serializes; note any inferred inventory. |

## `Wave`

| Field | Type | Notes |
|-------|------|-------|
| `wave` | int | 1-based; matches each member task's `wave`. |
| `taskIds` | array<int> | Task ids in this wave; all mutually independent. |
| `dependsOnWaves` | array<int> | Distinct earlier waves these tasks depend on (`[]` for wave 1). |
| `rationale` | string | One line: why these group together / what gates them. |

## `Task`

| Field | Type | Notes |
|-------|------|-------|
| `id` | int | Unique, 1-based. |
| `title` | string | Imperative, object-scoped (e.g. "Create codeunit CTS-CB NewBank Auth"). |
| `wave` | int | The wave this task runs in. |
| `status` | enum | `"Ready"` or `"Blocked"`. `"Blocked"` ⇒ note the unresolved Open Question in `inputs`. |
| `dependsOn` | array<int> | Task ids (never wave numbers). `[]` if none. |
| `designDocReferences` | array<string> | Section anchors (`"§3.3"`) into the design doc. |
| `objects` | array<Object> | Usually one. `{ type, id, name }`. |
| `estimatedComplexity` | enum | `"small"` / `"medium"` / `"large"`. |
| `inputs` | array<string> | What the builder needs before starting. |
| `outputs` | array<string> | File(s) produced. |
| `acceptanceCriteria` | array<string> | Always includes "Compiles with no AL warnings" + behavioral assertions. |
| `touchPoints` | array<string> | Files created/edited. Shared files (enum, permission sets) flagged here. |

### `Object`

| Field | Type | Notes |
|-------|------|-------|
| `type` | string | `"Enum"`, `"Table"`, `"TableExtension"`, `"Codeunit"`, `"Page"`, `"PageExtension"`, `"Interface"`, `"PermissionSet"`, `"EnumRegistration"`, `"TestCodeunit"`, `"Test"` (a single `[Test]` procedure), … |
| `id` | int | Reserved object ID from the design doc. For pure wiring edits to an existing object, reuse that object's id. |
| `name` | string | Full object name incl. prefix (e.g. `"CTS-CB NewBank Auth"`). |

## Invariants

1. Every `dependsOn` id exists in `tasks`. No cycles.
2. No task in wave *N* depends on a task in wave ≥ *N*.
3. Each `id` appears in exactly one wave's `taskIds`.
4. `waveCount == waves.length`, `taskCount == tasks.length`.
5. Each task is single-object or an explicit wiring/registration edit; `acceptanceCriteria` non-empty.

---

## Worked example — minimal new bank ("NewBank")

Abbreviated; real output carries full `inputs`/`acceptanceCriteria` per task.

```jsonc
{
  "source": "docs/banking/plans/newbank-design.md",
  "summary": {
    "waveCount": 3,
    "taskCount": 8,
    "criticalPathLength": 3,
    "sequentialFloor": 3,
    "parallelismPossible": true,
    "parallelismNotes": "Auth, AuthItem, UrlValue, Setup page and Setup codeunit fan out once Auth exists; Export and Import depend on Auth; the CommunicationType enum-registration edit is serialized last because it wires every codeunit."
  },
  "waves": [
    { "wave": 1, "taskIds": [1], "dependsOnWaves": [], "rationale": "Authentication codeunit — every other object references it." },
    { "wave": 2, "taskIds": [2, 3, 4, 5, 6], "dependsOnWaves": [1], "rationale": "AuthItem, UrlValue, Export, Import, Setup — all depend only on Auth; mutually independent." },
    { "wave": 3, "taskIds": [7, 8], "dependsOnWaves": [2], "rationale": "Setup page binds the Setup codeunit; enum registration wires all codeunits." }
  ],
  "tasks": [
    {
      "id": 1, "title": "Create codeunit CTS-CB NewBank Auth", "wave": 1, "status": "Ready",
      "dependsOn": [], "designDocReferences": ["§4.1"],
      "objects": [{ "type": "Codeunit", "id": 71553860, "name": "CTS-CB NewBank Auth" }],
      "estimatedComplexity": "medium",
      "inputs": ["OAuth flow + token endpoints from §4.1", "Request header mapping table §6"],
      "outputs": ["Bank Communication/Codeunits/Authentication/NewBankAuth.Codeunit.al"],
      "acceptanceCriteria": [
        "Compiles with no AL warnings",
        "Implements ICommunicationType Auth and IResponseAuthHandling",
        "Stores token via Authentication Entry + Commit()"
      ],
      "touchPoints": ["Bank Communication/Codeunits/Authentication/NewBankAuth.Codeunit.al"]
    },
    {
      "id": 4, "title": "Create codeunit CTS-CB NewBank Export", "wave": 2, "status": "Ready",
      "dependsOn": [1], "designDocReferences": ["§5.1"],
      "objects": [{ "type": "Codeunit", "id": 71553863, "name": "CTS-CB NewBank Export" }],
      "estimatedComplexity": "large",
      "inputs": ["/send endpoint + payload from §5.1", "Auth codeunit (task 1)"],
      "outputs": ["Bank Communication/Codeunits/Export/NewBankExport.Codeunit.al"],
      "acceptanceCriteria": [
        "Compiles with no AL warnings",
        "Implements ICommunicationType Export + IResponseExportHandling",
        "Extracts payment-batch-id and updates Payment Register",
        "Archives both success and error responses"
      ],
      "touchPoints": ["Bank Communication/Codeunits/Export/NewBankExport.Codeunit.al"]
    },
    {
      "id": 8, "title": "Register NewBank in CommunicationType enum", "wave": 3, "status": "Ready",
      "dependsOn": [1, 2, 3, 4, 5, 6, 7], "designDocReferences": ["§3.3"],
      "objects": [{ "type": "EnumRegistration", "id": 71553577, "name": "CTS-CB Communication Type" }],
      "estimatedComplexity": "small",
      "inputs": ["All NewBank codeunits (tasks 1–7)"],
      "outputs": ["Bank Communication/Enums/CommunicationType.Enum.al"],
      "acceptanceCriteria": [
        "Compiles with no AL warnings",
        "New value maps Auth/Export/Import/AssistedSetup + optional interfaces to NewBank codeunits"
      ],
      "touchPoints": ["Bank Communication/Enums/CommunicationType.Enum.al"]
    }
  ]
}
```

## Worked example — test tasks (Test Plan section present)

When the design doc has a Test Plan, the same JSON also carries a scaffold task per test codeunit and one task per pseudo-test. Abbreviated:

```jsonc
{
  "tasks": [
    {
      "id": 20, "title": "Scaffold test codeunit TestNewBankAuth", "wave": 4, "status": "Ready",
      "dependsOn": [1], "designDocReferences": ["§Test Plan / TestNewBankAuth"],
      "objects": [{ "type": "TestCodeunit", "id": 95300, "name": "Test NewBank Auth" }],
      "estimatedComplexity": "small",
      "inputs": ["CTS-CB Fake Http Factory (95180)", "Auth codeunit (task 1)"],
      "outputs": ["base-application-test/Communication/NewBank/TestNewBankAuth.Codeunit.al"],
      "acceptanceCriteria": ["Subtype = Test", "Compiles with no AL warnings", "Fixtures + fake wiring in place"],
      "touchPoints": ["base-application-test/Communication/NewBank/TestNewBankAuth.Codeunit.al"]
    },
    {
      "id": 21, "title": "Test T-Auth-01: valid token authenticates", "wave": 5, "status": "Ready",
      "dependsOn": [1, 20], "designDocReferences": ["§Test Plan / T-Auth-01"],
      "objects": [{ "type": "Test", "id": 95300, "name": "TestNewBankAuth.T_Auth_01" }],
      "estimatedComplexity": "small",
      "inputs": ["scenario+given from T-Auth-01", "Fake returns canned token response"],
      "outputs": ["base-application-test/Communication/NewBank/TestNewBankAuth.Codeunit.al"],
      "acceptanceCriteria": [
        "Asserts token stored in Authentication Entry + IsAuthValid true (the 'then')",
        "Test is observed failing before the implementation makes it pass (red-first)"
      ],
      "touchPoints": ["base-application-test/Communication/NewBank/TestNewBankAuth.Codeunit.al"]
    },
    {
      "id": 22, "title": "Test T-Auth-02 (negative): expired token rejected", "wave": 5, "status": "Ready",
      "dependsOn": [1, 20], "designDocReferences": ["§Test Plan / T-Auth-02"],
      "objects": [{ "type": "Test", "id": 95300, "name": "TestNewBankAuth.T_Auth_02" }],
      "estimatedComplexity": "small",
      "inputs": ["scenario+given from T-Auth-02 (type=negative)", "Fake returns expired token"],
      "outputs": ["base-application-test/Communication/NewBank/TestNewBankAuth.Codeunit.al"],
      "acceptanceCriteria": ["Asserts IsAuthValid false / re-auth triggered", "Observed failing first (red-first)"],
      "touchPoints": ["base-application-test/Communication/NewBank/TestNewBankAuth.Codeunit.al"]
    }
  ]
}
```

Note: tasks 21 and 22 share the touch point `TestNewBankAuth.Codeunit.al` (and depend on scaffold task 20), so the orchestrator **serializes** them even though they're both in wave 5 — `parallelismNotes` must say so. They are not split across the production object's wave; they layer after task 1 (the thing they test) and task 20 (their scaffold).
