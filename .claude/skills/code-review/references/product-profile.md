# Product Profile — Continia Banking

This file is the **only** product-specific configuration the code-review skill consumes. The skill and its agents are otherwise generic AL/Business Central reviewers. To reuse this skill in another AL repo, replace this one file.

---

## Scope exclusions (do NOT review)

Files matching these are owned by a separate pipeline or are generated — never flag findings in them:

- `*.xlf` — translation files, managed by a separate localization pipeline.

A finding whose **only** subject is an excluded file is dropped.

---

## Repo-layout note

- **`.dependencies/` is NOT external dependencies.** Despite the name, it holds shipped first-party AL code. Treat its files as normal, reviewable code. **Never** premise a finding on "this lives in `.dependencies/`".

---

## Object prefix hint (optional)

This product uses the prefixes `CTS-CB` and `CTS-PE`. This is provided as an optional hint only — the review engine infers naming context from sibling files and does not require a prefix list to function.

---

## Optional rules overlay

If this profile points at a ruleset (e.g. `.claude/rules/coding-rules/`), agents may treat it as sibling-grade supporting evidence. The engine never depends on `/rules` files — all agent knowledge is inline. Rule files, when present, are a secondary overlay only.

---

## Product agents

The code-review skill dispatches every agent listed here (when enabled) from `agents/product-specific/`, in parallel with the 8 generic agents. Each follows `agents/product-specific/README.md`.

| Agent file | Enabled | Purpose |
|---|---|---|
| `continia-conventions-reviewer.md` | yes | Continia field-ID ranges, TransferFields-ID, abbreviations, return-style |

### Continia-specific abbreviations (beyond the MS standard list)

None yet. Add any Continia-only abbreviations here (word → abbreviation); the Continia conventions agent reads them in addition to the standard list in `al-variable-naming.md` Rule 3.
