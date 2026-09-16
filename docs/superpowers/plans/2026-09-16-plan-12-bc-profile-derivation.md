# Plan 12 — Derive the BC environment profile from the worktree

## Context

`env-provision` creates each per-WI Business Central environment from
`CONTINIA_ENV_PROFILE_ID`, a single profile GUID pinned in deployment config. The
pipeline has no version logic at all: it does not know, and cannot discover, which
BC version the branch it is about to compile actually requires.

WI 82205 ran the full pipeline against an environment created from that pin, reached
`build-and-test`, and died with `symbol-fetch-failed` after **$33.16** of spend. The
causal chain, confirmed against the live CLI:

- the pinned profile `cc557829-71df-40ee-9516-98ca954d4b2f` is "BASE Business Central
  28.1", `buildVersion` `28.1.49838.50268`
- that string is character-for-character the `Microsoft_Application 28.1.49838.50268`
  in the failure log
- the worktree's apps declare `29.0.0.0`, and a `base` profile for `29.0.0.0` exists
  (`ff24b00b-ea9b-4311-8191-81b8370f0a0a`)

The same commands succeed on developer machines. That is not a VM or Docker
difference — it is *when the version gets chosen*. The `continia-env-setup` skill's
own creation procedure is:

```
1. continia env profiles versions --json
2. Pick a version, list profiles: continia env profiles list --bc-version <version>
3. continia env create --name "..." --profile <profileId>
```

Developers re-run all three every time they spin up a red/green environment, so step
2's judgment is re-made against the code in front of them. `env-provision` runs step
3 only, against a decision frozen into an env var when Banking was on 28.1. Because
the VM is the only actor that mints environments, the VM is the only place that could
ever notice the pin had gone stale.

This plan restores steps 1-2 in code, with `app.json` supplying the input a developer
currently supplies from knowledge.

## Decisions locked

1. **Derive by default; the pin becomes an override.** `CONTINIA_ENV_PROFILE_ID`, when
   set, still selects the profile — but the resulting environment is validated like
   any other, so an off-version pin is deliberate and visible rather than silent.
2. **Match rule: lowest published `bcVersion` that satisfies the requirement.**
   `app.json`'s `application`/`platform` are minimums; profiles are discrete published
   versions. Today `29.0.0.0` is simultaneously the exact match, the lowest satisfying
   version, and the newest published one, so all candidate rules agree. They diverge
   later, and this rule tracks `app.json` rather than DemoPortal's release calendar:
   BC 30 publishing does not silently retarget every work item, and retiring `29.0.0.0`
   moves to `29.1.0.0` instead of hard-failing.
3. **Required version = max over ALL apps in the worktree**, across both `application`
   and `platform`. Not the deploy set: that is derived in `build-and-test` from changed
   files, and at provision time the coder has not run, so nothing has changed yet. The
   eventual deploy set is always a subset, so the max over everything satisfies it.
4. **Localization comes from config, not the manifests.** A BC version identifies 18
   profiles, one per localization; `app.json` cannot disambiguate. New
   `CONTINIA_ENV_LOCALIZATION`, default `base` — what the current pin resolves to.
5. **A stale persisted environment is recreated, not reused.** The reuse path is the
   one that bites: WI 82205 has a 28.1 environment in its state file and would
   otherwise reuse it forever.
6. **Every failure is thrown at `env-provision`**, before the revision loop spends
   anything. That is the entire value of the change: the same mismatch costs the
   analyzer alone (~$0.74) instead of $33.16, and reports the real cause.

## Architecture overview

`env-provision` gains a selection step ahead of environment creation:

```
required = max(application, platform) over every app.json in the worktree
              |
              v
  continia env profiles versions --json      -> ["16.0.0.0", ..., "29.0.0.0"]
              |
              v
  lowest version >= required                 -> "29.0.0.0"
              |
              v
  continia env profiles list --bc-version 29.0.0.0 --json
              |
              v
  isEnabled && localization === config        -> ff24b00b-...  (BASE BC 29.0)
              |
              v
  continia env create --profile ff24b00b-...
```

Both profile queries are account-level, so they work before any environment exists.
Two extra CLI calls per work item, well inside the 300 s
`STAGE_TIMEOUT_MS_ENV_PROVISION`.

The pin short-circuits selection but not validation. After creation, and on the
persisted-environment reuse path, the environment's own `bcVersion` is compared
against `required`.

## File / function changes

### `src/utils/bc-version.ts` (new)

Four-part version parse and compare. String comparison is wrong here —
`"9.0.0.0" > "29.0.0.0"` lexically — so this is numeric per segment.

- `parseBcVersion(raw: string): number[] | undefined` — tolerant of 1-4 segments,
  `undefined` on anything unparseable.
- `compareBcVersions(a: string, b: string): number` — segment-wise, missing segments
  treated as 0.
- `maxBcVersion(versions: string[]): string | undefined`
- `selectBcVersion(required: string, available: string[]): string | undefined` — the
  lowest entry `>= required`; `undefined` when none satisfies.

### `src/utils/al-app-graph.ts`

`AlApp` gains `application?: string` and `platform?: string`. `discoverAlApps` already
opens and `JSON.parse`s every `app.json` (lines 36-48) and keeps only `name` and
`dependencies` — widen the destructured type and carry the two fields through. Both
stay optional: a manifest without them is still a usable app for the existing deploy-set
derivation, and must not start throwing.

### `src/services/continia-cli.ts`

- `EnvProfile` (new exported interface): `{ id, bcVersion, localization, description?,
  buildVersion?, isEnabled? }`.
- `EnvironmentInfo` gains `bcVersion?: string`. `env get` already returns it;
  `environmentInfoSchema` (line 127) drops it today. Add to the schema and to
  `toEnvironmentInfo` (line 337).
- `ContiniaCli` gains two methods, both built on the existing `runJson` helper (line
  345) and both using lenient Zod like every other schema in the file:
  - `listProfileVersions(opts: ContiniaCallOpts): Promise<string[]>` —
    `env profiles versions --json`, which returns a bare JSON array of version strings.
  - `listProfiles(bcVersion: string, opts: ContiniaCallOpts): Promise<EnvProfile[]>` —
    `env profiles list --bc-version <v> --json`.

### `src/pipeline/stages/env-provision.ts`

- New dep: `discoverAlApps` (injectable, defaulting to the real one) so the stage can
  read the worktree's manifests.
- New helper `resolveRequiredBcVersion(apps: AlApp[]): string | undefined` — max across
  `application` and `platform` of every app.
- New helper `selectProfile(...)` performing steps 1-3 of the diagram, returning the
  profile id or throwing one of the errors below.
- Creation path: derive unless `config.continiaEnvProfileId` is set; create; then
  validate the created environment's `bcVersion`.
- Reuse path (lines 39-58): after the existing `getEnvironment` call, compare
  `live.bcVersion` against `required`. On mismatch, log and fall through to fresh
  creation — the same branch the existing "no longer resolves" case (line 52) already
  takes. This is what auto-heals WI 82205 and any other work item already carrying a
  stale environment.
- Persist the resolved `bcVersion` onto `state.outputs.environment` so the choice is
  visible in state and logs.

**When the requirement is underivable.** If no manifest declares either field,
`required` is `undefined`, and the two paths diverge rather than both failing:

- **pin set** — proceed, and skip validation. There is nothing to validate against,
  and a pin with no derivable requirement is precisely the deliberate-override case
  this escape hatch exists for. Log that validation was skipped, so a silently
  unvalidated environment is never invisible.
- **pin unset** — throw. Selection has no input and there is no fallback to fall back
  to.

The same rule governs the reuse path: an underivable requirement means a persisted
environment is reused as-is, never recreated on the strength of a comparison that
could not be made.

Errors, all thrown from this stage:

| condition | message names |
|---|---|
| no manifest declares a version, pin unset | the worktree path, and that `CONTINIA_ENV_PROFILE_ID` can pin one |
| no published version satisfies | required version + the available list |
| version found, localization absent | the version, the requested localization, and the localizations that do exist |
| pinned profile's env does not satisfy | both versions, and that the pin must be updated or unset |

The third is a real case, not a theoretical one: 28.1 publishes a `cz` profile and 29.0
does not, so "same localization, next version" can legitimately not exist.

### `src/types/index.ts`

`AppConfig` gains `continiaEnvLocalization: string`. `EnvironmentOutput` gains
`bcVersion?: string`.

### `src/config/index.ts`

- `CONTINIA_ENV_LOCALIZATION: z.string().default('base')` in the schema; mapped to
  `continiaEnvLocalization` in the returned object (near line 202).
- Remove `CONTINIA_ENV_PROFILE_ID` from the required-unless-`SKIP_BUILD_TEST` list
  (lines 94-99). It is an override now. `CONTINIA_API_TOKEN` stays required.

### `README.md`, `CLAUDE.md`, `.env.example`

Env-var table: `CONTINIA_ENV_PROFILE_ID` moves from **yes\*** to optional and is
redescribed as an override; `CONTINIA_ENV_LOCALIZATION` added. A short paragraph in
both docs on the derivation and the fail-fast gate.

## Testing

### `tests/utils/bc-version.test.ts` (new)

Numeric ordering where lexical ordering differs (`9.0.0.0` vs `29.0.0.0`); short forms
(`"29.0"`); unparseable input; `selectBcVersion` returning the exact match when present,
the next-highest when not, and `undefined` when nothing satisfies.

### `tests/utils/al-app-graph.test.ts`

`application`/`platform` surfaced when present; apps without them still discovered with
the fields `undefined`; existing deploy-set derivation tests unaffected.

### `tests/pipeline/stages/env-provision.test.ts`

Mocked `ContiniaCli`:

- derives the version from manifests and creates from the matching profile
- an exact-match version is preferred over a higher one
- `CONTINIA_ENV_PROFILE_ID` set → no profile queries, creates from the pin
- a pinned profile whose environment reports a lower `bcVersion` → throws, naming both
- persisted environment with a satisfying `bcVersion` → reused (existing behaviour)
- **persisted environment with a stale `bcVersion` → recreated, not reused** (the
  WI 82205 resume case)
- no satisfying version → throws, naming required and available
- localization missing for the selected version → throws, naming the available ones
- no manifest declares a version, pin unset → throws
- no manifest declares a version, pin set → creates from the pin, logs that validation
  was skipped
- no manifest declares a version, environment persisted → reused unvalidated, not
  recreated

### `tests/config/index.test.ts`

`CONTINIA_ENV_PROFILE_ID` unset with `SKIP_BUILD_TEST=false` now loads; `CONTINIA_API_TOKEN`
still required; `CONTINIA_ENV_LOCALIZATION` defaults to `base`.

### Cascade work (mechanical, not new behavior)

`AppConfig` is a required-field type, so every config fixture across the suite needs
`continiaEnvLocalization`. Same sweep as previous plans.

## Out of scope (explicit non-goals)

- Choosing localization per work item, or deriving it from anything in the repo. It is
  one config value.
- Reconciling *Continia app* versions on the environment (the `Continia Core 30.0.0.0`
  vs `29.0.0.0` half of the WI 82205 log). That is the `deps install` catalogue, a
  different axis from the BC platform profile, and it did not block the deploy.
- Tearing down or migrating environments already created at the wrong version. The
  reuse-path check recreates them on next run; the strays auto-delete after ~10 days.
- Changing `build-and-test`'s deploy-set derivation or its `symbol-fetch-failed`
  classification. Both are correct; they were simply the first code to notice a problem
  created eight stages earlier.
