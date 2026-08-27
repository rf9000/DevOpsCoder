---
name: requirement-to-spec
description: Converts business requirements source materials (api contracts, user stories, screenshots, freeform descriptions, prior-art code, vendor docs) into an implementation-ready Business-Central / AL design document. Use whenever the user points at a folder of inputs and asks to turn it into a spec, design doc, build plan or PTE design. Triggers on phrases like "turn this into a spec," "design this PTE," "design this AppSource extension," "plan the build for...," "write the design for this requirement," or any request that hands over raw source material and expects a structured AL design as output. Pairs with 'spec-to-tasklist' for downstream work.
---

# Requirement → Spec

Turn raw source material into a **single, implementation-ready BC/AL design document** that `spec-to-tasklist` can decompose and builder agents can execute. The job is to resolve ambiguity into concrete AL objects, fields, and flows — and to record honestly what you could not resolve.

## When to use

The user points at inputs (a folder, links, pasted material) and wants a structured AL design: "turn this into a spec," "design this PTE," "design this AppSource extension," "plan the build for…," "write the design for this requirement."

## Inputs

- **Source material** — API contracts/Swagger, user stories, screenshots, freeform descriptions, prior-art AL code, vendor docs. A folder path is typical.
- **Output path** for the design doc. Ask; default to a scratch location if not given.
- **Resolved decisions** from any prior conversation with the user (so they land in a Resolved table, not Open Questions).

## Process — work the problem

Do these in order. Don't jump to writing the document until steps 1–5 are done.

1. **Survey the source folder.** Enumerate and actually read every input. Note formats and gaps. For prior-art AL, read it with LSP/Serena, not just text. Identify the single most relevant existing implementation to anchor on.
2. **Establish metadata.** Feature name; extension type (**PTE vs AppSource** — a real decision, annotate it); target app/module; affected existing objects; BC version; object ID range for the target app; date; author.
3. **Identify the flows.** The end-to-end flows the feature supports (e.g. "authenticate → send payment → poll status → reconcile"). Each flow drives which objects exist.
4. **Assign object IDs.** Reserve **real** IDs via `mcp__al-object-id-ninja__ninja_assignObjectId` (objectType + targetFilePath = any file in the target app). Never hand-pick. Reserve one per new object so the spec — and the downstream task list — carry concrete IDs. (See `.claude/rules/coding-rules/al-object-id-assignment.md`.) For table fields / enum values use the `table_{id}` / `enum_{id}` sub-types.
5. **Map fields explicitly.** For each table/record and each external payload, a row-level mapping: AL field (No., name, type) ↔ source (UI input, API JSON property, computed/derived). Make required-vs-optional and lengths explicit. Unmapped-but-required fields are a red flag — surface them.
6. **Annotate decisions & limitations inline**, where they occur in the document, using these markers **exactly**:
   - `> **Decision note:**` — a choice that needed judgment (PTE vs AppSource, single- vs multi-account, table vs enum).
   - `> **Why X:**` — a non-obvious mechanism choice (e.g. *why infer payments from a delta rather than poll an endpoint*).
   - `> **Known limitation:**` — something the design accepts as out-of-scope or imperfect.
7. **Close with open questions.** Anything you could **not** resolve from the source alone. Frame each as a *specific* question **with a suggested default** so the reader can decide fast. If the user already resolved questions in conversation, present those as a **Resolved** table instead — a closing log of what was decided and why, not a pending list.
8. **Present the document to the user (ALWAYS).** After writing the file, surface it: report the **full path**, a one-line summary (object count, flow count, any Open Questions outstanding), and invite the user to review. Do this every time, whether invoked directly or by an orchestrator — never finish silently or hand the doc straight to a downstream step. This skill stops here; it does not decompose into tasks (see Boundaries).

## Output contract

A **single markdown document**, sections in this fixed order. Omit a section only when truly inapplicable (e.g. *External Integration* when there is no external API). The canonical template and the annotation markers live in **[references/output-contract.md](references/output-contract.md)**; a short worked example is in **[references/example-spec.md](references/example-spec.md)**.

1. **Title + Metadata** — feature name, type (PTE/AppSource), target app/module, BC version, ID range, date, author.
2. **Summary / Overview** — what this builds and why, in a few sentences.
3. **Flows** — the end-to-end flows from step 3, each as a short numbered sequence.
4. **Object Inventory** — a table of every object to create/modify: `type | id | name | folder/path | interfaces | purpose`. This is the section `spec-to-tasklist` consumes — make it complete and ID-bearing.
5. **Field Mapping** — per-object field-to-source/JSON tables from step 5.
6. **External Integration / API contract** — endpoints, URL keys, request/response schemas, async patterns. *(Omit if none.)*
7. **Decisions & Limitations** — a consolidated list of the inline `Decision note` / `Why` / `Known limitation` items (the inline markers stay where they occur; this section is the index).
8. **Open Questions** *or* **Resolved** — per step 7.

## Quality bar (self-review before reporting done)

- Sections present and in order; any omission is justified by inapplicability.
- Object Inventory is complete and every new object has a **reserved** ID (not a placeholder).
- Field Mapping has no required field left unmapped without an Open Question covering it.
- Every judgment call is annotated with the correct marker; no silent assumptions.
- The document closes with either Open Questions (each with a default) or a Resolved table — never an empty section.
- A builder could start from the Object Inventory + Field Mapping without re-reading the source folder.

## Boundaries

- Does **not** write AL code and does **not** decompose into tasks — hand the finished doc to `spec-to-tasklist` for that.
- Does **not** invent requirements to fill gaps — gaps become Open Questions with suggested defaults.
- For the **bank communication** domain specifically, this skill's *output format* is reused, but the design doc is produced by the specialized `bank-integration-planner` (parallel domain agents + devil's-advocate verification). Use that skill for new banks rather than driving this one manually.
