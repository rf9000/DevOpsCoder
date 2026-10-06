---
paths:
  - "**/*.al"
---

# AL Error Handling

## TryFunction
- NEVER `Insert`/`Modify`/`Delete`/`DeleteAll`/`ModifyAll` inside a `[TryFunction]`. A caught error does not roll the writes back in every environment, so partial data survives. Reads are fine.
- Never `Commit()` inside a `[TryFunction]`; the runtime raises an error.
- Use it for: validation that ends in `Error`, parsing (`JsonObject.ReadFrom`, `Evaluate`, `Uri.Init`), HTTP calls that may fault, and any call into third-party code you must survive.
- Name them `Try<Verb>...` and return `Boolean` explicitly so the call site reads `if not TryParse(...) then`.
- Need to isolate a write and roll it back on error? Move the writing code into its own codeunit and call `if not MyCodeunit.Run(Rec) then ...`; `Codeunit.Run` creates a real transaction boundary (requires no open write transaction in the caller).

## Ordering
- Validate first with a TryFunction or `TestField`, then write. Never interleave writes with validation that may fail.

## Messages
- Every `Error`/`Message`/`Confirm` text is a label with the right suffix and a `Comment` for placeholders (see al-variable-naming Rule 5).
- Users get actionable business wording; `GetLastErrorText()`, stack traces, table/field names and HTTP details go to telemetry only (see al-security-patterns).
- Do not re-raise a caught error with `Error(GetLastErrorText())` for display; either propagate the original error (do not catch it) or show a labelled message and log the detail.

## Tests
- A TryFunction needs a passing and a failing test; the failing one asserts the return value is `false`, not that an error escaped.

## References
- https://learn.microsoft.com/dynamics365/business-central/dev-itpro/developer/devenv-handling-errors-using-try-methods
- https://demiliani.com/2023/02/08/dynamics-365-business-central-and-tryfunctions-be-careful/
