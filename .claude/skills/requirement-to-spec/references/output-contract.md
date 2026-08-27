# Design Document — Output Contract

Copy this skeleton when producing a `requirement-to-spec` design doc. Keep the section order. Omit a section only when truly inapplicable; if you omit one, that itself is often a `> **Decision note:**`.

## Annotation markers (use verbatim, inline where the choice occurs)

```markdown
> **Decision note:** Built as a PTE rather than an AppSource extension because the customer needs per-tenant field additions that AppSource rules forbid.

> **Why delta inference:** The bank exposes no "new payments since" endpoint, so we infer new payments by diffing the statement against the last imported cursor.

> **Known limitation:** Multi-currency reconciliation is out of scope for v1; amounts are assumed in the bank account's LCY.
```

The consolidated **Decisions & Limitations** section indexes these; the markers stay inline so a reader hits the reasoning exactly where it matters.

## Skeleton

```markdown
# <Feature Name> — Design

| | |
|---|---|
| **Type** | PTE \| AppSource |
| **Target app / module** | <app folder> |
| **BC version** | <version> |
| **Object ID range** | <range for the app> |
| **Date** | <YYYY-MM-DD> |
| **Author** | <name> |

## 1. Summary
<What this builds and why, in 2–5 sentences.>

## 2. Flows
1. **<Flow name>** — step → step → step.
2. ...

## 3. Object Inventory
| Type | ID | Name | Path | Interfaces | Purpose |
|------|----|------|------|------------|---------|
| Codeunit | 71553860 | CTS-CB ... | .../Codeunits/... | ICommunicationType Auth | ... |
<Every object to create or modify. IDs are reserved (real), not placeholders. This table feeds spec-to-tasklist.>

## 4. Field Mapping
### <Object / payload name>
| AL field (No., name, type) | Source | Required | Notes |
|----------------------------|--------|----------|-------|
| 10 "Token"; SecretText | API resp `access_token` | yes | stored via Auth Entry |

## 5. External Integration / API contract   *(omit if none)*
- **Endpoints / URL keys:** ...
- **Request schema:** ...
- **Response schema (+ async pattern):** ...

## 6. Decisions & Limitations
- **Decision:** <one line> — see §<n>.
- **Why:** <one line> — see §<n>.
- **Known limitation:** <one line>.

## 7. Open Questions   *(use this OR the Resolved table below, not both empty)*
| # | Question | Suggested default |
|---|----------|-------------------|
| 1 | Does the bank support direct debit (PAIN.008)? | Assume no for v1; add later. |

## 7. Resolved   *(when prior conversation already settled the questions)*
| Question | Resolution | Rationale |
|----------|-----------|-----------|
| PTE or AppSource? | PTE | Per-tenant fields required. |
```

## Notes

- The Object Inventory is the contract with `spec-to-tasklist`: one row ≈ one downstream task. Be exhaustive — include wiring edits (enum registration, permission-set updates) as their own rows.
- Prefer concrete AL types and lengths in Field Mapping over prose. Lengths and required-flags drive validation acceptance criteria downstream.
- Keep section numbering stable so downstream `designDocReferences` (`§3`, `§4`) resolve.
