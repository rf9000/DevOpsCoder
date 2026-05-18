## Axis: code-structure

The `axis` field in every finding MUST be `"code-structure"` exactly.

### What this axis cares about

Code structure and design quality: SOLID principle violations, access control mismatches, parameter passing errors, unnecessary complexity, dead code, and testability gaps. If the code is correct and fast but poorly organized, over-engineered, or hard to extend without modification, it belongs here.

### Detection targets

#### Control flow and readability
- Code wrapped in `if Condition then begin ... end` instead of using an early `if not Condition then exit` — **major**
  - Exception: `FindSet` + `repeat..until` is logically paired — do NOT flag these
- `else` branch after `exit`, `Error()`, `break`, `skip`, or `quit` — the else is unreachable dead code — **minor**
- `begin..end` wrapping a single statement (AA0005) — **minor**
  - Exception: when omitting `begin..end` would create `else`-binding ambiguity
- `if BoolVar = true then` or `if BoolVar = false then` instead of `if BoolVar then` / `if not BoolVar then` — **minor**
- Method call or database query in a loop condition evaluated every iteration — cache the result before the loop — **critical**
- Redundant default return value at end of procedure: `exit(0)`, `exit(false)`, `exit('')` — **nit**
  - Exception: procedure with multiple exit points where explicit values aid readability

#### Access modifiers
- Non-local procedure in an `Access = Public` object not explicitly marked `internal` (unless part of a documented API contract) — **major**
- Procedure marked `internal` in an `Access = Internal` object (redundant) — **nit**
- `var` parameter on a value that the procedure only reads — unnecessary aliasing — **major**
- Missing `var` on a `Record` parameter when the procedure sets filters on it — **major**

#### Procedure design
- Procedure body exceeding 50 lines — consider extracting sub-procedures — **minor**
- Procedure body exceeding 100 lines — strongly consider splitting — **major**
- Procedure with more than 5 parameters — consider grouping related parameters — **minor**
- Procedure with more than 7 parameters — consider a Record parameter or configuration interface — **major**
  - Exception: interface implementation procedures constrained by the interface definition
  - Exception: event publishers where parameter count is driven by subscriber needs
- Boolean flag parameter that controls branching inside the procedure — suggests two distinct responsibilities — **minor**
  - Exception: standard BC patterns (`RunTrigger: Boolean`, `var IsHandled: Boolean`)
- New non-local procedure with zero production callers (dead code / YAGNI) — **minor**
  - Exception: event publishers (`[IntegrationEvent]`, `[BusinessEvent]`), interface implementations, trigger procedures (`OnInsert`, `OnValidate`, etc.), procedures in `Access = Public` API contracts

#### DRY and magic values
- Two or more changed procedures with substantially similar logic (5+ matching lines) — extract a shared procedure — **major**
- Numeric literals other than 0, 1, −1 used directly in business logic without a named constant — **minor**
  - Exception: array indexes, standard math (`/ 100` for percentage), `CalcDate` format strings
- String literals used in comparisons that should be named constants — **minor**

#### Dead code and formatting
- Block of 3+ consecutive commented-out AL code lines — **minor**
- Unreachable code after unconditional `exit`, `Error()`, `break`, `skip`, or `quit` — **minor**
- `repeat` not on its own line; `case` action not on the line after its selector — **nit**

#### Architecture
- Codeunit with 10+ non-local procedures serving unrelated purposes (God Object) — **major**
  - Exception: factory codeunits, DI containers, setup/initialization codeunits that are naturally large
  - Exception: existing codeunits being modified — only flag if the change adds procedures that further dilute responsibility
- New cross-codeunit call that creates a direct circular dependency (A calls B, B already calls A) — **critical**
  - Exception: event publisher/subscriber relationships; interface implementations

#### Design for testability
- New external I/O (HTTP, file, external API) introduced without an interface abstraction — **major**
- Interface created for a single-table CRUD operation (over-engineering) — **minor**
- Global variable used instead of a parameter for dependency injection — **minor**

#### Page standards
- `ApplicationArea` set on individual page fields instead of on the page properties — **minor**

#### Test quality (only for `*-test/` app files)
- Test procedure with a generic non-descriptive name (`Test1`, `TestIt`, `MyTest`) — **minor**
- Test procedure with no `Assert` calls (what is being verified?) — **major**
- `Assert` calls with empty or generic failure messages (`''`, `'Failed'`) — **nit**

### Out of scope for this axis

TryFunction correctness, CalcFields omissions, error labels, performance (SetLoadFields, N+1 queries), naming conventions (PascalCase, variable naming), security (credential handling, permission declarations), and integration patterns (event publisher design, API page schema). Other axes cover those.

### Strategy

1. **Load rule files.** If the worktree has `.claude/rules/coding-rules/al-code-structure-patterns.md` or `al-design-for-testability.md`, read them.

2. **Get the diff.** Run `git diff origin/main..HEAD` (or the explicit range from the user prompt).

3. **For each changed procedure:**
   - Check nesting depth — deep nesting suggests missing early exits.
   - Check for `else` after exit/error.
   - Check `begin..end` blocks wrapping single statements.
   - Check boolean comparisons (`= true`, `= false`).
   - Check for method calls in loop conditions.
   - Count procedure body lines; flag at 50 (minor) and 100 (major).
   - Count parameters; flag at 5 (minor) and 7 (major).
   - Check for Boolean flag parameters controlling branches.
   - Check for numeric/string magic values in business logic.
   - Check for commented-out code blocks or unreachable code.

4. **For newly introduced non-local procedures:**
   - Check caller count — is there a production caller?
   - Skip event publishers, interface implementations, and trigger procedures.

5. **For changed or new codeunits:**
   - Count non-local procedures; flag god objects.
   - For new cross-codeunit calls, check whether the target already references the caller (circular dependency).

6. **For `Access = Public` objects:** verify new/modified non-local procedures have correct access modifiers.

7. **For `*-test/` files:** check test naming, structure, and assert quality.

8. **Apply the scope guard.** Only flag issues in changed code. Exception: if a change adds a new procedure to an existing object, check its access modifier against the object's `Access` level.

9. **Emit findings** with `axis: "code-structure"`. If no issues, return `{ "findings": [] }`.
