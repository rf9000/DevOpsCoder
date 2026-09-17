---
name: devopscoder-al-deploy
description: Pipeline-specific rules for deploying and verifying AL code from inside a DevOpsCoder per-work-item worktree. Read this BEFORE continia-deploy, continia-deps, continia-env-setup or continia-test whenever you are running inside the automated pipeline — it constrains what those skills tell you to do. Covers which environment to use (never pick one), why some deploy failures are yours to fix and others are not, and the localization dependency that must be installed first.
---

# Deploying AL from a DevOpsCoder worktree

You are running inside an automated per-work-item pipeline, not an interactive
developer session. The `continia-*` skills are written for a human at a
workstation and are shipped by the Continia CLI; this file is owned by the
pipeline and **overrides them wherever they disagree**.

> Maintainers: this file exists because the `continia-*` skills are vendored
> upstream content that a CLI upgrade overwrites in place. Anything
> pipeline-specific belongs here, never in those files. See `CLAUDE.md`
> ("Plan 13") for the orchestrator-side view of the same rules.

## Never choose an environment

`continia-env-setup` tells a developer to list environments and pick the most
recently active one. **Do not do that.** The pipeline provisions exactly one
environment per work item, derives its Business Central version from the
worktree's `app.json` files, and records its id in the work item's state. It is
passed to you explicitly on every CLI call.

Picking a different environment means deploying onto one a colleague or another
agent is using. There is no situation in a pipeline run where you should run
`continia env list`, `continia env use`, or set `CONTINIA_ENV`.

If a command fails because the environment is wrong or unreachable, that is a
stage-level problem — report it, do not route around it.

## The localization app is already handled

Since v29 only the country apps (`banking-w1`, `banking-dk`, …) declare
`Continia Finance`; `base-application` does not. The pipeline therefore runs
`continia deps install <envId> banking-<cc>` **before** anything else, because
that is the only step that brings Finance onto the environment.

You do not need to repeat it, and you must not add a country app to a deploy.
`external/Continia Finance/00_Base_App` declares the app.json name
`Continia Finance`, so pulling a country app into a build makes the tooling
compile vendored third-party source (pinned to an older `application` version)
against the environment.

## Deploy invocation

```bash
continia deploy <envId> <absolute app dir> --allow-downgrade --json
```

Run from the worktree root. Three deliberate omissions, each of which has cost
a debugging session before:

- **No `--workspace-root`.** The CLI resolves the positional app path *against*
  workspace-root rather than cwd, so passing the same relative path in both
  slots joins it onto itself (`permission-sets/permission-sets` → "No app.json
  found"). It also hides the siblings the unpublished-dependency gate needs.
- **No `--with-deps`.** It recompiles dependency apps that are already on the
  environment.
- **The app dir is absolute**, so the call does not depend on cwd.

## Which deploy failures are yours

Branch on the `code` field of a failed row, never on the prose in `error`.

**Fix these in the AL source** — they mean your code does not build:
`compile-failed`, `compile-produced-no-app`, `publish-failed`, and any failed
row carrying no `code` at all.

**Do not attempt to fix these.** They are environment or deploy-set problems and
no source edit resolves them; report and stop rather than burning attempts:
`unpublished-sibling`, `dependency-not-on-env`, `symbol-fetch-failed`,
`symbol-refresh-failed`, `superseded-package-retained`, `app-lock-held`,
`app-lock-failed`, `higher-version-installed`, and any code not in the fixable
list above.

`symbol-fetch-failed` in particular usually means the environment's BC version
does not match what the code requires. That is provisioning, not your code.

When the CLI reports a `diagnostics` array, read that rather than the raw `error`
dump — it carries `file`, `line`, `column`, `code` and `message` per diagnostic.

## Tests

The pipeline selects which test codeunits to run and deploys the apps that own
them. Run what you are given; do not widen the selection to "the whole suite" —
codeunits execute sequentially against one environment and a full run is hours.

`continia test run` exits 1 when tests fail, which breaks `&&` chaining. Use `;`
between sequential runs.
