# Request Entry Management Patterns

Patterns for managing the `CTS-CB Request ID Entry` table which tracks pending async requests.

## Table Structure

The `CTS-CB Request ID Entry` table stores pending async request information:

| Field | Type | Purpose |
|-------|------|---------|
| `EntryID` | Text[50] | Primary key - the status-entry-id from API |
| `BankSystemCode` | Code[30] | Bank system identifier |
| `BankCode` | Code[30] | Bank code |
| `FileType` | Enum | File type (Pain001, CAMT053, etc.) |
| `Type` | Enum | Transaction type |
| `Async Status` | Enum | Current status of the request |
| `BankAccountNo` | Code[20] | Related bank account |
| `PaymentID` | Text[250] | Related payment ID |

---

## Logging New Entries

When an API returns a `status-entry-id`, log it immediately:

```al
procedure LogRequestEntryID(EntryID: Text[50]; BankSystemCode: Code[30];
    BankCode: Code[30]; FileType: Enum "CTS-CB File Type";
    Type: Enum "CTS-CB Transaction Type"; BankAccountNo: Code[20];
    PaymentID: Text[250])
var
    RequestIDEntry: Record "CTS-CB Request ID Entry";
begin
    SetRequestEntryIDValues(RequestIDEntry, EntryID, BankSystemCode, BankCode,
        FileType, Type, Enum::"CTS-CB Async Status"::RecordInserted,
        PaymentID, BankAccountNo);
    InsertStatusEntryID(RequestIDEntry);
end;

local procedure SetRequestEntryIDValues(var RequestIDEntry: Record "CTS-CB Request ID Entry";
    EntryID: Text[50]; BankSystemCode: Code[30]; BankCode: Code[30];
    FileType: Enum "CTS-CB File Type"; Type: Enum "CTS-CB Transaction Type";
    AsyncStatus: Enum "CTS-CB Async Status"; PaymentID: Text[250];
    BankAccountNo: Code[20])
begin
    RequestIDEntry.EntryID := EntryID;
    RequestIDEntry.BankSystemCode := BankSystemCode;
    RequestIDEntry.BankCode := BankCode;
    RequestIDEntry.FileType := FileType;
    RequestIDEntry.Type := Type;
    RequestIDEntry."Async Status" := AsyncStatus;
    RequestIDEntry."Payment ID" := PaymentID;
    RequestIDEntry.BankAccountNo := BankAccountNo;
end;
```

### Usage in Response Handler

```al
// In HandleImportResponse or HandleExportResponse
local procedure HandleResponse(...; var RequestEntryID: Text[50]): Boolean
var
    ResponseJsonObject: JsonObject;
begin
    if not IHttpFactory.GetResponse().IsSuccessStatusCode() then
        exit(false);

    if not ResponseJsonObject.ReadFrom(IHttpFactory.GetResponse().GetResponseBodyAsText()) then
        exit(false);

    // Extract status-entry-id from response
    RequestEntryID := ExtractStatusEntryId(ResponseJsonObject);

    // Log it to Request ID Entry table
    IHttpFactory.GetRequestEntryIDLog().LogRequestEntryID(
        RequestEntryID, BankSystemCode, Bank.Code, FileType,
        TransactionType, BankAccountNo, PaymentID);

    exit(true);
end;

local procedure ExtractStatusEntryId(ResponseJsonObject: JsonObject): Text[50]
var
    Token: JsonToken;
begin
    if ResponseJsonObject.Get('status-entry-id', Token) then
        exit(CopyStr(Token.AsValue().AsText(), 1, 50));
end;
```

---

## Retrieving Uncollected Entries

Before making new requests, always check for uncollected entries from previous operations:

```al
procedure GetUncollectedRequestEntries(Type: Enum "CTS-CB Transaction Type";
    "BankAccountNo.": Code[20]; PaymentID: Text[250]): List of [Text[50]]
var
    RequestIDEntry: Record "CTS-CB Request ID Entry";
    ListOfRequestEntries: List of [Text[50]];
begin
    FilterRequestEntryForUncollectedEntries(RequestIDEntry, Type, "BankAccountNo.", PaymentID);
    LoopRequestEntriesAndAddIDToList(RequestIDEntry, ListOfRequestEntries);
    exit(ListOfRequestEntries);
end;

local procedure FilterRequestEntryForUncollectedEntries(var RequestIDEntry: Record "CTS-CB Request ID Entry";
    Type: Enum "CTS-CB Transaction Type"; BankAccountNo: Code[20]; PaymentID: Text[250])
begin
    RequestIDEntry.SetRange(Type, Type);
    if BankAccountNo <> '' then
        RequestIDEntry.SetRange(BankAccountNo, BankAccountNo);
    if PaymentID <> '' then
        RequestIDEntry.SetRange("Payment ID", PaymentID);
    // Filter for entries that haven't been collected yet
    RequestIDEntry.SetFilter("Async Status", '%1|%2',
        Enum::"CTS-CB Async Status"::RecordInserted,
        Enum::"CTS-CB Async Status"::Pending);
end;
```

### Processing Old Entries in Export

```al
procedure GetResponseFromOldAsyncStatusEntries(IHttpFactory: Interface "CTS-CB IHttpFactory";
    TransactionType: Enum "CTS-CB Transaction Type")
begin
    // Process any pending payment entries
    IHttpFactory.GetRequestEntryIDLog().GetUncollectedRequestEntriesInNewSession(
        TransactionType, '', '');
end;
```

### Processing Old Entries in Import

```al
procedure GetResponseFromOldAsyncStatusEntries(IHttpFactory: Interface "CTS-CB IHttpFactory";
    Bank: Record "CTS-CB Bank"; BankSystemCode: Code[30]; BankAccountNo: Code[20];
    TransactionType: Enum "CTS-CB Transaction Type"; FileType: Enum "CTS-CB File Type")
    FoundEntries: Boolean
var
    RequestIDEntry: Record "CTS-CB Request ID Entry";
    RequestEntryID: Text[50];
begin
    foreach RequestEntryID in IHttpFactory.GetRequestEntryIDLog().GetUncollectedRequestEntries(
        TransactionType, BankAccountNo, '') do begin
        FoundEntries := true;

        // Use no-backoff for old entries (they should be ready)
        IHttpFactory.GetRequestEntryIDLog().GetAsyncRequestEntryResponseNoBackOff(
            IHttpFactory, BankSystemCode, RequestEntryID);

        // Load entry to get actual values (may differ from parameters)
        RequestIDEntry.SetLoadFields(BankSystemCode, FileType, EntryID, Type);
        if RequestIDEntry.Get(RequestEntryID, BankSystemCode) then
            IHttpFactory.GetResponseHandling().HandleRequestEntryStatusResponse(
                IHttpFactory.GetAuthenticationFactory(), Bank,
                RequestIDEntry.BankSystemCode, RequestIDEntry.FileType,
                RequestIDEntry.EntryID, RequestIDEntry.Type, IHttpFactory);
    end;
end;
```

---

## Processing in New Session

For background processing of old entries:

```al
procedure GetUncollectedRequestEntriesInNewSession(Type: Enum "CTS-CB Transaction Type";
    BankAccountNo: Code[20]; PaymentID: Text[250])
var
    RequestIDEntry: Record "CTS-CB Request ID Entry";
    SessionID: Integer;
begin
    FilterRequestEntryForUncollectedEntries(RequestIDEntry, Type, BankAccountNo, PaymentID);
    if RequestIDEntry.FindSet() then
        StartSession(SessionID, Codeunit::"CTS-CB GetRequestEntryIDs", CompanyName(), RequestIDEntry);
end;
```

---

## Deleting Entries After Processing

After successfully processing a response, delete the entry:

```al
local procedure DeleteRecord(EntryID: Text[50]; BankSystemCode: Code[30])
var
    RequestIDEntry: Record "CTS-CB Request ID Entry";
begin
    if RequestIDEntry.Get(EntryID, BankSystemCode) then
        RequestIDEntry.Delete();
end;
```

### Complete Cleanup Pattern

```al
procedure ConfirmDownloadOfRequestEntryID(EntryID: Text[50];
    IHttpFactory: Interface "CTS-CB IHttpFactory"; BankSystemCode: Code[30])
var
    RequestIDEntry: Record "CTS-CB Request ID Entry";
    HttpRequestMessageType: HttpRequestMessage;
begin
    if GetRequestEntryRecord(RequestIDEntry, EntryID, BankSystemCode) then
        if IsInCompletedOrUnknown(RequestIDEntry."Async Status") then begin
            // 1. Tell API we're done with this entry
            IHttpFactory.GetBuildRequestFactory().SetHttpRequestMessageURL(
                HttpRequestMessageType,
                StrSubstNo(IHttpFactory.GetUrlInterface().GetUrl('DeleteAsyncStatus'), ...));
            RequestEntryIDRequest(IHttpFactory, HttpRequestMessageType, EntryID);

            // 2. Delete local record
            DeleteRecord(EntryID, BankSystemCode);
        end;
end;

local procedure IsInCompletedOrUnknown(AsyncStatus: Enum "CTS-CB Async Status"): Boolean
begin
    exit(AsyncStatus in [Enum::"CTS-CB Async Status"::Completed,
                         Enum::"CTS-CB Async Status"::Unknown]);
end;
```

---

## Async Status Flow

```
RecordInserted → Pending → Completed → [Deleted]
                    ↓
                  Failed
```

| Status | Description | Next Action |
|--------|-------------|-------------|
| `RecordInserted` | Just logged, not polled yet | Poll with GetAsyncRequestEntryResponse |
| `Pending` | Polled, response not ready | Poll again |
| `Completed` | Response ready and processed | Call ConfirmDownloadOfRequestEntryID |
| `Unknown` | Status unclear, treated as completed | Call ConfirmDownloadOfRequestEntryID |
| `Failed` | Request failed | Handle error, may retry |

---

## Best Practices

1. **Always log immediately** - Log status-entry-id right after receiving it
2. **Process old entries first** - Check for uncollected entries before new requests
3. **Use NoBackOff for old entries** - They're already ready, no need to wait
4. **Always confirm download** - Clean up both API-side and local records
5. **Use LoadFields** - When reading entries, load only needed fields
6. **Handle all transaction types** - Different transaction types may have separate entries
