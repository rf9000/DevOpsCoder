# Bank Communication Operations Implementation Checklist

Step-by-step checklist for implementing Export and Import codeunits for a new bank.

## Table of Contents

- [Phase 1: Pre-Implementation](#phase-1-pre-implementation)
- [Phase 2: Export Codeunit](#phase-2-export-codeunit)
- [Phase 3: Import Codeunit](#phase-3-import-codeunit)
- [Phase 4: URL Configuration](#phase-4-url-configuration)
- [Phase 5: Testing](#phase-5-testing)
- [Phase 6: Code Review Checklist](#phase-6-code-review-checklist)
- [Common Pitfalls](#common-pitfalls)
- [Quick Reference: File Locations](#quick-reference-file-locations)

## Phase 1: Pre-Implementation

### Gather Requirements
- [ ] Obtain Swagger/OpenAPI specification
- [ ] Use `swagger-api-reader` skill to understand endpoints
- [ ] Identify supported operations:
  - [ ] Payment export (`/send`)
  - [ ] Direct debit export (`/send`)
  - [ ] Payment status import (`/getpaymentstatus`)
  - [ ] Account statement import (`/getreports`, `/getreport`)
- [ ] Document bank-specific request fields
- [ ] Understand response content structure

### Reserve Object IDs
- [ ] Use `mcp__objid__allocate_id` for Export codeunit
- [ ] Use `mcp__objid__allocate_id` for Import codeunit
- [ ] Verify IDs are in correct range

### Prerequisites
- [ ] Authentication codeunit exists (use `new-bank-communication` skill)
- [ ] URL configuration entries exist
- [ ] Request Header Mapping configured
- [ ] Bank System record configured

---

## Phase 2: Export Codeunit

### File Setup
- [ ] Create: `base-application/Bank Communication/Codeunits/Export/{BankName}Export.Codeunit.al`
- [ ] Set correct object ID and name with `CTS-CB` prefix
- [ ] Add `Access = Internal;`
- [ ] Implement interfaces:
  - [ ] `CTS-CB ICommunicationType Export`
  - [ ] `CTS-CB IResponseExportHandling`

### SendPayment Implementation
- [ ] Register response handler: `IHttpFactory.SetResponseExportHandling(this)`
- [ ] Generate TracingID
- [ ] Extract PaymentEntry from DataRecordRef
- [ ] Get BankSystemCode via `BankAccComSetup.GetSystemTypeCodeForExport()`
- [ ] Process old async entries: `GetResponseFromOldAsyncStatusEntries()`
- [ ] Build request header with payload
- [ ] Set URL to `Send` endpoint
- [ ] Execute POST request with error handling
- [ ] Log tracing ID
- [ ] Handle response → extract status-entry-id
- [ ] Poll async status
- [ ] Call `HandleRequestIDResponse`

### HandleRequestIDResponse Implementation
- [ ] Check `IsSuccessStatusCode()` → error handling
- [ ] Parse JSON response
- [ ] Get MessageID from RequestEntryID
- [ ] Archive response to File Archive
- [ ] Extract payment-batch-id → update Payment Register
- [ ] Update payment ledger entry status
- [ ] Confirm download: `ConfirmDownloadOfRequestEntryID()`

### SendDirectDebit
- [ ] Implement if supported (similar to SendPayment)
- [ ] Or leave empty with comment

### Helper Procedures
- [ ] `RequestHeader` - build JSON with payload
- [ ] `HandleResponse` - delegate to RequestEntryIDLog
- [ ] `HandleErrorResponse` - archive and throw
- [ ] `GetErrorText` - extract error message
- [ ] `GetResponseFromOldAsyncStatusEntries`
- [ ] `Populate` and `SetRequestHeaderMappingFilter`
- [ ] `GetBankSystem`

---

## Phase 3: Import Codeunit

### File Setup
- [ ] Create: `base-application/Bank Communication/Codeunits/Import/{BankName}Import.Codeunit.al`
- [ ] Set correct object ID and name with `CTS-CB` prefix
- [ ] Add `Access = Internal;`
- [ ] Implement interfaces:
  - [ ] `CTS-CB ICommunicationType Import`
  - [ ] `CTS-CB IResponseHandling`

### Import Implementation (with RecordRef)
- [ ] Extract PaymentBatchID from RecordRef if provided
- [ ] Register response handler: `IHttpFactory.SetResponseHandling(this)`
- [ ] Get BankSystemCode via `BankAccComSetup.GetSystemTypeCodeForImport()`
- [ ] Process old payment async entries
- [ ] Process old import async entries
- [ ] If no entries found → call `DoImportCall`

### DoImportCall Implementation
- [ ] Set authentication handler
- [ ] Generate TracingID
- [ ] Build request with payment-id
- [ ] Set URL to `GetPaymentStatus` endpoint
- [ ] Execute POST
- [ ] Log tracing ID
- [ ] Handle response via interface
- [ ] Poll async status
- [ ] Call `HandleRequestEntryStatusResponse`

### IResponseHandling Implementation
- [ ] `HandleResponse` - delegate to HandleImportResponse
- [ ] `HandleRequestEntryStatusResponse` - delegate to internal method
- [ ] `HandleErrorResponse` - delegate to ErrorResponse

### RequestEntryStatusResponse Implementation
- [ ] Check `IsSuccessStatusCode()`
- [ ] Parse JSON response
- [ ] Decode content to JSON array
- [ ] Check for errors with `ContainsErrors()`
- [ ] Apply custom error rules with `HandleAsError()`
- [ ] Archive response
- [ ] Confirm download

### Custom Error Handling (Optional)
- [ ] `ContainsErrors` - check for 'errors' property
- [ ] `HandleAsError` - extract message and apply rules
- [ ] `GetMessage` - get message token
- [ ] `HandleError` - check custom rules, ignore/replace

### Old Async Entry Processing
- [ ] `GetResponseFromOldPaymentAsyncStatusEntries`
- [ ] `GetResponseFromOldAsyncStatusEntries` (both overloads)

### Import (without RecordRef) - Account Statements
- [ ] Implement if supported
- [ ] Or leave empty with comment

---

## Phase 4: URL Configuration

### Export URLs
- [ ] `Send` → `/public-api/v1/{bank}/send`

### Import URLs
- [ ] `GetPaymentStatus` → `/public-api/v1/{bank}/getpaymentstatus`
- [ ] `GetReports` → `/public-api/v1/{bank}/getreports` (if supported)
- [ ] `GetReport` → `/public-api/v1/{bank}/getreport` (if supported)

---

## Phase 5: Testing

### Export Tests
- [ ] Test SendPayment with mock HTTP factory
- [ ] Test async response polling
- [ ] Test payment batch ID extraction
- [ ] Test payment status update
- [ ] Test error handling and archiving
- [ ] Test with actual test environment

### Import Tests
- [ ] Test Import with mock HTTP factory
- [ ] Test old async entry processing
- [ ] Test custom error rules (ignore/replace)
- [ ] Test response archiving
- [ ] Test with actual test environment

### Integration Tests
- [ ] Full export → import flow
- [ ] Verify File Archive entries
- [ ] Verify Payment Register updates
- [ ] Verify Payment Ledger Entry status updates

---

## Phase 6: Code Review Checklist

### Interface Compliance
- [ ] All interface methods implemented
- [ ] Method signatures match exactly
- [ ] No missing `var` modifiers

### Response Handler Registration
- [ ] `SetResponseExportHandling(this)` called in SendPayment
- [ ] `SetResponseHandling(this)` called in Import

### Async Entry Processing
- [ ] Old entries processed before new requests
- [ ] `ConfirmDownloadOfRequestEntryID` called after success
- [ ] RequestIDEntry loaded with correct fields before processing

### Error Handling
- [ ] All errors archived to File Archive
- [ ] Error messages extracted properly
- [ ] `GuiAllowed()` checked before Error() in export
- [ ] Custom error rules applied in import (if applicable)

### File Archiving
- [ ] Correct TransactionType used
- [ ] Correct FileDirection (Export/Import)
- [ ] MessageId included where applicable

### Performance
- [ ] `SetLoadFields` used before Get/Find
- [ ] `ReadIsolation := IsolationLevel::UpdLock` for updates
- [ ] No unnecessary database reads

### Code Style
- [ ] Follows AL coding patterns
- [ ] Early exit pattern used
- [ ] Variable names match object names
- [ ] Labels used for error messages

---

## Common Pitfalls

### Export

**Payment status not updating:**
- Check `TryUpdatePaymentStatus` is called
- Verify `GetAsyncValue` maps status correctly
- Check MessageId is correct

**Payment batch ID not saved:**
- Verify `GetPaymentBatchID` extracts correct field
- Check Payment Register filter is correct

### Import

**Old entries not processed:**
- Verify `GetUncollectedRequestEntries` filter is correct
- Check `GetAsyncRequestEntryResponseNoBackOff` is called

**Custom error rules not applied:**
- Verify rules exist in custom error handling table
- Check message text matches exactly

**Response not archived:**
- Verify `HandleRequestEntryResponseObject` is called
- Check FileType and TransactionType are correct

### Both

**Async polling fails:**
- Verify `status-entry-id` is logged correctly
- Check `HandleResponse` returns true
- Verify URL configuration is correct

---

## Quick Reference: File Locations

| Component | Path |
|-----------|------|
| Export codeunits | `base-application/Bank Communication/Codeunits/Export/` |
| Import codeunits | `base-application/Bank Communication/Codeunits/Import/` |
| Interfaces | `base-application/Bank Communication/Interfaces/` |
| Build Request | `base-application/Bank Communication/Codeunits/BuildRequest.Codeunit.al` |
| Request ID Entry | `base-application/Bank Communication/Tables/` |
| Tests | `base-application-test/` |
