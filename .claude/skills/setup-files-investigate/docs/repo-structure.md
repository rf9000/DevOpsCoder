# Setup Files Repo Structure

**Repo:** Resolved from repo-paths.json as `setup-files` (see SKILL.md Step 0)

## Directory Tree

```
Continia Banking - Setup Files/
  CLAUDE.md                              # Project instructions
  CODEOWNERS.md                          # lake@continia.com slla@continia.com tbn@continia.com
  README.md                              # Placeholder (not written yet)
  Setup/                                 # AL extension project (CTS-SS prefix, ID range 50000-51000)
  Files/                                 # All JSON setup data files
    Bank/                                # 547 files - one per bank
    Bank System/                         # 94 files - one per bank system
    Bank System - Export/                # 94 files - export-specific per bank system
    Bank System - Import/                # 94 files - import-specific per bank system
    Separated Temporary Data/            # 1 file - BankBranchLookup.json
    BankSystemGeneral.json               # Global field validations
    ExportSetup.json                     # Bank closing days per country
    GeneralData.json                     # File architecture / table metadata
    ImportSetup.json                     # ISO bank transaction codes
    PSP.json                             # PSP/CSV port definitions
    Validation.json                      # ~5MB - validation rule DSL definitions
```

**Total:** ~830+ JSON files

## File Naming Conventions

- **Bank files:** Named by bank code (e.g., `DANSKEBANK.json`, `HSBC.json`)
- **Bank System files:** Named by bank system code (e.g., `DANSKEBANKBUSINESSONLINE.json`, `YAPILY.json`)
- **Bank System - Export/Import:** Mirror the Bank System folder with same filenames
- **JSON keys:** AL table names used as top-level keys (e.g., `"CTS-CB Bank"`, `"CTS-CB Field Validation"`)

## All Bank System Codes (94)

```
ABNAMROISO20022       ABN-INBANK            ACCESSPAY             ATSEPAV09
BANKDATAISO20022      BANKMENDESGANSNV      BANKSAPI              BANKSAPIEBICS
BARCLAYS              BARC-MAN              BD01                  BD01-JB
BD01-SEB              BEC01                 BECISO20022           BESEPAV09
BIZCUIT               BNPPARIBAS            BNPPARIBASCH          BNPPARIBASDK
CHISOV09              CITIBANKISO20022      COMMERZBANK           CREDITSUISSE
DANSKEBANKBUSINESSONLINE                    DESEPAV03             DESEPAV09
DEUTSCHEBANK          DKBISO20022           DNBISO20022           ERSTEBANKAUSTRISO20022
ESSEPAV09             FLESSABANK            FRSEPAV09             GBISOV09
GLSGEMEINSCHAFTSB     HANDELSBANKENISO20022 HSBC                  HSBC-GB
HSBC-GLOB             HYPOVEREINISO20022    INGISO20022           ISO-BNPDK
ISO-BOFAML            JPM-ACCESS            JPMORGAN              KBC
KONFIPAYSEPA          KYRIBA                LBBWISO20022          LLOYDS-CBO
LUSEPAV09             NACHA                 NATWEST               NDEA-CORP
NDEA-NACHA            NLSEPAV09             OLDENBURGLANDESBANAG  ORCO
PLSEPAV09             POSTFINANCE           PTSEPAV09             RABOBANK20022
RAIFFEISEN            RAIFFEISENISO20022AT  RAIFFEISENISO20022CH  RAIFFEISENISO20022DE
SDC01                 SDCISO20022           SE_BNKG               SEBISO20022
SOLARIS               SPAREB-ISO            SPARKASSENAT          SPARKASSENISO20022
SWEDBANKISO20022      TARGOBANK             TEMPSEPAPAIN03        TIETOEVRY
TRATON                UBSAG                 UNICREDITAUSTRISO20022 UNITEL02
YAPAIB                YAPBARC               YAPHSBC               YAPILY
YAPLLOYD              YAPNATWEST            YAPRBS                YAPREVOLUT
YAPSANT               YAPSILICON            ZURICHCANTONALISO20022
```

## JSON Structure by Category

### Bank Files (`Files/Bank/{code}.json`)

```json
{
  "CTS-CB Bank": [
    { "Code": "DANSKEBANK", "Name": "DANSKE BANK", "Default Import/Export": "Direct" }
  ],
  "CTS-CB Bank System Mapping2": [
    {
      "Bank Code": "DANSKEBANK",
      "Bank System Code": "DANSKEBANKBUSINESSONLINE",
      "Bank System Description": "Danske Bank Business Online - Communication via webservice",
      "Supported Communication": "DanskeBank",
      "Import/Export Comm Type": "Direct"
    }
  ],
  "CTS-CB Bulk Payment Rule": []
}
```

### Bank System Files (`Files/Bank System/{code}.json`)

```json
{
  "Payment Method": [
    {
      "Code": "FP",
      "Description": "Faster Payment",
      "CTS-CB Payment Method Code": "10820",
      "CTS-CB Direct Debit": false,
      "CTS-CB Type": "Account Transfer"
    }
  ],
  "CTS-CB Bank System": [
    {
      "Code": "YAPILY",
      "Name": "Yapily - PSD2 service provider",
      "Communication Type": "Yapily"
    }
  ],
  "CTS-CB Bank System Pmt. Mth.": [...],
  "CTS-CB Field Validation": [
    {
      "Bank System Code": "YAPILY",
      "CB Payment Method Code": "00000000000",
      "Field Name": "Payment Method Code",
      "Required": "true",
      "Validated": "false"
    }
  ],
  "CTS-CB Validation Set": [...]
}
```

### Bank System - Export Files (`Files/Bank System - Export/{code}.json`)

Many are empty (`{}`). When populated, contain export-specific configuration.

### Bank System - Import Files (`Files/Bank System - Import/{code}.json`)

```json
{
  "CTS-PI PropBankTransCodeIssr": [...],
  "CTS-PI Default Stmt Desc Templ": [...],
  "CTS-PI Default Pmt Desc Templ": [...]
}
```

### BankSystemGeneral.json

Global field validation rules (not bank-system-specific):
```json
{
  "CTS-CB Field Validation": [
    {
      "Bank System Code": "",
      "CB Payment Method Code": "00000000000",
      "Field Name": "Amount",
      "Required": "true",
      "Validated": "false",
      "Payment Validation": true,
      "Purchase Validation": false,
      "Sales Validation": false
    }
  ]
}
```

### GeneralData.json

File architecture bootstrap — defines table-to-category mappings:
```json
{
  "CTS-CB File Architecture": [
    {
      "File Category": "Bank System General",
      "Order No.": 1,
      "Table ID": 71553578,
      "Data Update": "Replace Table"
    }
  ]
}
```

### ExportSetup.json

Bank closing days (holidays) per country/region:
```json
{
  "CTS-PE Bank Closing Day": [
    {
      "Country/Region Code": "AT",
      "Date": "2024-01-01",
      "Description": "Neujahr"
    }
  ]
}
```

### ImportSetup.json

ISO bank transaction codes reference table:
```json
{
  "CTS-PI ISO Bank Trans. Code": [
    {
      "Domain": "ACMT",
      "Family": "ACOP",
      "Sub-Family": "ADJT",
      "Description": "Account Management / Additional Miscellaneous Credit Operations / Adjustments"
    }
  ]
}
```

### PSP.json

PSP settlement import CSV port definitions:
```json
{
  "CTS-CB CSV Port": [
    {
      "Code": "ADYEN",
      "Description": "Adyen Settlement Import",
      "CSV Format": "...",
      "Separator": ",",
      "Date Format": "yyyy-MM-dd"
    }
  ]
}
```

### Validation.json (~5MB)

Validation rule DSL definitions:
```json
{
  "CTS-CB Validation Set": [
    {
      "Code": "V000002",
      "Description": "Creditor IBAN Length Greater than 28; Bank System Code Content Equal to X; ..."
    }
  ]
}
```

### BankBranchLookup.json

Danish bank branch directory:
```json
{
  "CTS-SS Bank Branch Lookup": [
    {
      "Bank Branch No.": "0004",
      "Name": "Danske Bank A/S",
      "Address": "Holmens Kanal 2-12",
      "PostCode": "1092",
      "City": "Copenhagen K",
      "Country Code": "DK"
    }
  ]
}
```

## Search Tips

- **Find a specific bank:** Grep for bank code in `Files/Bank/` filenames
- **Find bank system config:** Look in `Files/Bank System/{BankSystemCode}.json`
- **Cross-file search:** Use grep across `Files/` for a table name, field name, or value
- **Field validations:** Check both `BankSystemGeneral.json` (global) and `Bank System/{code}.json` (per-system)
- **Bank-to-bank-system mapping:** Look in `Files/Bank/{BankCode}.json` under `"CTS-CB Bank System Mapping2"`
