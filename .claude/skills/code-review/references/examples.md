# Common Violation Examples

## Early-Exit Pattern Violation

**Bad:**
```al
procedure ProcessExportSelection(Selection: Integer; FilesCollected: Boolean)
begin
    if Selection > 0 then begin
        if FilesCollected then
            ExportFilesToZip()
        else
            Message(NoFilesFoundMsg);
    end;
end;
```

**Good:**
```al
procedure ProcessExportSelection(Selection: Integer; FilesCollected: Boolean)
begin
    if Selection = 0 then
        exit;

    if not FilesCollected then begin
        Message(NoFilesFoundMsg);
        exit;
    end;

    ExportFilesToZip();
end;
```

**Report Format:**
```markdown
🔴 **Object:** `ExportManagement.Codeunit.al` → `ProcessExportSelection()` (Lines 45-58)
**Location:** `app/Codeunits/ExportManagement.Codeunit.al:47`
**Issue:** Nested if statements instead of guard clauses
**CLAUDE.md Rule:** Line 58 - "minimal begin..end; early-exit guard clauses"
```

## SetLoadFields Missing

**Bad:**
```al
procedure GetCurrency(BankAccount: Record "Bank Account"): Text
var
    GeneralLedgerSetup: Record "General Ledger Setup";
begin
    GeneralLedgerSetup.Get();
    if BankAccount."Currency Code" = '' then
        exit(GeneralLedgerSetup."LCY Code")
    else
        exit(BankAccount."Currency Code");
end;
```

**Good:**
```al
procedure GetCurrency(BankAccount: Record "Bank Account"): Text
var
    GeneralLedgerSetup: Record "General Ledger Setup";
begin
    GeneralLedgerSetup.SetLoadFields("LCY Code");
    GeneralLedgerSetup.Get();
    if BankAccount."Currency Code" = '' then
        exit(GeneralLedgerSetup."LCY Code")
    else
        exit(BankAccount."Currency Code");
end;
```

## Parameter Passing - Missing var

**Bad:**
```al
procedure FilterRecords(CustomerRec: Record Customer)
begin
    CustomerRec.SetRange(Blocked, CustomerRec.Blocked::" ");
end;
```

**Good:**
```al
procedure FilterRecords(var CustomerRec: Record Customer)
begin
    CustomerRec.SetRange(Blocked, CustomerRec.Blocked::" ");
end;
```

## TryFunction with Database Write

**Bad:**
```al
[TryFunction]
procedure TryInsertRecord(var Rec: Record MyTable)
begin
    Rec.Insert(true);  // NEVER do this in TryFunction
end;
```

**Good:**
```al
[TryFunction]
procedure TryValidateRecord(Rec: Record MyTable): Boolean
begin
    // Validation only
    if Rec.Code = '' then
        exit(false);
    exit(true);
end;

procedure InsertRecord(var Rec: Record MyTable)
begin
    if not TryValidateRecord(Rec) then
        Error(ValidationFailedErr);
    Rec.Insert(true);
end;
```

## Variable Naming

**Bad:**
```al
var
    FieldMapper: Codeunit "MyApp Payment Field Mapper";
    Mgmt: Codeunit "MyApp Bank Account Management";
```

**Good:**
```al
var
    PaymentFieldMapper: Codeunit "MyApp Payment Field Mapper";
    BankAccountManagement: Codeunit "MyApp Bank Account Management";
```

## Error Without Label

**Bad:**
```al
Error('The payment could not be processed');
```

**Good:**
```al
var
    PaymentNotProcessedErr: Label 'The payment could not be processed';
begin
    Error(PaymentNotProcessedErr);
end;
```

## DeleteAll Without Guard

**Bad:**
```al
TempRecord.DeleteAll();
```

**Good:**
```al
if not TempRecord.IsEmpty() then
    TempRecord.DeleteAll();
```

## Hardcoded Secret (Security)

**Bad:**
```al
procedure GetAuthToken(): Text
begin
    exit('Bearer sk-12345-secret-key-here');
end;
```

**Good:**
```al
procedure GetAuthToken() AuthToken: SecretText
var
    IsolatedStorageValue: Text;
begin
    if IsolatedStorage.Get('AUTH_TOKEN', DataScope::Company, IsolatedStorageValue) then
        AuthToken := IsolatedStorageValue;
end;
```

## PII in Telemetry (Security)

**Bad:**
```al
CustomDimension.Add('CustomerEmail', Customer."E-Mail");
CustomDimension.Add('AccountNo', BankAccount.IBAN);
Session.LogMessage('0001', 'Payment processed', Verbosity::Normal, DataClassification::SystemMetadata, TelemetryScope::ExtensionPublisher, CustomDimension);
```

**Good:**
```al
CustomDimension.Add('CustomerNo', Customer."No.");
CustomDimension.Add('BankAccountNo', BankAccount."No.");
Session.LogMessage('0001', 'Payment processed', Verbosity::Normal, DataClassification::SystemMetadata, TelemetryScope::ExtensionPublisher, CustomDimension);
```

## Filter Injection (Security)

**Bad:**
```al
// User enters '*' or '@*a*' — returns all records
Rec.SetFilter(Name, UserInputText);
```

**Good:**
```al
// Parameter substitution escapes filter operators
Rec.SetFilter(Name, '%1', UserInputText);

// Or use SetRange which doesn't interpret operators
Rec.SetRange(Name, UserInputText);
```

## TryFunction Unchecked Return (Safety)

**Bad:**
```al
// Return value silently ignored — error swallowed
TryValidateUrl(InputUrl);
ProcessUrl(InputUrl);
```

**Good:**
```al
if not TryValidateUrl(InputUrl) then begin
    Session.LogMessage('0002', GetLastErrorText(), Verbosity::Error, DataClassification::SystemMetadata, TelemetryScope::ExtensionPublisher);
    Error(InvalidUrlErr);
end;
ProcessUrl(InputUrl);
```

## Missing CalcFields Before FlowField (Safety)

**Bad:**
```al
BankAccount.Get(AccountNo);
AmountValue := BankAccount.Balance;  // FlowField — value is 0!
```

**Good:**
```al
BankAccount.SetLoadFields(Balance);
BankAccount.Get(AccountNo);
BankAccount.CalcFields(Balance);
AmountValue := BankAccount.Balance;
```

## N+1 Query Pattern (Performance)

**Bad:**
```al
// Get() inside loop — N SQL round-trips
if PaymentLine.FindSet() then
    repeat
        BankAccount.Get(PaymentLine."Bank Account No.");
        ProcessWithBank(PaymentLine, BankAccount);
    until PaymentLine.Next() = 0;
```

**Good:**
```al
// Cache before loop — 1 SQL round-trip for all bank accounts
var
    BankAccountCache: Dictionary of [Code[20], Boolean];
begin
    if PaymentLine.FindSet() then
        repeat
            if not BankAccountCache.ContainsKey(PaymentLine."Bank Account No.") then begin
                BankAccount.SetLoadFields("No.", Name);
                BankAccount.Get(PaymentLine."Bank Account No.");
                BankAccountCache.Add(PaymentLine."Bank Account No.", true);
            end;
            ProcessWithBank(PaymentLine, BankAccount);
        until PaymentLine.Next() = 0;
end;
```

## Swallowed Exception (Error Handling)

**Bad:**
```al
// Error caught and silently ignored — no logging, no status update
if not TryProcessPayment(PaymentHeader) then
    exit; // Silent failure — what went wrong?
```

**Good:**
```al
if not TryProcessPayment(PaymentHeader) then begin
    Session.LogMessage('0003', GetLastErrorText(), Verbosity::Error,
        DataClassification::SystemMetadata, TelemetryScope::ExtensionPublisher);
    Error(PaymentProcessingFailedErr);
end;
```

## Test Assert Without Message (Test Quality)

**Bad:**
```al
Assert.AreEqual(ExpectedAmount, ActualAmount, '');
Assert.IsTrue(PaymentHeader.Find(), '');
```

**Good:**
```al
Assert.AreEqual(ExpectedAmount, ActualAmount, 'Payment amount should match invoice total after discount');
Assert.IsTrue(PaymentHeader.Find(), 'Payment header should exist after posting');
```

## Procedure Length Violation (Structure)

**Bad:**
```al
procedure ProcessAllPayments(var PaymentHeader: Record "MyApp Payment Header")
begin
    // 120+ lines of mixed validation, processing, and logging
    // Should be split into focused sub-procedures
end;
```

**Good:**
```al
procedure ProcessAllPayments(var PaymentHeader: Record "MyApp Payment Header")
begin
    ValidatePaymentHeader(PaymentHeader);
    ExecutePaymentProcessing(PaymentHeader);
    LogPaymentResult(PaymentHeader);
end;
```

## TryFunction with Database Write (Error-Handling)

**Bad:**
```al
[TryFunction]
procedure TryCreateEntry(var LedgerEntry: Record "G/L Entry")
begin
    LedgerEntry.Insert(true);  // ← DB write inside TryFunction — transaction rollback on any error
end;
```

**Good:**
```al
[TryFunction]
procedure TryValidateEntry(LedgerEntry: Record "G/L Entry"): Boolean
begin
    // Validation only — no DB writes
    if LedgerEntry."G/L Account No." = '' then
        exit(false);
    exit(true);
end;

procedure CreateEntry(var LedgerEntry: Record "G/L Entry")
begin
    if not TryValidateEntry(LedgerEntry) then
        Error(EntryValidationFailedErr);
    LedgerEntry.Insert(true);  // Write is outside TryFunction
end;
```

## Deleting a Released Public Field (Architecture)

**Bad:**
```al
// Released field removed — breaks extensions referencing it and destroys user personalizations
table 50100 "Sales Summary"
{
    fields
    {
        field(1; "Entry No."; Integer) { }
        // field(2; "Old Amount"; Decimal) { } ← silently deleted
        field(2; "Net Amount"; Decimal) { Caption = 'Net Amount'; }
    }
}
```

**Good:**
```al
table 50100 "Sales Summary"
{
    fields
    {
        field(1; "Entry No."; Integer) { }
        field(2; "Old Amount"; Decimal)
        {
            Caption = 'Old Amount';
            ObsoleteReason = 'Replaced by "Net Amount" field.';
            ObsoleteState = Pending;
            ObsoleteTag = '27.5';
        }
        field(3; "Net Amount"; Decimal) { Caption = 'Net Amount'; }
    }
}
```

## HttpClient Response Used Without Checking IsSuccessStatusCode (Integration)

**Bad:**
```al
procedure FetchExchangeRate(var ResponseBody: Text)
var
    HttpClient: HttpClient;
    HttpResponse: HttpResponseMessage;
begin
    HttpClient.Get('https://api.example.com/rates', HttpResponse);
    HttpResponse.Content.ReadAs(ResponseBody);  // ← body read without checking status
end;
```

**Good:**
```al
procedure FetchExchangeRate(var ResponseBody: Text)
var
    HttpClient: HttpClient;
    HttpResponse: HttpResponseMessage;
begin
    HttpClient.Get('https://api.example.com/rates', HttpResponse);
    if not HttpResponse.IsSuccessStatusCode() then
        Error(ExchangeRateFetchFailedErr, HttpResponse.HttpStatusCode());
    HttpResponse.Content.ReadAs(ResponseBody);
end;
```

---

# False Positives — Do NOT Flag These (verified against real reviews)

Each of these is a tempting-but-wrong finding; each dies to one checkable fact. Internalize them — the verifier exists to catch this class, but discovery agents should not generate it in the first place.

## "Public procedure / widened API" on an `Access = Internal` object
**What was flagged:** an `internal procedure` becoming `procedure`, or non-local procedures "needing `internal`", framed as a breaking-change / API-surface widening.
**Why it's wrong:** the codeunit declared `Access = Internal` (often at line 3). Internal objects have no external surface — nothing widened, and procedures must stay non-local for `InternalsVisibleTo` test access. **Check the object's `Access` property before any visibility/API claim. Objects with no `Access` property are public; `Access = Internal` is not the default.**

## "Missing `Permissions`" on a codeunit that only writes temp tables
**What was flagged:** a codeunit lacking `Permissions = tabledata` "because it has Insert/Modify".
**Why it's wrong:** the only writes were to `temporary` records / temp-table copies, which need no permissions; or the writes were delegated to another codeunit that owns them. **Confirm a direct write to a persisted table first.**

## "Missing `SetLoadFields`" where it's impossible or already present
**What was flagged:** `SetLoadFields` missing before a `Get`/`FindSet`.
**Why it's wrong (several variants):** the record is passed out via `var` (caller may use any field); it's the source/target of `TransferFields` (needs all columns — the fix would zero fields); fields are read by dynamic `RecordRef` field-ID (`SetLoadFields` can't express it — the fix breaks compilation); the table is a tiny setup/singleton; or **`SetLoadFields` was already present just outside the diff hunk** (read the whole procedure). Most `SetLoadFields` findings are false positives — apply the suppression rules before reporting one.

## "Add a `Commit()`" to release a lock held across an HTTP call
**What was flagged:** prescribe a bare mid-flow `Commit()` after a lock-then-HTTP sequence.
**Why it's wrong:** a bare `Commit()` breaks the atomicity of the surrounding transaction — a footgun. The lock concern can be real, but the fix is to **restructure** (slow work first, then lock-modify-commit quickly) or document the trade-off.

## Backwards naming-rule citation (the label-suffix case)
**What was flagged:** a `…IdLbl` label "must use the `Tok` suffix".
**Why it's wrong:** the naming rule *permits* the `Lbl` suffix, and all 8 sibling notification codeunits use the identical pattern. **Read the cited rule file (`al-variable-naming.md`) and check ≥2–3 siblings before asserting a suffix rule. Never assert it from memory.** (Do not cite analyzer codes like `AA0074` at all — CI enforces those authoritatively; the reviewer cites rule files.)

## Invented conventions
- **"Labels must have `MaxLength`"** — no such rule; zero of ~25 labels in the same file used it.
- **"Every feature needs telemetry on enable/disable"** — not a repo convention; all sibling features have none.
- **"Page caption must equal the object name"** — normal BC practice drops the prefix in captions; not a violation.
**Why it's wrong:** none had a rule or sibling backing. **A convention needs a cited rule or ≥2–3 sibling files following it — otherwise it is not a finding.**

## "`case` needs an `else`" when all values are covered
**What was flagged:** a `case` on an option with no `else`.
**Why it's wrong:** all option values (e.g., None/EMU/All) were explicitly handled; an `else` would be dead code. **Enumerate the enum/option values before claiming a missing branch.**

## "Interface getters return empty → blank UI"
**What was flagged:** `GetName`/`GetDescription` returning empty on an `IFeature` implementation.
**Why it's wrong:** those getters are unused dead interface methods; Feature Management populates the UI via a different path (`OnRequestAppFeatureInformation`), and all sibling implementations have the same empty getters. **Trace how the value is actually consumed before claiming a user-visible effect.**

## "Breaking change — deleted/renamed element"
**What was flagged:** a deleted field/procedure as an obsolete-pattern / breaking-change violation.
**Why it's wrong (variants):** the element was **added earlier in the same development cycle** (never released → free to delete); or the object is `Access = Internal` (monorepo-internal, compiler-caught — CRITICAL at most, not BLOCKING). **Confirm release status and Access before flagging.**

## Stale: flagging code that already contains the fix
**What was flagged:** "add `SetLoadFields`" / "guard this `Get`" on code that already had it.
**Why it's wrong:** the reviewer read only the diff hunk, not the surrounding lines. **Read the whole procedure; confirm the fix isn't already present.**
