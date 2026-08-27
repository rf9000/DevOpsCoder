---
name: code-review
description: AL code review skill for Continia Banking. Reviews AL code changes provided as a unified diff against CLAUDE.md and team standards. Provides precise Object→Procedure→Line references with VS Code navigation. Use when users say "review my code", "code review", "/review", "check my changes", "review staged changes", or "PR review". Callers must provide REVIEW_DIFF (unified diff) and BRANCH_NAME before invoking.
---

# AL Code Review (Discovery → Verification → Synthesis)

Review AL code changes through three stages:

1. **Discovery** — 8 specialized agents run in parallel. Each one **reads the full changed files** (not just the diff), traces real behavior, and reports findings *with the verified facts each finding rests on*.
2. **Verification gate** — batched verifier agents adversarially try to **refute** every discovery finding before it reaches the report. This stage exists because every invalid finding traces to one unchecked, checkable fact (an `Access = Internal` line, a `SetLoadFields` already present just outside the hunk, a sibling convention, the actual ruleset content). The gate re-reads those facts.
3. **Synthesis** — dedup by theme, auto-promote convergent findings, recompute severity from validated impact, and assemble the report.

## Why these rules

Each non-negotiable rule below prevents a specific failure mode that wrecks review precision: reviewing the diff alone (false premises), asserting findings without verifying the facts (wrong directives), pure pattern-matching (misses runtime bugs), per-pattern severity (inflation), and quota-filling (invented findings). Do not relax them.

## Non-negotiable rules

1. **Read the files.** Every discovery agent MUST read each changed file in full before flagging anything in it. The diff shows *what changed*; the file shows *whether it is actually a problem* (the fix may already be present outside the hunk; the object may be `Access = Internal`; the record may be consumed wholesale). Use LSP per `.claude/rules/USE-AL-LSP-TOOLS/` for definitions, references, types, and call hierarchy; fall back to Read/Grep if LSP is unavailable (LSP needs `.alpackages` — a review must never fail because LSP is down).
2. **Every finding names its evidence.** Each finding carries a `VERIFIED_FACTS:` line listing the facts checked (e.g., "object is Access=Public per line 3; sibling UndoMerge.Codeunit.al:4 declares Permissions"). A finding with no verified facts is a hunch — mark it `CONFIDENCE: low` so the gate routes it to 🔍 NEEDS VERIFICATION instead of asserting it.
3. **Finding nothing is a successful review.** Do not invent findings to fill a quota. If a file is clean, say so and move on. There is no coverage target.
4. **Severity comes from impact, not pattern category.** "Missing SetLoadFields" is not automatically CRITICAL. Trace the actual blast radius and rate accordingly (see severity definitions in `references/output-format.md`).
5. **Read-only.** Discovery and verifier agents MUST NOT edit, create, or stage code. (A prior incident: review subagents edited and staged code they were only asked to flag.) After a review run, `git status --short` must be unchanged.
6. **Out of scope:** files matching the **scope-exclusion globs in `references/product-profile.md`** (e.g. generated translation files managed by a separate pipeline). Repo-layout quirks — e.g. a misleadingly-named folder that actually holds shipped first-party code — are documented in `CLAUDE.md` and the profile; read them and never premise a finding on a path's folder name alone.

## Prerequisites

Two inputs must be in conversation context before invoking:

- **`REVIEW_DIFF`**: A unified diff (`--unified=5`) of the AL files to review. The caller produces it (`git diff --cached`, `git diff`, PR diff, etc.).
- **`BRANCH_NAME`**: The current branch name (for the report header).

If `REVIEW_DIFF` is empty or contains no `.al` file changes, report **"Nothing to review — no AL file changes found in the provided diff."** and stop.

## Step 1: Build the context pack

Do NOT regex-parse object metadata into a fragile map. Instead, assemble a small **context pack** that every agent receives and uses to read for itself:

1. **Changed file list** — extract the file paths from the diff hunk headers (`diff --git`, `+++ b/...`).
2. **Repo anchors** the agents will need:
   - The relevant `app.json` for each changed app (for `Access`, `idRanges`, `internalsVisibleTo`).
   - `references/product-profile.md` — the single product-specific config file (object prefixes, scope-exclusion globs, repo-layout facts). Agents read it instead of hard-coding product specifics.
   - `CLAUDE.md` — the team's AL standards the review enforces.
   - An optional rules overlay (only if the product profile points at one) is sibling-grade evidence, never required — the engine does not depend on `/rules`.
3. **Test detection** — note whether the diff touches any `*-test/` app (the flow-tracer must then check the PR's own tests for runtime-passability).

The context pack passed to each agent is: `BRANCH_NAME`, `REVIEW_DIFF`, the changed file list, and the anchor paths above (app.json, product-profile.md, CLAUDE.md). Agents read everything else themselves.

## Step 2: Dispatch the 8 generic agents plus any enabled product agents (single message, parallel)

Read each agent prompt file from `.claude/skills/code-review/agents/` and dispatch all 8 generic agents in **one message** with `Agent` tool calls (`subagent_type: "general-purpose"`). They must run independently — never feed one discovery agent another's findings.

Each agent receives: its prompt-file content, the context pack (Step 1), and the instruction to read the changed files in full (plus any sibling files it needs for evidence). Agents carry their own domain knowledge inline — they do not read `/rules` files.

| # | Agent | Prompt file | Mission |
|---|-------|-------------|---------|
| 1 | **Flow-Tracing** | `agents/flow-tracing-reviewer.md` | Runtime/behavioral bug hunter: traces user-action/call paths end-to-end, truth-tables guards, checks the PR's own tests, validates vs BC base-app semantics, broken internal callers, data-integrity ordering, runtime-type/pitfall checks. |
| 2 | **Devil's Advocate** | `agents/devils-advocate-reviewer.md` | Red-teams six runtime failure-mode categories with confidence calibration. Empty output is a valid result. |
| 3 | **Error-Handling** | `agents/error-handling-reviewer.md` | Error/ErrorInfo, FieldError, TryFunction (incl. no-DB-writes-in-Try), validation completeness, labels, propagation. |
| 4 | **Performance** | `agents/performance-reviewer.md` | SetLoadFields/N+1/loops/transactions/temp-tables; impact-based severity with suppression rules. |
| 5 | **Security & Compliance** | `agents/security-compliance-reviewer.md` | Secrets/IsolatedStorage, PII/telemetry, injection, tenant isolation, AND the compliance net: `Permissions = tabledata` on writers, DataClassification on PII, permission-set coverage, orphaned compliance state. |
| 6 | **Architecture** | `agents/architecture-reviewer.md` | SRP/coupling/extensibility/event design/procedure complexity/patterns + released-public-API/obsolete breaking changes. |
| 7 | **Quality & Conventions** | `agents/quality-conventions-reviewer.md` | Naming, readability, dead code, magic values, page style, YAGNI — every claim backed by generic principle + ≥2–3 siblings. Output is ONE consolidated section. |
| 8 | **Integration** | `agents/integration-reviewer.md` | Generic external/async integration: HttpClient resilience, API page design, background-job idempotency, webhooks, event wiring. |

### Product agents (profile-driven, optional)

After preparing the 8 generic agents, read `references/product-profile.md`. If its **Product agents** section lists any enabled agents, dispatch each one from `agents/product-specific/` **in the same single parallel message** as the generic agents, with the same context pack. Product agents are discovery agents — their findings go through the verification gate (Step 3) and synthesis (Step 4) exactly like the generic agents. If the profile lists no enabled product agents (or has no Product agents section), dispatch only the 8 generic agents.

## Step 3: Verification gate (batched verifiers)

Collect all discovery `---BEGIN ISSUE---` blocks. **Do not report any of them yet.** Group findings **by file** into batches of ≤8 findings each. Dispatch one `finding-verifier` agent per batch, all in a single message (read `agents/finding-verifier.md` for the full prompt).

Each verifier tries to **refute** each finding in its batch by re-checking the facts: re-read the flagged lines and whole file, check the object `Access` property + `app.json`, check the cited rule file (if any) actually requires what the finding claims, check 2–3 sibling files for any convention claim, trace reachability for any runtime claim, and sanity-check the proposed FIX (would it break TransferFields/RecordRef? does a rename match file conventions?).

Verifier verdicts per finding:

- **CONFIRMED** — survives, with recomputed severity + impact.
- **ADJUSTED** — right alarm, wrong wire: the concern is real but the mechanism/severity/fix was off; the verifier supplies the correction.
- **REFUTED** — dropped. The verifier records a one-line reason (kept for the "dropped by verification" count).
- **UNVERIFIED** — could neither confirm nor refute; routed to the 🔍 NEEDS VERIFICATION section with the open question stated.

A finding may only appear in the final report as CONFIRMED, ADJUSTED, or UNVERIFIED.

## Step 4: Synthesize the report

1. **Theme dedup** — collapse findings with the same root cause (even across files) into one entry. A systemic issue (e.g., 8 codeunits missing `Permissions`) is ONE finding listing all locations, not eight.
2. **Convergence promotion** — when the same issue was independently raised by 2+ discovery agents AND confirmed, keep it at the highest verified severity. Convergence is a strong validity signal.
3. **Severity** — use the verifier's recomputed severity (see `references/output-format.md` for definitions). BLOCKING and CRITICAL are itemized in full; everything stylistic collapses into the consolidated Conventions section.
4. **Assemble** per `references/output-format.md`:
   - 🔴 BLOCKING and 🟠 CRITICAL — full itemized template.
   - 🟡 Conventions — ONE consolidated section (compact list: location — issue — evidence).
   - 🔍 NEEDS VERIFICATION — UNVERIFIED findings, each stating the open question. Non-blocking.
   - **Severity counts** — the report's primary machine-readable output: `N BLOCKING, M CRITICAL, …`. Any consumer (a gating workflow, a PR bot) derives its own pass/fail from these counts; the reviewer does not own a downstream gate. A human-readable Final Status line (`APPROVED` / `REQUIRES CHANGES` / `REJECTED`) is included as a convenience, defined locally in `references/output-format.md`.
   - A one-line transparency note: "Dropped by verification: N findings (refuted premises)."

Report ONLY issues. Never include "Strengths" or "compliant code" sections.

## References

- Product-specific config (prefixes, scope exclusions, repo-layout facts): `references/product-profile.md`
- Agent output format & severity definitions: `references/output-format.md`
- Violation & refuted-finding examples: `references/examples.md`
- Review checklist (human reference): `references/review-checklist.md`
- Team standards: `CLAUDE.md` (rules overlay is optional — see Step 1)
- LSP usage: `.claude/rules/USE-AL-LSP-TOOLS/`
- [AL Developer Reference](https://learn.microsoft.com/dynamics365/business-central/dev-itpro/developer/devenv-reference-overview)
