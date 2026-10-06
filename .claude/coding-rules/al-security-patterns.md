---
paths:
  - "**/*.al"
---

# AL Security

Apply when code touches credentials, permissions, telemetry, user input, external data or state transitions.

## Secrets
- Never put API keys, passwords, tokens or certificates in string literals, `Text` variables or plaintext table fields. Carry them as `SecretText`; persist them with `IsolatedStorage` (or the app's `IConfigureStorage` pattern).
- `IsolatedStorage` scope must match visibility: `DataScope::Company` for per-company credentials (the default for bank setup), `DataScope::User` for per-user, `DataScope::Module` only for app-wide values. Module scope leaks one company's key to every company in the tenant; User scope is invisible to Job Queue sessions.
- Never log or display a secret value. Telemetry may record presence only, e.g. `CustomDimension.Add('TokenPresent', Format(not Token.IsEmpty()))`. Never log `Authorization` headers or request bodies that carry credentials.

## Permissions
- A codeunit that writes (`Insert`/`Modify`/`Delete`) declares `Permissions = tabledata "<Table>" = <RIMD subset>;` with the minimum letters it needs.
- Every new table goes into the permission set extensions: Admin = RIMD, Edit = RIMD, Read = R (run the `add-table-to-permissions` skill).
- Destructive or internal operations live in `Access = Internal` objects. Do not expose them from `Access = Public` codeunits.

## Telemetry and error text
- No PII in `Session.LogMessage` dimensions: no names, e-mails, phone numbers, IBANs or account numbers. Use identifiers (`No.`, `Entry No.`, codes). If an account number is unavoidable, mask all but the last 4 characters.
- User-facing `Error`/`Message` text is a label with actionable business wording. Table names, field IDs, SQL text, HTTP details and `GetLastErrorText()` go to telemetry, never to the user.

## Input and external data
- User text in a filter: `SetRange(Field, Value)` for exact match, or `SetFilter(Field, '%1', Value)` so `*`, `@`, `..`, `|`, `<`, `>` are escaped. Never `SetFilter(Field, UserText)`.
- URLs from user or setup data must start with `https://` before use.
- Parse external JSON/XML defensively: check `ReadFrom` succeeded and that required tokens exist before reading them.

## Business logic
- Validate the current state before a transition (`TestField(Status, Status::Pending)` before setting `Approved`). Direct procedure or API calls must not skip workflow steps.
- Check-then-modify runs under `ReadIsolation := IsolationLevel::UpdLock` so two sessions cannot both pass the check.
- Financial amounts are `Decimal`, never `Integer`.
- Job Queue codeunits verify the company they run in is configured (setup exists and feature enabled) instead of assuming the current company. Cross-company reads use an explicit `ChangeCompany`.

## References
- https://learn.microsoft.com/dynamics365/business-central/dev-itpro/developer/methods-auto/isolatedstorage/isolatedstorage-data-type
- https://learn.microsoft.com/dynamics365/business-central/dev-itpro/developer/methods-auto/secrettext/secrettext-data-type
- https://learn.microsoft.com/dynamics365/business-central/dev-itpro/developer/methods-auto/record/record-setfilter-method
