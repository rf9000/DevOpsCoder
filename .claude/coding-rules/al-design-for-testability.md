---
paths:
  - "**/*.al"
---

# AL Design for Testability

Extract an interface only where a dependency makes tests slow, brittle or non-deterministic. Everything else uses direct `Record` access and `Codeunit` calls; an interface with one implementation is noise.

## Decide in this order, stop at the first Yes
1. Crosses an external boundary (HTTP, file I/O, external API, secure storage)? -> interface.
2. A second implementation exists or is being built now (OAuth vs certificate vs SFTP auth)? -> interface.
3. Testing it needs 4+ unrelated tables of setup? -> consider extracting that one expensive dependency.
4. Cross-cutting concern used from 5+ unrelated procedures (logging, telemetry, auth)? -> consider an interface.
5. Otherwise: no interface. Premature abstraction is harder to remove than a missing one is to add.

Never wrap in an interface: single-table CRUD, setup-table reads, simple lookups, local helpers, or permission isolation (use `Permissions`, `TableNo`, `Access = Internal` instead).

## Patterns
- **Backward-compatible overload** when adding an interface parameter to an existing procedure: the new overload holds the logic; the old signature creates the production implementation and delegates. Callers are not broken.
  ```al
  procedure Convert(Amount: Decimal; Converter: Interface ICurrencyConverter): Decimal
  begin
      exit(Converter.Convert(WorkDate(), Amount));
  end;

  procedure Convert(Amount: Decimal): Decimal
  var
      BCConverter: Codeunit "BC Currency Converter";
  begin
      exit(Convert(Amount, BCConverter));
  end;
  ```
- Pass an interface only to procedures that call it. Do not thread `IHttpFactory` through validation code "for consistency".
- Interfaces travel as parameters, not as codeunit globals set through a `SetX()` procedure; a global hides the dependency and its lifetime. The `IHttpFactory` DI container is the sanctioned exception.
- Business-logic procedures hold decisions; infrastructure (HTTP, files) sits behind the injected interface.
- Never add production surface (procedures, parameters, events) whose only purpose is to make a test compile.

## Canonical example
`Interface "CTS-CB IHttpFactory"` (base-application/Communication/Decoupled HTTP/) qualifies on all counts: external boundary, one fake per external service, used across import/export/auth/archiving, and it doubles as the DI container for 18+ dependencies. Do not replicate a factory for ordinary features; most procedures need 0-2 interface parameters.

## References
- https://vjeko.com/2023/12/09/testing-in-isolation/
