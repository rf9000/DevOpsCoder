---
name: continia-deps
description: Install external dependencies on a BC environment and download symbol packages for AL compilation. Use when (1) compilation fails with missing symbol or reference errors, (2) a fresh environment needs base apps installed before deploying, (3) the user asks to install or update dependencies, or (4) .alpackages is empty or outdated.
---

# Manage Dependencies

The CLI is located at `.tools/continia.exe`.

Two distinct operations:

## Install on Environment

Install an app's **direct** external dependencies on the BC environment (runtime dependencies):
```bash
continia deps install <envId> <appPath> --json
```

Reads `app.json`, looks up each direct dependency by appId (falling back to publisher/name),
and installs it — skipping any already installed at a satisfying version. Use `--dry-run` to
preview. Override the env's profile lookup with `--bc-version <ver>` / `--target <Cloud|OnPrem>`
(same flags as `deps install-by-id`). Transitive runtime install is intentionally not performed
(it would risk installing Microsoft test/mock libraries onto the environment); the symbol
closure is `deps download`'s job.

**Exit code:** a genuine install failure (BC rejects the install) lands in the `failed` JSON array and makes the command exit non-zero (1). A catalogue *miss* stays in `skipped` (usually a pre-installed Microsoft platform app) and keeps exit 0 — so `$?` distinguishes "couldn't install" from "nothing to install".

**JSON contract:** exactly one object on stdout on every path, carrying `success` on both. A run that cannot start (e.g. `<appPath>` has no `app.json`) emits `{ success: false, error: { code, message }, ... }` with every collection present but empty, so a consumer never has to check whether a key exists before reading it.

**Symbol gaps:** After `deps install`, check two fields in JSON (or the summary line on stderr in human mode):
- `symbolsMissing` — no `.app` at all in `.alpackages` for a satisfied dependency. Run `continia deps download <envId> <appPath>` to populate it.
- `symbolsStale` — a `.app` is present but the symbol engine's refresh policy would replace it anyway (env switch, version drift, a publish event newer than the cached download, platform drift). Run `continia deps refresh <appPath>` to replace it.

Both are computed dry-run, no downloads.

## Download Symbols

Download the **transitive** `.app` symbol closure to `.alpackages` (compile-time dependencies):
```bash
continia deps download <envId> <appPath> --json
```

Starting from `app.json` — both the `dependencies` array and the `application` / `platform`
base-symbol references — the CLI reads each package's embedded `NavxManifest.xml` and
recursively resolves the symbol closure the AL compiler needs (this is what prevents AL1022,
both for transitive dependency refs such as `Application Test Library` / `Permissions Mock`
and for the Microsoft base/system symbols pulled in via `application` / `platform`).

The target environment's NST is treated as truth: a dependency **installed on the
env** is fetched from BC's `/dev/packages` endpoint (authoritative — the env can be running a
custom same-version build the catalogue doesn't have). The DemoPortal catalogue is used only
for a dependency **not installed on the env** — this command, unlike `compile`, is allowed to
reach it, since staging happens before `deps install` has necessarily run. A package already
cached with valid provenance (matches the env, no newer publish event, no version drift) costs
zero network traffic.

Add `--clean` to rebuild `.alpackages` from scratch (also drops recorded provenance for this
app). Override the env's profile lookup with `--bc-version <ver>` / `--target <Cloud|OnPrem>`
when needed.

JSON output: `{ success, envId, packageDir, resolved: [...], skipped: [...], counts: { refreshed, cached, cachedRefreshFailed, staged, missing, errors }, degraded, stateSaved }`.
- Each `resolved` entry: `{ resolved: { id, name, publisher, version }, source, reasonCode, reason }` — `source` is `dev-endpoint`, `catalogue`, or `existing-cache` (already there, untouched this run).
- Each `skipped` entry: `{ dep: { id, name, publisher, version }, reasonCode, reason, workspaceApp, guidance? }` — `workspaceApp: true` means the dependency is a sibling app in this workspace that the target env doesn't publish; `guidance` then names the fix (deploy it, or `compile --local-symbols`).
- **`resolved.length` is deliberately NOT `counts.refreshed + counts.cached + counts.staged`.** `resolved` lists every package that ended up usable in the package directory, which includes the ones served from cache after a failed refresh (`reasonCode: "cached-refresh-failed"`) — they are on disk and alc will read them. `counts.cached` excludes those, reporting them under `counts.cachedRefreshFailed` instead, so "verified cache hit" and "unverified fallback" never collapse into one number. To reconcile: `resolved.length === counts.refreshed + counts.cached + counts.cachedRefreshFailed + counts.staged`.
- `degraded: true` means this run did **not** end with every dependency in the closure verified against the environment: a package kept from cache after a failed refresh, a dependency that couldn't be fetched, or one the environment doesn't hold. Same definition `compile` and `deploy` use, so one predicate works across all three. A `deps download` that reports `skipped` entries is degraded — the cache it left behind is not compile-ready.

## Force a Refresh

`deps download` (and `compile`/`deploy`) only refresh what's provably stale: no provenance,
a hash mismatch, a different source env, version drift, or a publish event recorded in
`.continia/symbol-state.json` after the download. A **same-version republish done by another
tool** (the VS Code Env Explorer) or **from another workspace** leaves no trace this CLI can
see — the NST exposes no content hash, and no publish event lands here. That's the one gap
the env-truth model doesn't close on its own. If you suspect it happened, force it:
```bash
continia deps refresh <appPath> --json          # non-Microsoft dependencies only
continia deps refresh <appPath> --all --json    # also Microsoft platform/base symbols (large, rarely needed)
```
Resolves the environment the same way `compile`/`deploy` do: `--env <id>` > `CONTINIA_ENV` >
the workspace default set by `continia env use`.

## Version Resolution (BC major vs Continia major)

**Continia app major and BC platform major are independent.** A Continia app commonly targets the *previous* BC platform major — so an environment on BC major `N` legitimately needs Continia dependencies at major `N+1`. (Concrete example at time of writing: a BC 28 env needs Continia 29 deps; after the next release the same pattern reads BC 29 / Continia 30.) The DemoPortal catalogue for a BC `N` env (`apps.json?bc_version=N...`) **does** carry the `N+1` Continia builds — they are reachable, just stored under a BC-version-keyed blob path.

`deps install` and `deps download` resolve each dependency to the **major required by `app.json`**, not the env's BC major. An AL dependency is satisfied only by the same major — a lower-major build can never satisfy a higher-major dependency (it would fail compile with AL1022).

If a lower-major build lands for a dependency that requires a higher major, that is a resolution problem to investigate — **not** evidence that the higher-major build is unpublished or that you must fall back to a lower-major source branch. Confirm with `continia env catalog <envId> --json` (or `deps tree`) that the required build exists before changing branches.

To install a specific build by GUID, use `--app-version` (an **exact** selector, e.g. `--app-version 29.0.0.0`): `continia deps install-by-id <envId> <appId> --app-version <ver> --json`. With the flag, a different installed build (higher or lower) is reinstalled to the requested version rather than skipped; without it, any installed build counts as present.

## Dependency Tree

Visualize the dependency graph without installing or downloading:
```bash
continia deps tree --workspace-root .
continia deps tree <appPath> --workspace-root .
```

## Fresh Environment Setup

1. Invoke `continia-env-setup` to get a running env (this also sets it as the workspace
   default via `continia env use`, so you don't need to repeat `--env` below)
2. Install deps in dependency order:
   ```bash
   continia deps install <envId> Core/Cloud --json
   continia deps install <envId> DeliveryNetwork/Cloud --json
   continia deps install <envId> DocumentOutput/Cloud --json
   ```
3. Invoke `continia-deploy` to build and publish — `compile`/`deploy` pull dependency symbols
   from the environment automatically as they run; a separate `deps download` pass before
   compiling is no longer part of the normal workflow (see `continia-deploy` for the
   env-truth model). Run `deps download` yourself only to pre-stage `.alpackages` without
   compiling (e.g. inspecting the closure, or preparing an offline compile).

## Fixing Missing Symbol Errors

`compile`/`deploy` refresh symbols from the target environment automatically, so most
AL1022/AL0132-style errors from a stale cache no longer happen. If you still hit one:
- **Dependency not installed on the env** — compile/deploy fail with a message naming it:
  `continia deps install <envId> <appPath> --json`, then deploy the dependency, or
  `continia deploy <envId> <appPath> --with-deps --json`.
- **Suspected stale cache from another tool or workspace** (the one gap env-truth can't
  detect on its own — see "Force a Refresh" above): `continia deps refresh <appPath> --json`.
- **Pre-publish chain check**, dependency not deployed yet: `continia compile <appPath> --local-symbols --json`.
- **Deliberate offline compile**: `continia compile <appPath> --no-symbol-refresh --json` (uses whatever is already cached, unverified).
