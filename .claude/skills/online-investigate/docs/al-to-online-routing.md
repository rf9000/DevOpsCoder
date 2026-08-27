# AL to Online Routing: How BC Decides Which Endpoint Receives a Request

> Last verified: 2026-02-25

This doc explains the URL construction chain from Business Central (AL) to online microservices. Read this when investigating "why did the request go to bank X instead of bank Y?"

## URL Construction Formula

```
Final URL = StrSubstNo(
    URLTemplate,                    // From CTS-CB Url table (e.g., 'Convert', 'GetTransactions')
    ICommunicationTypeSpecificUrlValue.GetUrlValue(...)  // Bank-specific URL segment
)
```

**Example:** If the URL template is `https://api.continia.com/public-api/v1/%1/conversion` and `GetUrlValue()` returns `banksapi`, the final URL is `https://api.continia.com/public-api/v1/banksapi/conversion`.

## Component 1: CTS-CB Url Table

**File:** `base-application/Communication/Tables/Url.Table.al` (Table 71553578)

Simple key-value store:
- `Name: Text[60]` — URL identifier (e.g., `'Convert'`, `'GetTransactions'`, `'GetPaymentStatus'`)
- `Value: Text[250]` — URL template with `%1` placeholder for bank-specific segment

Retrieved via `IHttpFactory.GetUrlInterface().GetUrl('Convert')`.

## Component 2: ICommunicationTypeSpecificUrlValue Interface

**File:** `base-application/Bank Communication/Interfaces/ICommunicationTypeSpecificUrlValue.Interface.al`

Three overloads of `GetUrlValue`:

```al
procedure GetUrlValue(BankSystemCode: Code[30]): Text
procedure GetUrlValue(BankSystemCode: Code[30]; TransactionType: Enum "CTS-CB Transaction Type"): Text
procedure GetUrlValue(BankSystemCode: Code[30]; TransactionType: Enum "CTS-CB Transaction Type"; Conversion: Boolean): Text
```

The overload used depends on the entry point (see below). The return value becomes the `%1` substitution in the URL template.

## Component 3: Implementations (7 total)

| Codeunit | ID | Used By | Overload 1 | Overload 2 | Overload 3 (Conversion) |
|---|---|---|---|---|---|
| **DefaultComTypeUrlValue** | 71553802 | Most banks | `BankSystemCode` | `BankSystemCode` | `BankSystemCode` |
| **BANKSapiComTypeUrlValue** | 72282326 | BANKSapiEBICS (19) | `'banksapi'` | `'banksapi'` | See below |
| **EBICSComTypeUrlValue** | 72282355 | EBICS banks | `'banksapi'` | `'banksapi'` | See below |
| **RabobankComTypeUrlValue** | 71553861 | Rabobank (7) | `'RABOBANK20022'` | Conditional | `'RABOBANK20022'` |
| **ABNAmroComTypeUrlValue** | 71553855 | ABNAMRO (9) | `'ABNAMROISO20022'` | Conditional | `'ABNAMROISO20022'` |
| **YapilyComTypeUrlValue** | 72282347 | All Yapily variants | `'YAPILY'` | `'YAPILY'` | `'YAPILY'` |
| **KonfipayComTypeUrlValue** | 71553803 | Konfipay (17) | Comm type name | Conditional | `BankSystemCode` |

### BANKSapiComTypeUrlValue — Overload 3 Logic

```
GetUrlValue(BankSystemCode, TransactionType, Conversion):
    IF BankSystem.EBICS = false
        RETURN 'banksapi'                     // PSD2 bank → always 'banksapi'
    ELSE IF TransactionType IN [Account Statement, Status]
        RETURN 'banksapi'                     // EBICS but statement/status → 'banksapi'
    ELSE
        RETURN BankSystemCode                 // EBICS payment/other → bank system code
```

### EBICSComTypeUrlValue — Overload 3 Logic

```
GetUrlValue(BankSystemCode, TransactionType, Conversion):
    IF TransactionType IN [Account Statement, Status]
        RETURN 'banksapi'                     // Statement/status → 'banksapi'
    ELSE
        RETURN BankSystemCode                 // Payment/other → bank system code
```

## Entry Points (Where URL Construction Happens)

### Entry Point 1: FileConversion.ConvertFile

**File:** `base-application/Conversion/Codeunits/FileConversion.Codeunit.al` (Codeunit 71553706)

**Uses overload 3** (with Conversion = true):

```al
StrSubstNo(
    IHttpFactory.GetUrlInterface().GetUrl('Convert'),
    IHttpFactory.GetCommunicationTypeUrlValue(
        GetCommTypeBankSystem.GetCommunicationType(SystemCode)
    ).GetUrlValue(SystemCode, TransactionType, true)   // Conversion = TRUE
)
```

**When called:** File format conversions (inhouse JSON ↔ bank-specific format).

### Entry Point 2: BANKSapiImportHelper.DoImportCall

**File:** `base-application/Bank Communication/Codeunits/Import/BANKSapiImportHelper.Codeunit.al` (Codeunit 72918625)

**Uses overload 1** (no TransactionType, no Conversion):

```al
// For Status:
StrSubstNo(
    IHttpFactory.GetUrlInterface().GetUrl('GetPaymentStatus'),
    IHttpFactory.GetCommunicationTypeUrlValue(...).GetUrlValue(BankSystemCode)  // 1-param
)

// For Account Statement / Transactions:
StrSubstNo(
    IHttpFactory.GetUrlInterface().GetUrl('GetTransactions'),
    IHttpFactory.GetCommunicationTypeUrlValue(...).GetUrlValue(BankSystemCode)  // 1-param
)
```

**When called:** Importing transactions, account statements, or checking payment status.

### Entry Point 3: BANKSapiExportHelper.SetupBankCommunication

**File:** `base-application/Bank Communication/Codeunits/Export/BANKSapiExportHelper.Codeunit.al` (Codeunit 72282351)

Sets up communication type and bank system code for export flows. Does **not** pass Conversion parameter — delegates to bank-specific export codeunits (BANKSapiExport, BanksAPIExportEBICS, etc.).

## The Conversion Parameter Bug

Both `BANKSapiComTypeUrlValue` and `EBICSComTypeUrlValue` accept a `Conversion: Boolean` parameter in overload 3 but **never read it**:

```al
// BANKSapiComTypeUrlValue — Conversion parameter is accepted but IGNORED
procedure GetUrlValue(BankSystemCode: Code[30]; TransactionType: Enum "CTS-CB Transaction Type"; Conversion: Boolean): Text
var
    BankSystem: Record "CTS-CB Bank System";
begin
    BankSystem.SetLoadFields(EBICS);
    if BankSystem.Get(BankSystemCode) then
        if not BankSystem.EBICS then
            exit(BanksAPITok)              // 'banksapi'
        else
            if TransactionType in [...] then
                exit(BanksAPITok)          // 'banksapi' — even for conversion!
            else
                exit(BankSystemCode);
    // Conversion parameter never referenced ^^^
end;
```

**Impact:** When `FileConversion.ConvertFile` calls with `Conversion = true` and `TransactionType = Account Statement`:
- **Expected:** Route to BANKSAPIEBICS controller (which has CAMT053 support via SDK)
- **Actual:** Routes to BANKSapi PSD2 controller (which returns 415 for CAMT053)
- **Root cause:** The Conversion boolean is ignored; routing is based only on TransactionType

## Communication Type Enum → URL Value Implementation Mapping

**File:** `base-application/Bank Communication/Enums/CommunicationType.Enum.al` (Enum 71553577)

| Ordinal | Communication Type | URL Value Implementation |
|---|---|---|
| 0 | Manual | Default (returns BankSystemCode) |
| 1 | Webservice | Default (Obsolete) |
| 2 | SFTP | Default (Obsolete) |
| 3 | DNB | Default |
| 4 | Bizcuit | Default |
| 5 | TietoEvry | Default |
| 6 | Barclays | Default |
| 7 | Rabobank | **RabobankComTypeUrlValue** → `'RABOBANK20022'` |
| 8 | Yapily | **YapilyComTypeUrlValue** → `'YAPILY'` |
| 9 | ABNAMRO | **ABNAmroComTypeUrlValue** → `'ABNAMROISO20022'` |
| 10 | HSBC | Default |
| 11 | Nordea | Default |
| 12 | DanskeBank | Default |
| 13 | SEBBank | Default |
| 14 | SWEDBank | Default |
| 15 | BankConnect | Default |
| 16 | Handelsbanken | Default |
| 17 | Konfipay | **KonfipayComTypeUrlValue** → comm type name |
| 18 | BanksAPIPSD2 | Default |
| 19 | BANKSapiEBICS | **BANKSapiComTypeUrlValue** → conditional |
| 20 | Citibankiso20022 | Default |
| 21 | AccessPay | Default |
| 22-29 | Yapily variants | **YapilyComTypeUrlValue** → `'YAPILY'` |

## Transaction Type Enum Values

**File:** `base-application/Bank/Enums/TransactionType.Enum.al` (Enum 71553615)

Key routing-relevant values:

| Ordinal | Name | Routing Significance |
|---|---|---|
| 5 | Payment | Triggers 'Send' endpoint; EBICS routes to BankSystemCode |
| 6 | Direct Debit | Some banks (Rabobank, ABN AMRO) route to BankSystemCode |
| 10 | Account Statement | Triggers 'GetTransactions'; EBICS stays on 'banksapi' |
| 11 | Transactions | Triggers 'GetTransactions' |
| 15 | PSP | Some banks route to BankSystemCode |
| 20 | Status | Triggers 'GetPaymentStatus'; EBICS stays on 'banksapi' |

## File Type Enum Values

**File:** `base-application/Bank/Enums/FileType.Enum.al` (Enum 71553613)

The File Type is **not used for URL routing** — it's included in the request body as `file-type` (kebab-case JSON). The online controller reads it to decide local vs SDK handling.

Key values:

| Ordinal | Name | Controller Handling |
|---|---|---|
| 2 | CAMT053 | SDK delegation (where supported) |
| 3 | CAMT054 | SDK delegation |
| 4 | MT940 | SDK delegation |
| 9 | PAIN001 | Local converter |
| 10 | PAIN002 | SDK delegation |
| 11 | PAIN008 | Local converter |
| 12 | CAMT053E | SDK delegation |
| 13 | CAMT054C | SDK delegation |
| 15 | CUSTOMSTATUS | Local converter |
| 17 | CUSTOMPAYMENT | Local converter |
| 19 | CUSTOMSTATEMENT | Local converter |
| 21 | CUSTOMDIRECTDEBIT | Local converter |

Converted to string via: `FileType.Names.Get(FileType.Ordinals.IndexOf(FileType.AsInteger()))`

## Routing Examples

### Example 1: CAMT053 conversion for BANKSapi EBICS bank

```
FileConversion.ConvertFile(SystemCode='BANKSAPIEBICS01', TransactionType=AccountStatement, FileType=CAMT053, ...)
  → CommunicationType = BANKSapiEBICS (19)
  → URL value impl = BANKSapiComTypeUrlValue
  → GetUrlValue('BANKSAPIEBICS01', AccountStatement, true)
  → BankSystem.EBICS = true, TransactionType = AccountStatement → RETURN 'banksapi'
  → Final URL: .../public-api/v1/banksapi/conversion
  → BANKSapi PSD2 controller receives request with file-type: "CAMT053"
  → CAMT053 not in switch → HTTP 415 ❌

Expected: should route to .../public-api/v1/banksapiebics/conversion
```

### Example 2: PAIN001 conversion for EBICS bank

```
FileConversion.ConvertFile(SystemCode='BANKSAPIEBICS01', TransactionType=Payment, FileType=PAIN001, ...)
  → CommunicationType = BANKSapiEBICS (19)
  → BANKSapiComTypeUrlValue.GetUrlValue('BANKSAPIEBICS01', Payment, true)
  → BankSystem.EBICS = true, TransactionType = Payment → RETURN 'BANKSAPIEBICS01'
  → Final URL: .../public-api/v1/BANKSAPIEBICS01/conversion ✅
```

### Example 3: Account statement import for BANKSapi

```
BANKSapiImportHelper.DoImportCall(TransactionType=AccountStatement, ...)
  → GetUrlValue('BANKSAPIEBICS01')  // 1-param overload
  → BANKSapiComTypeUrlValue returns 'banksapi'
  → Final URL: .../public-api/v1/banksapi/gettransactions ✅ (import, not conversion)
```
