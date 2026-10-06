---
paths:
  - "**/*.al"
---

# AL Integration

Apply when writing events, API pages, HTTP communication, Job Queue codeunits or external-service calls.

## Events
- Publishers pass enough context (the `var` record plus the values the decision needs) that subscribers never re-query. Passing only a primary key is a defect.
- Extensibility events use the IsHandled pattern: `OnBefore...(var Rec; ...; var IsHandled: Boolean)`, then `if IsHandled then exit;`.
- A publisher does not touch the record after raising an `OnBefore`/`OnAfter` event, or it silently overwrites subscriber changes.
- Subscribers never depend on execution order or on state another subscriber mutates.
- `[IntegrationEvent]` publishers must be `local` or plain `procedure`; an `internal` publisher cannot be subscribed to from another app (AL0161).

## API pages
- Set `EntityName`, `EntitySetName` and `ODataKeyFields = SystemId` (or the PK). Auto-generated names change on recompile and break consumers.
- Never expose credentials, secrets, internal IDs or PII fields.
- Removing or retyping a field on a shipped API page requires a new `APIVersion`; never change a published version in place.

## HTTP
- All HTTP goes through `Interface "CTS-CB IHttpFactory"` (or the module's equivalent factory) so tests can inject `CTS-CB Fake Http Factory`. No direct `HttpClient` in business code.
- Check `IsSuccessStatusCode()` before reading the body; a 401/500 body parsed as JSON produces a misleading error.
- Refresh or validate the token before sending, not after a 401.
- Log failures with URL, method and status code. Never log headers, tokens or bodies that carry secrets (see al-security-patterns).

## Job Queue and background work
- Idempotent: filter on the state you process (`Status = Pending`) and set the state on completion so a re-run cannot duplicate.
- On failure set an error status and message on the record (`CopyStr(GetLastErrorText(), 1, MaxStrLen(...))`); never swallow the error silently.
- `Commit()` every 50-200 records in long jobs (see al-performance-patterns) so a failure resumes from the last checkpoint.

## External-service resilience
- Retry transient failures only (HTTP 429, 503, transport failure) with exponential backoff or the `Retry-After` header; cap the attempts.
- Do not block the user on a failed call with a hard `Error`. Set a "pending retry" state and schedule via Job Queue, or tell the user to retry.
- Isolate per integration: loop over banks with `if not TryProcessBank(Bank) then LogBankError(...)` so one bank's outage cannot abort the others. Remember `[TryFunction]` bodies must not write to the database (see al-error-handling).
