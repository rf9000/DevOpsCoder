## Axis: integration

The `axis` field in every finding MUST be `"integration"` exactly.

### What this axis cares about

Integration quality: event publisher/subscriber contracts, API page design, HTTP client usage, Job Queue patterns, and external service resilience. If the code introduces an extensibility seam, an external API surface, or a background task, and does so with a broken contract, a missing required property, or no error isolation, it belongs here.

### Detection targets

#### Event publisher/subscriber patterns
- Event publisher with insufficient parameters — subscribers would need to re-query to get necessary context — **minor**
- Publisher that modifies state after raising an event — breaks the publisher isolation contract — **critical**
- Subscriber that assumes execution order or unsafely modifies shared state — **critical**
- `OnBefore`-style extensibility event missing the `var IsHandled: Boolean` pattern — publisher does not check the flag before default behavior — **minor**
- Event subscriber with excessive inline logic — should delegate to a method codeunit — **minor**

#### API page design
- Sensitive field (credential, internal ID, PII) exposed on a `PageType = API` page — **blocking**
- `PageType = API` page missing `EntityName` or `EntitySetName` properties — **critical**
- `PageType = API` page missing `ODataKeyFields` property — **critical**
- Breaking change on an existing API page: field removed, type changed, or `EntitySetName` changed without a version bump — **critical**

#### HTTP client usage
- Direct `HttpClient` usage instead of routing through the project's `IHttpFactory` interface — **critical**
- HTTP response body processed without first checking `IsSuccessStatusCode` — **critical**
- Authentication token or credential logged in HTTP request/response log entries — **critical**
  - Note: the security axis also covers this; flag here for integration context regardless
- Authentication token not validated or refreshed before an HTTP call — **minor**

#### Job Queue patterns
- Job Queue codeunit without an idempotency guard — no check-before-insert or upsert pattern before enqueuing — **minor**
- Job Queue error handler that swallows failures silently — catch without status update or re-throw — **critical**
- Long-running Job Queue codeunit processing many records in a single transaction without checkpoint `Commit()` calls — **minor**

#### External service resilience
- External API call with no retry or backoff logic for transient failures (HTTP 429, 503) — **minor**
- External service failure not isolated — shared error state or cascading failure risk across integrations — **minor**
- Synchronous external call that blocks the user with no async fallback — **minor**

### Out of scope for this axis

AL correctness (TryFunction, CalcFields), performance (SetLoadFields, N+1 queries), naming conventions, code structure (SOLID, access modifiers), security (credential storage in fields, PII in telemetry outside of HTTP logs), and general `IsolatedStorage` or permission gating. Other axes cover those. The credential-in-HTTP-log pattern is flagged here AND by the security axis by design.

### Strategy

1. **Load rule files.** If the worktree has `.claude/rules/coding-rules/al-integration-patterns.md`, read it.

2. **Get the diff.** Run `git diff origin/main..HEAD` (or the explicit range from the user prompt).

3. **Identify event publishers and subscribers in changed hunks:**
   - Find `[IntegrationEvent]` and `[BusinessEvent]` declarations — check that subscribers would have enough context without re-querying.
   - Find code that calls event publishers — check for state modification after the call.
   - Find `[EventSubscriber]` procedures — check for execution order assumptions, shared state modification, and inline logic size.
   - For `OnBefore`-style events, check for the `var IsHandled: Boolean` pattern.

4. **Identify API page changes:**
   - Find `PageType = API` declarations — verify `EntityName`, `EntitySetName`, `ODataKeyFields` are present.
   - Scan field list for sensitive names (password, secret, token, key, PII fields).
   - For modified API pages, check whether field removals or type changes require a version bump.

5. **Identify HTTP communication patterns:**
   - Find `HttpClient`, `HttpRequestMessage`, `HttpResponseMessage` usage — verify factory pattern.
   - Find HTTP response handling — verify `IsSuccessStatusCode` check before body access.
   - Find request/response logging — verify no credentials appear in log entries.
   - Find token/authentication handling — verify refresh before use.

6. **Identify Job Queue patterns:**
   - Find codeunits with `TableNo = Database::"Job Queue Entry"` or similar Job Queue markers.
   - Check insert operations for idempotency guards.
   - Check error handling — verify errors are surfaced, not swallowed.
   - For bulk-processing code, check for checkpoint `Commit()` calls.

7. **Check external service resilience:**
   - Find outbound HTTP calls — check for retry logic on transient errors.
   - Check error propagation — verify failures are isolated per integration.
   - Check for synchronous blocking calls that could benefit from async alternatives.

8. **Apply the scope guard.** Only flag issues in changed code or in the same procedure as a change where the finding directly affects integration quality. Do NOT flag pre-existing issues in unchanged code.

9. **Emit findings** with `axis: "integration"`. If no issues, return `{ "findings": [] }`.
