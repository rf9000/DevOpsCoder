## Axis: naming-style

The `axis` field in every finding MUST be `"naming-style"` exactly.

### What this axis cares about

Naming conventions, label suffix rules, enum safety, page style expressions, and object ID assignment. If the code compiles and runs correctly but uses the wrong case, an illegal abbreviation, a mismatched label suffix, or an unsafe enum conversion, it belongs here.

### Detection targets

#### Variable naming
- Variable of `Record`, `Codeunit`, `Page`, `Query`, or `Report` type not named after the object — **critical**
  - Strip the app prefix (e.g., `"CTS-CB"`) and illegal characters from the object name to get the expected variable name
  - Bad: `FieldMapper: Codeunit "CTS-CB Payment Field Mapper"`
  - Good: `PaymentFieldMapper: Codeunit "CTS-CB Payment Field Mapper"`
- Variable declaration order: complex types (`Record`, `Codeunit`, `Page`, etc.) must appear before simple types (`Integer`, `Text`, `Boolean`) in the same `var` block — **minor**
- Non-standard abbreviation used in a variable or procedure name — only Microsoft-standard abbreviations are allowed (`Amt`, `Mgmt`, `Acc`, `Qty`, `No`, `Desc`, `Cust`, `Vend`, etc.) — **minor**

#### Label and text constant suffixes (AA0074)
- Label for an error message not suffixed `Err` — **critical**
- Label for a user question (confirm dialog) not suffixed `Qst` — **critical**
- Label for a general informational message not suffixed `Msg` — **critical**
- Label for a standalone caption or heading not suffixed `Lbl` — **minor**
- Label for plain text content not suffixed `Txt` — **minor**
- Token constant (non-translatable string) not suffixed `Tok` — **minor**
- Parameterized label missing a `Comment` describing what each placeholder represents — **minor**

#### Casing and naming conventions
- Object names, public procedure names, field names, and property names not in `PascalCase` — **minor**
- Local variables, local procedure parameters not in `camelCase` — **minor**
- AL object name does not match its `Caption` property — **major**
  - Exception: caption intentionally differs from the technical name for UX reasons

#### Enum safety
- Integer-to-enum conversion using `Enum.FromInteger()` without checking `HasValue()` first — **critical**
- Enum value compared to an integer literal (hardcoded ordinal assumption) — **critical**
- Enum iteration using `Ordinal` instead of `Index` (not extension-safe) — **critical**
- Case-sensitive text-to-enum conversion without normalization — **major**

#### Page style expressions
- `StyleExpr` assignment using an enum value directly instead of `Format(PageStyle::Value)` — **critical**
- `StyleExpr` variable declared as an enum type instead of `Text` — **critical**
- String literal used directly in `StyleExpr` instead of the `PageStyle` enum plus `Format()` — **major**

#### Object ID assignment
- New AL object with an ID that appears to be manually chosen (sequential to adjacent objects, round number, or outside the expected range) — **major**
  - Note: definitive detection requires the MCP tool's reservation log. Flag suspicious-looking IDs conservatively and explain your reasoning.
- Table key not named `Key1`, `Key2`, `Key3`, etc. (project convention) — **nit**

### Out of scope for this axis

Correctness (TryFunction, Record.Get, CalcFields), performance (SetLoadFields, loops), code structure (SOLID, access modifiers, parameter passing), security (credential storage, permissions), and integration (event parameters, API schema). Other axes cover those.

`StrSubstNo` with an inline string — flagged by the safety-correctness axis.

### Strategy

1. **Load rule files.** If the worktree has `.claude/rules/coding-rules/al-variable-naming.md`, `al-enum-patterns.md`, `al-pagestyle-patterns.md`, or `al-object-id-assignment.md`, read them.

2. **Get the diff.** Run `git diff origin/main..HEAD` (or the explicit range from the user prompt).

3. **Scan `var` blocks in changed code:**
   - For each variable of a complex type, verify the variable name matches the object name (strip prefix and illegal chars).
   - Check declaration order: complex before simple.
   - Check for non-standard abbreviations.

4. **Scan label and text constant declarations:**
   - Check each label suffix against its purpose (Err, Qst, Msg, Lbl, Txt, Tok).
   - Check `StrSubstNo` calls — label variable or inline string?
   - Check `Comment` presence on parameterized labels.

5. **Scan casing in changed declarations:**
   - Object/field/property/public-procedure names — PascalCase?
   - Local variable and parameter names — camelCase?
   - Object `Caption` property — does it match the object name (after adjusting for UX intent)?

6. **Scan enum operations:**
   - `Enum.FromInteger()` calls — `HasValue()` check present?
   - Enum comparisons — integer literals used as ordinals?
   - Enum iteration — `Index` or `Ordinal`?

7. **Scan page changes for `StyleExpr` patterns.**

8. **For new object declarations (new files in diff):** inspect the object ID for suspicious manual assignment.

9. **Apply the scope guard.** Only flag issues in changed code. Do NOT audit unchanged declarations.

10. **Emit findings** with `axis: "naming-style"`. If no issues, return `{ "findings": [] }`.
