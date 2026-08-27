---
name: bank-communication-operations
description: Guide for implementing bank Export and Import codeunits for payment sending, status retrieval, file import, async response handling, and error processing. Use when (1) creating Export codeunit for a new bank (sending payments), (2) creating Import codeunit for a new bank (retrieving statements/status), (3) implementing async response polling for bank operations, (4) understanding payment file sending patterns, (5) implementing custom error handling rules, or (6) debugging export/import failures. Key areas: Payment Export, Statement Import, Async Polling, File Processing.
---

# Bank Communication Operations Guide

## Quick Start: Which Interface?

| Operation | Interface(s) | Reference |
|-----------|--------------|-----------|
| **Export (Payments)** | `ICommunicationType Export`, `IResponseExportHandling` | [export-patterns.md](references/export-patterns.md) |
| **Import (Statements/Status)** | `ICommunicationType Import`, `IResponseHandling` | [import-patterns.md](references/import-patterns.md) |

## Swagger Endpoint Mapping

| Operation | Swagger Endpoint | URL Key |
|-----------|------------------|---------|
| Send Payment | `/send` | `Send` |
| Send Direct Debit | `/send` | `Send` |
| Get Payment Status | `/getpaymentstatus` | `GetPaymentStatus` |
| Get Reports | `/getreports` | `GetReports` |
| Get Report | `/getreport` | `GetReport` |

## Core Flow Patterns

### Export Flow (SendPayment)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         EXPORT FLOW                                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  1. SetResponseExportHandling(this)                                        │
│  2. Get BankSystemCode from BankAccComSetup                                │
│  3. Process old uncollected async entries                                  │
│  4. Build request with payload (RequestHeader)                             │
│  5. POST to /send endpoint                                                 │
│  6. Handle response → extract status-entry-id                              │
│  7. Poll async status (GetAsyncRequestEntryResponse)                       │
│  8. HandleRequestIDResponse:                                               │
│     - Save response to File Archive                                        │
│     - Extract payment-batch-id → update Payment Register                   │
│     - Update payment ledger entry status                                   │
│     - Confirm download of request entry                                    │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Import Flow (GetPaymentStatus)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         IMPORT FLOW                                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  1. SetResponseHandling(this)                                              │
│  2. Get BankSystemCode from BankAccComSetup                                │
│  3. Process old payment async entries                                      │
│  4. Process old import async entries                                       │
│  5. If no entries found → DoImportCall:                                    │
│     a. Build request with payment-id                                       │
│     b. POST to /getpaymentstatus endpoint                                  │
│     c. Handle response → extract status-entry-id                           │
│     d. Poll async status                                                   │
│  6. HandleRequestEntryStatusResponse:                                      │
│     - Check success status                                                 │
│     - Decode content (JSON array)                                          │
│     - Check for errors → apply custom error rules                          │
│     - Archive response to File Archive                                     │
│     - Confirm download                                                     │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Key Components

| Component | Purpose |
|-----------|---------|
| `CTS-CB Payment Entry` | Source data for export operations |
| `CTS-CB Payment Register` | Tracks payment batches, stores `Payment Batch ID` |
| `CTS-CB Request ID Entry` | Tracks async request entries for polling |
| `CTS-CB Bank Acc. Com. Setup` | Gets correct bank system code for operation |
| `CTS-CB Build Request` | Creates JSON with auth, root values, payload |
| `CTS-CB Comm Helper Functions` | Response processing utilities |

## Async Response Pattern

Both Export and Import use the same async pattern:

```al
// 1. Send request and get status-entry-id
if HandleResponse(..., RequestEntryID, ...) then begin
    // 2. Poll for actual response
    IHttpFactory.GetRequestEntryIDLog().GetAsyncRequestEntryResponse(IHttpFactory, BankSystemCode, RequestEntryID);
    // 3. Process the response
    exit(HandleRequestIDResponse(...) / HandleRequestEntryStatusResponse(...));
end;
```

## Reference Documentation

### `references/export-patterns.md`
Complete export implementation patterns:
- Full `SendPayment` implementation
- Response handling with payment batch ID extraction
- Status update logic
- File type handling

**Use when:** Implementing payment export for new bank

### `references/import-patterns.md`
Complete import implementation patterns:
- Full `Import` and `DoImportCall` implementation
- Response decoding and processing
- Custom error rule handling
- File content extraction

**Use when:** Implementing statement/status import for new bank

### `references/implementation-checklist.md`
Step-by-step checklist:
- Pre-implementation requirements
- Export implementation steps
- Import implementation steps
- Testing requirements

**Use when:** Starting new bank integration, code review

## Critical Warnings

- **ALWAYS register response handler** - Call `SetResponseExportHandling(this)` or `SetResponseHandling(this)` first
- **ALWAYS process old async entries** - Call `GetResponseFromOldAsyncStatusEntries` before new requests
- **ALWAYS archive responses** - Both success and error responses go to File Archive
- **ALWAYS confirm download** - Call `ConfirmDownloadOfRequestEntryID` after processing
- **NEVER skip error archiving** - Errors must be archived before throwing

## Quick Troubleshooting

| Problem | Likely Cause | Fix |
|---------|--------------|-----|
| Payment status not updating | `TryUpdatePaymentStatus` not called | Check GetAsyncValue maps status correctly |
| Payment batch ID not saved | Wrong JSON field extraction | Verify `GetPaymentBatchID` extracts correct field |
| Old entries not processed | Wrong filter on GetUncollectedRequestEntries | Check TransactionType and BankAccountNo filters |
| Custom error rules ignored | Message text mismatch | Verify exact message text in error handling table |
| Response not archived | HandleRequestEntryResponseObject not called | Check FileType and TransactionType parameters |

## Integration Points

This skill complements:
- `new-bank-communication` - Authentication codeunit patterns
- `swagger-api-reader` - Understanding API specifications
- `bank-system-setup-wizard` - Bank system configuration
