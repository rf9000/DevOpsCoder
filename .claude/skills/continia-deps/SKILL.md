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

**Symbol gaps:** After `deps install`, check the `symbolsMissing` field in JSON (or the "symbol gaps N" summary on stderr in human mode). If non-empty, run `continia deps download <envId> <appPath>` to populate `.alpackages` for compile.

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
For each package the DemoPortal catalogue is tried first (by appId), then BC's `/dev/packages`
endpoint for Microsoft system symbols. The chosen version prefers what is installed on the
target environment. Add `--clean` to rebuild `.alpackages` from scratch. Override the env's
profile lookup with `--bc-version <ver>` / `--target <Cloud|OnPrem>` when needed. JSON output is
`{ resolved: [...], skipped: [...] }` with the requested vs. resolved identity and source per entry.

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

1. Invoke `continia-env-setup` to get a running env
2. Install deps in dependency order:
   ```bash
   continia deps install <envId> Core/Cloud --json
   continia deps install <envId> DeliveryNetwork/Cloud --json
   continia deps install <envId> DocumentOutput/Cloud --json
   ```
3. Download symbols:
   ```bash
   continia deps download <envId> Core/Cloud --json
   continia deps download <envId> DeliveryNetwork/Cloud --json
   continia deps download <envId> DocumentOutput/Cloud --json
   ```
4. Invoke `continia-deploy` to build and publish

## Fixing Missing Symbol Errors

1. `continia deps download <envId> <appPath> --json`
2. `continia compile <appPath> --json`
