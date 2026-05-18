## Axis: performance

The `axis` field in every finding MUST be `"performance"` exactly.

### What this axis cares about

Performance: patterns that cause unnecessary database round-trips, lock contention, excessive memory use, or transaction timeouts in Business Central SaaS. This includes missing `SetLoadFields`, unfiltered queries, N+1 loops, `DeleteAll` without guards, lock duration issues, and string concatenation in loops. If it works but will hurt throughput or hit BC's 10-minute transaction limit, it belongs here.

### Detection targets

#### SetLoadFields and field loading
- `Record.Get()`, `Record.Find()`, `Record.FindFirst()`, or `Record.FindSet()` without a preceding `SetLoadFields` — **critical**
  - Exception: single-record setup/config tables with few fields
  - Additional check: verify only the fields loaded via `SetLoadFields` are accessed after the read

#### DeleteAll / ModifyAll guards
- `Record.DeleteAll()` without a preceding `if not Record.IsEmpty() then` guard — **critical**
- `Record.ModifyAll()` without a preceding `if not Record.IsEmpty() then` guard — **critical**
- Destructive operations (`DeleteAll`, `ModifyAll`) on `Record` parameters without checking `IsTemporary` first — **critical**
- Event subscribers that modify `Rec` without checking `IsTemporary` — **critical**

#### Query patterns and key usage
- `FindFirst` or `FindSet` without `SetRange`/`SetFilter` on non-trivial (non-config) tables — **critical**
- Missing `SetCurrentKey` before a filtered find where the filter fields are not part of the primary key — **critical**
- Expensive database query placed before a cheap in-memory check that could short-circuit — **critical**
- After a unique-key find, doing another query to check a field that is already in the found record — **minor**

#### Lock usage
- `LockTable()` called for a read-only operation when `ReadIsolation` would suffice — **critical**
- Expensive non-database work (HTTP calls, complex calculations) performed while holding `ReadIsolation::UpdLock` — **critical**

#### Loop patterns
- Reassigning the loop variable inside a `FindSet` + `repeat..until Next()` loop (resets cursor, causes infinite or incorrect iteration) — **blocking**
- `Record.Get()` called inside a `repeat..until` loop where the target records could be cached or bulk-fetched (N+1 pattern) — **critical**
- `CalcFields` on FlowFields called inside a loop without prior filtering to reduce iterations — **critical**
- FlowField `CalcFields` or complex expressions evaluated in `OnAfterGetRecord` for fields that are hidden/not visible — **minor**

#### Deferred and conditional reads
- `Record.Get`/`Find` called unconditionally when the result is only used in one branch — defer to the branch that needs it — **minor**
- Procedure receives a full `Record` parameter but only reads 2-3 fields — consider passing scalar values — **minor**

#### Transaction and batch sizing
- Procedure processing many records without checkpoint `Commit()` — risk of 10-minute SaaS transaction timeout — **minor**
  - Exception: code called from a write transaction context where `Commit()` would be unsafe
- Bulk `Insert`/`Modify`/`Delete` of 1000+ records in a single transaction without batching — **minor**

#### Subscriber design
- Event subscriber with heavy inline logic instead of delegating to a method codeunit — **minor**
- Subscriber codeunit with mutable state missing `SingleInstance = true` — **minor**

#### String concatenation in loops
- Building strings with `Text + Text` inside a loop — use `TextBuilder` instead — **minor**

### Out of scope for this axis

Correctness of TryFunction usage, error labels, CalcFields omissions that cause wrong values (not performance), naming, code structure (SOLID, early exits), security, and integration patterns. Other axes cover those.

### Strategy

1. **Load rule files.** If the worktree has `.claude/rules/coding-rules/al-performance-patterns.md`, read it.

2. **Get the diff.** Run `git diff origin/main..HEAD` (or the explicit range from the user prompt).

3. **Scan for database operations in changed hunks:**
   - `.Get(`, `.Find(`, `.FindFirst(`, `.FindSet(` — check for `SetLoadFields` (and fields actually used)
   - `.DeleteAll(`, `.ModifyAll(` — check for `IsEmpty` guard and `IsTemporary` guard
   - `.LockTable(` — check if the operation is actually read-only
   - `ReadIsolation := IsolationLevel::UpdLock` followed by expensive non-DB work — check lock duration
   - `repeat` / `until` loops — check for loop variable reassignment, `.Get(` inside loop, `CalcFields` inside loop, string concatenation
   - `.SetRange(`, `.SetFilter(`, `.SetCurrentKey(` — verify filters are set before finds
   - `Commit()` presence in bulk-processing procedures

4. **For each database operation found:**
   - Look backwards in the procedure for the required guard or setup call.
   - Identify which fields are accessed after the read (to judge SetLoadFields adequacy).
   - Check the surrounding control flow (is this in a loop? in a branch?).

5. **Apply the scope guard.** Only flag issues in changed code or in procedures containing changes. Do NOT audit unchanged procedures.

6. **Emit findings** with `axis: "performance"`. If no issues, return `{ "findings": [] }`.
