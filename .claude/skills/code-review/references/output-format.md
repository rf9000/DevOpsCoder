# Output Format

## Report Structure

```markdown
# Code Review: [Branch Name]

**Files reviewed:** X AL files
**Review agents:** Flow-Tracing, Devil's Advocate, Error-Handling, Performance, Security & Compliance, Architecture, Quality & Conventions, Integration
**Focus:** [Primary change summary]

---

## Issues Found

🔴 BLOCKING

[BLOCKING issues using the issue template below]

🟠 CRITICAL

[CRITICAL issues using the issue template below]

🟡 Conventions

[ONE consolidated Conventions section — compact list, see template below]

🔍 NEEDS VERIFICATION

[UNVERIFIED findings — each stating the open question, see template below. Non-blocking.]

---

## Action Items

### Required Changes (must fix)
- [ ] [BLOCKING and CRITICAL issues with file:line]

### Suggested Improvements (should fix)
- [ ] [Conventions items worth acting on]

---

## Final Status

**Status:** APPROVED | REQUIRES CHANGES | REJECTED

**Summary:**
- 🔴 X BLOCKING issues
- 🟠 Y CRITICAL issues
- 🟡 Z Conventions items
- 🔍 W findings needing verification
- Dropped by verification: N findings (refuted premises)

**Objects Requiring Changes:**
- `Object1.al` → `Procedure1()`
- `Object2.al` → `Procedure2()`

**VS Code Navigation:**
Ctrl+G → ObjectName.al:LineNumber
```

> **Status mapping (the reviewer's own human-readable summary):**
> APPROVED = 0 BLOCKING + 0 CRITICAL · REQUIRES CHANGES = any CRITICAL (no BLOCKING) · REJECTED = any BLOCKING.
> The 🔍 NEEDS VERIFICATION and 🟡 Conventions sections never change the status — they are non-blocking.
>
> This status line is a convenience. The **severity counts** are the machine-readable contract: downstream consumers (e.g. a gating workflow) derive their own pass/fail from `BLOCKING`/`CRITICAL` counts and do not depend on this exact wording.

### Severity section headers

Each severity group is introduced by a header line on its own. Only include sections that have issues:

```
🔴 BLOCKING
```
```
🟠 CRITICAL
```
```
🟡 Conventions
```
```
🔍 NEEDS VERIFICATION
```

## Issue Template

Every issue — regardless of severity — MUST use this exact template. The emoji on the Object line matches the severity.

### BLOCKING issue

```markdown
🔴 **Object:** `FileName.al` → `ProcedureName()` (Line X)
**Location:** `relative/path/to/FileName.al:X`
**Issue:** [Short description of what is wrong]
**Rule (Basis):** [the generic AL principle, and/or ≥2–3 sibling files that establish the convention — NOT a /rules path or analyzer code]
**Impact:** [What happens if this isn't fixed — runtime error, compilation failure, data corruption, etc.]
**Code Context:**

[3-5 lines showing the problematic code with ← arrow annotation on the offending line]

**Fix Required:**

[Corrected code showing the fix]
```

### CRITICAL issue

```markdown
🟠 **Object:** `FileName.al` → `ProcedureName()` (Line X)
**Location:** `relative/path/to/FileName.al:X`
**Issue:** [Short description of what is wrong]
**Rule (Basis):** [the generic AL principle, and/or ≥2–3 sibling files that establish the convention — NOT a /rules path or analyzer code]
**Impact:** [What happens if this isn't fixed — performance degradation, CLAUDE.md violation, security risk, etc.]
**Code Context:**

[3-5 lines showing the problematic code with ← arrow annotation on the offending line]

**Fix Required:**

[Corrected code showing the fix]
```

### 🟡 Conventions section (consolidated — ONE section, not per-item)

All confirmed stylistic / structural / naming / convention findings collapse into a single compact list. Do NOT use the full itemized template for these — that volume is exactly what made past reviews unreadable. Each line names the location, the issue, and the evidence (rule or sibling) that backs it.

```markdown
🟡 Conventions

The following convention items were verified (rule cited or sibling-backed). They do not block.

- `FileName.al:X` `ProcedureName()` — [issue in one line]. _Evidence:_ [generic principle | sibling Foo.al:Y]
- `OtherFile.al:Z` — [issue in one line]. _Evidence:_ [...]
- ...
```

If a single convention deviation is severe enough to cause a real defect, it is not a Convention item — it was promoted to CRITICAL by the verifier and uses the itemized CRITICAL template instead.

### 🔍 NEEDS VERIFICATION section

Findings the verifier could neither confirm nor refute (or that arrived low-confidence). Each states the open question precisely so the author can check it. Non-blocking — these never change the Final Status.

```markdown
🔍 NEEDS VERIFICATION

These could not be confirmed from the code alone — please verify:

- `FileName.al:X` `ProcedureName()` — [the concern]. _Open question:_ [the exact thing to check — e.g., "does this field ever hold a customer name in production data?"]
- ...
```

## Complete Example

```markdown
🟠 CRITICAL

🟠 **Object:** `OrderProcessing.Codeunit.al` → `CreateOrderLines()` (Line 15)
**Location:** `app/Codeunits/OrderProcessing.Codeunit.al:15`
**Issue:** Unchecked Record.Get() — OrderHeader fields accessed without verifying the record exists
**Rule (Basis):** Unchecked Get — record may not exist; guard the Get (generic AL correctness principle)
**Impact:** If the order header does not exist (data inconsistency or deleted header), this throws an unhandled runtime error with a generic message. Same pattern repeated at line ~111 in CreateBatchOrderLines.
**Code Context:**

OrderHeader.SetLoadFields("Combine Lines");
OrderHeader.Get(GenJournalLine."Journal Template Name", GenJournalLine."Journal Batch Name", GenJournalLine."MyApp Order No.");    ← LINE 15 - UNCHECKED GET
if OrderHeader."Combine Lines" then

**Fix Required:**

OrderHeader.SetLoadFields("Combine Lines");
if not OrderHeader.Get(GenJournalLine."Journal Template Name", GenJournalLine."Journal Batch Name", GenJournalLine."MyApp Order No.") then
    Error(OrderHeaderNotFoundErr, GenJournalLine."MyApp Order No.");
// Label: OrderHeaderNotFoundErr: Label 'Order header %1 not found.', Comment = '%1 = Order No.';

🔴 BLOCKING

🔴 **Object:** `SplitPostHelper.Codeunit.al` → `FillSplitLineForNotSummarizedPosting()` (Line ~14)
**Location:** `app/Codeunits/SplitPostHelper.Codeunit.al:14`
**Issue:** Public procedure renamed without ObsoleteState on old procedure — breaking change
**Rule (Basis):** Released public API must be obsoleted, not deleted/renamed (breaking-change principle; CLAUDE.md states "never introduce breaking changes to public APIs")
**Impact:** The public procedure FillSplitLineForPosting was renamed to FillSplitLineForNotSummarizedPosting. Additionally, the parameter signature changed (OrderLine lost its var qualifier). Any external extension referencing the old name or signature will fail to compile.
**Code Context:**

// OLD (removed):
procedure FillSplitLineForPosting(var GenJournalLine: Record "Gen. Journal Line";
    var TempGenJournalLine: Record "Gen. Journal Line" temporary;
        OrderLine: Record "MyApp Order Line";
    var LineNo: Integer)
// NEW (replacement):
procedure FillSplitLineForNotSummarizedPosting(var GenJournalLine: Record "Gen. Journal Line";
    var TempGenJournalLine: Record "Gen. Journal Line" temporary;
        OrderLine: Record "MyApp Order Line";
    var LineNo: Integer)

**Fix Required:**

[Obsolete('Renamed to FillSplitLineForNotSummarizedPosting.', '27.5')]
procedure FillSplitLineForPosting(var GenJournalLine: Record "Gen. Journal Line";
    var TempGenJournalLine: Record "Gen. Journal Line" temporary;
        OrderLine: Record "MyApp Order Line";
    var LineNo: Integer)
begin
    FillSplitLineForNotSummarizedPosting(GenJournalLine, TempGenJournalLine, OrderLine, LineNo);
end;
```

## Severity Definitions

Severity is computed from **traced, validated impact** — never assigned by pattern category. The verifier recomputes it; the discovery agent's label is only a suggestion.

### 🔴 BLOCKING
- A **reachable** runtime failure (including the common/default case), data loss/corruption, or silently wrong financial/posting result.
- Compilation failure or a breaking change to a **public** API (verify the object is not `Access = Internal` first — Internal breaks are CRITICAL, not BLOCKING).
- The finding must name the path/trigger that reaches the failure.

### 🟠 CRITICAL
- A **verified** rule violation (cited against the actual rule file) or a probable defect with a named, realistic impact — incorrect behavior on a non-default path, a shipped test that cannot pass, a confirmed missing `Permissions`/DataClassification issue, a performance pattern that bites at realistic scale, a broken internal caller.

### 🟡 Conventions (consolidated)
- Naming, structure/SOLID, page style, event/extensibility, and other stylistic items — each backed by a cited rule or ≥2–3 sibling files. Rendered as ONE consolidated section. Non-blocking.

### 🔍 NEEDS VERIFICATION
- A real-seeming concern the verifier could neither confirm nor refute from the code (depends on data state, an external system, or an unread file), or any finding that arrived low-confidence. Stated as an open question. Non-blocking.

## What NOT to Include

- Compliant code sections
- "Strengths" or "Good job" sections
- Code that follows standards
- Unchanged code analysis

---

## Agent-Level Output Format

Each review agent returns findings in this structured format for orchestrator parsing. This format is designed for machine consumption — the orchestrator transforms it into the human-readable format above.

### Issue Format

For each violation found, return one block per issue:

```
---BEGIN ISSUE---
SEVERITY: [BLOCKING|CRITICAL|CONVENTIONS|RECOMMENDATION]
CONFIDENCE: [high|medium|low]
FILE: [filename.al]
LINE: [line number in actual file, not diff-relative]
PROCEDURE: [procedure name, or "N/A" for object-level issues]
RULE_SOURCE: [generic AL principle, and/or ≥2–3 sibling files that establish the convention (cite sibling path:line) — NOT a /rules file path and NOT an analyzer code (AA####/AS####/LC####)]
TITLE: [Short issue title, max 80 chars]
DESCRIPTION: [Detailed description explaining what is wrong and why; for behavioral findings, state the call path traced]
IMPACT: [What happens if this isn't fixed — runtime error, perf degradation, breaking change, etc.]
VERIFIED_FACTS: [the checkable facts this finding rests on — e.g., "object Access=Public (line 3); sibling UndoMerge.Codeunit.al:4 declares Permissions; write at line 47"]
CODE_CONTEXT:
```al
[3 lines before the problematic line]
[PROBLEMATIC LINE]    ← LINE [N] - [TITLE]
[2 lines after the problematic line]
```
FIX:
```al
[Corrected code showing the fix]
```
---END ISSUE---
```

- **`CONFIDENCE`** governs routing: `low` findings are sent to 🔍 NEEDS VERIFICATION rather than asserted. Do not inflate it.
- **`VERIFIED_FACTS`** is required. A finding with no verified facts is a hunch — mark it `CONFIDENCE: low`. The verifier re-checks exactly these facts.

### No Issues

When an agent finds no violations in its assigned scope:

```
---NO ISSUES---
[Agent Name] found no violations in assigned rule categories.
---NO ISSUES---
```

### Parsing Rules

- Issues are delimited by `---BEGIN ISSUE---` and `---END ISSUE---`
- Each field is on its own line with the format `FIELD_NAME: value`
- `CODE_CONTEXT` and `FIX` contain fenced AL code blocks (may span multiple lines)
- `FILE` + `LINE` together form the deduplication key; the synthesizer additionally dedups by **theme** (same root cause across files → one finding)
- `SEVERITY` determines merge priority: BLOCKING > CRITICAL > CONVENTIONS > RECOMMENDATION
- Line numbers must reference actual file lines (from diff hunk headers), not diff-relative positions
- `IMPACT`, `VERIFIED_FACTS`, and `CONFIDENCE` are required fields
- Every issue passes through the `finding-verifier` gate before it can appear in the report (as CONFIRMED, ADJUSTED, or — for unconfirmable items — UNVERIFIED → 🔍 section)
