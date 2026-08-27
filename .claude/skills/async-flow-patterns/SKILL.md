---
name: async-flow-patterns
description: Guide for implementing async status polling patterns in AL bank communication. Use when (1) implementing async API calls with status-entry-id polling, (2) understanding the request/response flow for async operations, (3) debugging async polling issues, (4) implementing new bank export/import operations with async responses, or (5) understanding Request ID Entry management. Key areas: Async Polling, Status Entry ID, Request Entry Management.
---

# Async Flow Patterns for Bank Communication

This skill documents the async status polling patterns used in Continia Banking's API communication layer.

## Overview

Many bank APIs use asynchronous request/response patterns:
1. Client sends request
2. API returns `status-entry-id` immediately
3. Client polls with `status-entry-id` until response is ready
4. Client confirms download to clean up server-side state

## Core Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    ASYNC POLLING FLOW                                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  1. INITIAL REQUEST                                                         │
│     POST /send (or /getpaymentstatus, /createagreement, etc.)              │
│     ↓                                                                       │
│     Response: {"status-entry-id": "abc-123-def"}                           │
│                                                                             │
│  2. LOG STATUS ENTRY ID                                                     │
│     IHttpFactory.GetRequestEntryIDLog().LogRequestEntryID(                 │
│         'abc-123-def', BankSystemCode, ...)                                │
│     → Creates CTS-CB Request ID Entry record                               │
│                                                                             │
│  3. POLL FOR RESPONSE (with exponential backoff)                           │
│     IHttpFactory.GetRequestEntryIDLog().GetAsyncRequestEntryResponse(      │
│         IHttpFactory, BankSystemCode, 'abc-123-def')                       │
│     POST /GetAsyncStatus?id=abc-123-def                                    │
│     ↓                                                                       │
│     Response: {"status": "Completed", "content": [...]}                    │
│                                                                             │
│  4. PROCESS RESPONSE                                                        │
│     HandleRequestIDResponse() / HandleRequestEntryStatusResponse()         │
│     → Archive response to File Archive                                     │
│     → Update payment status                                                │
│     → Extract batch IDs                                                    │
│                                                                             │
│  5. CONFIRM DOWNLOAD                                                        │
│     IHttpFactory.GetRequestEntryIDLog().ConfirmDownloadOfRequestEntryID(   │
│         'abc-123-def', IHttpFactory, BankSystemCode)                       │
│     POST /DeleteAsyncStatus?id=abc-123-def                                 │
│     → Deletes local Request ID Entry record                                │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Key Components

| Component | Purpose |
|-----------|---------|
| `CTS-CB Request ID Entry` | Table storing pending async request IDs |
| `IRequestEntryID` | Interface for request entry operations |
| `CTS-CB Request Entry ID` | Codeunit implementing the interface |
| `status-entry-id` | JSON field returned by API with unique request ID |
| `GetAsyncStatus` | URL key for polling endpoint |
| `DeleteAsyncStatus` | URL key for cleanup endpoint |

## Reference Documentation

### `references/status-polling.md`
Detailed polling implementation patterns:
- Exponential backoff logic
- Timeout handling
- No-backoff variant for old entries
- Response processing

**Use when:** Implementing polling logic, debugging timeouts

### `references/request-entry-patterns.md`
Request ID Entry table management:
- Logging new entries
- Filtering uncollected entries
- Processing old async entries
- Cleanup patterns

**Use when:** Managing request entry lifecycle

---

## Quick Code Patterns

### Extract and Log Status Entry ID

```al
local procedure ExtractAndLogStatusEntryID(IHttpFactory: Interface "CTS-CB IHttpFactory";
    ResponseJsonObject: JsonObject; BankSystemCode: Code[30]; TransactionType: Enum "CTS-CB Transaction Type")
var
    Token: JsonToken;
    RequestEntryID: Text[50];
begin
    if ResponseJsonObject.Get('status-entry-id', Token) then begin
        RequestEntryID := CopyStr(Token.AsValue().AsText(), 1, 50);
        IHttpFactory.GetRequestEntryIDLog().LogRequestEntryID(
            RequestEntryID, BankSystemCode, '', Enum::"CTS-CB File Type"::" ",
            TransactionType, '', '');
    end;
end;
```

### Poll and Process

```al
// After getting status-entry-id
if HandleResponse(IHttpFactory, Bank, BankSystemCode, FileType, RequestEntryID, TransactionType) then begin
    // Poll for actual response
    IHttpFactory.GetRequestEntryIDLog().GetAsyncRequestEntryResponse(
        IHttpFactory, BankSystemCode, RequestEntryID);
    // Process the response
    exit(HandleRequestIDResponse(IHttpFactory.GetAuthenticationFactory(), Bank,
        BankSystemCode, FileType, RequestEntryID, IHttpFactory));
end;
```

### Process Old Uncollected Entries

```al
procedure GetResponseFromOldAsyncStatusEntries(IHttpFactory: Interface "CTS-CB IHttpFactory";
    Bank: Record "CTS-CB Bank"; BankSystemCode: Code[30]; TransactionType: Enum "CTS-CB Transaction Type")
var
    RequestEntryID: Text[50];
begin
    foreach RequestEntryID in IHttpFactory.GetRequestEntryIDLog().GetUncollectedRequestEntries(
        TransactionType, '', '') do begin
        // Use no-backoff variant for old entries
        IHttpFactory.GetRequestEntryIDLog().GetAsyncRequestEntryResponseNoBackOff(
            IHttpFactory, BankSystemCode, RequestEntryID);
        // Process the response
        IHttpFactory.GetResponseHandling().HandleRequestEntryStatusResponse(...);
    end;
end;
```

---

## Critical Warnings

- **ALWAYS log status-entry-id** before polling - otherwise you'll lose track of pending requests
- **ALWAYS process old entries first** - call `GetUncollectedRequestEntries` before making new requests
- **ALWAYS confirm download** - call `ConfirmDownloadOfRequestEntryID` after successful processing
- **Use NoBackOff variant** for old entries - they're already ready, no need to wait
- **Handle polling timeout** - long-running operations may exceed default timeout

## Integration Points

This skill complements:
- `new-bank-communication` - Authentication flow with async patterns
- `bank-communication-operations` - Export/Import with async responses
- `swagger-api-reader` - Understanding async endpoint specifications
