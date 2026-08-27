# Product-Specific Agents — Contract

This folder holds **product agents**: team-authored review agents that add domain rules the 8 generic review agents deliberately do not carry (e.g., proprietary API conventions, module-boundary rules, business-logic invariants specific to this product).

Product agents run as additional discovery agents alongside the generic 8. They are gated by `references/product-profile.md` — an agent that is not listed there is not dispatched.

---

## Why this folder exists

The generic engine is a portable AL reviewer: it knows BC/AL correctness, performance, security, architecture, and conventions. It does not know your product's internal contracts — which codeunits own which module boundary, which integration endpoints have idempotency requirements, which fields carry business-critical invariants that no analyzer checks. That knowledge lives here, inline, authored and maintained by the team.

---

## Registration

To enable an agent, add its filename (relative to this folder) to the **"Product agents"** section of `references/product-profile.md`. `SKILL.md` dispatches every enabled agent in this folder automatically — no edit to the shared core is needed to add or remove a product agent.

---

## Authoring rules (every agent in this folder MUST follow all of these)

### 1. Self-contained domain knowledge
Carry the domain rule inline. You may cite an internal source document or skill as the evidence basis (e.g., a goal document, an architecture decision record, a module-contract file). Do not depend on generic-agent internals — product agents run in parallel, not in sequence.

### 2. Output format
Read `references/output-format.md` → **Agent-Level Output Format** section. Emit one `---BEGIN ISSUE---` … `---END ISSUE---` block per finding, with `VERIFIED_FACTS:` and `CONFIDENCE:` fields populated. Return `---NO ISSUES---` (full sentinel) when the scope is clean. Do **not** inline the issue-block template here — delegate to `output-format.md`, exactly as the generic agents do.

### 3. Premise-gated and evidence-based
Every finding must state a checkable premise and cite its rule basis in the `RULE_SOURCE` field. Acceptable sources:
- An internal rule/doc path (e.g., a module-contract document, a team decision record)
- Two or more sibling files that establish the convention (path:line format)

**Never cite analyzer codes** (`AA####`, `AS####`, `LC####`, or any `####`-style code) — CI owns those checks and the review engine does not duplicate them.

### 4. Stay in lane
Declare your scope explicitly at the top of the agent file. Do not re-flag categories already owned by the 8 generic agents (runtime bugs, error handling, performance, security, architecture, quality/conventions, integration, devil's-advocate checks). Product agents add rules that are *absent* from the generic engine — not louder repetitions of rules it already enforces.

### 5. Read `references/product-profile.md`
This file carries product-specific configuration: object-prefix hints, scope-exclusion globs, repo-layout facts, and any toggles or lists your agent needs. Read it at runtime; do not hard-code values that the profile already provides.

### 6. Read-only
Never edit, create, or stage code. This rule is non-negotiable for every agent in the skill (see `SKILL.md` non-negotiable rule 5).

---

## Lane boundaries (vs the 8 generic agents)

The generic agents own:

| Generic agent | What it covers |
|---|---|
| Flow-Tracing | Runtime/behavioral bugs, call-path tracing, guard truth-tables |
| Devil's Advocate | Six runtime failure-mode categories with confidence calibration |
| Error-Handling | Error/ErrorInfo, TryFunction, validation, labels, propagation |
| Performance | SetLoadFields, N+1, loops, transactions, temp tables |
| Security & Compliance | Secrets, PII/telemetry, injection, tenant isolation, Permissions, DataClassification |
| Architecture | SRP, coupling, extensibility, events, breaking-change / obsolete patterns |
| Quality & Conventions | Naming, readability, dead code, magic values, page style, YAGNI |
| Integration | HttpClient resilience, API page design, background-job idempotency, webhooks |

Product agents cover everything the generic engine *cannot know*: product-internal module contracts, domain-specific business invariants, proprietary API conventions, and team policies that are not generic BC/AL practices.

---

## Quick checklist before committing a new agent

- [ ] Agent filename added to the "Product agents" section of `references/product-profile.md`
- [ ] Scope declared at the top; lane boundaries noted (what generic agents already cover that this agent does NOT re-check)
- [ ] Domain knowledge is inline; evidence basis cited in `RULE_SOURCE`
- [ ] Output uses `---BEGIN ISSUE---` / `---END ISSUE---` format from `references/output-format.md`; `---NO ISSUES---` returned when clean
- [ ] `VERIFIED_FACTS:` and `CONFIDENCE:` populated on every finding
- [ ] No analyzer codes (`AA####` / `AS####` / `LC####`) cited anywhere
- [ ] No edits, creates, or staged files — agent is read-only
