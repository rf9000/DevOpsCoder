---
paths:
  - "**/*.al"
---

# AL Common Pitfalls

Recurring mistakes that compile (or fail late) and are not obvious from the code. Check before presenting AL.

- **`and`/`or` do not short-circuit.** `if (Rec.Get(No)) and (Rec.Amount > 0)` evaluates both sides; nest the `if`s when the right side may fault or is expensive.
- **`0DT`, not `0D`, for DateTime.** `0D` is a `Date`; comparing it to a `DateTime` is a type error.
- **`Code[N]` has no `StartsWith`/`EndsWith`/`Contains`.** Use `CopyStr(Code, 1, n) = 'X'`, `StrPos`, or copy into a `Text` first.
- **`Record.Get()` needs the full primary key in order.** Fewer fields than the PK compiles but silently returns `false` (or errors at run time). Check the table's `keys` (LSP `documentSymbol`) before writing `.Get(...)`; with a partial key use `SetRange` + `FindFirst`.
- **Do not hand-convert `Record` <-> `RecordRef`.** Runtime 15.2+ converts implicitly; pass the `Record` straight to a `RecordRef` parameter. Declare a `RecordRef` only for generic multi-table code, `FieldRef`/`FieldCount`/`FieldIndex` APIs, or to detach from the source variable.
- **Call own procedures via `this`**, never through a local variable of the same codeunit type.
- **Unused locals and parameters are errors (AA0137).** Remove declarations when you delete their last use.
- **Uploaded `InStream` is single-use.** Read it once into a `Temp Blob` (`TempBlob.CreateInStream`) or `Text`; a second read, including on retry, yields empty content.
- **`SecretText` rejects `Text` literals (AL0122).** Build it via `SecretText.SecretStrSubstNo` or from a `SecretText` source, not `'literal'`.
- **`Key` is a reserved word (AL0519)**; do not use it as a variable or parameter name.
- **Upgrade code belongs in the app that owns the table.** Never put upgrade logic for base-application tables in psp/export/import. Check the existing upgrade codeunits of the owning app first.
- **Interface variables fault when unassigned.** Passing an uninitialised `Interface` variable as an argument raises "interface not initialized" at the call, not at first use; assign an implementation before it leaves the procedure.
- **Object names max 30 characters (AL0305)** and the file name must match the object (AA0215). Check length when planning names.
