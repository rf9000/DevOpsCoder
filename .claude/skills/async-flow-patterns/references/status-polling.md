# Status Polling Implementation

Detailed patterns for implementing async status polling in bank communication.

## Polling Methods

### 1. GetAsyncRequestEntryResponse (Standard)

Uses exponential backoff for polling. Best for new requests where response may take time.

```al
procedure GetAsyncRequestEntryResponse(IHttpFactory: Interface "CTS-CB IHttpFactory";
    BankSystemCode: Code[30]; EntryID: Text[50]): Boolean
var
    HttpRequestMessageType: HttpRequestMessage;
begin
    // Build URL for GetAsyncStatus endpoint
    IHttpFactory.GetBuildRequestFactory().SetHttpRequestMessageURL(
        HttpRequestMessageType,
        StrSubstNo(IHttpFactory.GetUrlInterface().GetUrl('GetAsyncStatus'),
            IHttpFactory.GetCommunicationTypeUrlValue(
                GetCommunicationType(BankSystemCode)).GetUrlValue(BankSystemCode)));

    // Execute with exponential backoff
    HandleRequest(IHttpFactory, HttpRequestMessageType, EntryID, BankSystemCode);

    exit(IHttpFactory.GetResponse().IsSuccessStatusCode());
end;
```

### 2. GetAsyncRequestEntryResponseNoBackOff (Immediate)

Single immediate request without retry. Use for old uncollected entries that are already ready.

```al
procedure GetAsyncRequestEntryResponseNoBackOff(IHttpFactory: Interface "CTS-CB IHttpFactory";
    BankSystemCode: Code[30]; EntryID: Text[50]): Boolean
var
    HttpRequestMessageType: HttpRequestMessage;
begin
    // Same URL building
    IHttpFactory.GetBuildRequestFactory().SetHttpRequestMessageURL(
        HttpRequestMessageType,
        StrSubstNo(IHttpFactory.GetUrlInterface().GetUrl('GetAsyncStatus'),
            IHttpFactory.GetCommunicationTypeUrlValue(
                GetCommunicationType(BankSystemCode)).GetUrlValue(BankSystemCode)));

    // Execute WITHOUT backoff - single immediate request
    HandleRequestNoBackOff(IHttpFactory, HttpRequestMessageType, EntryID, BankSystemCode);

    exit(IHttpFactory.GetResponse().IsSuccessStatusCode());
end;
```

### 3. GetAsyncRequestEntryResponse (Custom Timeout)

Allows specifying maximum wait duration for long-running operations.

```al
procedure GetAsyncRequestEntryResponse(IHttpFactory: Interface "CTS-CB IHttpFactory";
    BankSystemCode: Code[30]; EntryID: Text[50]; MaxDurationInMilliseconds: Duration): Boolean
var
    HttpRequestMessageType: HttpRequestMessage;
begin
    // ... same URL building ...

    // Execute with custom timeout
    HandleRequest(IHttpFactory, HttpRequestMessageType, EntryID, BankSystemCode,
        MaxDurationInMilliseconds);

    exit(IHttpFactory.GetResponse().IsSuccessStatusCode());
end;
```

---

## Exponential Backoff Logic

The standard polling uses exponential backoff to avoid overwhelming the server:

```
Attempt 1: Wait 0ms, then poll
Attempt 2: Wait 500ms, then poll
Attempt 3: Wait 1000ms, then poll
Attempt 4: Wait 2000ms, then poll
Attempt 5: Wait 4000ms, then poll
...
Max wait: Capped at ~30 seconds between attempts
Total timeout: Default ~5 minutes, configurable
```

---

## Request Building for Async Status

The async status request includes the entry ID in the request body:

```al
local procedure RequestEntryIDRequest(IHttpFactory: Interface "CTS-CB IHttpFactory";
    HttpRequestMessageType: HttpRequestMessage; EntryID: Text[50])
var
    BuildRequest: Codeunit "CTS-CB Build Request";
    Json: JsonObject;
    TracingID: Text[50];
begin
    TracingID := IHttpFactory.GetTracingIDLog().GetTracingID();

    // Add status-entry-id to request
    Json.Add('status-entry-id', EntryID);

    // Add standard root values (transaction-id, company-guid, etc.)
    BuildRequest.CreateRootValues(Json, RequestValues, TracingID,
        IHttpFactory.GetBuildRequestFactory());

    IHttpFactory.GetBuildRequestFactory().SetHttpRequestMessageContent(
        HttpRequestMessageType, Format(Json));
end;
```

---

## Response Processing

### Checking Response Status

```al
local procedure HandleRequest(IHttpFactory: Interface "CTS-CB IHttpFactory";
    HttpRequestMessageType: HttpRequestMessage; EntryID: Text[50]; BankSystemCode: Code[30])
var
    ResponseJsonObject: JsonObject;
    StatusToken: JsonToken;
    Status: Text;
begin
    // Build and send request
    RequestEntryIDRequest(IHttpFactory, HttpRequestMessageType, EntryID);
    IHttpFactory.GetHttp().Post(HttpRequestMessageType, true, IHttpFactory,
        Enum::"CTS-CB Transaction Type"::"Request Status Entry");

    // Check response
    if not IHttpFactory.GetResponse().IsSuccessStatusCode() then
        exit;

    // Parse status from response
    if ResponseJsonObject.ReadFrom(IHttpFactory.GetResponse().GetResponseBodyAsText()) then
        if ResponseJsonObject.Get('status', StatusToken) then begin
            Status := StatusToken.AsValue().AsText();
            // Status values: 'Completed', 'Pending', 'Failed', etc.
        end;
end;
```

### Async Status Enum

The response status maps to `CTS-CB Async Status` enum:

| Status | Meaning |
|--------|---------|
| `RecordInserted` | Entry created, not yet polled |
| `Pending` | Request still processing |
| `Completed` | Response ready |
| `Unknown` | Status cannot be determined |
| `Failed` | Request failed |

---

## Confirm Download (Cleanup)

After successfully processing the response, confirm download to clean up:

```al
procedure ConfirmDownloadOfRequestEntryID(EntryID: Text[50];
    IHttpFactory: Interface "CTS-CB IHttpFactory"; BankSystemCode: Code[30])
var
    RequestIDEntry: Record "CTS-CB Request ID Entry";
    HttpRequestMessageType: HttpRequestMessage;
begin
    // Get the entry record
    if GetRequestEntryRecord(RequestIDEntry, EntryID, BankSystemCode) then
        // Only confirm if status is Completed or Unknown (processed)
        if IsInCompletedOrUnknown(RequestIDEntry."Async Status") then begin
            // Call DeleteAsyncStatus endpoint
            IHttpFactory.GetBuildRequestFactory().SetHttpRequestMessageURL(
                HttpRequestMessageType,
                StrSubstNo(IHttpFactory.GetUrlInterface().GetUrl('DeleteAsyncStatus'),
                    IHttpFactory.GetCommunicationTypeUrlValue(
                        GetCommunicationType(BankSystemCode)).GetUrlValue(BankSystemCode)));

            RequestEntryIDRequest(IHttpFactory, HttpRequestMessageType, EntryID);

            // Delete local record
            DeleteRecord(EntryID, BankSystemCode);
        end;
end;
```

---

## URL Keys

| Operation | URL Key | Purpose |
|-----------|---------|---------|
| Poll for status | `GetAsyncStatus` | Retrieve async response |
| Confirm download | `DeleteAsyncStatus` | Clean up after processing |

---

## Troubleshooting

| Issue | Likely Cause | Solution |
|-------|--------------|----------|
| Timeout during polling | Response takes too long | Use custom timeout overload |
| Status stuck on Pending | API processing delay | Check bank API status |
| Old entries not processed | `GetUncollectedRequestEntries` not called | Always process old entries first |
| Duplicate processing | Missing `ConfirmDownloadOfRequestEntryID` | Always confirm after success |
