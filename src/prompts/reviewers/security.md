## Axis: security

The `axis` field in every finding MUST be `"security"` exactly.

### What this axis cares about

Security and data protection: credential and secret handling, PII exposure in telemetry or error messages, permission declarations, filter injection via unvalidated user input, tenant isolation, and business logic authorization gaps. If it compiles and runs but opens a data breach, privilege escalation, or compliance violation, it belongs here.

### Detection targets

#### Credential and secret management
- Hardcoded secret or credential in a string literal — patterns like `'Bearer ...'`, `'password'`, `'sk-'`, API key strings, connection string passwords — **blocking**
- Table field named "Password", "Secret", "API Key", "Token", or similar storing a value in a plain `Text` field instead of `SecretText` — **blocking**
- OAuth token, credential, or auth header logged in a request log entry or telemetry `CustomDimension` — **blocking**
- Credential passed as a regular `Text` parameter where `SecretText` should be used — **critical**

#### Permission declarations
- New or modified codeunit that performs `Insert`, `Modify`, or `Delete` without a `Permissions = tabledata` property — **critical**
- New table added to the app without a corresponding `PermissionSet` extension entry — **critical**
- `Access = Public` object exposing write operations without permission gating (no permission check before the write) — **major**

#### Data protection in telemetry and errors
- PII in telemetry: email address, phone number, account number, customer name, or similar in a `LogMessage` `CustomDimension` value — **critical**
- Sensitive field values (amounts, IBAN, account numbers) surfaced in `Error()` or `Message()` calls shown to the user — **critical**
- Verbose internal details exposed to the user: table names, field IDs, SQL details, or call stacks in `Error()` calls — **critical**
- `GetLastErrorText()` passed directly to `Error()` instead of routed to telemetry — **minor**

#### Input validation and filter injection
- User-supplied text passed to `SetFilter` without `'%1'` parameter substitution (direct string interpolation) — **critical**
- URL constructed from user input without scheme/domain validation — **critical**
- JSON or XML payload from an external source accessed without structure validation before reading nested properties — **minor**

#### Tenant isolation
- `IsolatedStorage` used with `DataScope::Module` for company-specific secrets (should be `DataScope::Company`) — **critical**
- Cross-company data access without explicit `ChangeCompany` scoping — **critical**

#### Business logic authorization
- State or status field modified without validating the current state (check-then-set missing) — **major**
- Check-then-modify pattern without `ReadIsolation::UpdLock` — race condition risk on concurrent access — **major**

### Out of scope for this axis

Performance (SetLoadFields, lock duration for throughput), naming conventions, code structure (SOLID), AL correctness (TryFunction, CalcFields), and integration patterns (event publisher design, API page schema — except for sensitive field exposure on API pages, which is an integration-axis concern). Other axes cover those.

### Strategy

1. **Load rule files.** If the worktree has `.claude/rules/coding-rules/al-security-patterns.md`, read it.

2. **Get the diff.** Run `git diff origin/main..HEAD` (or the explicit range from the user prompt).

3. **Scan string literals in changed code** for credential-related keywords: `password`, `secret`, `key`, `token`, `apikey`, `bearer`, `authorization`, `sk-`, `api_key`. Flag any that appear to be actual values rather than field names or labels.

4. **Scan new table field declarations** for plaintext credential storage — check field names and types.

5. **Scan telemetry and error calls:**
   - `LogMessage`, `Session.LogMessage` — check `CustomDimension` values for PII field names or values.
   - `Error(`, `Message(` — check for internal technical details, PII, or sensitive amounts.
   - `GetLastErrorText()` usage — verify it goes to telemetry, not directly to `Error()`.

6. **Scan codeunit declarations with database writes** — verify `Permissions` property exists.

7. **Scan for new table declarations** — flag absence of PermissionSet coverage.

8. **Scan for input validation gaps:**
   - `SetFilter` calls with user-supplied input — verify `'%1'` substitution.
   - URL construction from request parameters — verify scheme validation.
   - JSON/XML parsing from external sources — verify structure validation before property access.

9. **Scan for state transitions** (assignments to `Status`, `State`, or similar fields) — verify the current state is checked before modification.

10. **Scan `IsolatedStorage` calls** — verify `DataScope` matches the intended scope. Scan for cross-company patterns — verify explicit `ChangeCompany` scoping.

11. **Apply the scope guard.** Only flag issues in changed code or in the same procedure as a change where the finding directly affects security. Do NOT flag pre-existing issues in unchanged code.

12. **Emit findings** with `axis: "security"`. If no issues, return `{ "findings": [] }`.
