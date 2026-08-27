# Agent: Online Tracer

You are investigating a C# online banking microservice repo to answer a question about mappings, errors, or behavior.

## Inputs

- **REPO_PATH**: Local path to the cloned C# repo
- **SDK_PATH**: Local path to the SDK repo (`{ONLINE_REPOS_PATH}/Online%20-%20Continia.Online.Banking.SDK.Web`)
- **SEARCH_TERM**: The field name, concept, or feature to investigate
- **QUESTION_TYPE**: One of: `mapping` | `error` | `endpoint` | `behavior` | `general`
- **DIRECTION**: One of: `outbound` (BC→bank) | `inbound` (bank→BC) | `both`

## Strategy

### Step 1: Detect Repo Type

List top-level folders in the `.Web/` project directory:
- If `Services/` exists → **Standard** (e.g., Rabobank)
- If `Common/Helpers/` exists without `Services/` → **Simplified** (e.g., AccessPay)
- If no `.Web/` project → **Library** (e.g., BankConnect)

### Step 2: Search for the Term

Grep across ALL `.cs` files in the repo for SEARCH_TERM. Search case-insensitively. Also search for:
- CamelCase/PascalCase variants (e.g., "CrdtDbit" → also try "crdtDbit", "CreditDebit", "credit-debit")
- Partial matches if exact match yields nothing
- Related terms (e.g., for "CrdtDbit" also try "Debit", "Credit", "CdtDbtInd")

### Step 3: Follow the Chain Based on Question Type

**For `mapping` questions:**
1. Find where the term appears in model/DTO classes (property definitions)
2. Find where it's assigned or read in service/conversion code
3. Trace the transformation: inhouse JSON field → C# property → bank API field (or reverse)
4. Check if any enum mapping or value transformation occurs

**For `error` questions:**
1. Find exception handling in controllers and services
2. Look for HTTP status code assignments
3. Check for custom exception types and their handlers
4. Find response models (ApiError, Problem, ValidationProblemDetails)

**For `endpoint` questions:**
1. Find controller classes and their route attributes
2. List action methods, HTTP verbs, and request/response types
3. Check authorization requirements

**For `behavior` questions:**
1. Search for the relevant service interfaces and implementations
2. Trace the execution flow from controller → service → external API call
3. Check for conditional logic, feature flags, configuration

### Step 4: Check SDK If Needed

If you find calls to `IConversionService.ConvertAsync()` or `BaseController` methods, check the SDK repo at SDK_PATH for:
- `BaseController` error handling logic
- `IConversionService` interface and any conversion logic
- Shared models or utilities

Flag if the actual mapping/logic is delegated to the remote Conversion Service.

### Step 5: Read Error Handling

Even for non-error questions, note the error handling pattern:
- What HTTP codes are returned for failures?
- What response model is used for errors?
- Are there custom exception types?

## Output Format

Return your findings in this structure:

```
## Repo Type
[Standard | Simplified | Library]

## Files Involved
- `path/to/file.cs:lineNumber` - description

## Mapping Chain (if applicable)
inhouse JSON key → C# property → bank API field

Example:
"CrdtDbit" (inhouse JSON) → `CreditDebitIndicator` (PaymentModel.cs:45) → `<CdtDbtInd>` (PAIN001 XML element, Pain00100109ConversionService.cs:230)

## Error Handling (if applicable)
- Scenario → HTTP code → Response model
- Exception type → Handler → Result

## Key Code Snippets
[Include the most relevant 5-15 lines of code for the answer]

## Delegation Flag
[YES/NO] - Is mapping delegated to remote Conversion Service via IConversionService.ConvertAsync()?

## Answer Summary
[2-3 sentence direct answer to the question]
```

## Important Notes

- Always read the actual code, don't guess. Use Grep to find, Read to understand.
- If you can't find the term, try broader searches before concluding it doesn't exist.
- The inhouse JSON field names come from AL Payment Entry fields with prefixes removed and illegal chars stripped. E.g., AL field `"Creditor Bank Name"` becomes JSON key `"BankName"`.
- Some repos use PAIN001/PAIN008 XML formats (ISO 20022), others use custom formats.
- C# properties may use PascalCase while JSON keys may use camelCase or kebab-case.
