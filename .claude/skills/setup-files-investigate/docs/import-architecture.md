# AL-Side Import Architecture

How JSON setup files are downloaded from Azure Blob Storage and written into AL tables.

## Overview

```
Trigger (Job Queue / Wizard / Manual)
    │
    ▼
ImportSetup.ImportGeneralSetup()
    ├── ETag HEAD → compare with BankingSetup."General Setup ETag"
    ├── If stale: GET GeneralData.json → SetupDataManagement.ImportJson()
    │       ├── For each JSON key (= AL table name):
    │       │     GetFileArchitecture(name, category)
    │       │     → RecordRefFunctions.GetFieldNameIdMapping() [reflection]
    │       │     → For each JSON array entry:
    │       │         JsonFunctions.AssignRecRefFromJsonToken()
    │       │         → Insert/Modify per DataReplacement strategy
    │       │
    ├── OnAfterImportGeneralSetup event →
    │       CTS-PE Import Setup → ExportSetup.json
    │       CTS-PI Import Setup → ImportSetup.json
    │       CTS-CBPP Import Setup → PSP.json
    │
    ▼
ImportSetup.ImportBankSystem(code)
    ├── Dependencies: GeneralSetup + GeneralBankSystem
    ├── GET Bank System/{code}.json → ImportJson()
    ├── OnAfterImportBankSystem event →
    │       CTS-PE Import Setup → Bank System - Export/{code}.json
    │       CTS-PI Import Setup → Bank System - Import/{code}.json
    │
    ▼
ImportSetup.ImportBank(code)
    ├── Dependency: GeneralSetup
    └── GET Bank/{code}.json → ImportJson()
```

## Key AL Objects

### SetupDataManagement (Codeunit 71553629)

**Path:** `base-application/Communication/Codeunits/SetupDataManagement.Codeunit.al`

The core import engine. Key procedures:

| Procedure | Purpose |
|-----------|---------|
| `GetETagFromStorage(Url, IHttpFactory)` | HTTP HEAD to check if file changed (ETag comparison) |
| `GetSetupFromAzure(Url, var JsonToken, IHttpFactory)` | HTTP GET to download JSON |
| `GetSetupFromFile(var JsonToken, FileName)` | Manual file upload path |
| `ImportJson(FileJsonObject, FileCategory, FilterValue)` | Entry point: iterates JSON keys, calls FillData per table |
| `FillData(ObjectName, Token, FileCategory, FilterValue)` | Core: lookup FileArchitecture → build field mapping → write records |
| `GetFileArchitecture(ObjectName, FileCategory, var FileArchitecture)` | Finds target table config; bootstraps itself for "CTS-CB File Architecture" |

**Import flow in FillData:**
1. Look up `FileArchitecture` record for the JSON key (table name) and file category
2. For `Replace Table`: delete existing records (optionally scoped by filter value)
3. Build `FieldNameIdMapping` dictionary (field name → field ID) via reflection
4. For each JSON array entry: populate `RecordRef` fields from JSON, then Insert or Modify
5. Language pinned to 1033 (English) during field assignment

### ImportSetup (Codeunit 71553623)

**Path:** `base-application/Communication/Codeunits/ImportSetup.Codeunit.al`

Orchestrator for base application imports. Controls dependency order and ETag caching.

| Procedure | Downloads | ETag Field |
|-----------|-----------|------------|
| `ImportGeneralSetup` | `GeneralData.json` | `BankingSetup."General Setup ETag"` |
| `ImportGeneralBankSystem` | `BankSystemGeneral.json` | `BankingSetup."General Bank System Setup ETag"` |
| `ImportBank(BankCode)` | `Bank/{code}.json` | Per `CTS-CB Bank` record |
| `ImportBankSystem(BankSystemCode)` | `Bank System/{code}.json` | Per `CTS-CB Bank System` record |
| `UpdateValidations` | `Validation.json` | `BankingSetup."Validation ETag"` |

**Integration Events:**
- `OnAfterImportGeneralSetup(ManualImport, Force)` — subscribed by export/import/PSP modules
- `OnAfterImportBankSystem(BankSystemCode, ManualImport, Force)` — subscribed by export/import modules

### FileArchitecture (Table 71553599)

**Path:** `base-application/Communication/Tables/FileArchitecture.Table.al`

Maps (FileCategory, TableName) to target table and write strategy.

| Field | Purpose |
|-------|---------|
| `File Category` (PK1) | Enum: which JSON file |
| `Order No.` (PK2) | Import ordering within category |
| `Table ID` | Target AL table |
| `Table Filter` | Scoped deletion filter for Replace Table |
| `Field ID` / `Field Name` | Filter field for building Table Filter at runtime |
| `Data Update` | Strategy: Replace Table / Update Table / Replace Selected Fields |
| `Replace Fields By ID` | Comma-separated field IDs for Replace Selected Fields |
| `Run OnInsert Trigger` | Fire OnInsert on new records? |
| `Run OnValidate Trigger` | Fire OnValidate when assigning fields? |

**Bootstrap:** FileArchitecture records are themselves imported from `GeneralData.json` — the import engine detects `ObjectName = "CTS-CB File Architecture"` and bootstraps with `Replace Table` strategy.

### FileCategory (Enum 71553601)

**Path:** `base-application/Communication/Enum/FileCategory.Enum.al`

| Value | Ordinal | JSON File |
|-------|---------|-----------|
| `General Data` | 0 | `GeneralData.json` |
| `Bank System General` | 1 | `BankSystemGeneral.json` |
| `Bank System` | 2 | `Bank System/{code}.json` |
| `Bank` | 3 | `Bank/{code}.json` |
| `Validation` | 4 | `Validation.json` |
| `Separated Temporary Data` | 10 | Special (no category filter on FileArchitecture lookup) |
| `Export Setup` | 15 | `ExportSetup.json` |
| `Bank System - Export` | 16 | `Bank System - Export/{code}.json` |
| `Import Setup` | 20 | `ImportSetup.json` |
| `Bank System - Import` | 21 | `Bank System - Import/{code}.json` |
| `PSP` | 25 | `PSP.json` |

### DataReplacement (Enum 71553602)

**Path:** `base-application/Communication/Enum/DataReplacement.Enum.al`

| Value | Behavior |
|-------|----------|
| `Update Table` (0) | Upsert: if PK exists → update; else insert |
| `Replace Table` (1) | Delete all (optionally filtered), then insert all |
| `Replace Selected Fields` (2) | Like Update but only overwrites fields in `Replace Fields By ID` |

### Urls (Codeunit 71553630)

**Path:** `base-application/Communication/Codeunits/Urls.Codeunit.al`

Constructs Azure Blob URLs. Format: `https://bankingfiles.blob.core.windows.net/{env}/CTSCB/setupfiles/{version}/{filename}`

- Single-file categories: `{CategoryNameNoSpaces}.json`
- Per-code categories: `{CategoryName}/{code}.json`
- Has `OnBeforeBaseEndpoint` event for demo app URL override

### JsonFunctions (Codeunit 71553624)

**Path:** `base-application/Helper/Codeunits/JsonFunctions.Codeunit.al`

- `AssignRecRefFromJsonToken()` — Maps JSON keys to AL fields via `FieldNameIdMapping`, calls `EvaluateValue` per field
- `ExportRecRefToJsonObject()` — Inverse: AL record → JSON
- Handles null values, telemetry for unmapped/unevaluated fields

### RecordRefFunctions (Codeunit 71553636)

**Path:** `base-application/Helper/Codeunits/RecordRefFunctions.Codeunit.al`

- `GetFieldNameIdMapping()` — Queries `Field` system table, builds field name → field ID dictionary
- `EvaluateValue()` — Parses text into AL field type (delegates to `ConfigValidateManagement.EvaluateValue`)
- Reflection utilities for PK handling, field transfer, blank value detection

## Module-Specific Import Codeunits

| Codeunit | ID | Module | Subscribes To | Handles |
|----------|------|--------|---------------|---------|
| `CTS-PE Import Setup` | 71553905 | export/ | `OnAfterImportGeneralSetup`, `OnAfterImportBankSystem` | Export Setup, Bank System - Export |
| `CTS-PI Import Setup` | 71554210 | import/ | `OnAfterImportGeneralSetup`, `OnAfterImportBankSystem` | Import Setup, Bank System - Import |
| `CTS-CBPP Import Setup` | 72282089 | psp/ | `OnAfterImportGeneralSetup` | PSP |

## Key Insight: JSON Key = AL Table Name

The mapping between JSON and AL is by convention:
- JSON top-level keys are AL table **names** (captions), e.g., `"CTS-CB Field Validation"`
- JSON array entry keys are AL **field names**, e.g., `"Bank System Code"`, `"Required"`
- `RecordRefFunctions.GetFieldNameIdMapping()` builds the field name → ID lookup at runtime via reflection
- This means any changes to table/field names in AL must be mirrored in the JSON files
