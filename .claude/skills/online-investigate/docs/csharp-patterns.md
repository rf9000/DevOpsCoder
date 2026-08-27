# C# Repo Structure Patterns

Online banking repos follow one of three structural patterns. Agents must identify the pattern before searching for mappings.

## Pattern Detection

1. List top-level folders in `.Web/` project
2. If `Services/` exists → **Standard**
3. If `Common/Helpers/` exists without `Services/` → **Simplified**
4. If no `.Web/` project → **Library**

## Standard ASP.NET (e.g., Rabobank, DanskeBank)

```
.Web/
├── Controllers/v1/
│   ├── PublicController.cs       ← BC-facing endpoints
│   ├── PrivateController.cs      ← Worker/bank API endpoints
│   ├── ConversionController.cs   ← Format conversions
│   ├── Models/                   ← Request models from BC
│   └── Dtos/                     ← Bank response DTOs
├── Services/
│   ├── Pain00100109ConversionService.cs  ← Inhouse → PAIN001
│   ├── Pain00800108ConversionService.cs  ← Inhouse → PAIN008
│   ├── I*Service.cs                      ← Service interfaces
│   └── ICustomStatusService.cs           ← Status conversions
├── Common/
│   ├── *Builder.cs               ← Bank → CAMT/inbound
│   ├── *RequestFactory.cs        ← HTTP request building
│   └── AddressFormatter.cs
├── Persistence/                  ← EF Core
├── Models/                       ← Domain/config
└── Constants.cs
```

| What | Search location |
|------|----------------|
| Outbound mappings (inhouse→bank) | `Services/Pain*.cs` |
| Inbound mappings (bank→inhouse) | `Common/*Builder.cs`, `ConversionController.cs` |
| Error handling | Controllers + Services |
| Endpoints | `Controllers/v1/PublicController.cs` |
| Request models | `Controllers/v1/Models/` |
| Response DTOs | `Controllers/v1/Dtos/` |
| Bank API calls | `Common/*RequestFactory.cs` + Services |

## Simplified ASP.NET (e.g., AccessPay)

```
.Web/
├── Controllers/
│   └── *Controller.cs
├── Common/
│   ├── Helpers/
│   │   └── Converter.cs          ← All conversions here
│   ├── Clients/
│   │   └── *Client.cs            ← Bank API HTTP clients
│   └── Models/                   ← Mixed request/response models
└── ...
```

| What | Search location |
|------|----------------|
| All mappings | `Common/Helpers/Converter.cs` |
| Error handling | Controllers + Common |
| Bank API calls | `Common/Clients/*Client.cs` |
| Models | `Common/Models/` (mixed) |

## Utility Library (e.g., BankConnect)

No Controllers. No `.Web/` project. Direct `.cs` files at root.

```
Root/
├── *Communication.cs             ← Main communication logic
├── Common/
│   ├── WCF/                      ← WCF service references
│   └── Models/
└── ...
```

| What | Search location |
|------|----------------|
| Mappings | Root `*Communication.cs` |
| Error handling | Root `.cs` files |
| Bank API calls | Root + `Common/WCF/` |

## SDK Components (Continia.Online.Banking.SDK.Web)

**Repo:** `Online - Continia.Online.Banking.SDK.Web`
**Local clone:** `{ONLINE_REPOS_PATH}/Online%20-%20Continia.Online.Banking.SDK.Web`

### SDK Packages

| Package | Purpose |
|---|---|
| `Continia.Online.Banking.SDK.Web` | Base controller, serialization, health checks, ConversionService |
| `Continia.Online.Banking.SDK.Web.Direct` | Direct bank integration helpers |

### BaseController

**File:** `Continia.Online.Banking.SDK.Web/Common/BaseController.cs`

All bank controllers inherit from `BaseController`. Provides:
- `HandleException()` → Returns `ApiError` with HTTP 500
- Request logging with correlation ID
- Standard error response formatting

### ConversionService (Typed HttpClient)

**File:** `Continia.Online.Banking.SDK.Web/Services/ConversionService.cs`

Delegates conversions to the centralized Common Conversion Service:

```csharp
public async Task<string> ConvertAsync<TPayload>(
    string bankCentral,
    ConversionRequest<TPayload> request,
    CancellationToken cancellationToken
) where TPayload : IPayload
{
    HttpResponseMessage response = await httpClient.PostAsJsonAsync(bankCentral, request, cancellationToken);
    return await response.Content.ReadAsStringAsync(cancellationToken);
    // WARNING: No response.EnsureSuccessStatusCode()!
}
```

**Bug:** Does NOT check `response.StatusCode`. If the Common Conversion Service returns an error, the error body is silently returned as "converted" content wrapped in a 200 OK.

### ServiceCollectionExtensions

**File:** `Continia.Online.Banking.SDK.Web/ServiceCollectionExtensions.cs`

Common DI registration called by all bank repos. Registers health checks, JSON serialization, and shared services.

### JSON Serialization Configuration

Configured in each repo's `DependencyInjection.cs`:

| Component | File | Effect |
|---|---|---|
| `KebabCaseNamingPolicy` | `Formatting/KebabCaseNamingPolicy.cs` | PascalCase C# → kebab-case JSON |
| `JsonStringEnumConverter` | System.Text.Json built-in | Enum values as string names |
| `JsonBooleanConverter` | `Formatting/JsonBooleanConverter.cs` | Flexible boolean deserialization |

Key property name mappings:

| C# Property | JSON Key |
|---|---|
| `FileType` | `file-type` |
| `TransactionId` | `transaction-id` |
| `CompanyGuid` | `company-guid` |
| `BcUserName` | `bc-user-name` |
| `Compression` | `compression` |

### DI Lifetime Patterns

| Lifetime | Components | Why |
|---|---|---|
| **Singleton** | `Converter` (local format converters) | Stateless transformation logic |
| **Scoped** | Repositories, compression services | Per-request state |
| **Transient-via-HttpClient** | `ConversionService` (typed HttpClient) | HttpClientFactory-managed |

## ConversionController Pattern

The standard pattern across repos for handling file type conversion:

```csharp
[HttpPost]
public async Task<IResult> Post(
    [FromBody] ConversionRequest<Payload> request,
    CancellationToken cancellationToken)
{
    string? output = request.FileType switch
    {
        // Local conversions
        BankRequestFileTypeEnum.CUSTOMPAYMENT => _converter.ConvertInhouseToCustomPayment(request),
        BankRequestFileTypeEnum.CUSTOMSTATUS => _converter.ConvertCustomStatusToBankExportData(request),

        // SDK delegation to Common Conversion Service
        BankRequestFileTypeEnum.CAMT053 or
        BankRequestFileTypeEnum.CAMT054 or
        BankRequestFileTypeEnum.PAIN002 =>
            await _conversionService.ConvertAsync(Constants.BankName, request, cancellationToken),

        // Unsupported
        _ => null
    };

    if (output is null)
        return TypedResults.Json(
            new ApiError { Message = "File type not supported", Details = $"..." },
            statusCode: 415);  // Or 500 (BANKSAPIEBICS bug)

    return TypedResults.Ok(output);
}
```

> **Important:** `PAIN001` and `PAIN008` are **always handled locally** by bank-specific converters. They are never delegated to the Common Conversion Service via `ConversionService.ConvertAsync()`. If investigating PAIN001 mapping, always look in the bank-specific repo's `Services/Pain001*.cs` or `Common/Converter.cs`.

## Request/Response Models

### ConversionRequest

```csharp
ConversionRequest<TPayload> where TPayload : IPayload
{
    BankRequestFileTypeEnum FileType;   // → "file-type" in JSON
    bool Compression;                   // → "compression" in JSON
    TPayload Payload;                   // → "payload" in JSON
    string TracingId;                   // → "tracing-id"
    string CompanyGuid;                 // → "company-guid"
    string BcUserName;                  // → "bc-user-name"
}
```

### Payload (IPayload / IBCRequest)

```csharp
Payload : IPayload
{
    string Content;                     // → "content" in JSON
    // Content is the actual file data (plain or GZip+Base64 if compressed)
}
```

### ApiError

```csharp
ApiError
{
    string Message;                     // → "message" in JSON
    string Details;                     // → "details" in JSON
}
```

### BankRequestFileTypeEnum

C# enum with all file types. Members match AL `CTS-CB File Type` enum names exactly:

`CAMT053`, `CAMT053E`, `CAMT054`, `CAMT054C`, `PAIN002`, `MT940`, `PBSSEKTOR`, `CUSTOMPAYMENT`, `CUSTOMSTATUS`, `CUSTOMSTATEMENT`, `CUSTOMDIRECTDEBIT`, `PAIN001`, `PAIN008`, `CAMT052`, `CSV`, `SINGLEPAYMENT`, `BULKPAYMENT`, etc.

Serialized as string via `JsonStringEnumConverter`: `BankRequestFileTypeEnum.CAMT053` → `"CAMT053"` in JSON.

## Error Handling Patterns

### Standard Error Response

```csharp
// Unsupported file type (correct: 415)
return new ObjectResult(new ApiError
{
    Message = "File type not supported",
    Details = $"File type {request.FileType} is not supported"
}) { StatusCode = 415 };

// BANKSAPIEBICS variant (bug: 500 instead of 415)
return TypedResults.Json(new ApiError
{
    Message = "Unsupported Media Type",
    Details = $"File type {request.FileType} is not supported"
}, statusCode: 500);
```

### HTTP Status Codes

| Code | Meaning | When |
|---|---|---|
| **200** | Success | Conversion completed (or silent error passthrough from SDK bug) |
| **400** | Bad Request | Validation/deserialization failures |
| **415** | Unsupported Media Type | File type not handled by this controller |
| **500** | Internal Server Error | Unhandled exceptions; also BANKSAPIEBICS unsupported type bug |

## SDK Delegation

Some repos delegate conversion to the remote Common Conversion Service via `ConversionService.ConvertAsync()`. If you find this call instead of local mapping logic, the actual transformation happens in the centralized Azure service, not in the bank repo. Flag this in findings and see `controller-routing-matrix.md` for which types each bank delegates.

## Inhouse JSON Model (Shared)

The inhouse JSON model is defined in **`Continia.Online.Banking.Common`** (NuGet package, repo: `Online - Continia.Online.Banking.Common`). All bank converters reference this package for deserializing the inhouse JSON content.

### Key `TransactionInformation` Properties

| C# Property | Type | JSON Key (kebab-case) | Used For |
|---|---|---|---|
| `CategoryCode` | string | `category-code` | Primary → `<RgltryRptg><Dtls><Cd>` |
| `CategoryDescription` | string | `category-description` | → `<RgltryRptg><Dtls><Inf>` or second `<Dtls><Cd>` |
| `Purposes` | List\<Purpose\> | `purposes` | Fallback for RgltryRptg when CategoryCode is empty |
| `Creditor` | Creditor | `creditor` | Nested object with creditor details |
| `Creditor.Bank.CountryCode` | string | nested | Some converters use for `<RgltryRptg><Dtls><Ctry>` |

### `Purpose` Model

```csharp
Purpose
{
    string Code;           // → "code" — maps to <Dtls><Cd>
    string Description;    // → "description" — maps to <Dtls><Inf>
}
```

### RgltryRptg Mapping Patterns Across Banks

Different banks handle RgltryRptg differently. Common pattern (DNB, DanskeBank, SwedBank, Nordea):

1. **If `CategoryCode` is present** → Create `RegulatoryReporting3` with `Dtls[0].Cd = CategoryCode`
2. **If `CategoryDescription` is present** → Add to `Dtls[0].Inf` (or second `Dtls` entry)
3. **Fallback to `Purposes[]`** → Each Purpose becomes a `StructuredRegulatoryReporting3`

**Not mapped by any bank:** `<DbtCdtRptgInd>`, `<Authrty>`, `<Dtls><Tp>` — these ISO 20022 elements have no source in the shared model.

## Universal Search Fallbacks

When pattern-specific paths don't yield results, grep across entire repo:
- Field name as property: `*.cs` files
- Conversion logic: `Convert|Map|Transform` in `*.cs`
- Error handling: `StatusCode|Exception|ApiError|Problem` in `*.cs`
- Request models: `ConversionRequest|IBCRequest|IPayload` in `*.cs`
- JSON mapping: `JsonPropertyName|KebabCase` in `*.cs`
