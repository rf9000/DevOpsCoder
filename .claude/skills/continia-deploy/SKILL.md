---
name: continia-deploy
description: Compile and deploy AL code to a BC environment. Handles single-app and multi-app deploys with topological dependency ordering. Use when (1) AL code was changed and needs deploying, (2) the user asks to compile and publish, (3) a test fix needs deploying before re-running tests, or (4) a fresh environment needs all apps deployed. Invoke continia-env-setup first if no envId is available.
---

# Deploy AL Code

Compile and publish AL apps to a running BC environment.

The CLI is located at `.tools/continia.exe`.

## Prerequisites

A running environment ID. If unavailable, invoke `continia-env-setup` first.

## Strategy Selection

**Default — deploy ONLY your target app.**
`compile`/`deploy` refresh the app's dependency symbols from the target environment
automatically before every run (env-truth model: the environment's NST is the source of
truth, not a local build — see CLAUDE.md's "Env-truth symbols"). You do NOT need to run
`continia deps download` first, and you do NOT compile or deploy your dependencies — you
deploy just your app. Run it from the session root:
```bash
continia deploy <envId> <appPath> --allow-downgrade --json
```
- **`--allow-downgrade`** lets your branch build replace the higher-versioned
  CI-built baseline the env already has (BC refuses a downgrade by default).
- Naming `<appPath>` (rather than `--all`) is what scopes the run to one app. Deploy
  compiles and publishes only the app you name; it discovers siblings but never builds them
  unless you pass `--with-deps`.

**Do NOT pass `--workspace-root <appPath>`.** Earlier versions of this skill did, to keep
discovery off sibling source directories. Two things go wrong now:
- The unpublished-dependency safety gate needs to SEE the siblings. Scoping discovery to
  one app hides them, so a dependency the environment does not publish stops being an
  actionable error and becomes a confusing compile failure later.
- Symbol state anchors at the nearest ancestor holding `.continia` (what `continia env use`
  creates). Run `continia env use <envId>` once at your session root and every app in the
  session shares one symbol state and one set of publish events.

Use `--workspace-root` only to point discovery at a session root that is not your current
directory. It no longer affects where symbol state is written.

**Do NOT use `--with-deps` or `--all` for a normal change.** `--with-deps`
recompiles your dependency apps from their source dirs (slow, fails without their
own deps, and unnecessary — the target app's own compile/deploy already refreshes its
symbols from the environment). `--all` discovers every app in the workspace (including
200+ BC base apps). Deploy your specific app only.

**`--with-deps` is ONLY for the rare case** where you genuinely changed a
companion's source and must rebuild it as part of your change — not for resolving
missing symbols. Symbol refresh is automatic; if a dependency genuinely isn't published
on the target env, compile/deploy fail with an actionable message naming it (deploy it
first, run `deploy --with-deps`, or use `compile --local-symbols` for a pre-publish check).

**Override schema sync mode** (default: Synchronize; options: Synchronize, ForceSync, Recreate):
```bash
continia deploy <envId> <appPath> --sync-mode ForceSync --json
```

**Deploy a lower version over a higher installed build** (e.g. a branch build `29.0.0.0` over a CI build `29.0.0.96961`): BC refuses the downgrade by default. Pass `--allow-downgrade` to auto-unpublish the higher entry first:
```bash
continia deploy <envId> <appPath> --allow-downgrade --json
```
Without the flag, deploy fails with an actionable message and a structured `conflict: "higher-version-installed"` field in `--json` (carrying `installedVersion` / `requestedVersion`) so automation can branch on it.

**Override ruleset path** (useful for workspace `.cli-ruleset.json` variants):
```bash
continia deploy <envId> <appPath> --ruleset "Banking Rulesets/.cli-ruleset.json" --json
```
`--ruleset` applies only to the explicit `<appPath>` target by default. Pass `--ruleset-scope all` to apply it to every app in a `--with-deps` or `--all` run.

**Per-app NDJSON progress** (one line per app, useful for CI / long deploys):
```bash
continia deploy <envId> --all --json --stream
```

**Continue on failure** (collect per-app status across the workspace instead of aborting on first failure):
```bash
continia deploy <envId> --all --continue-on-error --json
```
(`--force` is kept as a deprecated alias for back-compat.)

**Breaking-change refactor (member removed from base, dependents installed):**
```bash
continia deploy <envId> <appPath> --with-deps --unpublish-dependents --json
```
Unpublishes any workspace app already installed on the env (in reverse dependency order) before re-publishing in topo order. Avoids BC's "extension compilation failed" rollback that fires when the base recompiles installed dependents against new (now-incompatible) symbols. Only handles workspace consumers — third-party apps depending on the base are NOT touched, so after the new base publishes those third-party apps will be left broken until republished. The DemoPortal API does not block this; if any third-party dependents must be preserved, reinstall them yourself afterwards.

## Rulesets

`continia compile` and `continia deploy` auto-load the ruleset in this order: `<app>/.vscode/settings.json` `al.ruleSetPath`, then `<workspaceRoot>/.vscode/settings.json`, then `<app>/ruleset.json` if present. Explicit `--ruleset <path>` overrides all three and is scoped to the target app only — dep apps keep their own auto-discovery. Pass `--ruleset-scope all` to apply the same ruleset to every app in the run.

```bash
continia deploy <envId> <appPath> --ruleset "Banking Rulesets/.cli-ruleset.json" --json
```

Relative `--ruleset` (and `--package-cache`) paths resolve against `--workspace-root` (default: current directory) and support `${workspaceFolder}`. An explicit `--ruleset` whose file does not exist is a hard error.

**External HTTPS includes are rejected by `alc.exe`.** VS Code happily loads remote rulesets via `includedRuleSets`; CLI `alc.exe` errors with:

```
error AL1033: external rulesets are not allowed.
```

If a workspace uses such a ruleset, ship a sibling `.cli-ruleset.json` whose `includedRuleSets` point at local file paths only, and either point `al.ruleSetPath` at it or pass it via `--ruleset`.

**Pre-existing AA0215 errors block compile.** AL CodeCop AA0215 requires the source filename to match the object name. If a file fails this rule, compile errors out before the ruleset can suppress anything else — fix the filename (`git mv`) once.

## Result Interpretation

JSON output is an array per app (one NDJSON line per app under `--stream`):
```json
[{"app": "Continia Software_Continia Core", "compiled": true, "published": true,
  "workspaceRoot": "U:\\Git\\DO.Support", "degraded": false}]
```
- **`code`** — present on every failed row, and the field to branch on: `unpublished-sibling`,
  `dependency-not-on-env`, `superseded-package-retained`, `symbol-fetch-failed`,
  `app-lock-held`, `app-lock-failed`,
  `symbol-refresh-failed`, `compile-failed`, `compile-produced-no-app`, `publish-failed`,
  `higher-version-installed`. `error` is free prose (alc's full output on a compile failure) —
  never regex it.
- **`workspaceRoot`** — where this run's symbol provenance and publish events were recorded.
  Same on every row. If it isn't your session root, see the Gotchas above.
- **`degraded`** — `true` when this app's packages were not fully verified against the env.
- A run that cannot even reach the per-app loop emits one object instead of an array:
  `{"success": false, "error": {"code": "...", "message": "..."}}`.

On failure, the `error` field contains details:
- **Missing/stale symbols** -- `compile`/`deploy` refresh dependency symbols from the target
  env automatically, and **stop before running the compiler** if any dependency could not be
  established. They never fall through to a possibly-stale cached package; the `code` says
  which case you hit:
  - `unpublished-sibling` — a workspace app the env doesn't publish. Deploy it, run
    `deploy --with-deps`, or use `compile --local-symbols` for a pre-publish check.
  - `dependency-not-on-env` — proven absent from the env's extension list. `continia deps
    install <envId> <appPath>`, or deploy it.
  - `superseded-package-retained` — a stale package couldn't be deleted from `.alpackages`,
    and alc compiles against the highest version in the directory. A **local file lock**, not
    an env problem: close whatever holds the `.app` open (usually VS Code with the AL
    extension) and re-run.
  - `symbol-fetch-failed` — the env couldn't serve the package (unreachable, auth, a bad
    package). Fix the connection (`continia auth status`) and re-run; for a deliberate
    offline compile, `continia compile <appPath> --no-symbol-refresh` uses the cache
    unverified.
  If symbols look stale but nothing errors, the cache may need a forced refresh because
  another tool republished at the same version (`continia deps refresh <appPath>` — see
  `continia-deps`, the one gap the env-truth model can't detect on its own).
- **AL syntax errors** -- fix the code and re-deploy
- **"App is already installed" (same-version re-deploy):** BC silently no-ops a same-version POST. The CLI automatically unpublishes the installed entry first so the new binary actually replaces the old one. Opt out with `--no-replace-same-version`.
- **"a newer version X was already installed" (downgrade):** the env holds a higher version than the build you're deploying. Re-run with `--allow-downgrade` to auto-unpublish and replace it, or unpublish the higher version manually then re-deploy. The `--json` result carries `conflict: "higher-version-installed"` with both versions.
- **"Specified part does not exist in the package":** usually a Windows backslash path in `app.json` (`logo`/`screenshots`) that breaks the Linux `alc`. `compile`/`deploy` now normalize this automatically; if you still hit it, fix the source to use forward slashes (`"Images/Logo.png"`).
- **AppSourceCop `AS0003` (baseline missing) on a LOCAL deploy:** AppSourceCop's
  breaking-change baseline is an **AppSource-submission gate enforced in CI**, not a
  requirement for deploying to your test env. Do NOT hand-edit `AppSourceCop.json`
  to strip its `version`/baseline. Instead deploy with a ruleset that excludes the
  AppSourceCop analyzer locally — ship/point to a sibling `.cli-ruleset.json` (see
  Rulesets) without `${AppSourceCop}` in `al.codeAnalyzers`, or pass
  `--ruleset <that-file>`. CI still runs the full AppSourceCop gate.
- **Schema sync errors** -- retry with `--sync-mode ForceSync` (or `Recreate` as last resort, which drops and recreates tables)
- **Connection refused** -- environment may have stopped; re-run `continia-env-setup`

## Standalone Operations

Compile only (no publish):
```bash
continia compile <appPath> --json
```

`compile` refreshes the app's dependency symbols from the target environment first
(`--env <id>` > `CONTINIA_ENV` > the workspace default from `continia env use`; a hard error
if none of those resolve and the cache can't stand in). If any dependency can't be
established against the env, compile **fails before alc runs** with `error.code` set to
`unpublished-sibling`, `dependency-not-on-env`, `superseded-package-retained`, or
`symbol-fetch-failed` — it never falls
through to a cached package the refresh policy just judged stale. Two escape hatches:
`--no-symbol-refresh` compiles against whatever is already in `.alpackages`, unverified
(offline); `--local-symbols` stages sibling apps' locally built `.app` files instead of the
environment's, for checking a dependency + dependent chain before either is published.
`symbolRefresh.degraded` is `true` on any run whose packages weren't fully verified.

Compile uses the AL VS Code extension's bundled `alc.exe` (matched against analyzer DLLs by construction — no version mismatch). Override with `CONTINIA_ALC_PATH=<path>`. Without an AL extension installed, falls back to altool's `al compile` and warns on stderr — analyzers may fail to load in that mode.

Code analyzers (CodeCop, UICop, AppSourceCop, PerTenantExtensionCop, BCLinterCop) are auto-loaded from `<appPath>/.vscode/settings.json` (`al.codeAnalyzers` array). Standard placeholders (`${CodeCop}`, `${analyzerFolder}BusinessCentral.LinterCop.dll`, etc.) resolve against the same AL extension. Missing DLLs warn on stderr and skip — compile still runs.

Publish a pre-built .app file:
```bash
continia publish <envId> <appFile> --json
continia publish <envId> <appFile> --sync-mode ForceSync --json
```

Unpublish an installed extension — select by GUID **or** by name + publisher:
```bash
continia unpublish <envId> --app-id <appId> [--app-version <v>] --json
continia unpublish <envId> --name "<App Name>" --publisher "<Publisher>" [--app-version <v>] --json
```
Prefer `--app-id` from headless callers (it's the field `env apps --json` returns; mirrors `deps install-by-id`). Provide either `--app-id` or **both** `--name` and `--publisher` — otherwise the command errors. Omit `--app-version` to remove all versions. (Flag is `--app-version`, not `--version` — the latter collides with the global `continia --version`.) BC will refuse if other installed apps depend on this one — unpublish those first, or use `deploy --unpublish-dependents` for the workspace cascade.

**Exit codes with `--json`:** `compile`, `publish`, and `unpublish` exit non-zero (1) on failure even in `--json` mode — the failure JSON is still written to stdout, so check `$?` (or the `success` field) rather than assuming exit 0. (Previously these silently exited 0 in `--json` mode.)

## Gotchas

- **Deploy from the session root** — run `continia env use <envId>` there once, then run
  deploy from that directory. Discovery starts at cwd, so `<appPath>` can be a path
  relative to it (`DocumentOutput/Cloud`) or an absolute path under it. Do **not** pin
  `--workspace-root` to the app directory: that hides the sibling apps the
  unpublished-dependency check needs to see, and it is not what decides where symbol state
  lives (the nearest ancestor holding `.continia` does).
- **Where symbol state lives** — deploy prints both roots on stderr
  (`Discovery root: … ; symbol state root: …`) and every `--json` row carries
  `workspaceRoot`. If the state root is not your session root, you have a stray `.continia`
  below it; the CLI says so the first time it creates one.
- **`--all` deploys too much** — `--all --workspace-root` discovers all apps in the workspace including BC base apps (209+ apps in DO.Support). Deploy specific apps instead of using `--all`.

## Common Pattern: Fix-and-Deploy

1. Fix the AL code
2. `continia deploy <envId> <appPath> --allow-downgrade --json` (from the session root)
3. If compile fails, fix errors and retry
4. Once published, invoke `continia-test` to verify
