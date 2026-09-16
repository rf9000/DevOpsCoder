# Plan 13 — Install the localization app so Continia Finance reaches the environment

## Context

`build-and-test` derives its deploy set from the files a work item changed plus
the tests it selected, then expands that seed over **internal** dependencies
(`resolveDeployOrder`, `src/utils/al-app-graph.ts`). Since v29 the Continia
Banking dependency graph runs country-app → base-app:

```
banking-w1        -> Import, Export, Banking, CSV Import, PSP, Permission Sets, Continia Finance
base-application  -> System Application, Core, Approval, Connector App, Permission Sets
```

`Continia Finance` is declared **only** by the country apps. `base-application`
does not declare it. Because expansion follows dependency edges, and every edge
from the deploy set points *toward* `base-application`, the walk can never reach
a `banking-<cc>` app. So unless a work item touches a country app directly — none
has — `continia deps install <envId> banking-<cc>` never runs, and **Continia
Finance is never installed on the per-WI environment**.

The team's documented order is:

1. `continia deps install <envId> banking-<cc>` — the localization app first.
   This step is the only thing that brings Finance onto the environment.
2. `continia deps install <envId> base-application` — then the base app's externals.
3. Publish the workspace apps in topological order.

Skipping step 1, or running it after step 2, leaves Finance uninstalled and the
country app's publish fails on the missing dependency. Our pipeline does 2 and 3.

Evidence from WI 82205: the derived deploy set was `permission-sets → approval →
base-application → base-application-test → import → import-test` — no country app
— and every deps-install in that run reported skipped dependencies and symbol gaps.

This is a **second, independent defect** from the one Plan 12 fixed. Plan 12
corrected the BC *platform* version (the environment was BC 28.1 for 29.0.0.0
code). This one concerns which *Continia* apps reach the environment. Fixing Plan
12 may simply advance the failure from the Microsoft symbol wall to a
missing-Finance one.

## Decisions locked

1. **Deps-install only; never publish the country app.** Confirmed with the repo
   owner: the test codeunits do not need a localization app installed to run. The
   purpose of the step is solely to pull Finance and the other externals onto the
   environment.
2. **The country app must never enter `appPaths`.** This is the load-bearing
   constraint, not a stylistic one. `external/Continia Finance/00_Base_App/app.json`
   declares `name: "Continia Finance"` — the exact string `banking-w1` lists as a
   dependency — so the moment a country app joins the deploy set,
   `resolveDeployOrder` resolves that edge to an in-repo app and the pipeline
   compiles vendored third-party source (which declares `application: 28.0.0.0`)
   against a BC 29 environment.
3. **Fall back to `banking-w1` when the exact localization app is absent.** Every
   country app declares `Continia Finance`, so any of them satisfies the step's
   purpose. This path is real: BC 29 publishes profiles for `au`, `ca` and `nz`,
   and the repo has no `banking-au`/`-ca`/`-nz`. Conversely the repo has
   `banking-is` with no matching profile. Warn on fallback.
4. **No new configuration.** `CONTINIA_ENV_LOCALIZATION` (added by Plan 12 to
   select the profile) already carries the answer. `base` maps to `banking-w1`;
   every other localization maps to `banking-<loc>`.
5. **Exclude `external/**` from internal-dependency expansion.** A latent bug this
   work exposes rather than creates: today, a work item that touches `banking-dk`
   directly would already drag vendored Finance into the build. Folded in because
   it is the same bug class in the same function.
6. **A missing country app never fails the stage.** If not even `banking-w1`
   exists, log and skip. A repo with no country app is not Continia Banking, and
   failing the verification gate over it would be a worse outcome than proceeding.

## Architecture overview

```
build-and-test.execute
  ...
  waitForRunning / installAppById (activation)          [unchanged]
  discoverAlApps + changed files + test selection       [unchanged]
  resolveAppPaths -> appPaths                           [unchanged]
                                                         |
  localizationAppDir(apps, config.continiaEnvLocalization)
        base -> banking-w1 | <loc> -> banking-<loc>
        absent -> banking-w1 (warn) | absent -> undefined (warn, skip)
                                                         |
  installDependencies(envId, <country app>)   <--- NEW, and FIRST
                                                         |
  for (appPath of appPaths) installDependencies(...)    [unchanged]
  for (appPath of appPaths) downloadSymbols(...)        [unchanged, country app excluded]
  for (appPath of appPaths) deployApp(...)              [unchanged, country app excluded]
```

The country app is a local variable, never a member of `appPaths`. It gets
exactly one CLI call — `installDependencies` — and takes part in neither symbol
download nor deploy.

## File / function changes

### `src/utils/al-app-graph.ts`

- New `localizationAppDir(apps: AlApp[], localization: string): { dir: string; fellBack: boolean } | undefined`.
  Normalizes `base` to `w1`, builds the candidate directory `banking-<cc>`, and
  matches case-insensitively against `apps`. On no match, retries `banking-w1`
  and reports `fellBack: true`. Returns `undefined` when neither exists.
  Returning the fallback flag rather than logging inside keeps the function pure
  and lets the stage own its log line.
- `resolveDeployOrder` gains an `external/` guard: **during dependency expansion
  only**, an edge that resolves to an app whose `dir` starts with `external/` is
  not followed and not added to the order. Externals come from `continia deps
  install`, which is exactly what that directory holds.

  A directly seeded `external/` app is deliberately **not** excluded: if a work
  item actually edits vendored source, that app is its own seed via `ownerAppOf`
  and must still build. The guard stops the graph from reaching into `external/`
  on its own, not the operator from aiming at it. An implementation that filters
  `external/` out of the final order, rather than out of the traversal, gets this
  backwards and will silently drop a legitimately changed app.

### `src/pipeline/stages/build-and-test.ts`

Between the `appPaths` log line and the existing deps-install loop:

```ts
const localizationApp = localizationAppDir(appGraph, config.continiaEnvLocalization);
if (!localizationApp) {
  deps.logger.warn(
    `build-and-test: no localization app found for CONTINIA_ENV_LOCALIZATION=` +
      `${config.continiaEnvLocalization} and no banking-w1 fallback — skipping the ` +
      `localization deps install. Continia Finance will NOT be on the environment, ` +
      `and dependent apps may fail to publish.`,
  );
} else {
  deps.logger.info(
    `build-and-test: installing localization dependencies from ${localizationApp.dir}` +
      (localizationApp.fellBack
        ? ` (no app for '${config.continiaEnvLocalization}'; fell back to banking-w1 — ` +
          `every country app declares Continia Finance, which is what this step is for)`
        : '') +
      ' — this is the only step that brings Continia Finance onto the environment',
  );
  const info = await deps.continiaCli.installDependencies(env.envId, localizationApp.dir, callOpts);
  // Same surfacing as the per-app loop below.
}
```

The skipped/symbol-gap warning is identical in shape to the existing loop's, so
extract the two into a small local helper rather than duplicating the template.

### `README.md`, `CLAUDE.md`

A paragraph on the localization deps step: what it does, why it must run first,
and that the country app is deliberately never published.

## Testing

### `tests/utils/al-app-graph.test.ts`

- `localizationAppDir`: `base` → `banking-w1`; `dk` → `banking-dk`; `DK` → `banking-dk`
  (case-insensitive); `au` with no `banking-au` → `banking-w1` with `fellBack: true`;
  no country apps at all → `undefined`.
- `resolveDeployOrder`: a seed whose dependency resolves to an app under
  `external/` does not pull that app into the order, while the same dependency
  name resolving to a non-`external/` app still does.

### `tests/pipeline/stages/build-and-test.test.ts`

- The localization app is deps-installed, and **call-order** asserts it happens
  before any `appPaths` entry. Order is the whole point; a test that only checks
  presence would pass against the broken arrangement.
- The localization app appears in **neither** `downloadSymbols` nor `deployApp`
  calls, and not in the persisted deploy set — the guard against decision 2.
- A repo with no country app logs the warning and still completes the stage.
- The fallback case logs that it fell back.
- Existing build-and-test tests keep passing; fixtures whose app graphs contain no
  `banking-*` app now take the "skip with warning" path, which must not change
  their assertions.

## Out of scope (explicit non-goals)

- Publishing the country app, or making the environment a genuinely configured
  localized install. Tests do not need it.
- Per-work-item localization selection. `CONTINIA_ENV_LOCALIZATION` is one config
  value, as decided in Plan 12.
- Validating `CONTINIA_ENV_LOCALIZATION` against the repo's country apps at config
  load time. The stage's fallback plus warning is sufficient, and config load has
  no worktree to inspect.
- Reconciling the profile/app mismatch itself (profiles for `au`/`ca`/`nz` with no
  app; `banking-is` with no profile). That is a Continia catalogue matter, not a
  pipeline one.
- Installing Microsoft's country-specific externals (e.g. `Payment and
  Reconciliation Formats (DK)`, which only `banking-dk` declares). They arrive
  with the matching country app when it exists; the `w1` fallback does not bring
  them, which is acceptable because we do not build country-specific code.
