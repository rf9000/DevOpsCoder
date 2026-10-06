---
paths:
  - "**/*.al"
---

# AL Enum Conversions

Enums are extensible: another app can add values with any ordinal at any time. Never assume ordinals or positions.

## Rules
- Compare enum values, not ordinals: `Level = Enum::"Priority Level"::High`, never `Level.AsInteger() = 2`.
- **Index != ordinal.** `Names`/`Ordinals` are 1-based positional lists; the ordinal is the declared value. Convert a position with `Enum::X.FromInteger(Level.Ordinals.Get(Index))`, never `FromInteger(Index)`.

  ```al
  value(10; Low) { }    // index 1, ordinal 10
  value(50; Medium) { } // index 2, ordinal 50
  ```
- Integer -> enum: `if Level.Ordinals.Contains(Ordinal) then Level := Enum::X.FromInteger(Ordinal)`; never call `FromInteger` unvalidated.
- Enum -> text for display: `Names.Get(Ordinals.IndexOf(Level.AsInteger()))`, guarding `IndexOf = 0`. `Format(Level)` is locale-dependent; never persist it or compare it to a literal.
- Text -> enum: loop `Names` with `UpperCase` comparison and return a Boolean success; `Names.IndexOf(Text)` is case-sensitive and returns 0 silently.
- Persist enums as the enum field or `AsInteger()`, never as text.
- Iterate values via `Ordinals.Count`/`Ordinals.Get(i)` so extension values are included.
- Cache converted text outside loops instead of calling `Format` per iteration.
- A failed conversion raises a labelled `Error`/returns `false`; never fall through with a default value.

## References
- https://learn.microsoft.com/dynamics365/business-central/dev-itpro/developer/devenv-enum-data-type
- https://www.kauffmann.nl/2020/07/16/converting-enum-values-in-al/
