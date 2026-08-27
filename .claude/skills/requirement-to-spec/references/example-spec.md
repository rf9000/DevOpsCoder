# Worked Example — a small PTE design doc

A compact, non-bank example showing the contract end-to-end. Real specs are longer; this shows the shape, the annotation markers, and an Object Inventory that `spec-to-tasklist` can decompose.

---

# Service Contract Status — Design

| | |
|---|---|
| **Type** | PTE |
| **Target app / module** | customer-pte |
| **BC version** | 26.0 |
| **Object ID range** | 50000–50049 |
| **Date** | 2026-06-22 |
| **Author** | René Frandsen |

## 1. Summary
Adds a lifecycle status to service contracts so dispatchers can filter active work. A new `Contract Status` enum drives a field on the contract table, surfaced on the contract card and enforced by a small management codeunit.

> **Decision note:** Built as a PTE, not AppSource — the customer wants to keep editing the status values per tenant, which AppSource extension rules would lock down.

## 2. Flows
1. **Set status** — user opens Contract Card → changes Status → management codeunit validates the transition → record saved.
2. **Filter active** — dispatcher list page filters Status = Active.

## 3. Object Inventory
| Type | ID | Name | Path | Interfaces | Purpose |
|------|----|------|------|------------|---------|
| Enum | 50000 | Contract Status | src/Enums/ContractStatus.Enum.al | — | Draft / Active / Suspended / Closed |
| TableExtension | 50001 | Service Contract Ext | src/TableExt/ServiceContractExt.TableExt.al | — | Adds "Status" field |
| Codeunit | 50002 | Contract Status Mgt | src/Codeunits/ContractStatusMgt.Codeunit.al | — | Validates status transitions |
| PageExtension | 50003 | Service Contract Card Ext | src/PageExt/ServiceContractCardExt.PageExt.al | — | Surfaces Status field |

> **Decision note:** Status modeled as an **enum**, not a lookup table — the value set is small and stable, and an enum gives compile-time safety in the transition codeunit.

## 4. Field Mapping
### Service Contract Ext (tableextension 50001)
| AL field (No., name, type) | Source | Required | Notes |
|----------------------------|--------|----------|-------|
| 50000 "Status"; Enum "Contract Status" | user input on card | yes | defaults to Draft on insert |

## 5. External Integration / API contract
*(Omitted — no external integration.)*

## 6. Decisions & Limitations
- **Decision:** PTE over AppSource — per-tenant value edits required (§1).
- **Decision:** Enum over lookup table — small stable value set (§3).
- **Known limitation:** No status history/audit trail in v1; only the current status is stored.

## 7. Resolved
| Question | Resolution | Rationale |
|----------|-----------|-----------|
| Allowed transitions? | Draft→Active→Suspended↔Active→Closed; Closed is terminal | Confirmed with dispatcher lead |
| Default on new contract? | Draft | Matches existing paper process |
