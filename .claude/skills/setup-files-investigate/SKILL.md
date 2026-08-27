---
name: setup-files-investigate
description: "Investigates JSON setup/configuration files for Continia Banking: banks, bank systems, payment methods, field validations, import/export rules, and more. Triggers on any question about bank capabilities, supported features, field rules, payment methods, default formats, bank holidays, ISO codes, or country-specific banking — even when 'setup' isn't mentioned. Also triggers on: specific bank names (Danske, Nordea, ABN AMRO, Rabobank, etc.) and their capabilities; debugging validation failures or unavailable payment methods; discovery questions like 'what banks exist' or 'what bank systems support X'; banking protocol terms (SEPA, ISO20022, pain.001, camt.053, MT940, CSV); comparing bank configurations."
---

# Setup Files Investigator

Investigate questions about the JSON configuration files that drive the Continia Banking system. These files live in a sibling repo and are imported into BC tables at runtime.

## When to Use This Skill

### Explicit setup questions
- "What field validations does [bank system] have?"
- "How is [table/field] configured in setup data?"
- "What ISO transaction codes exist for [domain]?"
- "What CSV port definitions exist for [PSP]?"

### Bank-specific capability questions (no "setup" keyword needed)
- "What does Danske Bank support?"
- "How does ABN AMRO handle domestic payments?"
- "What's the default export format for Nordea?"
- "Does Rabobank support SEPA direct debit?"

### Import behavior questions
- "Will importing setup files overwrite field X on table Y?"
- "How does setup data import handle existing records for [table]?"
- "What fields get replaced vs preserved during setup import?"
- "Is my user-customized value safe from being overwritten?"
- "What Data Update strategy is used for [table]?"

### Debugging / troubleshooting
- "Why is my IBAN validation failing for German banks?"
- "Why can't I use payment method X with bank Y?"
- "What validation rules apply to the Amount field?"
- "Why did my manually changed field get overwritten after setup import?"
- "The bank system imported fine but files route to manual import / direct import does nothing"
  (start at the `"Communication Type"` trap below — it fails silently)

### Discovery / browsing
- "What banks are available in Germany?"
- "What bank systems exist?"
- "Which banks support SEPA credit transfer?"
- "List all payment methods for [bank system]"

### Protocol / format terms
- Questions mentioning SEPA, ISO20022, pain.001, camt.053, MT940, CSV

### Country-specific
- "What are the German bank closing days?"
- "Danish bank branch lookup"
- "Banks available in the Netherlands"

### Comparison
- "What's different between DANSKEBANK_DK and DANSKEBANK_SE?"
- "Compare field validations for two bank systems"

### Any question about bank/bank system configuration data

## Step 0: Resolve Repo Paths

Before accessing external repos, resolve their paths from the repo-paths config:

1. Run `echo $REPO_PATHS_FILE` via Bash
2. If non-empty, read that file with the Read tool
3. If empty/unset, read `.claude/repo-paths.json` with the Read tool
4. Parse the JSON — use the `setup-files` value as `SETUP_FILES_PATH`

## Setup Files Repo

**Location:** Resolved from repo-paths.json as `setup-files` (see Step 0)

This repo contains 830+ JSON files organized by category. Files are deployed to Azure Blob Storage and downloaded into BC tables via the SetupDataManagement import engine.

## Orchestration Flow

```
1. Parse question → identify file category and search target
2. Dispatch agents (setup-data-tracer, optionally al-setup-tracer)
3. Synthesize results
```

## Step 1: Parse the Question

Extract from the user's question:

| Parameter | Description | Examples |
|-----------|-------------|---------|
| **category** | File category (see table below) | Bank, Bank System, Validation, Export Setup |
| **code** | Bank code or bank system code | "DANSKEBANK", "YAPILY", "ABNAMROISO20022" |
| **table** | AL table name in JSON | "CTS-CB Field Validation", "Payment Method" |
| **field** | Specific field or concept | "IBAN", "Amount", "Creditor Name" |
| **scope** | Breadth of search | single file / cross-file / all files |

### File Category Quick Reference

| Question About | File Category | Path Pattern |
|----------------|---------------|--------------|
| Bank name, default import/export, bank system mappings | Bank | `Files/Bank/{BankCode}.json` |
| Bank system config, payment methods, field validations | Bank System | `Files/Bank System/{BankSystemCode}.json` |
| Export-specific bank system config | Bank System - Export | `Files/Bank System - Export/{BankSystemCode}.json` |
| Import-specific config, ISO codes per bank system | Bank System - Import | `Files/Bank System - Import/{BankSystemCode}.json` |
| Global field validations (not bank-specific) | Bank System General | `Files/BankSystemGeneral.json` |
| File architecture, table metadata | General Data | `Files/GeneralData.json` |
| Validation rule DSL definitions | Validation | `Files/Validation.json` |
| Bank closing days (holidays) per country | Export Setup | `Files/ExportSetup.json` |
| ISO bank transaction codes | Import Setup | `Files/ImportSetup.json` |
| PSP/CSV port definitions | PSP | `Files/PSP.json` |
| Danish bank branch directory | Separated Temporary Data | `Files/Separated Temporary Data/BankBranchLookup.json` |

## Step 2: Dispatch Agents

### Always dispatch: Setup Data Tracer

Read `.claude/skills/setup-files-investigate/agents/setup-data-tracer.md` for the agent prompt.

Dispatch as an **Explore** agent to search and read the JSON setup files.

```
Task prompt:
[Include setup-data-tracer.md content]

INPUTS:
- CATEGORY: {category}
- CODE: {code or empty}
- TABLE_NAME: {table name or empty}
- FIELD_NAME: {field name or empty}
- QUESTION: {original user question}
```

### Optionally dispatch: AL Setup Tracer

Read `.claude/skills/setup-files-investigate/agents/al-setup-tracer.md` for the agent prompt.

Dispatch when: the question involves understanding how setup data is used at runtime, how it's imported, or what AL code reacts to it.

```
Task prompt:
[Include al-setup-tracer.md content]

INPUTS:
- TABLE_NAME: {AL table name from JSON key}
- FIELD_NAME: {specific field if applicable}
- QUESTION: {original user question}
```

## Step 3: Synthesize Results

Combine agent findings into a structured answer:

```markdown
## Answer
[Direct answer to the question]

## Setup Data Found
[From Setup Data Tracer: JSON content, file paths, relevant entries]

## AL Usage (if investigated)
[From AL Setup Tracer: how the data maps to AL tables, where it's used at runtime]

## Key Files
- Setup: `Files/Bank System/YAPILY.json` - field validations
- AL: `base-application/.../FieldValidation.Table.al` - runtime table
```

## JSON Structure Patterns

### Bank Files (`Files/Bank/{code}.json`)
Top-level keys: `"CTS-CB Bank"`, `"CTS-CB Bank System Mapping2"`, `"CTS-CB Bulk Payment Rule"`

### Bank System Files (`Files/Bank System/{code}.json`)
Top-level keys: `"Payment Method"`, `"CTS-CB Bank System"`, `"CTS-CB Bank System Pmt. Mth."`, `"CTS-CB Field Validation"`, `"CTS-CB Validation Set"`

## Silent-Failure Trap: `"Communication Type"` is an enum value NAME

**Check this first when a bank system imports without error but behaves as if it
has no communication type** — files land in the wrong place, direct import does
nothing, or everything routes through manual handling.

In the `"CTS-CB Bank System"` header row, `"Communication Type"` must be a value
**name** from `CommunicationType.Enum.al` — **not** the bank code, and not the
bank system code.

```jsonc
// Files/Bank System/ACMEBANKISO20022.json
"CTS-CB Bank System": [
  { "Code": "ACMEBANKISO20022", "Communication Type": "AcmeBank" }  // enum value name
  //                                                  ^ NOT "ACMEBANK" (bank code)
]
```

**Why it is dangerous rather than merely wrong:** an unresolvable value does not
error. It resolves to ordinal `0` — `Manual` — so the bank system imports
cleanly and then routes every file through `CTS-CB Manual Import`. Nothing in the
import log, nothing in the JSON validation, and nothing in the AL layer flags it.
The symptom appears far from the cause.

**Why nobody noticed:** ABN AMRO is `value(9; ABNAMRO)` in the enum and its bank
code is also `ABNAMRO`, so the most-copied reference bank works either way.
Copying its shape while substituting a bank code whose spelling differs from its
enum value name reproduces the bug.

**The same enum value name appears in a second file**, and must match
character-for-character in both:

| File | Array | Field |
|---|---|---|
| `Files/Bank System/{code}.json` | `CTS-CB Bank System` | `"Communication Type"` |
| `Files/Bank/{CODE}.json` | `CTS-CB Bank System Mapping2` | `"Supported Communication"` |

**To verify a value is real** rather than assuming:

```bash
grep -n 'value(' <banking>/base-application/**/CommunicationType.Enum.al
```

Compare the value name — case and all — against both JSON fields above. Do not
infer the spelling from the bank code, the bank system code, or the folder name.

### Root-Level Files
- `GeneralData.json`: `"CTS-CB File Architecture"` (self-referential bootstrap)
- `BankSystemGeneral.json`: `"CTS-CB Field Validation"` (global rules)
- `Validation.json`: `"CTS-CB Validation Set"` (validation DSL)
- `ExportSetup.json`: `"CTS-PE Bank Closing Day"` (holidays)
- `ImportSetup.json`: `"CTS-PI ISO Bank Trans. Code"` (ISO codes)
- `PSP.json`: `"CTS-CB CSV Port"` (PSP definitions)

## Connection to AL Code

For detailed architecture, read: `.claude/skills/setup-files-investigate/docs/import-architecture.md`

Key mapping:
- JSON top-level keys = AL table names (e.g., `"CTS-CB Field Validation"` → Table "CTS-CB Field Validation")
- `FileArchitecture` table maps (FileCategory, TableName) → target Table ID + write strategy
- `SetupDataManagement.ImportJson()` uses reflection to map JSON fields → AL table fields by name
- `FileCategory` enum values match the folder/file structure in the setup repo

## Import Behavior: FileArchitecture in GeneralData.json

The `"CTS-CB File Architecture"` array in `GeneralData.json` controls **how** each table's data is written during import. Key fields per entry:

| Field | Values | Impact |
|-------|--------|--------|
| `Data Update` | `Replace Table` / `Update Table` / `Replace Selected Fields` | Controls whether records are deleted+reinserted, upserted, or partially updated |
| `Replace Fields By ID` | Comma-separated field IDs (e.g., `"2,3,4,5,6"`) | Only these field IDs are overwritten (only used with `Replace Selected Fields`) |
| `Run OnValidate Trigger` | `true` / `false` | Whether field OnValidate triggers fire during import (guards may prevent overwrites) |
| `Run OnInsert Trigger` | `true` / `false` | Whether OnInsert trigger fires for new records |
| `Field ID` / `Field Name` | Filter field | Used to scope operations by bank system code or bank code |
| `Table Filter` | Filter expression | Scoped deletion filter for `Replace Table` strategy |

### How to answer "will field X be overwritten?"

1. Find the FileArchitecture entry in `GeneralData.json` matching the target table (by `Table ID` or `File Category`)
2. Check `Data Update`:
   - **`Replace Table`**: Yes — the entire record is deleted and re-inserted from the setup file
   - **`Update Table`**: Yes — all fields from the JSON are written onto existing records
   - **`Replace Selected Fields`**: Only if the field's ID appears in `Replace Fields By ID`
3. If `Run OnValidate Trigger` = `true`, also check the AL table's OnValidate trigger — it may contain guards that revert programmatic overwrites

## Reference Docs

| Doc | When to Read |
|-----|--------------|
| `docs/repo-structure.md` | For detailed file layout, naming conventions, all bank system codes |
| `docs/import-architecture.md` | For AL-side import flow, FileArchitecture, ETag caching, module subscribers |
