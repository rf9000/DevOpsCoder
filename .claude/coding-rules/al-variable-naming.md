---
paths:
  - "**/*.al"
---

# AL Naming

## Rule 1: Object variables are named after the object
- PascalCase, no spaces, periods, parentheses or hyphens: `"Gen. Jnl.-Post Line"` -> `GenJnlPostLine`, `"Amount (LCY)"` -> `AmountLCY`.
- No generic names (`Helper`, `Mgt`, `Buffer`, `Rec2`).
- **Same app:** drop the app prefix. In base-application, `Codeunit "CTS-CB Upgrade Tag"` -> `UpgradeTag`.
- **Cross app:** keep the prefix without the hyphen. In import (CTS-PI), `Codeunit "CTS-CB Upgrade Tag"` -> `CTSCBUpgradeTag`; in base-application, `Codeunit "CTS-PI Upgrade Tag"` -> `CTSPIUpgradeTag`.
- **Temp prefix** on every record variable that holds in-memory data: declared `temporary`, or of a table with `TableType = Temporary`. `TempCustomer`, `TempPaymentEntry`, cross-app `TempCTSCBPaymentEntry`. Without it a reader assumes real rows, which is dangerous in upgrade code.

## Rule 2: Declaration order
Object types first, then simple types: Record, Report, Codeunit, XmlPort, Page, Query, Notification, BigText, DateFormula, RecordId, RecordRef, FieldRef, FilterPageBuilder, then Text/Code/Integer/Decimal/Boolean/Date/... (simple types unordered among themselves).

## Rule 3: Abbreviations
Prefer full words. When length forces it, use only Microsoft's standard abbreviations:

| Word | Abbr | Word | Abbr | Word | Abbr |
|---|---|---|---|---|---|
| Account | Acc | General Ledger | GL | Purchase | Purch |
| Address | Addr | Header | Hdr | Quantity | Qty |
| Adjustment | Adjmt | Information | Info | Receipt | Rcpt |
| Amount | Amt | Invoice | Inv | Register | Reg |
| Buffer | Buf | Journal | Jnl | Reservation | Reserv |
| Calculate | Calc | Ledger | Ledg | Shipment | Shpt |
| Customer | Cust | Local Currency | LCY | Statement | Stmt |
| Description | Desc | Management | Mgt | Temporary | Temp |
| Dimension | Dim | Message | Msg | Transaction | Transac |
| Document | Doc | Number(s) | No/Nos | Vendor | Vend |
| Entry | Entr | Payment | Pmt | Warehouse | Whse |
| Exchange | Exch | Posted/Posting | Pstd/Post | Currency | Curr |
| General | Gen | Prepayment | Prepmt | Reconciliation | Recon |

Full list: https://alguidelines.dev/docs/bestpractices/suggested-abbreviations/

## Rule 4: Label suffixes (AA0074)
`Msg` message, `Err` error, `Qst` confirm question, `Lbl` caption, `Txt` other text, `Tok` token/format/tag.

## Rule 5: Labels, not inline strings (AA0217)
- `Error`, `Message`, `Confirm`, `StrSubstNo` take a label, never a literal.
- Parameterised labels carry a `Comment` naming each placeholder: `Label 'Amount %1 exceeds %2', Comment = '%1 - Amount, %2 - Limit';`.
- Call `Error(MyErr, A, B)` directly; do not wrap in `StrSubstNo` inside `Error()`.

## Rule 6: Table keys
Name keys `Key1`, `Key2`, `Key3`... in declaration order; `Key1` is the clustered primary key.

## References
- https://alguidelines.dev/docs/bestpractices/variable-naming/
- https://alguidelines.dev/docs/bestpractices/variables-declarations-order/
