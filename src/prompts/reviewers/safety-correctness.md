## Axis: safety-correctness

The `axis` field in every finding MUST be `"safety-correctness"` exactly.

### What this axis cares about

Safety and correctness: code that will produce wrong results, crash at runtime, silently lose data, or violate hard AL/BC correctness rules. This includes TryFunction misuse, missing error labels, CalcFields omissions, Record.Get pitfalls, obsolete-pattern violations, and incomplete error handling. If it compiles but behaves wrongly or dangerously, it belongs here.

### Detection targets

#### TryFunction restrictions
- `[TryFunction]` procedure containing `Insert`, `Modify`, or `Delete` — **blocking**
- `[TryFunction]` used for complex business logic that includes database writes — **blocking**
- Calling a `[TryFunction]` procedure without capturing the Boolean return value — **critical**
- Nested `[TryFunction]` calls: one `[TryFunction]` calling another — **critical**
- TryFunction failure path with no cleanup of partial state or reset of variables — **critical**
- `GetLastErrorText()` / `GetLastErrorCallStack()` not captured when handling TryFunction failure — **minor**

#### Record.Get pitfalls
- `Record.Get()` called with fewer arguments than the table's primary key field count — **blocking**
- Accessing record fields after `Record.Get()` without checking the Boolean return value — **critical**
- Wrong `SetRange`/`SetFilter` field: filter applied to a field using the wrong record variable — **blocking**

#### CalcFields and FlowFields
- Accessing a FlowField value without a prior `CalcFields()` call (value will be 0/empty) — **blocking**

#### Error handling and labels
- `Error()` or `Message()` with an inline string literal instead of a label variable — **critical**
- `StrSubstNo` called directly inside `Error()` or `Message()` rather than via a label variable — **critical**
- Parameterized label missing a `Comment` describing what each placeholder represents — **minor**
- Exception caught in a general handler but not re-thrown or logged (silent failure) — **critical**
- Re-throwing with a new message that discards the original error detail — **minor**

#### ObsoleteState / breaking changes
- Released page field, action, or group deleted instead of marked `ObsoleteState = Pending` — **blocking**
- Table field deleted instead of obsoleted — **blocking**
- `ObsoleteState` set without `ObsoleteReason` or `ObsoleteTag` — **critical**
- Obsoleted page element missing `Visible = false` — **minor**

#### AL type pitfalls
- `DateTime` literal `0D` used where `0DT` is needed — **blocking**
- String methods (`StartsWith`, `EndsWith`, `Contains`) called on `Code[N]` variables — **blocking**
- Raw `InStream` used for file operations without a `TempBlob` intermediary — **critical**
- Upgrade codeunit placed in an app that does not own the table — **critical**

#### Logic completeness
- `Record.Insert()` called without validating mandatory fields that have no default — **critical**
- `case` statement on an enum without an `else` branch for unhandled values — **minor**
- `FieldError(FieldName)` used without a custom message where context would help the user — **nit**
- Numeric fields accepted without bounds checking when only a subset of values is valid — **minor**
- Text fields storing structured data (IBAN, email, URL) accepted without format verification — **minor**
- Related fields not validated together (e.g., Start Date > End Date not caught) — **minor**

### Out of scope for this axis

Performance (SetLoadFields, N+1 queries, DeleteAll guards), naming conventions, code structure (early exits, SOLID), security (credential storage, permission gating, filter injection), and integration (event patterns, HTTP). Those axes will catch violations in those areas.

### Strategy

1. **Load rule files.** If the worktree has `.claude/rules/coding-rules/al-error-handling.md`, `al-common-pitfalls.md`, or `al-obsolete-patterns.md`, read them. They may contain project-specific overrides.

2. **Get the diff.** Run `git diff origin/main..HEAD` (or the explicit range from the user prompt). Identify all changed hunks.

3. **For each changed hunk, check:**
   - Any `[TryFunction]` attribute near changed code — look for database writes inside that procedure.
   - Any call to a `[TryFunction]` procedure — verify the Boolean return is captured (`if not Try...() then`).
   - Any nested `[TryFunction]` → `[TryFunction]` chains.
   - Any `Error(` or `Message(` call — verify a label variable is used, not an inline string.
   - Any `Record.Get(` call — count the primary key fields and verify the Boolean return is checked.
   - Any `Record.Insert(` call — check mandatory fields are validated beforehand.
   - Any FlowField access — verify `CalcFields()` was called in the same procedure.
   - Any `case` statement on an enum — check for an `else` branch.
   - Any deleted fields, actions, or groups on pages or tables — check if they were released.
   - Any `DateTime` literal patterns or string method calls on `Code[N]` variables.

4. **Use `Read`/`Grep` for context.** If a hunk modifies a call site, read the called procedure to understand its contract. If a record type is unclear, `Grep` for its table definition.

5. **Apply the scope guard.** Only flag issues in changed code or in the same procedure as a change when the finding's validity depends on that context. Do NOT flag pre-existing issues in unchanged code.

6. **Emit findings.** For each issue found, produce a finding with `axis: "safety-correctness"` and the appropriate severity. If no issues are found, return `{ "findings": [] }`.
