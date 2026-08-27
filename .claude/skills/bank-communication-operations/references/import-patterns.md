# Import Codeunit Patterns

Complete implementation patterns for bank statement/status import codeunits.

## Table of Contents

- [Codeunit Shell](#codeunit-shell)
- [Import Implementation (Payment Status)](#import-implementation-payment-status)
- [DoImportCall Implementation](#doimportcall-implementation)
- [Request Header (Status Query)](#request-header-status-query)
- [IResponseHandling Implementation](#iresponsehandling-implementation)
  - [HandleResponse](#handleresponse)
  - [HandleRequestEntryStatusResponse](#handlerequestentrystatusresponse)
  - [HandleErrorResponse](#handleerrorresponse)
- [RequestEntryStatusResponse (Core Logic)](#requestentrystatusresponse-core-logic)
- [Custom Error Handling](#custom-error-handling)
- [Response Processing and Confirmation](#response-processing-and-confirmation)
- [Old Async Entry Processing](#old-async-entry-processing)
- [Error Response Handling](#error-response-handling)
- [Helper Functions](#helper-functions)
- [Account Statement Import](#account-statement-import-first-overload)

## Codeunit Shell

```al
codeunit 71553XXX "CTS-CB {BankName} Import" implements "CTS-CB ICommunicationType Import", "CTS-CB IResponseHandling"
{
    Access = Internal;

    #region ICommunicationType Import Interface Functions
    procedure Import(Bank: Record "CTS-CB Bank"; BankAccount: Record "Bank Account";
        TransactionType: Enum "CTS-CB Transaction Type"; FileType: Enum "CTS-CB File Type";
        IHttpFactory: Interface "CTS-CB IHttpFactory"): Boolean
    begin
        // Account statement import (or empty if not supported)
    end;

    procedure Import(Bank: Record "CTS-CB Bank"; BankAccount: Record "Bank Account";
        TransactionType: Enum "CTS-CB Transaction Type"; FileType: Enum "CTS-CB File Type";
        IHttpFactory: Interface "CTS-CB IHttpFactory"; RecordRef: RecordRef): Boolean
    begin
        // Payment status import
    end;
    #endregion

    #region IResponseHandling Interface functions
    procedure HandleResponse(...): Boolean;
    procedure HandleRequestEntryStatusResponse(...): Boolean;
    procedure HandleErrorResponse(...);
    #endregion

    var
        {BankName}Auth: Codeunit "CTS-CB {BankName} Auth";
        BankAccComSetup: Codeunit "CTS-CB Bank Acc. Com. Setup";
        JsonFunctions: Codeunit "CTS-CB Json Functions";
}
```

## Import Implementation (Payment Status)

```al
procedure Import(Bank: Record "CTS-CB Bank"; BankAccount: Record "Bank Account";
    TransactionType: Enum "CTS-CB Transaction Type"; FileType: Enum "CTS-CB File Type";
    IHttpFactory: Interface "CTS-CB IHttpFactory"; RecordRef: RecordRef): Boolean
var
    PaymentRegister: Record "CTS-CB Payment Register";
    BankSystemCode: Code[30];
    FieldId: Integer;
    PaymentBatchID: Text[75];
begin
    // 1. Extract Payment Batch ID from RecordRef if provided
    FieldId := PaymentRegister.FieldNo("Payment Batch ID");
    if Format(RecordRef) <> '' then
        PaymentBatchID := RecordRef.Field(FieldId).Value();

    // 2. Register this codeunit as response handler
    IHttpFactory.SetResponseHandling(this);

    // 3. Get bank system code for import
    BankSystemCode := BankAccComSetup.GetSystemTypeCodeForImport(
        TransactionType, FileType, BankAccount."No.");

    // 4. Process old payment async entries first
    GetResponseFromOldPaymentAsyncStatusEntries(IHttpFactory);

    // 5. Process old import async entries - if found, skip new call
    if not GetResponseFromOldAsyncStatusEntries(IHttpFactory, Bank, BankSystemCode,
        BankAccount."No.", TransactionType, FileType, '') then
        // 6. No old entries - make new import call
        exit(DoImportCall(Bank, TransactionType, FileType, IHttpFactory, BankSystemCode,
            BankAccount."No.", PaymentBatchID));
end;
```

## DoImportCall Implementation

```al
procedure DoImportCall(Bank: Record "CTS-CB Bank"; TransactionType: Enum "CTS-CB Transaction Type";
    FileType: Enum "CTS-CB File Type"; IHttpFactory: Interface "CTS-CB IHttpFactory";
    BankSystemCode: Code[30]; BankAccountNo: Code[20]; PaymentId: Text[75]): Boolean
var
    HttpRequestMessageType: HttpRequestMessage;
    RequestEntryID: Text[50];
    TracingID: Text[50];
begin
    // 1. Set authentication handler
    IHttpFactory.SetICommunicationTypeAuth({BankName}Auth);

    // 2. Generate tracing ID
    TracingID := IHttpFactory.GetTracingIDLog().GetTracingID();

    // 3. Build request with payment ID for status lookup
    IHttpFactory.GetBuildRequestFactory().SetHttpRequestMessageContent(
        HttpRequestMessageType,
        RequestHeader(Bank, IHttpFactory, TracingID, BankSystemCode, FileType,
            TransactionType, PaymentId));

    // 4. Set URL to payment status endpoint
    IHttpFactory.GetBuildRequestFactory().SetHttpRequestMessageURL(
        HttpRequestMessageType,
        StrSubstNo(IHttpFactory.GetUrlInterface().GetUrl('GetPaymentStatus'),
            IHttpFactory.GetCommunicationTypeUrlValue(
                GetBankSystem(BankSystemCode)."Communication Type").GetUrlValue(BankSystemCode)));

    // 5. Execute POST
    IHttpFactory.GetHttp().Post(HttpRequestMessageType, true, IHttpFactory, TransactionType);

    // 6. Log tracing
    IHttpFactory.GetTracingIDLog().LogTracingIDNewInSession(
        CopyStr(HttpRequestMessageType.GetRequestUri(), 1, 1024), TracingID);

    // 7. Handle response via interface
    if IHttpFactory.GetResponseHandling().HandleResponse(
        IHttpFactory, IHttpFactory.GetAuthenticationFactory(),
        IHttpFactory.GetFileArchiveFactory(), IHttpFactory.GetRequestEntryIDLog(),
        Bank, BankSystemCode, TransactionType, FileType, BankAccountNo, RequestEntryID) then begin
        // 8. Poll for actual response
        IHttpFactory.GetRequestEntryIDLog().GetAsyncRequestEntryResponse(
            IHttpFactory, BankSystemCode, RequestEntryID);
        // 9. Process status response
        exit(IHttpFactory.GetResponseHandling().HandleRequestEntryStatusResponse(
            IHttpFactory.GetAuthenticationFactory(), Bank, BankSystemCode, FileType,
            RequestEntryID, TransactionType, IHttpFactory));
    end;
end;
```

## Request Header (Status Query)

```al
procedure RequestHeader(Bank: Record "CTS-CB Bank"; IHttpFactory: Interface "CTS-CB IHttpFactory";
    TracingID: Text[50]; BankSystemCode: Code[30]; FileType: Enum "CTS-CB File Type";
    TransactionType: Enum "CTS-CB Transaction Type"; PaymentID: Text[75]) Result: Text
var
    RequestHeaderMapping: Record "CTS-CB Request Header Mapping";
    BuildRequest: Codeunit "CTS-CB Build Request";
    HeaderValues: Dictionary of [Text, Text];
    Json: JsonObject;
begin
    SetRequestHeaderMappingFilter(BankSystemCode, RequestHeaderMapping);
    Populate(RequestHeaderMapping, Bank, HeaderValues, Bank.RecordId().TableNo());

    // Add payment ID for status lookup
    AddBankSpecificValues(Json, PaymentID);

    BuildRequest.CreateAuthentication(Json, BankSystemCode, Bank, IHttpFactory,
        HeaderValues, TransactionType);
    BuildRequest.CreateRootValues(Json, HeaderValues, TracingID,
        IHttpFactory.GetBuildRequestFactory());

    Json.WriteTo(Result);
end;

procedure AddBankSpecificValues(var Json: JsonObject; PaymentID: Text[75])
begin
    Json.Add('payment-id', PaymentID);
end;
```

## IResponseHandling Implementation

### HandleResponse

```al
procedure HandleResponse(IHttpFactory: Interface "CTS-CB IHttpFactory";
    IAuthenticationFactory: Interface "CTS-CB IAuthentication Factory";
    IFileArchiveFactory: Interface "CTS-CB IFile Archive Factory";
    IRequestEntryID: Interface "CTS-CB IRequestEntryID";
    Bank: Record "CTS-CB Bank"; BankSystemCode: Code[30];
    TransactionType: Enum "CTS-CB Transaction Type"; FileType: Enum "CTS-CB File Type";
    BankAccountNo: Code[20]; var RequestEntryID: Text[50]): Boolean
begin
    exit(IHttpFactory.GetRequestEntryIDLog().HandleImportResponse(
        IAuthenticationFactory, Bank, BankSystemCode, FileType, IHttpFactory,
        RequestEntryID, TransactionType, BankAccountNo));
end;
```

### HandleRequestEntryStatusResponse

```al
procedure HandleRequestEntryStatusResponse(IAuthenticationFactory: Interface "CTS-CB IAuthentication Factory";
    Bank: Record "CTS-CB Bank"; BankSystemCode: Code[30]; FileType: Enum "CTS-CB File Type";
    RequestEntryId: Text[50]; TransactionType: Enum "CTS-CB Transaction Type";
    IHttpFactory: Interface "CTS-CB IHttpFactory"): Boolean
begin
    exit(RequestEntryStatusResponse(IAuthenticationFactory, Bank, BankSystemCode, FileType,
        RequestEntryId, TransactionType, IHttpFactory));
end;
```

### HandleErrorResponse

```al
procedure HandleErrorResponse(IAuthenticationFactory: Interface "CTS-CB IAuthentication Factory";
    Bank: Record "CTS-CB Bank"; BankSystemCode: Code[30]; FileType: Enum "CTS-CB File Type";
    IHttpFactory: Interface "CTS-CB IHttpFactory"; ThrowError: Boolean)
begin
    ErrorResponse(Bank, BankSystemCode, FileType, IHttpFactory, ThrowError);
end;
```

## RequestEntryStatusResponse (Core Logic)

```al
procedure RequestEntryStatusResponse(IAuthenticationFactory: Interface "CTS-CB IAuthentication Factory";
    Bank: Record "CTS-CB Bank"; BankSystemCode: Code[30]; FileType: Enum "CTS-CB File Type";
    RequestEntryId: Text[50]; TransactionType: Enum "CTS-CB Transaction Type";
    IHttpFactory: Interface "CTS-CB IHttpFactory"): Boolean
var
    ResponseJsonArray: JsonArray;
    ResponseJsonObject: JsonObject;
begin
    // 1. Check HTTP success status
    if not IsSuccessResponse(IHttpFactory) then
        IHttpFactory.GetResponseHandling().HandleErrorResponse(
            IAuthenticationFactory, Bank, BankSystemCode, FileType, IHttpFactory, true)
    else
        // 2. Parse JSON response
        if ResponseJsonObject.ReadFrom(IHttpFactory.GetResponse().GetResponseBodyAsText()) then begin
            // 3. Decode content to JSON array
            if DecodeContent(IHttpFactory, ResponseJsonObject, ResponseJsonArray) then
                // 4. Check for errors in response
                if ContainsErrors(ResponseJsonObject) then begin
                    // 5. Apply custom error handling rules
                    if HandleAsError(IHttpFactory, ResponseJsonObject, BankSystemCode) then
                        IHttpFactory.GetResponseHandling().HandleErrorResponse(
                            IAuthenticationFactory, Bank, BankSystemCode, FileType, IHttpFactory, true)
                    else begin
                        // Error ignored by rule - continue processing
                        IHttpFactory.GetResponseHandling().HandleErrorResponse(
                            IAuthenticationFactory, Bank, BankSystemCode, FileType, IHttpFactory, false);
                        exit(HandleResponseAndConfirmDownloadOfRequestEntry(
                            Bank, BankSystemCode, FileType, RequestEntryId, TransactionType,
                            IHttpFactory, ResponseJsonObject));
                    end;
                end else
                    // 6. No errors - process normally
                    exit(HandleResponseAndConfirmDownloadOfRequestEntry(
                        Bank, BankSystemCode, FileType, RequestEntryId, TransactionType,
                        IHttpFactory, ResponseJsonObject));
        end else
            JsonFunctions.CannotReadJSON(IHttpFactory, Bank, BankSystemCode, FileType);
end;
```

## Custom Error Handling

```al
procedure ContainsErrors(ResponseJsonObject: JsonObject): Boolean
begin
    exit(ResponseJsonObject.Contains('errors'));
end;

procedure HandleAsError(IHttpFactory: Interface "CTS-CB IHttpFactory";
    var ResponseJsonObject: JsonObject; BankSystemCode: Code[30]): Boolean
var
    MessageJsonToken: JsonToken;
begin
    if GetMessage(ResponseJsonObject, MessageJsonToken) then
        exit(HandleError(IHttpFactory, BankSystemCode, MessageJsonToken, ResponseJsonObject));
    exit(false);
end;

procedure GetMessage(ResponseJsonObject: JsonObject; var MessageJsonToken: JsonToken): Boolean
begin
    exit(ResponseJsonObject.Get('message', MessageJsonToken));
end;

procedure HandleError(IHttpFactory: Interface "CTS-CB IHttpFactory"; BankSystemCode: Code[30];
    MessageJsonToken: JsonToken; var ResponseJsonObject: JsonObject): Boolean
var
    NewErrorText: Text;
begin
    // Check if custom rule exists for this bank and error message
    if IHttpFactory.GetCustomErrorHandling3().DoesAlternativeRuleExistForBankSystem(
        BankSystemCode, MessageJsonToken.AsValue().AsText()) then begin

        // Rule says ignore this error completely
        if IHttpFactory.GetCustomErrorHandling3().IgnoreError(
            BankSystemCode, MessageJsonToken.AsValue().AsText()) then
            exit(false);

        // Rule says replace error text
        if IHttpFactory.GetCustomErrorHandling3().GetAlternativeErrorText(
            NewErrorText, BankSystemCode, MessageJsonToken.AsValue().AsText()) then begin
            ResponseJsonObject.Replace('message', NewErrorText);
            IHttpFactory.GetResponse().SetErrorResponseBodyAsText(Format(ResponseJsonObject));
        end;
        exit(true);
    end;

    // No custom rule - treat as normal error
    exit(true);
end;
```

## Response Processing and Confirmation

```al
procedure HandleResponseAndConfirmDownloadOfRequestEntry(var Bank: Record "CTS-CB Bank";
    BankSystemCode: Code[30]; var FileType: Enum "CTS-CB File Type"; RequestEntryId: Text[50];
    var TransactionType: Enum "CTS-CB Transaction Type";
    var IHttpFactory: Interface "CTS-CB IHttpFactory";
    var ResponseJsonObject: JsonObject): Boolean
begin
    // Archive response
    HandleRequestEntryResponseObject(IHttpFactory, ResponseJsonObject, Bank.Code,
        BankSystemCode, FileType, TransactionType);

    // Confirm download completed
    IHttpFactory.GetRequestEntryIDLog().ConfirmDownloadOfRequestEntryID(
        RequestEntryId, IHttpFactory, BankSystemCode);

    exit(true);
end;

procedure HandleRequestEntryResponseObject(IHttpFactory: Interface "CTS-CB IHttpFactory";
    ResponseJsonObject: JsonObject; BankCode: Code[30]; BankSystemCode: Code[30];
    FileType: Enum "CTS-CB File Type"; TransactionType: Enum "CTS-CB Transaction Type")
begin
    IHttpFactory.GetFileArchiveFactory().GetInsertFileArchive().InsertInNewSession(
        IHttpFactory.GetLogFactory(), ResponseJsonObject, TransactionType, FileType,
        BankCode, BankSystemCode, '', Enum::"CTS-CB File Direction"::Import, false);
end;
```

## `Import` returning true proves nothing — assert on downstream artifacts

The import codeunit's job **ends at the File Archive**. `HandleRequestEntryResponseObject`
above inserts the raw base64/JSON blob and the codeunit returns `true`. Turning a CAMT.053
into `CTS-PI Bank Transac. Header`/`Line` rows, or a custom-status blob into
`CTS-PE Payment Status Entry` rows, is a **second Continia Online round-trip** — made by
`FileConversion.Codeunit.al:25` via `ProcessFiles.Codeunit.al:26`, *not* by the import
codeunit.

**That second step fails silently.** On a conversion failure `ProcessFiles.Codeunit.al:26-29`
sets `"Processing Error" := true` and `"Processing Error Message"`, then falls straight through
to `SetProcessed` / `FileArchive.Modify()` / `Commit()` at `:31-35` — with a comment stating the
commit is deliberate, so the next record's failure doesn't roll this one back. **No `Error` is
raised anywhere on that path**, and the entry is marked processed either way. A failed
conversion is indistinguishable from a successful one at the import codeunit's return value.

Consequences worth designing around:

- **Never write a test whose only assertion is that `Import` returned true.** Assert on the
  downstream rows — bank transactions, payment status entries — or on
  `"Processing Error"`/`"Processing Error Message"` on the File Archive entry.
- **Cross-app test placement is forced by this.** `CTS-PI Bank Transac. Header`/`Line` live in
  the Import app and `CTS-PE Payment Status Entry` in the Export app, so downstream assertions
  cannot be made from `base-application-test` — check the `app.json` dependency graph and put
  those tests in `import-test`/`export-test`.
- **Conversion support is a per-(bank system, file type) connector capability.** If Continia
  Online has no `Convert` route for a pairing, imports appear to succeed forever and no data
  ever lands. Treat it as an explicit go-live prerequisite to confirm, not an assumption.
- The `Convert` URL row already exists globally (`GeneralData.json`, key `"Convert"`), so a
  missing capability is a connector-side gap, not a missing setup row.

## Old Async Entry Processing

```al
procedure GetResponseFromOldPaymentAsyncStatusEntries(IHttpFactory: Interface "CTS-CB IHttpFactory")
begin
    IHttpFactory.GetRequestEntryIDLog().GetUncollectedRequestEntriesInNewSession(
        Enum::"CTS-CB Transaction Type"::Payment, '', '');
end;

procedure GetResponseFromOldAsyncStatusEntries(IHttpFactory: Interface "CTS-CB IHttpFactory";
    Bank: Record "CTS-CB Bank"; BankSystemCode: Code[30]; "BankAccountNo.": Code[20];
    TransactionType: Enum "CTS-CB Transaction Type"; FileType: Enum "CTS-CB File Type"): Boolean
begin
    exit(GetResponseFromOldAsyncStatusEntries(IHttpFactory, Bank, BankSystemCode,
        "BankAccountNo.", TransactionType, FileType, ''));
end;

procedure GetResponseFromOldAsyncStatusEntries(IHttpFactory: Interface "CTS-CB IHttpFactory";
    Bank: Record "CTS-CB Bank"; BankSystemCode: Code[30]; "BankAccountNo.": Code[20];
    TransactionType: Enum "CTS-CB Transaction Type"; FileType: Enum "CTS-CB File Type";
    PaymentID: Text[50]) FoundEntries: Boolean
var
    RequestIDEntry: Record "CTS-CB Request ID Entry";
    RequestEntryID: Text[50];
begin
    foreach RequestEntryID in IHttpFactory.GetRequestEntryIDLog().GetUncollectedRequestEntries(
        TransactionType, "BankAccountNo.", PaymentID) do begin
        FoundEntries := true;

        // Poll without backoff for old entries
        IHttpFactory.GetRequestEntryIDLog().GetAsyncRequestEntryResponseNoBackOff(
            IHttpFactory, BankSystemCode, RequestEntryID);

        // Load actual values from request entry (may differ from parameters)
        RequestIDEntry.SetLoadFields(BankSystemCode, FileType, EntryID, Type);
        if RequestIDEntry.Get(RequestEntryID, BankSystemCode) then
            IHttpFactory.GetResponseHandling().HandleRequestEntryStatusResponse(
                IHttpFactory.GetAuthenticationFactory(), Bank,
                RequestIDEntry.BankSystemCode, RequestIDEntry.FileType,
                RequestIDEntry.EntryID, RequestIDEntry.Type, IHttpFactory);
    end;
end;
```

## Error Response Handling

```al
procedure ErrorResponse(var Bank: Record "CTS-CB Bank"; BankSystemCode: Code[30];
    FileType: Enum "CTS-CB File Type"; IHttpFactory: Interface "CTS-CB IHttpFactory";
    ThrowError: Boolean)
var
    ErrorMsg: Text;
begin
    GetErrorText(IHttpFactory, ErrorMsg);

    // Archive error response
    IHttpFactory.GetFileArchiveFactory().GetInsertFileArchive().InsertInNewSession(
        IHttpFactory.GetLogFactory(), IHttpFactory.GetResponse().GetResponseBodyAsText(),
        "CTS-CB Transaction Type"::Error, FileType, Bank.Code, BankSystemCode, '',
        Enum::"CTS-CB File Direction"::Import, true);

    if ThrowError then
        Error(ErrorMsg);
end;

procedure GetErrorText(IHttpFactory: Interface "CTS-CB IHttpFactory"; var ErrorMsg: Text)
var
    ResponseJsonObject: JsonObject;
    FallbackErrorMsg: Label 'An error occurred while importing the file.';
begin
    if ResponseJsonObject.ReadFrom(IHttpFactory.GetResponse().GetResponseBodyAsText()) then
        IHttpFactory.GetErrorHandlingFactory().GetErrorTexts(ErrorMsg, ResponseJsonObject)
    else
        ErrorMsg := FallbackErrorMsg;
end;
```

## Helper Functions

```al
procedure IsSuccessResponse(IHttpFactory: Interface "CTS-CB IHttpFactory"): Boolean
begin
    exit(IHttpFactory.GetResponse().IsSuccessStatusCode());
end;

procedure DecodeContent(IHttpFactory: Interface "CTS-CB IHttpFactory";
    var ResponseJsonObject: JsonObject; var ResponseJsonArray: JsonArray): Boolean
begin
    exit(IHttpFactory.GetErrorHandlingFactory().GetContentDecodedAsJsonArray(
        ResponseJsonObject, ResponseJsonArray));
end;

local procedure GetBankSystem(BankSystemCode: Code[30]) BankSystem: Record "CTS-CB Bank System"
begin
    BankSystem.Get(BankSystemCode);
end;

procedure Populate(var RequestHeaderMapping: Record "CTS-CB Request Header Mapping";
    ValueVariant: Variant; var HeaderValues: Dictionary of [Text, Text]; TableNo: Integer)
var
    PopulateRequestHeader: Codeunit "CTS-CB Populate Request Header";
begin
    PopulateRequestHeader.GetValuesFromTable(RequestHeaderMapping, ValueVariant, HeaderValues, TableNo);
end;

procedure SetRequestHeaderMappingFilter(BankSystemCode: Code[30];
    var RequestHeaderMapping: Record "CTS-CB Request Header Mapping")
begin
    RequestHeaderMapping.SetRange("Bank System Code", BankSystemCode);
end;
```

## Account Statement Import (First Overload)

If the bank supports account statement import:

```al
procedure Import(Bank: Record "CTS-CB Bank"; BankAccount: Record "Bank Account";
    TransactionType: Enum "CTS-CB Transaction Type"; FileType: Enum "CTS-CB File Type";
    IHttpFactory: Interface "CTS-CB IHttpFactory"): Boolean
begin
    // Implement similar to payment status, but:
    // - Use GetReports/GetReport endpoints
    // - Process CAMT053/MT940 file content
    // - Archive imported statements

    // If not supported:
    // Not Supported by {BankName}
end;
```
