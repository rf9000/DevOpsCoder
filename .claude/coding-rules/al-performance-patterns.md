---
paths:
  - "**/*.al"
---

# AL Performance

Every `Get`/`Find`/`CalcFields`/`Modify` is a SQL round-trip. Apply these when writing or reviewing data access.

## Reading
- `SetLoadFields(...)` immediately before every `Get`/`Find*`/`FindSet` on non-Setup tables. List only the non-PK, non-filter fields you read; PK and filtered fields are loaded automatically. Setup tables (single-record) are exempt.
- Filter large tables before `Find*` and pick a matching key (`SetCurrentKey`). Never call `FindSet`/`FindFirst` unfiltered on a ledger, log or archive table.
- Order guards cheapest first: parameter checks, in-memory lookups, then `Get`, then filtered `Find*`. A cheap guard that exits saves the query.
- Put a `Get`/`Find` inside the branch that uses it, not before the `if`, when only some branches need the record.
- After finding a record by a unique key, test extra fields on the loaded record. Do not add a filter and `FindFirst` again.
- No `Record.Get()` inside `repeat..until` for the same table (N+1). Cache in a `Dictionary`/temporary table or bulk-fetch with one filtered `FindSet` before the loop.
- `CalcFields` inside a loop runs one aggregate query per row. Filter the set down first, or use `SetAutoCalcFields` when the FlowField is needed on every row.
- Do not assign the loop record (`Loop := Other` or `Other := Loop` then `Other.Modify()`) between `FindSet` and `Next()`; it discards the server cursor and re-issues the full query on every `Next()`. Modify the loop variable directly.
- Pass scalars instead of a by-value `Record` when the callee reads only a few fields of a wide table (50+ fields or BLOBs). A `var` parameter is not copied and is always fine.

## Writing and locking
- `if not Rec.IsEmpty() then Rec.DeleteAll();` - an empty `DeleteAll` still takes a table lock.
- Use `Rec.ReadIsolation := IsolationLevel::UpdLock;` on the variable you will modify. Never `LockTable()` (LC0031): it escalates every instance of that table in the session, including subscribers.

  | Level | Use for |
  |---|---|
  | `ReadUncommitted` | page display, counts, `IsEmpty` checks |
  | `ReadCommitted` | data you will write (default inside a write transaction) |
  | `RepeatableRead` | re-reading the same rows unchanged; no `RunModal`/`Codeunit.Run` afterwards |
  | `UpdLock` | check-then-modify of specific rows |
- Do expensive work (HTTP calls, parsing, calculations, dialogs) before acquiring the lock; lock, `Modify`, done.
- Long-running batch jobs: `Commit()` every 50-200 records to stay under the SaaS 10-minute transaction limit and release locks. Only where a commit is legal: never from page triggers, `[TryFunction]`s or code that may run inside a caller's transaction.

## Loops and strings
- Cache loop-invariant calls (`FieldCount`, `Count()`, `Format(...)`) in a local before the loop.
- Build strings iteratively with `TextBuilder`, not `Text := Text + ...` (quadratic).

## Event subscribers
- Subscriber codeunits: `SingleInstance = true`, split by area, and delegate to a method codeunit; keep the subscriber body to a guard plus one call.
- First line of every table-event subscriber: `if Rec.IsTemporary() then exit;`.
- Guard destructive operations on records assumed temporary with `IsTemporary()`.
- Avoid subscribing to `OnInsert`/`OnModify`/`OnDelete` table triggers for bulk-processed tables; they run per row.

## Pages
- Computed columns that are expensive or `Visible = false`: bind the function in the field expression (`field(Bal; Calc.GetBalance(Rec))`), not a global set in `OnAfterGetRecord`, which runs for every row even when the column is hidden. Exception: `StyleExpr` needs a variable (see al-pagestyle-patterns).

## References
- https://alguidelines.dev/docs/bestpractices/ (setloadfields, deleteall, subscribercodeunits, istemporary-table-safeguard)
- https://learn.microsoft.com/dynamics365/business-central/dev-itpro/performance/performance-overview
- https://bcinternals.com/posts/tri-state-locking/
