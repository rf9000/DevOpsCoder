---
name: continia-env-setup
description: Find or start a running BC developer environment and configure launch.json. Use when (1) you need a running environment for deploy, test, or dependency operations, (2) a session was just started and no environment is configured, (3) a command fails because the environment is stopped, or (4) the user asks to set up or connect to an environment.
---

# Environment Setup

Ensure a running BC environment is available and configured for development.

The CLI is located at `.tools/continia.exe`.

## Process

1. List running environments: `continia env list --status running --json`
2. **If running env found** -- pick the one with most recent `lastActivityUtc`, skip to step 5
3. **If none running** -- list stopped: `continia env list --status stopped --json`, then start one: `continia env start <envId>`
4. Poll every 10s until status is `Running`: `continia env get <envId> --json` (typically 1-3 min; if >5 min, check `continia env logs <envId>`)
5. Install the Continia Core Internal Activation App (required before agents can interact with the env): `continia deps install-by-id <envId> c3755ece-dab0-4d16-987d-040661f18522 --json`. Idempotent — safe to run every time; skips if already installed. Fetches the prebuilt `.app` from the marketplace, no local source or AL compile. The CLI auto-selects the build matching the env's BC version, so no version flag is needed. If install ever reports `app_add_not_possible`, force the right build with `--bc-version <env BC version>` (or `--app-version <exact version>`).
6. Configure launch.json for all workspace apps: `continia launch add <envId> .`
7. Report the environment ID, description, and URL

## Command Reference

```
continia env list [--status running|stopped] [--json]
continia env get <id> [--json]
continia env start <id>
continia env stop <id>
continia env delete <id>
continia env create --name <name> --profile <profileId> [--json]
continia env logs <id>
continia env users <id> [--json]   # WARNING: --json includes plaintext passwords
continia env sessions <id> [--json]
continia env apps <id> [--all] [--name <substr>] [--publisher <substr>] [--json]   # --all adds pre-installed MS platform/AppSource apps via BC's Automation API
continia env profiles versions [--json]
continia env profiles list --bc-version <version> [--json]
continia launch add <id> <workspacePath>
continia deps install-by-id <id> <appId> [--app-version <ver>] [--bc-version <ver>] [--target <Cloud|OnPrem>] [--json]
```

Continia Core Internal Activation App GUID: `c3755ece-dab0-4d16-987d-040661f18522`

## Creating a New Environment

If no environments exist, create one:

1. List available BC versions: `continia env profiles versions --json`
2. Pick a version, list profiles: `continia env profiles list --bc-version <version> --json`
3. Create: `continia env create --name "My Env" --profile <profileId> --json`
4. The environment starts in "Draft" status. Start it: `continia env start <envId>`
5. Poll until Running (see step 4 in Process above)

## Error Handling

- **No environments exist** -- create one (see "Creating a New Environment" above)
- **Stuck in "Creating"** -- check `continia env logs <envId>`
- **API token error** -- token is auto-read from VS Code setting `environment-explorer.api-token`; verify it's set
