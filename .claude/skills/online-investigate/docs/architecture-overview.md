# Architecture Overview: BC to Online Microservices

> Last verified: 2026-02-25

High-level request flow, shared patterns, and key components across all online banking microservices.

## Request Flow

```
Business Central (AL)
  |
  |  HTTP POST (JSON, kebab-case properties)
  |  Authorization: Bearer <ContiniaToken JWT>
  v
Azure API Management / Routing
  |
  |  Routes by URL segment: /public-api/v1/{bank-slug}/...
  v
Bank-Specific Web API (ASP.NET Minimal API)
  |
  +-- PublicController    (BC-facing: Send, GetTransactions, GetPaymentStatus)
  +-- PrivateController   (Worker/bank-callback endpoints)
  +-- ConversionController (File format conversion)
        |
        +-- switch(request.FileType)
        |     |
        |     +-- CUSTOMPAYMENT, CUSTOMSTATUS, etc. --> Local Converter
        |     +-- CAMT053, PAIN002, MT940, etc.     --> SDK ConversionService
        |     +-- default                           --> HTTP 415 (or 500 bug)
        v
  Common Conversion Service (centralized Azure service)
    Handles: CAMT053, CAMT053E, CAMT054, CAMT054C, PAIN002, MT940, PBSSEKTOR
```

## Three Controller Patterns

| Controller | Role | Route Example |
|---|---|---|
| **PublicController** | BC-facing endpoints: Send payments, GetTransactions, GetPaymentStatus | `POST /public-api/v1/{slug}/send` |
| **PrivateController** | Internal/worker endpoints: bank callbacks, async job processing | `POST /private-api/v1/{slug}/...` |
| **ConversionController** | File format conversion: inhouse JSON <-> bank-specific formats | `POST /public-api/v1/{slug}/conversion` |

All controllers inherit from `BaseController` (SDK).

## SDK Shared Components

Package: `Continia.Online.Banking.SDK.Web`

| Component | Purpose |
|---|---|
| `BaseController` | Error handling (`HandleException()` -> `ApiError`), request logging with correlation ID |
| `ConversionService` | Typed `HttpClient` for delegating conversions to Common Conversion Service |
| `KebabCaseNamingPolicy` | JSON naming: `PascalCase` C# properties -> `kebab-case` JSON keys |
| `JsonStringEnumConverter` | Enums serialize as string names (e.g., `CAMT053` not `2`) |
| `JsonBooleanConverter` | Flexible boolean deserialization (handles string `"true"` and native `true`) |
| `ServiceCollectionExtensions` | Common DI registration for all bank repos |

## Error Response Model

All errors use the `ApiError` shape:

```json
{
  "message": "File type not supported",
  "details": "File type CAMT053 is not supported"
}
```

| HTTP Status | Meaning | When |
|---|---|---|
| **400** | Bad Request | Validation failures, deserialization errors |
| **415** | Unsupported Media Type | File type not handled by this controller (BANKSapi pattern) |
| **500** | Internal Server Error | Unhandled exceptions; also used by BANKSAPIEBICS for unsupported types (bug) |

**Known bug:** BANKSAPIEBICS returns `500` instead of `415` for unsupported file types. The error message says "Unsupported Media Type" but the status code is 500.

## JSON Serialization

All repos configure JSON via `DependencyInjection.cs`:

| Setting | Effect | Example |
|---|---|---|
| `KebabCaseNamingPolicy` | Property names: PascalCase -> kebab-case | `FileType` -> `file-type` |
| `JsonStringEnumConverter` | Enum values as strings | `BankRequestFileTypeEnum.CAMT053` -> `"CAMT053"` |
| `JsonBooleanConverter` | Flexible booleans | `"true"` and `true` both accepted |

Key kebab-case mappings:
- `file-type` (C# `FileType`)
- `transaction-id` (C# `TransactionId`)
- `company-guid` (C# `CompanyGuid`)
- `bc-user-name` (C# `BcUserName`)

## Request/Response Models

**Conversion request:**
```csharp
ConversionRequest<TPayload> where TPayload : IPayload
{
    FileType,           // BankRequestFileTypeEnum (string in JSON)
    Compression,        // bool - whether payload is GZip compressed
    Payload: {
        Content         // string - the actual file content (or compressed+base64)
    },
    TracingId,          // correlation ID
    CompanyGuid,        // tenant identifier
    BcUserName          // originating user
}
```

**File type enum (C# side):** `BankRequestFileTypeEnum` members: `CAMT053`, `CAMT053E`, `CAMT054`, `CAMT054C`, `PAIN002`, `MT940`, `PBSSEKTOR`, `CUSTOMPAYMENT`, `CUSTOMSTATUS`, `CUSTOMSTATEMENT`, `CUSTOMDIRECTDEBIT`, `PAIN001`, `PAIN008`, etc.

## Authorization

- **Most repos:** `ContiniaToken` JWT authorization policy (Bearer token)
- **BANKSapi PSD2:** Open/different authorization for PSD2-specific OAuth flows

## Compression

```
AL side:
  if BankSystem uses GZip compression:
    GZip(content) -> Base64 -> set as Payload.Content
    Add "compression": "true" to request JSON (string, not boolean)

C# side:
  if request.Compression:
    Base64 -> GZip decompress -> process content
```

The `compression` property is a JSON **string** `"true"`, not a boolean. The `JsonBooleanConverter` in the SDK handles this.

## Async Pattern

Long-running operations (OAuth flows, bank authorization) use **Dapr event publishing**:
1. Controller receives initial request
2. Publishes event via Dapr pub/sub
3. Returns immediately with a request status entry ID
4. Worker (PrivateController) processes the event asynchronously
5. BC polls for status via `GetPaymentStatus` / `RequestStatusEntry`

Infrastructure repos: `Online - Continia.Banking.Messaging`, `Online - Continia.Banking.Messaging.Dapr`

## DI Lifetime Patterns

| Lifetime | Components | Rationale |
|---|---|---|
| **Singleton** | `Converter` (local format converters) | Stateless transformation logic |
| **Scoped** | Repositories, compression services | Per-request state |
| **Transient-via-HttpClient** | `ConversionService` (typed HttpClient) | HttpClientFactory-managed |

## Quick Reference: What to Read First

| Investigation Type | Start Here |
|---|---|
| "Why does bank X return error Y?" | This doc -> `controller-routing-matrix.md` |
| "How does BC decide which endpoint to call?" | `al-to-online-routing.md` |
| "Where is field X mapped in C#?" | `csharp-patterns.md` -> repo-specific search |
| "What file types does bank X support?" | `controller-routing-matrix.md` |
