---
name: code-review-light
description: Lightweight one-pass AL self-review for agent-generated changes. Reviews uncommitted AL diff (git diff HEAD) for BLOCKING and CRITICAL issues only against .claude/rules/coding-rules/*.md. Inline, no subagent dispatch. Triggered by a Stop hook after agent work, or manually as a quick sanity check. Exits silently if no AL files changed. For deep multi-agent reviews use the full code-review skill instead.
---

# Lightweight AL Code Review (Single-Pass)

A fast, inline self-check for AL code the agent just produced. Reviews `git diff HEAD` for BLOCKING + CRITICAL issues only. Use it BEFORE finalizing work whenever AL files were edited.

For deep reviews with specialized parallel agents, use the full `code-review` skill instead. This one is intentionally narrow.

## When to Run

- **Automatically**: a `Stop` hook in `.claude/settings.local.json` reminds you to run this skill when an agent turn ends.
- **Manually**: invoke when you want a quick sanity check on uncommitted AL work.

## Step 1 — Compute the Diff

Run:

```bash
git diff HEAD --unified=5 -- "*.al"
```

If the output is empty, report exactly:

> Code review (light) skipped — no AL file changes in `git diff HEAD`.

…and stop. Do not proceed.

Otherwise capture the output as `REVIEW_DIFF` and continue.

## Step 2 — Identify Object + Procedure Context

For each changed file in `REVIEW_DIFF`, identify:

- Object header: `^(codeunit|page|table|enum|pageextension|tableextension|enumextension|interface|report|query)\s+(\d+)\s+"([^"]+)"`
- Object `Access = Internal | Public` (default: Public)
- Procedure boundaries: `^\s*(local\s+)?(internal\s+)?procedure\s+(\w+)`

You don't need a formal map — just enough context to attribute each finding to `Object → Procedure (Line N)`.

## Step 3 — Scan Changed Hunks

For every `+` line in `REVIEW_DIFF`, check against the detection lists below. Skip pre-existing code and `-` lines unless the deletion itself is the issue (B5, B6, C7).

### 🔴 BLOCKING

| # | Pattern | Rule source |
|---|---------|-------------|
| B1 | `[TryFunction]` procedure body contains `.Insert(`, `.Modify(`, `.Delete(`, `.ModifyAll(`, `.DeleteAll(` | `al-error-handling.md` — TryFunction + writes |
| B2 | `0D` used as a DateTime value (e.g., assigned to a DateTime field) | `al-common-pitfalls.md` — Date vs DateTime |
| B3 | `.StartsWith(`, `.EndsWith(`, `.Contains(` invoked on a `Code[N]` variable | `al-common-pitfalls.md` — Code string methods |
| B4 | `Record.Get(` with fewer arguments than the table's primary key length | `al-common-pitfalls.md` — Incomplete Get |
| B5 | Released page field/action/group deleted in an object **without** `Access = Internal` | `al-obsolete-patterns.md` — AS0062 / AS0063 |
| B6 | Released table field deleted | `al-obsolete-patterns.md` — Field obsoletion |
| B7 | FlowField is read without a prior `CalcFields(` on that record | `al-common-pitfalls.md` — FlowField access |
| B8 | `SetRange(` / `SetFilter(` referencing a field name from the wrong record variable | `al-common-pitfalls.md` — Filter on wrong record |
| B9 | Secret / credential / API key as a string literal in code | `CLAUDE.md` — security |
| B10 | Public procedure renamed or its parameter signature changed without an `[Obsolete(..)]` shim of the old name/signature | `al-obsolete-patterns.md` + `CLAUDE.md` — breaking changes |

### 🟠 CRITICAL

| # | Pattern | Rule source |
|---|---------|-------------|
| C1 | `Error(` or `Message(` with an inline string literal instead of a `Label` constant | `CLAUDE.md` — error labels |
| C2 | `StrSubstNo(` called directly inside `Error(` / `Message(` instead of being applied to a `Label` text | `CLAUDE.md` — StrSubstNo with labels |
| C3 | A `[TryFunction]` procedure is called without checking the Boolean return value | `al-error-handling.md` — Unchecked TryFunction |
| C4 | A `[TryFunction]` body calls another `[TryFunction]` (nested) | `al-error-handling.md` — Nested TryFunctions |
| C5 | `Record.Get(...)` whose return value is **not** guarded by `if ... then`, followed by field access | `al-common-pitfalls.md` — Null reference after Get |
| C6 | `ObsoleteState = Pending` set without sibling `ObsoleteReason` and `ObsoleteTag` properties | `al-obsolete-patterns.md` — Required obsolete props |
| C7 | Released page field/action/group or table field deleted in an object **with** `Access = Internal` (downgraded from B5/B6) | `al-obsolete-patterns.md` — Access-modifier downgrade |
| C8 | `Record.Insert(true)` or `Record.Insert()` with no prior validation of mandatory fields that lack defaults | `al-common-pitfalls.md` — Missing required field validation before Insert |
| C9 | `FINDSET`, `FIND('-')`, or `FindFirst` on a table with no `SetRange` / `SetFilter` / `SetCurrentKey` set first (unfiltered scan) | `al-performance-patterns.md` — Unfiltered iteration |
| C10 | Upgrade codeunit placed in an app that does not own the table being upgraded | `al-common-pitfalls.md` — Upgrade codeunit placement |

If you need clarification on any pattern, read the relevant rule file under `.claude/rules/coding-rules/`. Otherwise the detection tables above are self-contained — do not read rule files speculatively.

## Step 4 — Scope Guard

Only flag issues that are:

- Introduced by the change (visible in `+` lines), **or**
- In the same procedure as a change and directly affected by it (e.g., a missing `CalcFields` whose FlowField is now accessed in new code).

Do **NOT** flag:
- Pre-existing issues in unchanged code outside changed procedures.
- Style / naming / structure / recommendation findings — those are out of scope. Defer them to the full `code-review` skill.
- Anything below CRITICAL severity.

## Step 5 — Emit the Report

If zero issues, emit exactly one line:

> ✅ Code review (light): no BLOCKING or CRITICAL issues in AL changes.

If one or more issues, emit:

````markdown
## Code review (light)

**Files reviewed:** N AL file(s) (uncommitted in `git diff HEAD`)
**Scope:** BLOCKING + CRITICAL only

🔴 BLOCKING (X)

🔴 **`FileName.al`** → `ProcedureName()` (line L)
**Issue:** [one-sentence description of what is wrong]
**Rule:** [rule-file.md — pattern]
**Code:**
```al
[2–4 lines around the offending line, with ← arrow on the issue]
```
**Fix:**
```al
[corrected code]
```

🟠 CRITICAL (Y)

🟠 **`FileName.al`** → `ProcedureName()` (line L)
[same template]

---
**Status:** ❌ REQUIRES CHANGES — X BLOCKING, Y CRITICAL

Fix and re-run, or invoke the full `code-review` skill for STYLE + RECOMMENDATION coverage.
````

Sort issues by severity first (BLOCKING before CRITICAL), then by file, then by line. Use the exact emojis and headers above so the output is grep-able.

## What This Skill Does NOT Do

- No style / naming / structure / recommendation findings — use full `code-review`.
- No multi-agent passes — one inline scan, that's it.
- No automatic fixes — reports only; the calling agent decides.
- No reading of the full rule files unless a specific detection needs verification.

## References

- Full multi-agent review: `.claude/skills/code-review/SKILL.md`
- Authoritative rule sources: `.claude/rules/coding-rules/*.md`
- Output format reference: `.claude/skills/code-review/references/output-format.md`
- Team standards: `CLAUDE.md`
