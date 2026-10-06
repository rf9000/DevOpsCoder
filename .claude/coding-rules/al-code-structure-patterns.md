---
paths:
  - "**/*.al"
---

# AL Code Structure

Apply when writing or reviewing procedure bodies. Numbering is stable; other docs cite "Pattern N".

## Pattern 1: Early exit
- Guard with `if not <cond> then exit;` instead of wrapping the body in `if <cond> then begin ... end`.
- More than 2 indentation levels in a procedure: add guards, invert conditions, or extract a procedure.
- **Exception:** `FindSet` followed by `repeat..until` with NO code after the loop stays as `if X.FindSet() then repeat ... until X.Next() = 0;`. Only split with an early exit when meaningful code follows the loop.

## Pattern 2: No `else` after a terminating statement
- Drop `else` when the `then` branch ends in `exit`, `Error`, `break`, `skip` or `quit`.

## Pattern 3: `begin..end` only around compound statements (AA0005)
- Single statement (including a whole `case` or `repeat..until`): no `begin..end`.
- **Exception:** keep `begin..end` when a nested `if` needs it so `else` binds to the outer `if`:
  ```al
  if X then begin
      if Y then
          DoSomething();
  end else
      DoSomethingElse();
  ```

## Pattern 4: No boolean comparisons to literals
- `if Flag then` / `if not Flag then`, never `= true`, `= false`, `<> true`, `<> false`.

## Pattern 5: Parenthesize `not` inside `and`/`or`
- `if (not A) and (not B) then`. A lone `not` needs no parentheses.
- AL does not short-circuit `and`/`or`: nest `if`s when the right operand may fault (see al-common-pitfalls).

## Pattern 6: Layout
- `repeat` alone on its own line.
- `case` branch actions start on the line after the match value, never on the same line.

## Pattern 7: Cache loop-invariant calls
- Assign `RecRef.FieldCount`, `Count()`, `Format(...)` etc. to a local before the loop instead of calling inside the condition or body.

## Pattern 8: No redundant default `exit(value)`
- AL initialises return values to the type default. Delete a trailing `exit(0)`, `exit(false)`, `exit('')`, `exit(<empty guid>)`. Keep non-default exits (`exit(true)`, `exit(1)`).

## Pattern 9: Procedure access keyword
- Object has `Access = Internal`: write plain `procedure`; `internal procedure` is redundant.
- Object has `Access = Public`: every non-local procedure MUST be `internal` unless it is a documented API contract (only those stay a plain `procedure`).

## Pattern 10: No unused procedures (YAGNI)
- Every new non-local procedure needs a production caller. Write the caller first; never add helpers speculatively or "for tests only".
- Review check: for each new procedure in the diff, `findReferences`; zero callers = dead code; test-only callers = move to the test codeunit.
- Not flagged: `[IntegrationEvent]`/`[BusinessEvent]` publishers, interface implementations, triggers, documented public API, procedures that existed before the diff.

## References
- https://alguidelines.dev/docs/bestpractices/ (if-not-find-then-exit, unnecessary-else, begin-end, unnecessary-truefalse, lonely-repeat, case-actions)
