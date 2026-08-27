# Export Codeunit Patterns

Complete implementation patterns for bank payment export codeunits.

## Table of Contents

- [Codeunit Shell](#codeunit-shell)
- [SendPayment Implementation](#sendpayment-implementation)
- [Request Header with Payload](#request-header-with-payload)
- [HandleRequestIDResponse Implementation](#handlerequestidresponse-implementation)
- [Response Content Archiving](#response-content-archiving)
- [Payment Batch ID Extraction](#payment-batch-id-extraction)
- [Payment Status Update](#payment-status-update)
- [Error Handling](#error-handling)
- [Helper Procedures](#helper-procedures)
- [Bank-Specific Values](#bank-specific-values)
- [SendDirectDebit Pattern](#senddirectdebit-pattern)

## Codeunit Shell

```al
codeunit 71553XXX "CTS-CB {BankName} Export" implements "CTS-CB ICommunicationType Export", "CTS-CB IResponseExportHandling"
{
    Access = Internal;

    #region Interface functions
    procedure SendPayment(DataRecordRef: RecordRef; Bank: Record "CTS-CB Bank";
        TransactionType: Enum "CTS-CB Transaction Type"; FileType: Enum "CTS-CB File Type";
        Payload: Text; IHttpFactory: Interface "CTS-CB IHttpFactory"; PaymentID: Text[250])
    begin
        // Implementation
    end;

    procedure SendDirectDebit(DataRecordRef: RecordRef; Bank: Record "CTS-CB Bank";
        TransactionType: Enum "CTS-CB Transaction Type"; FileType: Enum "CTS-CB File Type";
        Payload: Text; IHttpFactory: Interface "CTS-CB IHttpFactory"; PaymentID: Text[250])
    begin
        // Implementation (or empty if not supported)
    end;

    procedure HandleRequestIDResponse(IAuthenticationFactory: Interface "CTS-CB IAuthentication Factory";
        Bank: Record "CTS-CB Bank"; BankSystemCode: Code[30]; FileType: Enum "CTS-CB File Type";
        RequestEntryId: Text[50]; IHttpFactory: Interface "CTS-CB IHttpFactory") ResponseJsonObject: JsonObject
    begin
        // Implementation
    end;
    #endregion Interface functions

    var
        BankAccComSetup: Codeunit "CTS-CB Bank Acc. Com. Setup";
        JsonFunctions: Codeunit "CTS-CB Json Functions";
}
```

## SendPayment Implementation

```al
procedure SendPayment(DataRecordRef: RecordRef; Bank: Record "CTS-CB Bank";
    TransactionType: Enum "CTS-CB Transaction Type"; FileType: Enum "CTS-CB File Type";
    Payload: Text; IHttpFactory: Interface "CTS-CB IHttpFactory"; PaymentID: Text[250])
var
    PaymentEntry: Record "CTS-CB Payment Entry";
    BankSystemCode: Code[30];
    HttpRequestMessageType: HttpRequestMessage;
    HttpRequestErr: Label 'HTTP Request failed with error code: %1, and error message: %2',
        Comment = '%1 = Last Error Code, %2 = last error message';
    RequestEntryID: Text[50];
    TracingID: Text[50];
begin
    // 1. Register this codeunit as response handler
    IHttpFactory.SetResponseExportHandling(this);

    // 2. Generate tracing ID
    TracingID := IHttpFactory.GetTracingIDLog().GetTracingID();

    // 3. Extract payment entry and get bank system code
    DataRecordRef.SetTable(PaymentEntry);
    BankSystemCode := BankAccComSetup.GetSystemTypeCodeForExport(
        TransactionType, FileType, PaymentEntry."Bank Account Record No.",
        PaymentEntry."Std Payment Method Code");

    // 4. Process any old uncollected async entries first
    GetResponseFromOldAsyncStatusEntries(IHttpFactory, TransactionType);

    // 5. Build HTTP request with payload
    IHttpFactory.GetBuildRequestFactory().SetHttpRequestMessageContent(
        HttpRequestMessageType,
        RequestHeader(Bank, IHttpFactory, TracingID, FileType, Payload, TransactionType,
            PaymentEntry."End To End Id", BankSystemCode));

    // 6. Set URL to send endpoint
    IHttpFactory.GetBuildRequestFactory().SetHttpRequestMessageURL(
        HttpRequestMessageType,
        StrSubstNo(IHttpFactory.GetUrlInterface().GetUrl('Send'),
            IHttpFactory.GetCommunicationTypeUrlValue(
                GetBankSystem(BankSystemCode)."Communication Type").GetUrlValue(BankSystemCode)));

    // 7. Execute POST request
    if not IHttpFactory.GetHttp().Post(HttpRequestMessageType, true, IHttpFactory, TransactionType) then begin
        IHttpFactory.GetTelemetryLog().LogError();
        Error(ErrorInfo.Create(StrSubstNo(HttpRequestErr, GetLastErrorCode(), GetLastErrorText()), true));
    end;

    // 8. Log tracing
    IHttpFactory.GetTracingIDLog().LogTracingIDNewInSession(
        CopyStr(HttpRequestMessageType.GetRequestUri(), 1, 1024), TracingID);

    // 9. Handle async response
    if HandleResponse(IHttpFactory.GetAuthenticationFactory(), Bank, BankSystemCode, FileType,
        IHttpFactory, RequestEntryID, TransactionType, PaymentID) then begin
        // 10. Poll for actual response
        IHttpFactory.GetRequestEntryIDLog().GetAsyncRequestEntryResponse(
            IHttpFactory, BankSystemCode, RequestEntryID);
        // 11. Process the response
        HandleRequestIDResponse(IHttpFactory.GetAuthenticationFactory(), Bank, BankSystemCode,
            FileType, RequestEntryID, IHttpFactory);
    end;
end;
```

## Request Header with Payload

```al
procedure RequestHeader(Bank: Record "CTS-CB Bank"; IHttpFactory: Interface "CTS-CB IHttpFactory";
    TracingID: Text[50]; FileType: Enum "CTS-CB File Type"; Payload: Text;
    TransactionType: Enum "CTS-CB Transaction Type"; PaymentId: Text[35];
    BankSystemCode: Code[30]) Result: Text
var
    RequestHeaderMapping: Record "CTS-CB Request Header Mapping";
    BuildRequest: Codeunit "CTS-CB Build Request";
    BankSpecificValues: Dictionary of [Text, Text];
    HeaderValues: Dictionary of [Text, Text];
    Json: JsonObject;
begin
    // Get field mappings for this bank system
    SetRequestHeaderMappingFilter(BankSystemCode, RequestHeaderMapping);
    Populate(RequestHeaderMapping, Bank, HeaderValues, Bank.RecordId().TableNo());

    // Build authentication section
    BuildRequest.CreateAuthentication(Json, BankSystemCode, Bank, IHttpFactory,
        HeaderValues, TransactionType);

    // Add standard root values (transaction-id, company-guid, bc-user-name)
    BuildRequest.CreateRootValues(Json, BankSpecificValues, TracingID,
        IHttpFactory.GetBuildRequestFactory());

    // Add payload with file type and payment ID
    BuildRequest.CreatePayload(Json, Payload,
        CopyStr(FileType.Names().Get(FileType.Ordinals().IndexOf(FileType.AsInteger())), 1, 50),
        PaymentId);

    Json.WriteTo(Result);
end;
```

## HandleRequestIDResponse Implementation

```al
procedure HandleRequestIDResponse(IAuthenticationFactory: Interface "CTS-CB IAuthentication Factory";
    Bank: Record "CTS-CB Bank"; BankSystemCode: Code[30]; FileType: Enum "CTS-CB File Type";
    RequestEntryId: Text[50]; IHttpFactory: Interface "CTS-CB IHttpFactory") ResponseJsonObject: JsonObject
var
    CommHelperFunctions: Codeunit "CTS-CB Comm Helper Functions";
    MessageId: Text[35];
    PaymentBatchID: Text[75];
begin
    // 1. Check for error response
    if not IHttpFactory.GetResponse().IsSuccessStatusCode() then
        HandleErrorResponse(Bank, BankSystemCode, FileType, IHttpFactory, true);

    // 2. Parse JSON response
    if ResponseJsonObject.ReadFrom(IHttpFactory.GetResponse().GetResponseBodyAsText()) then begin
        // 3. Get Message ID from request entry for tracking
        MessageId := GetMessageIDFromRequestEntryID(RequestEntryId, BankSystemCode);

        // 4. Archive the response
        SaveResponseContent(ResponseJsonObject, Bank, BankSystemCode,
            "CTS-CB Transaction Type"::Payment, FileType, IHttpFactory, MessageId);

        // 5. Extract and save payment batch ID
        PaymentBatchID := SavePaymentBatchIDOnPaymentLedgerEntry(
            IHttpFactory, ResponseJsonObject, MessageId);

        // 6. Update payment status based on response
        if TryUpdatePaymentStatus(
            CommHelperFunctions.GetResponseObjectWithStatus(IHttpFactory, ResponseJsonObject),
            MessageId) then
            // 7. Confirm successful processing
            IHttpFactory.GetRequestEntryIDLog().ConfirmDownloadOfRequestEntryID(
                RequestEntryId, IHttpFactory, BankSystemCode);
    end else
        JsonFunctions.CannotReadJSON(IHttpFactory, Bank, BankSystemCode, FileType);
end;
```

## Response Content Archiving

```al
local procedure SaveResponseContent(ResponseJsonObject: JsonObject; Bank: Record "CTS-CB Bank";
    BankSystemCode: Code[30]; TransactionType: Enum "CTS-CB Transaction Type";
    FileType: Enum "CTS-CB File Type"; IHttpFactory: Interface "CTS-CB IHttpFactory";
    MessageId: Text[35])
var
    ResponseJsonArray: JsonArray;
    ResponseTxt: Text;
begin
    // Try to decode as JSON array first
    if IHttpFactory.GetErrorHandlingFactory().GetContentDecodedAsJsonArray(
        ResponseJsonObject, ResponseJsonArray) then
        IHttpFactory.GetFileArchiveFactory().GetInsertFileArchive().InsertInNewSession(
            IHttpFactory.GetLogFactory(), Format(ResponseJsonArray), TransactionType, FileType,
            Bank.Code, BankSystemCode, MessageId, Enum::"CTS-CB File Direction"::Export, true)
    else
        // Fall back to text content
        if IHttpFactory.GetErrorHandlingFactory().GetContentDecodedAsText(
            ResponseJsonObject, ResponseTxt) then
            IHttpFactory.GetFileArchiveFactory().GetInsertFileArchive().InsertInNewSession(
                IHttpFactory.GetLogFactory(), ResponseTxt, TransactionType, FileType,
                Bank.Code, BankSystemCode, MessageId, Enum::"CTS-CB File Direction"::Export, true);
end;
```

## Payment Batch ID Extraction

```al
local procedure SavePaymentBatchIDOnPaymentLedgerEntry(IHttpFactory: Interface "CTS-CB IHttpFactory";
    ResponseJsonObject: JsonObject; MessageId: Text[35]) PaymentBatchID: Text[75]
var
    PaymentRegister: Record "CTS-CB Payment Register";
    ResponseJsonArray: JsonArray;
    JsonToken: JsonToken;
begin
    IHttpFactory.GetErrorHandlingFactory().GetContentDecodedAsJsonArray(
        ResponseJsonObject, ResponseJsonArray);

    foreach JsonToken in ResponseJsonArray do begin
        PaymentBatchID := CopyStr(GetPaymentBatchID(JsonToken.AsObject()), 1,
            MaxStrLen(PaymentRegister."Payment Batch ID"));

        if PaymentBatchID <> '' then begin
            PaymentRegister.SetRange("Message ID", MessageId);
            PaymentRegister.ReadIsolation := IsolationLevel::UpdLock;
            PaymentRegister.SetLoadFields("Payment Batch ID");
            if PaymentRegister.FindFirst() then begin
                PaymentRegister."Payment Batch ID" := PaymentBatchID;
                PaymentRegister.Modify();
            end;
        end;
    end;
end;

local procedure GetPaymentBatchID(ResponseJsonObject: JsonObject) PaymentBatchID: Text
var
    JsonToken: JsonToken;
begin
    if ResponseJsonObject.Get('payment-id', JsonToken) then
        PaymentBatchID := JsonToken.AsValue().AsText();
end;
```

## Payment Status Update

```al
local procedure TryUpdatePaymentStatus(ResponseJsonObject: JsonObject; MessageId: Text[35]): Boolean
var
    JsonToken: JsonToken;
begin
    if ResponseJsonObject.Get('status', JsonToken) then
        exit(GetIUpdateLedgEntries(GetAsyncValue(JsonToken)).UpdatePaymentLedgerEntries(MessageId));
end;

local procedure GetIUpdateLedgEntries(AsyncStatus: Enum "CTS-CB Async Status"): Interface "CTS-CB IUpdateLedgerEntries"
begin
    exit(AsyncStatus);
end;

local procedure GetAsyncValue(JsonToken: JsonToken): Enum "CTS-CB Async Status"
begin
    exit("CTS-CB Async Status".FromInteger(
        "CTS-CB Async Status".Ordinals().Get(
            "CTS-CB Async Status".Names().IndexOf(JsonToken.AsValue().AsText()))));
end;
```

## Error Handling

```al
procedure HandleErrorResponse(Bank: Record "CTS-CB Bank"; BankSystemCode: Code[30];
    FileType: Enum "CTS-CB File Type"; IHttpFactory: Interface "CTS-CB IHttpFactory";
    ThrowError: Boolean)
var
    ErrorMsg: Text;
begin
    GetErrorText(IHttpFactory, ErrorMsg);

    // Archive error response
    IHttpFactory.GetFileArchiveFactory().GetInsertFileArchive().InsertInNewSession(
        IHttpFactory.GetLogFactory(), IHttpFactory.GetResponse().GetResponseBodyAsText(),
        Enum::"CTS-CB Transaction Type"::"Payment Error", FileType, Bank.Code, BankSystemCode, '',
        Enum::"CTS-CB File Direction"::Export, true);

    if GuiAllowed() then
        Error(ErrorInfo.Create(ErrorMsg, true));
end;

procedure GetErrorText(IHttpFactory: Interface "CTS-CB IHttpFactory"; var ErrorMsg: Text)
var
    ResponseJsonObject: JsonObject;
    FallbackErrorMsg: Label 'An error occurred while sending the file.';
begin
    if ResponseJsonObject.ReadFrom(IHttpFactory.GetResponse().GetResponseBodyAsText()) then
        IHttpFactory.GetErrorHandlingFactory().GetErrorTexts(ErrorMsg, ResponseJsonObject)
    else
        ErrorMsg := FallbackErrorMsg;
end;
```

## Helper Procedures

```al
procedure GetResponseFromOldAsyncStatusEntries(IHttpFactory: Interface "CTS-CB IHttpFactory";
    TransactionType: Enum "CTS-CB Transaction Type")
begin
    IHttpFactory.GetRequestEntryIDLog().GetUncollectedRequestEntriesInNewSession(
        TransactionType, '', '');
end;

procedure HandleResponse(IAuthenticationFactory: Interface "CTS-CB IAuthentication Factory";
    Bank: Record "CTS-CB Bank"; BankSystemCode: Code[30]; FileType: Enum "CTS-CB File Type";
    IHttpFactory: Interface "CTS-CB IHttpFactory"; var RequestEntryID: Text[50];
    TransactionType: Enum "CTS-CB Transaction Type"; PaymentID: Text[250]): Boolean
begin
    exit(IHttpFactory.GetRequestEntryIDLog().HandleExportResponse(
        IAuthenticationFactory, Bank, BankSystemCode, FileType, IHttpFactory,
        RequestEntryID, TransactionType, PaymentID));
end;

local procedure GetMessageIDFromRequestEntryID(RequestEntryId: Text[50];
    BankSystemCode: Code[30]) MessageID: Text[35]
var
    RequestIDEntry: Record "CTS-CB Request ID Entry";
begin
    RequestIDEntry.Get(RequestEntryId, BankSystemCode);
    MessageID := CopyStr(RequestIDEntry."Payment ID", 1, MaxStrLen(MessageID));
end;

local procedure GetBankSystem(BankSystemCode: Code[30]) BankSystem: Record "CTS-CB Bank System"
begin
    BankSystem.SetLoadFields("Communication Type");
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

## Bank-Specific Values

Some banks require additional fields in the request:

```al
procedure AddBankSpecificValues(var Json: JsonObject; PaymentID: Text[75])
begin
    Json.Add('config-id', PaymentID);  // AccessPay-specific
end;
```

## SendDirectDebit Pattern

If the bank supports direct debit, implement similarly to SendPayment. Otherwise, leave empty:

```al
procedure SendDirectDebit(DataRecordRef: RecordRef; Bank: Record "CTS-CB Bank";
    TransactionType: Enum "CTS-CB Transaction Type"; FileType: Enum "CTS-CB File Type";
    Payload: Text; IHttpFactory: Interface "CTS-CB IHttpFactory"; PaymentID: Text[250])
begin
    // Not supported by this bank - leave empty
    // Or implement similar to SendPayment if supported
end;
```
