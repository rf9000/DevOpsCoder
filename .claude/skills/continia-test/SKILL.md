---
name: continia-test
description: Run AL tests on a BC environment and interpret results. Starts a test job via DemoPortal, waits for completion, and parses XML results with pass/fail status, error messages, and call stacks. Use when (1) the user asks to run tests, (2) a fix was deployed and needs verification, (3) regression testing is needed after code changes, or (4) a bug report references a test codeunit.
---

# Run AL Tests

Execute AL test codeunits and interpret results.

The CLI is located at `.tools/continia.exe`.

## Prerequisites

- Running environment ID (invoke `continia-env-setup` if needed)
- Code deployed to environment (invoke `continia-deploy` if needed)
- Test codeunit ID (the integer after `codeunit` in the AL source)

## Finding the Codeunit ID

```bash
grep -rn "SubType = Test" --include="*.al" .
```

Test codeunits are declared as `codeunit 148001 "CDO My Feature Test"` -- the number is the ID.

## Running Tests

Single function:
```bash
continia test run <envId> <codeunitId> <functionName>
```

All tests in codeunit:
```bash
continia test run <envId> <codeunitId>
```

Longer timeout (default 120s):
```bash
continia test run <envId> <codeunitId> --timeout 300
```

### Output Modes

- **Default** — human-readable summary with pass/fail per test
- `--json` — structured JSON with `summary`, `tests[]` (no raw XML)
- `--raw` — raw xUnit XML (for manual parsing)

## Interpreting Results

Default output shows a summary line and per-test results:
```
FAIL: 4/5 passed (82.5s) — CDO Setup Tests

  PASS  HideStandardMailActions_WhenEnabled (42.2s)
  FAIL  ActivateCompanyCDO_ShouldActivateProduct (15.3s)
        → record in table 'Access Token' is being updated...
```

With `--json`, the result is structured:
```json
{
  "status": "completed",
  "passed": false,
  "summary": { "total": 5, "passed": 4, "failed": 1, "skipped": 0, "durationSeconds": 82.5, "codeunitName": "CDO Setup Tests" },
  "tests": [
    { "name": "ActivateCompanyCDO_ShouldActivateProduct", "fullName": "CDO Setup Tests:ActivateCompanyCDO_ShouldActivateProduct", "result": "Fail", "durationSeconds": 15.3, "errorMessage": "...", "stackTrace": "..." }
  ]
}
```

On failure, look at the `stackTrace` field — lines like `"CDO Feature"(Codeunit 70001).Calculate line 123` point directly to the failing AL code.

## Important: No Parallel Tests

BC does not support running multiple test jobs concurrently on the same environment. Always run tests sequentially — wait for one `test run` to complete before starting another. Running tests in parallel will cause failures or incorrect results.

## Common Pattern: Fix-Test-Verify

1. Extract failing function name and line numbers from results
2. Navigate to the code and fix the issue
3. Deploy the fix: `continia deploy <envId> <appPath> --json`
4. Re-run the specific failing test: `continia test run <envId> <codeunitId> <func>`
5. If it passes, run the full codeunit for regressions: `continia test run <envId> <codeunitId>`

## Gotchas

- **Exit code 1 on success** — The CLI returns exit code 1 when tests fail, which breaks `&&` chaining. Use `;` to run tests sequentially regardless of exit code: `continia test run <envId> 148001 ; continia test run <envId> 148002`
- **Keep background commands simple** — Complex bash pipelines (variable assignments + pipes to python/grep) sometimes produce empty output files in Claude Code background mode. Run `continia test run` as a simple standalone command, don't pipe or assign in the same line.
- **Install deps on env first** — The environment needs runtime dependencies (e.g. Continia Core Internal Activation App) even if the app compiled locally fine. Invoke `continia-deps` before running tests on a fresh environment.
- **`Assert.AreEqual(0, someBigInt)` fails.** AL treats `Integer` and `BigInteger` as distinct types; the runtime message reads `Expected:<0> (Integer). Actual:<0> (BigInteger).` Fix: declare a typed local and assert against it:

  ```al
  var
      ZeroBigInt: BigInteger;
  begin
      ZeroBigInt := 0;  // explicit assignment required — AA0205 flags unassigned BigInteger locals
      Assert.AreEqual(ZeroBigInt, SomeRecord."Big Int Field", 'message');
  end;
  ```

## Code Coverage

```bash
continia test coverage <envId> <jobId>          # raw CSV on stdout
continia test coverage <envId> <jobId> --json   # JSON envelope { envId, jobId, csv }
```

Returns CSV data showing which AL lines were executed. With `--json` the CSV is wrapped in a self-describing JSON envelope (`{ "envId", "jobId", "csv" }`) for headless callers; without it, the raw CSV is printed.
