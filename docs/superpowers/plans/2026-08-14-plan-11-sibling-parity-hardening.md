# Plan 11 — Sibling-Parity Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the proven patterns from `C:\GeneralDev\DevOpsPullers\ADONewDirectCombuilder` (correct Continia CLI usage, PAT-safe git auth, WI-linked draft PRs, orchestrator-owned skill symlinking, working Linux container) into DevopsCoder, and close the correctness holes they expose in the Plan-10 verification gate.

**Architecture:** No architectural change — DevopsCoder keeps its typed `ContiniaCli` + stage-based orchestrator (settled design; the sibling's agent-driven verify phase is deliberately NOT adopted). Every task is either a corrective fix inside an existing seam (CLI argv, Zod schema, ADO body, push command) or a new injectable service (`skill-wiring`, `git-auth`) wired through the existing DI points.

**Tech Stack:** Bun (TypeScript), Zod, `bun:test`, git worktrees, Azure DevOps REST 7.1, Continia CLI (`continia-linux` in Docker / `continia.exe` on Windows dev), Docker (`oven/bun:1`).

**Spec:** Inline — see §Background below. Sibling reference code: `ADONewDirectCombuilder/src/services/workspace.ts` (wireSkills, git auth), `ADONewDirectCombuilder/Dockerfile`, `ADONewDirectCombuilder/.claude/skills/continia-{env-setup,deps,deploy,test}/SKILL.md` (the authoritative CLI contract).

## Global Constraints

- Runtime: Bun. Run `bun test` (full suite, 387 passing pre-plan) and `bun run typecheck` after every task; both must be green before commit.
- Imports use `.ts` extensions (`verbatimModuleSyntax: true`); type-only imports use the `type` keyword.
- `noUncheckedIndexedAccess` is on: `mock.calls[i]` accesses need `?.` / `!` and casts for generic interfaces (see existing tests for the pattern).
- Adding a required field to `AppConfig` (`src/types/index.ts`) breaks every test fixture that builds a literal `AppConfig`. The fixture sweep is: `grep -rn "dryRun: false" tests/` and add the new field beside it in every hit.
- Out of scope (do not introduce): plan-stage/human plan-approval gate, self-research analyzer, multi-target-repo support, migration of the 4 read-only agents, test-suggestion features.
- Do NOT port from the sibling: its agent-driven verify phase, its PAT-in-error-message leak (we explicitly fix that class of bug here), its non-idempotent publish path, `continia env users --json` (returns plaintext passwords — never invoke it).
- Commit style: conventional commits matching recent history (`feat(scope): …`, `fix(scope): …`, `docs: …`).

## Background (research findings this plan implements)

Verified against the sibling's skill docs (the authoritative CLI contract, written from real runs):

1. **Deploy flags.** The correct per-app deploy is `continia deploy <envId> <appPath> --workspace-root <appPath> --allow-downgrade --json`, run from the repo root with a repo-relative app path. `--with-deps` (what DevopsCoder uses today) is explicitly forbidden for normal changes: it recompiles dependency apps from source — slow, and it fails when those apps' own deps aren't staged. `--allow-downgrade` is required because a branch build (`29.0.0.0`) is lower than the CI baseline installed on the env (`29.0.0.96961`) and BC refuses downgrades by default (failure carries `conflict: "higher-version-installed"`).
2. **Activation app.** A fresh environment must get the *Continia Core Internal Activation App* installed before anything can interact with it: `continia deps install-by-id <envId> c3755ece-dab0-4d16-987d-040661f18522 --json`. Idempotent (skips if installed), pulls a prebuilt `.app`, no local compile.
3. **`deps install` semantics.** Real install failure → `failed[]` + exit 1. Catalogue *miss* → `skipped[]` + exit 0 (silent unless you look). After install, `symbolsMissing` in the JSON flags symbol gaps that surface later as compile errors.
4. **Token env var confirmed.** The headless CLI authenticates from `CONTINIA_API_TOKEN` in the process environment (interactive fallback is the VS Code setting `environment-explorer.api-token`). DevopsCoder's `CONTINIA_TOKEN_ENV_VAR` guess is correct; the hedging comment can be resolved.
5. **Green-washing hole (ours, not theirs).** `testRunSchema` in `continia-cli.ts` defaults `summary.failed` to `0`; a renamed CLI field silently yields `passed: true` on a red run. The real `--json` shape has `summary.{total,passed,failed}` and `tests[]` — require them.
6. **Git auth.** The sibling never persists the PAT: remote URLs are credential-free and every authenticated git call gets a per-invocation `-c http.extraHeader=Authorization: Basic base64(":"+PAT)` argv prefix, with `GIT_TERMINAL_PROMPT=0` + `GIT_ASKPASS=echo` so nothing blocks on prompts. Their one bug: git failure messages embed argv (= the header) and get posted to WI comments — we port the mechanism WITH redaction.
7. **Draft PR.** ADO rejects descriptions > 4000 chars with a 400 (hit on a real WI). `workItemRefs: [{id}]` in the create body links the PR to the WI properly (DevopsCoder today only has a text link).
8. **Skills.** The sibling symlinks its own `.claude/skills/*` (one junction-type link per skill dir) into each worktree's `.claude/`, never clobbering a skill the target repo ships, and registers `/.claude/` in `.git/info/exclude` — resolved via the git **common dir**, because a linked worktree's own `info/exclude` is silently inert. The SDK picks them up via `settingSources: ['project']` + `cwd` = worktree (which DevopsCoder already sets). DevopsCoder's own `.claude/skills/` (continia-deploy, continia-deps, continia-env-setup, continia-test, …) becomes usable by the coder/fix agents this way.
9. **Docker.** DevopsCoder's default `CONTINIA_CLI_PATH=.tools/continia.exe` is a Windows PE binary that cannot run in the Linux container (and `.tools/` is gitignored — it isn't even in the build context). The sibling ships `.tools/continia-linux` → `/usr/local/bin/continia`, needs `libicu` (dlopen'd by the .NET AL compiler — invisible to `ldd`; resolve the package name dynamically, a pinned `libicuNN` broke their build when the base image moved Debian releases), `libssl3`, `libstdc++6`, sets `CONTINIA_ALC_PATH=/opt/al/bin/linux/alc` (read-only bind mount of the host's AL VS Code extension) and `CONTINIA_AUTO_INSTALL_ALC=0` (upstream CLI bug: auto-install resolves `lib/net10.0/alc` but the package ships `lib/net8.0/alc`, mode 644). It also copies `node`/`npm`/`npx` from `node:22-bookworm-slim` because the Agent SDK spawns node — a silent failure mode without it.
10. **Smoke bypass.** Sibling pattern: `SKIP_BUILD_TEST=true` (boolFlag) skips the whole verification and makes the Continia config conditionally required — "a harness smoke test should not need a DemoPortal token."

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/services/continia-cli.ts` | Modify | deploy flags, strict test schema, `installAppById`, deps-install info |
| `src/pipeline/stages/build-and-test.ts` | Modify | activation app, deps warnings (logger), test timeout, skills in fix prompt |
| `src/config/index.ts` + `src/types/index.ts` | Modify | `CONTINIA_TEST_TIMEOUT_S`, `SKILLS_SOURCE_DIR`, `SKIP_BUILD_TEST` (+boolFlag) |
| `src/sdk/azure-devops-client.ts` | Modify | `workItemRefs` on PR create |
| `src/pipeline/stages/draft-pr-creator.ts` | Modify | description cap, signal, injected clock, authed force-with-lease push |
| `src/utils/git-auth.ts` | Create | `buildGitAuthArgs`, `redactPat` — shared PAT-safe git auth |
| `src/services/worktree-manager.ts` | Modify | authed fetch, PAT redaction in errors, no-prompt env |
| `src/services/skill-wiring.ts` | Create | symlink orchestrator skills into worktrees + `info/exclude` |
| `src/pipeline/stages/worktree-setup.ts` | Modify | invoke skill wiring after `ensureWorktree` |
| `src/services/skill-loader.ts` | Modify | `discoverSkillsIn` refactor + `mergeSkills` |
| `src/services/pipeline-builder.ts` | Modify | merged skill advertisement, logger→build-and-test, stage skipping |
| `Dockerfile`, `.dockerignore`, `docker-compose.example.yml` | Modify | Linux CLI, node, libicu, alc wiring |
| `README.md`, `.env.example`, `CLAUDE.md`, `src/prompts/draft-pr-description.md` | Modify | docs parity |
| `tests/…` | Modify/Create | mirrors of all the above |

---

### Task 1: Correct the Continia deploy invocation

**Files:**
- Modify: `src/services/continia-cli.ts` (deployApp at :331-338, token comment at :5-11, imports at :1)
- Test: `tests/services/continia-cli.test.ts` (deployApp describe at :150-171)

**Interfaces:**
- Consumes: existing `ContiniaCli.deployApp(envId, appPathRel, opts)` signature — unchanged.
- Produces: `deployApp` now runs from the worktree root and passes `['deploy', envId, appPathRel, '--workspace-root', appPathRel, '--allow-downgrade', '--json']`. Later tasks (3, 4) edit the same file — apply in order.

- [ ] **Step 1: Rewrite the deployApp test to expect the new argv**

Replace the first test inside `describe('deployApp', …)` in `tests/services/continia-cli.test.ts` (the one titled `'runs from the app parent dir with a relative app arg, --with-deps, never --all'`) with:

```ts
    it('deploys with --workspace-root and --allow-downgrade from the worktree root; never --with-deps or --all', async () => {
      const { cli, calls } = makeCli([
        ok('[{"app":"Continia_Core","compiled":true,"published":true}]'),
      ]);
      const result = await cli.deployApp('env-1', 'Core/Cloud', opts);
      const call = calls[0]!;
      expect(call.cwd).toBe(WORKTREE);
      expect(call.argv.slice(1)).toEqual([
        'deploy', 'env-1', 'Core/Cloud', '--workspace-root', 'Core/Cloud', '--allow-downgrade', '--json',
      ]);
      expect(call.argv).not.toContain('--with-deps');
      expect(call.argv).not.toContain('--all');
      expect(result).toEqual([{ app: 'Continia_Core', compiled: true, published: true }]);
    });
```

The `dirname` import in the test file becomes unused — remove it from the `import { resolve, dirname, join } from 'path'` line (keep `join` only if still used; check with grep).

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/services/continia-cli.test.ts`
Expected: FAIL — argv mismatch (`--with-deps` present, cwd is the app's parent dir).

- [ ] **Step 3: Implement the new deployApp**

In `src/services/continia-cli.ts` replace the `deployApp` method (:331-338) with:

```ts
    async deployApp(envId, appPathRel, opts) {
      // Invocation contract per the sibling's continia-deploy skill:
      // --workspace-root scopes app discovery to the app itself so sibling
      // dependency source dirs are not recompiled; --allow-downgrade lets a
      // branch build (e.g. 29.0.0.0) replace a higher CI baseline, which BC
      // otherwise refuses (conflict: "higher-version-installed").
      // --with-deps is deliberately NOT used: it recompiles dependency apps
      // from source — slow, and it fails when their own deps aren't staged.
      const args = [
        'deploy', envId, appPathRel,
        '--workspace-root', appPathRel,
        '--allow-downgrade', '--json',
      ];
      const raw = await runJson(args, opts);
      return deployResultSchema.parse(raw) as DeployAppResult[];
    },
```

Remove the now-unused `basename` and `dirname` from the `path` import at :1 (keep `isAbsolute`, `resolve`).

Also replace the token-var doc comment at :5-10 with (the name is now confirmed, not guessed):

```ts
/**
 * Env-var name the spawned Continia CLI reads its DemoPortal token from.
 * Confirmed against ADONewDirectCombuilder: headless runs authenticate from
 * CONTINIA_API_TOKEN in the process environment (the interactive CLI falls
 * back to the VS Code setting `environment-explorer.api-token`).
 */
```

- [ ] **Step 4: Run tests + typecheck**

Run: `bun test tests/services/continia-cli.test.ts && bun run typecheck`
Expected: PASS. Then `bun test` (full) — the build-and-test/integration suites don't assert deploy argv, so they stay green.

- [ ] **Step 5: Commit**

```bash
git add src/services/continia-cli.ts tests/services/continia-cli.test.ts
git commit -m "fix(continia): deploy with --workspace-root/--allow-downgrade, drop forbidden --with-deps"
```

---

### Task 2: Strict test-result schema (close the green-washing hole)

**Files:**
- Modify: `src/services/continia-cli.ts` (testRunSchema at :118-146, runTests parse at :363)
- Test: `tests/services/continia-cli.test.ts` (runTests describe)

**Interfaces:**
- Consumes: `testRunSchema`, `ContiniaCliError` from Task 1's file state.
- Produces: `runTests` now throws `ContiniaCliError` with message containing `unexpected test-result shape` when `summary` (with numeric `total`/`passed`/`failed`) or `tests` is missing. `TestRunResult` type unchanged.

- [ ] **Step 1: Write the failing tests**

Add to `describe('runTests', …)` in `tests/services/continia-cli.test.ts`:

```ts
    it('refuses to guess pass/fail when summary is missing (no silent green)', async () => {
      const { cli } = makeCli([ok('{"status":"completed","tests":[]}')]);
      await expect(cli.runTests('env-1', 148001, opts)).rejects.toThrow(
        /unexpected test-result shape/,
      );
    });

    it('refuses to guess pass/fail when summary.failed is missing', async () => {
      // A renamed counter field must be a hard error, not a default-0 pass.
      const { cli } = makeCli([
        ok('{"status":"completed","summary":{"total":2,"passed":1,"failures":1},"tests":[]}'),
      ]);
      await expect(cli.runTests('env-1', 148001, opts)).rejects.toThrow(
        /unexpected test-result shape/,
      );
    });

    it('refuses to guess when the tests array is missing', async () => {
      const { cli } = makeCli([
        ok('{"status":"completed","summary":{"total":1,"passed":0,"failed":1,"skipped":0}}'),
      ]);
      await expect(cli.runTests('env-1', 148001, opts)).rejects.toThrow(
        /unexpected test-result shape/,
      );
    });
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test tests/services/continia-cli.test.ts`
Expected: FAIL — today the lenient defaults produce `passed: true` / `passed: false` instead of throwing.

- [ ] **Step 3: Tighten the schema and the parse site**

Replace `testRunSchema` (:118-146) with:

```ts
// `summary` and `tests` are REQUIRED, with required counters: lenient defaults
// here green-wash a red run (a renamed `summary.failed` would default to 0 and
// make `passed` come out true). Unknown EXTRA fields still pass through.
const testRunSchema = z
  .object({
    status: z.string().default('unknown'),
    summary: z
      .object({
        total: z.number(),
        passed: z.number(),
        failed: z.number(),
        skipped: z.number().default(0),
        durationSeconds: z.number().optional(),
        codeunitName: z.string().optional(),
      })
      .passthrough(),
    tests: z.array(
      z
        .object({
          name: z.string().default('(unnamed test)'),
          fullName: z.string().optional(),
          result: z.string().default('unknown'),
          durationSeconds: z.number().optional(),
          errorMessage: z.string().optional(),
          stackTrace: z.string().optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();
```

In `runTests`, replace `const parsed = testRunSchema.parse(raw);` (:363) with:

```ts
      const shape = testRunSchema.safeParse(raw);
      if (!shape.success) {
        throw new ContiniaCliError(
          `continia ${args.join(' ')} returned an unexpected test-result shape ` +
            `(refusing to guess pass/fail): missing/invalid ${shape.error.issues
              .map((i) => i.path.join('.'))
              .join(', ')}`,
          result.argv,
          result.exitCode,
          result.stdout,
          result.stderr,
        );
      }
      const parsed = shape.data;
```

- [ ] **Step 4: Run tests + typecheck**

Run: `bun test tests/services/continia-cli.test.ts && bun test && bun run typecheck`
Expected: all PASS — every existing fixture already sends a full `summary` + `tests`.

- [ ] **Step 5: Commit**

```bash
git add src/services/continia-cli.ts tests/services/continia-cli.test.ts
git commit -m "fix(continia): require summary/tests in test results — a renamed field must fail loudly, not pass green"
```

---

### Task 3: Activation-app install + deps-install visibility

**Files:**
- Modify: `src/services/continia-cli.ts` (interface :67-83, installDependencies :323-325, new method, new schema)
- Modify: `src/pipeline/stages/build-and-test.ts` (deps :120-136, execute :190-192)
- Modify: `src/services/pipeline-builder.ts` (createBuildAndTestStage call :186-195)
- Test: `tests/services/continia-cli.test.ts`, `tests/pipeline/stages/build-and-test.test.ts`, `tests/integration/_continia-fake.ts`

**Interfaces:**
- Produces (in `continia-cli.ts`):
  ```ts
  export const ACTIVATION_APP_ID = 'c3755ece-dab0-4d16-987d-040661f18522';
  export interface DepsInstallInfo { skippedCount: number; symbolsMissingCount: number; }
  // on ContiniaCli:
  installAppById(envId: string, appId: string, opts: ContiniaCallOpts): Promise<void>;
  installDependencies(envId: string, appPathRel: string, opts: ContiniaCallOpts): Promise<DepsInstallInfo>;
  ```
- Produces (in `build-and-test.ts`): `BuildAndTestDeps` gains `logger: Logger` (import `type { Logger } from '../../utils/logger.ts'`).

- [ ] **Step 1: Write the failing CLI tests**

In `tests/services/continia-cli.test.ts`, import `ACTIVATION_APP_ID` from the CLI module and add:

```ts
  it('installAppById uses deps install-by-id with the app GUID', async () => {
    const { cli, calls } = makeCli([ok('{}')]);
    await cli.installAppById('env-1', ACTIVATION_APP_ID, opts);
    expect(calls[0]?.argv.slice(1)).toEqual([
      'deps', 'install-by-id', 'env-1', ACTIVATION_APP_ID, '--json',
    ]);
  });

  it('installDependencies surfaces skipped deps and symbol gaps as counts', async () => {
    const { cli } = makeCli([
      ok('{"installed":["A"],"skipped":[{"id":"B"}],"symbolsMissing":["C","D"]}'),
    ]);
    const info = await cli.installDependencies('env-1', 'Core/Cloud', opts);
    expect(info).toEqual({ skippedCount: 1, symbolsMissingCount: 2 });
  });

  it('installDependencies returns zero counts when the CLI omits the arrays', async () => {
    const { cli } = makeCli([ok('{}')]);
    const info = await cli.installDependencies('env-1', 'Core/Cloud', opts);
    expect(info).toEqual({ skippedCount: 0, symbolsMissingCount: 0 });
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/services/continia-cli.test.ts`
Expected: FAIL — `installAppById` doesn't exist; `installDependencies` returns void.

- [ ] **Step 3: Implement in continia-cli.ts**

Below `DEFAULT_TEST_RUN_TIMEOUT_S` add:

```ts
/**
 * Continia Core Internal Activation App. Must be installed on a fresh
 * environment before agents can interact with it. `deps install-by-id` is
 * idempotent server-side (skips when already installed) and pulls a prebuilt
 * .app matching the env's BC version — no local compile.
 */
export const ACTIVATION_APP_ID = 'c3755ece-dab0-4d16-987d-040661f18522';

/** Counts from a `deps install` round. Catalogue misses land in `skipped`
 * with exit 0 — invisible unless surfaced; symbol gaps become compile errors. */
export interface DepsInstallInfo {
  skippedCount: number;
  symbolsMissingCount: number;
}
```

Add the schema next to the others:

```ts
const depsInstallSchema = z
  .object({
    skipped: z.array(z.unknown()).default([]),
    symbolsMissing: z.array(z.unknown()).default([]),
  })
  .passthrough();
```

Interface additions on `ContiniaCli` (:67-83): change `installDependencies`'s return type to `Promise<DepsInstallInfo>` and add `installAppById(envId: string, appId: string, opts: ContiniaCallOpts): Promise<void>;`.

Implementation — replace `installDependencies` (:323-325) and add the new method:

```ts
    async installDependencies(envId, appPathRel, opts) {
      const raw = await runJson(['deps', 'install', envId, appPathRel, '--json'], opts);
      const parsed = depsInstallSchema.parse(raw ?? {});
      return {
        skippedCount: parsed.skipped.length,
        symbolsMissingCount: parsed.symbolsMissing.length,
      };
    },

    async installAppById(envId, appId, opts) {
      await runJson(['deps', 'install-by-id', envId, appId, '--json'], opts);
    },
```

- [ ] **Step 4: Write the failing build-and-test test**

In `tests/pipeline/stages/build-and-test.test.ts`, extend the fake cli inside `makeHarness` (:179-202) with:

```ts
    installAppById: mock(async (_e: string, appId: string) => {
      callOrder.push(`install-app:${appId}`);
    }),
```

and change the `installDependencies` mock to return the new info object:

```ts
    installDependencies: mock(async (_e: string, app: string) => {
      callOrder.push(`install:${app}`);
      return { skippedCount: 0, symbolsMissingCount: 0 };
    }),
```

Add `logger: createLogger()` to the `createBuildAndTestStage({ … })` deps in `makeHarness` (:222-235).

Update the green-first-pass expectation (:272-278) so the activation app installs right after the env is Running:

```ts
    expect(callOrder).toEqual([
      'waitForRunning',
      'install-app:c3755ece-dab0-4d16-987d-040661f18522',
      'install:Core/Cloud', 'install:Banking/Cloud',
      'download:Core/Cloud', 'download:Banking/Cloud',
      'deploy:Core/Cloud', 'deploy:Banking/Cloud',
      'test:148001', 'test:148002',
    ]);
```

- [ ] **Step 5: Run to verify failure, then implement the stage change**

Run: `bun test tests/pipeline/stages/build-and-test.test.ts` — expected FAIL (callOrder missing `install-app:…`).

In `src/pipeline/stages/build-and-test.ts`:
- Import `ACTIVATION_APP_ID` (extend the existing `type { ContiniaCli }` import into a value+type import: `import { ACTIVATION_APP_ID, type ContiniaCli } from '../../services/continia-cli.ts';`) and `import type { Logger } from '../../utils/logger.ts';`.
- Add `logger: Logger;` to `BuildAndTestDeps` (:120-136).
- Replace the install loop (:190-192) with:

```ts
      // A fresh environment can't be interacted with until the Continia Core
      // Internal Activation App is installed. Idempotent — safe on re-entry.
      await deps.continiaCli.installAppById(env.envId, ACTIVATION_APP_ID, callOpts);

      for (const appPath of config.continiaAppPaths) {
        const info = await deps.continiaCli.installDependencies(env.envId, appPath, callOpts);
        if (info.skippedCount > 0 || info.symbolsMissingCount > 0) {
          deps.logger.warn(
            `build-and-test: deps install for ${appPath} reported ${info.skippedCount} skipped dep(s) ` +
              `and ${info.symbolsMissingCount} symbol gap(s) — catalogue misses surface later as compile errors`,
          );
        }
      }
```

In `src/services/pipeline-builder.ts`, add `logger: deps.logger,` to the `createBuildAndTestStage({ … })` call (:186-195).

In `tests/integration/_continia-fake.ts`, update the fake:

```ts
    installDependencies: mock(async () => ({ skippedCount: 0, symbolsMissingCount: 0 })),
    installAppById: mock(async () => {}),
```

- [ ] **Step 6: Run the full suite + typecheck**

Run: `bun test && bun run typecheck`
Expected: PASS. If any other file builds a fake `ContiniaCli` (grep `as unknown as ContiniaCli` under `tests/`), give it the two updated members too.

- [ ] **Step 7: Commit**

```bash
git add src/services/continia-cli.ts src/pipeline/stages/build-and-test.ts src/services/pipeline-builder.ts tests/services/continia-cli.test.ts tests/pipeline/stages/build-and-test.test.ts tests/integration/_continia-fake.ts
git commit -m "feat(verification): install Continia activation app on env, surface deps-install skips/symbol gaps"
```

---

### Task 4: Configurable per-test-run timeout (`CONTINIA_TEST_TIMEOUT_S`)

**Files:**
- Modify: `src/config/index.ts` (schema + mapping), `src/types/index.ts` (AppConfig)
- Modify: `src/pipeline/stages/build-and-test.ts` (runTests call :234)
- Test: `tests/config/config.test.ts`, `tests/pipeline/stages/build-and-test.test.ts`, fixture sweep

**Interfaces:**
- Produces: `AppConfig.continiaTestTimeoutS: number` (default 600). `build-and-test` forwards it as `timeoutSeconds` on every `runTests` call. `STAGE_TIMEOUT_MS_VERIFY_PASS` remains a derivation-only input for the stage budget (documented in Task 13).

- [ ] **Step 1: Write the failing config tests**

In `tests/config/config.test.ts` (inside the Plan 10 describe):

```ts
    it('defaults continiaTestTimeoutS to 600 seconds', () => {
      const config = loadConfig(validEnv);
      expect(config.continiaTestTimeoutS).toBe(600);
    });

    it('CONTINIA_TEST_TIMEOUT_S overrides the per-test-run timeout', () => {
      const config = loadConfig({ ...validEnv, CONTINIA_TEST_TIMEOUT_S: '900' });
      expect(config.continiaTestTimeoutS).toBe(900);
    });
```

- [ ] **Step 2: Write the failing stage test**

In `tests/pipeline/stages/build-and-test.test.ts`, capture the runTests opts in `makeHarness`:

```ts
    runTests: mock(async (_e: string, codeunitId: number, o: { timeoutSeconds?: number }) => {
      callOrder.push(`test:${codeunitId}`);
      testOpts.push(o.timeoutSeconds);
      if (testQueue.length === 0) return greenRun;
      return testQueue.length > 1 ? testQueue.shift()! : testQueue[0]!;
    }),
```

with `const testOpts: Array<number | undefined> = [];` declared beside `callOrder` and returned from `makeHarness`. Add the test:

```ts
  it('forwards config.continiaTestTimeoutS to every runTests call', async () => {
    const { stage, testOpts } = makeHarness();
    await stage.execute(makeStageState(), makeStageCtx());
    expect(testOpts).toEqual([600, 600]);
  });
```

- [ ] **Step 3: Run to verify both fail**

Run: `bun test tests/config/config.test.ts tests/pipeline/stages/build-and-test.test.ts`
Expected: FAIL — unknown config field / `testOpts` receives `[undefined, undefined]`.

- [ ] **Step 4: Implement**

`src/config/index.ts` — add to the schema after `MAX_TEST_FIX_ATTEMPTS` (:33):

```ts
  CONTINIA_TEST_TIMEOUT_S: z.coerce.number().int().positive().default(600),
```

and to the returned object (beside `maxTestFixAttempts`): `continiaTestTimeoutS: p.CONTINIA_TEST_TIMEOUT_S,`.

`src/types/index.ts` — add to `AppConfig` after `maxTestFixAttempts` (:33):

```ts
  /** `--timeout` (seconds) passed to each `continia test run`. */
  continiaTestTimeoutS: number;
```

Fixture sweep: `grep -rn "dryRun: false" tests/` → add `continiaTestTimeoutS: 600,` beside it in every literal `AppConfig`.

`src/pipeline/stages/build-and-test.ts` — change the runTests call (:234) to:

```ts
            const run = await deps.continiaCli.runTests(env.envId, cu.id, {
              ...callOpts,
              timeoutSeconds: config.continiaTestTimeoutS,
            });
```

- [ ] **Step 5: Run full suite + typecheck, commit**

Run: `bun test && bun run typecheck` — expected PASS.

```bash
git add src/config/index.ts src/types/index.ts src/pipeline/stages/build-and-test.ts tests/
git commit -m "feat(config): CONTINIA_TEST_TIMEOUT_S — operator-settable per-test-run timeout, wired into runTests"
```

---

### Task 5: Fix agent gets the skills list (use the dead `discoveredSkills` dep)

**Files:**
- Modify: `src/pipeline/stages/build-and-test.ts` (buildFixPrompt :65-118, runFixCall call site :265-272)
- Test: `tests/pipeline/stages/build-and-test.test.ts`

**Interfaces:**
- Produces: `buildFixPrompt(failure, wiCtx, worktree, environment, attempt, maxAttempts, skills: DiscoveredSkill[] = [])` — new trailing param with default, so existing callers/tests compile unchanged. Renders the same `## Available Invocable Skills` block the analyzer/coder/test-author use.

- [ ] **Step 1: Write the failing test**

In the `describe('buildFixPrompt', …)` block:

```ts
  it('advertises invocable skills when provided', () => {
    const prompt = buildFixPrompt(
      { compiled: false, deploy: [{ app: 'A', compiled: false, published: false, error: 'x' }], testRuns: [] },
      wiCtx, worktree, environment, 1, 2,
      [{ name: 'continia-deploy', description: 'Compile and deploy AL code to a BC environment.' }],
    );
    expect(prompt).toContain('## Available Invocable Skills');
    expect(prompt).toContain('**continia-deploy**: Compile and deploy AL code');
  });
```

And in the stage section, assert the wiring (the harness passes `discoveredSkills: []` today — parameterize it):

```ts
  it('passes discoveredSkills through to the fix prompt', async () => {
    const { stage, runnerCalls } = makeHarness({
      deployQueue: [redDeploy, redDeploy, greenDeploy],
      skills: [{ name: 'continia-test', description: 'Run AL tests on a BC environment.' }],
    });
    await stage.execute(makeStageState(), makeStageCtx());
    expect(runnerCalls[0]!.prompt).toContain('**continia-test**');
  });
```

Extend `makeHarness`'s options with `skills?: DiscoveredSkill[]` and pass `discoveredSkills: opts.skills ?? []` in the stage deps (import `type { DiscoveredSkill } from '../../../src/services/skill-loader.ts'`).

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/pipeline/stages/build-and-test.test.ts` — expected FAIL.

- [ ] **Step 3: Implement**

In `buildFixPrompt`, add the trailing parameter `skills: DiscoveredSkill[] = []` and, immediately before the `sections.push('\n## Rules');` line (:112), insert:

```ts
  if (skills.length > 0) {
    sections.push('\n## Available Invocable Skills\n');
    for (const s of skills) {
      sections.push(`- **${s.name}**: ${s.description}`);
    }
  }
```

In `runFixCall`'s `buildFixPrompt(...)` call (:265-272), pass `deps.discoveredSkills` as the seventh argument.

- [ ] **Step 4: Run full suite + typecheck, commit**

Run: `bun test && bun run typecheck` — PASS.

```bash
git add src/pipeline/stages/build-and-test.ts tests/pipeline/stages/build-and-test.test.ts
git commit -m "fix(build-and-test): advertise invocable skills to the fix agent (discoveredSkills was wired but unused)"
```

---

### Task 6: Link the PR to the work item; thread signal and clock

**Files:**
- Modify: `src/types/index.ts` (`CreatePullRequestArgs` :374-383)
- Modify: `src/sdk/azure-devops-client.ts` (createPullRequest body :209-215)
- Modify: `src/pipeline/stages/draft-pr-creator.ts` (:139, :175-190)
- Test: `tests/sdk/azure-devops-client.test.ts`, `tests/pipeline/stages/draft-pr-creator.test.ts`

**Interfaces:**
- Produces: `CreatePullRequestArgs.workItemId?: number`. The ADO body gains `workItemRefs: [{ id: String(workItemId) }]` when set. The stage passes `workItemId: wiCtx.id`, `{ signal: ctx.signal }`, and stamps `createdAt` from `ctx.now()`.

- [ ] **Step 1: Write the failing ADO client test**

In `tests/sdk/azure-devops-client.test.ts`, following that file's existing fetch-mock pattern (adapt config/fixture names to what the file already defines):

```ts
  it('createPullRequest sends workItemRefs when workItemId is provided', async () => {
    let capturedBody: Record<string, unknown> = {};
    const fetchMock = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({ pullRequestId: 7, url: 'https://x/pr/7', sourceRefName: 's', targetRefName: 't' }),
        { status: 201 },
      );
    }) as typeof fetch;
    const client = createAdoClient(baseConfig, fetchMock);
    await client.createPullRequest({
      repositoryName: 'r', sourceRefName: 'refs/heads/b', targetRefName: 'refs/heads/main',
      title: 'T', description: 'D', isDraft: true, workItemId: 101,
    });
    expect(capturedBody.workItemRefs).toEqual([{ id: '101' }]);
  });

  it('createPullRequest omits workItemRefs when workItemId is absent', async () => {
    let capturedBody: Record<string, unknown> = {};
    const fetchMock = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({ pullRequestId: 8, url: 'https://x/pr/8', sourceRefName: 's', targetRefName: 't' }),
        { status: 201 },
      );
    }) as typeof fetch;
    const client = createAdoClient(baseConfig, fetchMock);
    await client.createPullRequest({
      repositoryName: 'r', sourceRefName: 'refs/heads/b', targetRefName: 'refs/heads/main',
      title: 'T', description: 'D', isDraft: true,
    });
    expect('workItemRefs' in capturedBody).toBe(false);
  });
```

- [ ] **Step 2: Write the failing stage tests**

In `tests/pipeline/stages/draft-pr-creator.test.ts`:
- In T1, after the existing `prCall` assertions add `expect(prCall.workItemId).toBe(101);` (extend the local `prCall` cast type with `workItemId: number`).
- Change `makeCtx()` (:135-143) to a fixed clock: `now: () => new Date('2026-08-14T12:00:00.000Z'),` and in T1 replace the createdAt regex assertion with `expect(draftPr.createdAt).toBe('2026-08-14T12:00:00.000Z');`.
- Add:

```ts
  it('forwards the pipeline abort signal to createPullRequest', async () => {
    let capturedOpts: { signal?: AbortSignal } | undefined;
    const ado = makeAdoClient({
      createPullRequest: mock(async (_args, opts) => {
        capturedOpts = opts;
        return { id: 1, url: 'https://x/pr/1', sourceRefName: 's', targetRefName: 't' };
      }),
    });
    const stage = createDraftPrCreatorStage({
      config: baseConfig, ado, prDescriptionTemplate: MINIMAL_TEMPLATE, pushBranch: mock(async () => {}),
    });
    const ctx = makeCtx();
    await stage.execute(makeState(), ctx);
    expect(capturedOpts?.signal).toBe(ctx.signal);
  });
```

- [ ] **Step 3: Run to verify failure**

Run: `bun test tests/sdk/azure-devops-client.test.ts tests/pipeline/stages/draft-pr-creator.test.ts` — expected FAIL.

- [ ] **Step 4: Implement**

`src/types/index.ts` — add to `CreatePullRequestArgs`:

```ts
  /** WI to link via workItemRefs — ADO then shows the PR on the work item. */
  workItemId?: number;
```

`src/sdk/azure-devops-client.ts` — in the createPullRequest body (:209-215):

```ts
          body: JSON.stringify({
            sourceRefName: args.sourceRefName,
            targetRefName: args.targetRefName,
            title: args.title,
            description: args.description,
            isDraft: args.isDraft,
            ...(args.workItemId !== undefined
              ? { workItemRefs: [{ id: String(args.workItemId) }] }
              : {}),
          }),
```

`src/pipeline/stages/draft-pr-creator.ts` — rename `_ctx` to `ctx` (:139); pass `workItemId: wiCtx.id,` inside the createPullRequest args and `{ signal: ctx.signal }` as its second argument (:175-182); set `createdAt: ctx.now().toISOString(),` (:189).

- [ ] **Step 5: Run full suite + typecheck, commit**

Run: `bun test && bun run typecheck` — PASS.

```bash
git add src/types/index.ts src/sdk/azure-devops-client.ts src/pipeline/stages/draft-pr-creator.ts tests/sdk/azure-devops-client.test.ts tests/pipeline/stages/draft-pr-creator.test.ts
git commit -m "feat(pr): link draft PR to WI via workItemRefs; thread abort signal and injected clock"
```

---

### Task 7: PR description 4000-char cap (environment section survives)

**Files:**
- Modify: `src/pipeline/stages/draft-pr-creator.ts` (buildPrDescription :49-129)
- Test: `tests/pipeline/stages/draft-pr-creator.test.ts`

**Interfaces:**
- Produces: `export const MAX_PR_DESCRIPTION_LENGTH = 4000;` and `export function capPrDescription(full: string): string`, applied as the last step of `buildPrDescription`. Truncation sacrifices the head (summaries) and preserves everything from the `## Test environment` heading down. Task 11 rewords that section's body but keeps the heading — do not rename the heading in either task.

- [ ] **Step 1: Write the failing tests**

```ts
  describe('capPrDescription', () => {
    it('leaves short descriptions unchanged', () => {
      expect(capPrDescription('short')).toBe('short');
    });

    it('caps at 4000 chars, drops head content, and preserves the environment section', () => {
      const head = 'H'.repeat(6000);
      const tail = '\n## Test environment\n\nenv `env-9` — https://bc/env-9\n';
      const capped = capPrDescription(head + tail);
      expect(capped.length).toBeLessThanOrEqual(MAX_PR_DESCRIPTION_LENGTH);
      expect(capped).toContain('## Test environment');
      expect(capped).toContain('https://bc/env-9');
      expect(capped).toContain('truncated');
    });

    it('hard-caps when there is no environment section', () => {
      const capped = capPrDescription('X'.repeat(6000));
      expect(capped.length).toBeLessThanOrEqual(MAX_PR_DESCRIPTION_LENGTH);
      expect(capped).toContain('truncated');
    });
  });

  it('buildPrDescription output never exceeds the ADO limit', () => {
    const desc = buildPrDescription({
      wiCtx: sampleWiCtx,
      analyzer: sampleAnalyzer,
      coder: { ...sampleCoder, summary: 'S'.repeat(6000) },
      testAuthor: undefined,
      reviewer: undefined,
      worktree: sampleWorktree,
      template: '{{coder-summary}}\n## Test environment\n{{environment-url}}',
      environment: { envId: 'env-9', name: 'n', url: 'https://bc/env-9', status: 'Running', createdAt: 'x' },
      config: baseConfig,
    });
    expect(desc.length).toBeLessThanOrEqual(MAX_PR_DESCRIPTION_LENGTH);
    expect(desc).toContain('https://bc/env-9');
  });
```

Import `capPrDescription, MAX_PR_DESCRIPTION_LENGTH` alongside the existing imports.

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/pipeline/stages/draft-pr-creator.test.ts` — FAIL (symbols don't exist).

- [ ] **Step 3: Implement**

In `src/pipeline/stages/draft-pr-creator.ts`, above `buildPrDescription`:

```ts
/** ADO rejects PR descriptions over 4000 chars with a 400 (seen on a real WI). */
export const MAX_PR_DESCRIPTION_LENGTH = 4000;
const TRUNCATION_NOTICE = '\n\n_(earlier sections truncated to fit ADO\u2019s 4000-char description limit)_\n';
const TAIL_MARKER = '\n## Test environment';

/**
 * Cap the rendered description. Truncation sacrifices the head (summaries) and
 * preserves everything from the "## Test environment" heading down — the env
 * URL is the part a human tester cannot reconstruct.
 */
export function capPrDescription(full: string): string {
  if (full.length <= MAX_PR_DESCRIPTION_LENGTH) return full;
  const idx = full.indexOf(TAIL_MARKER);
  if (idx === -1) {
    return full.slice(0, MAX_PR_DESCRIPTION_LENGTH - TRUNCATION_NOTICE.length) + TRUNCATION_NOTICE;
  }
  const tail = full.slice(idx);
  const headBudget = MAX_PR_DESCRIPTION_LENGTH - tail.length - TRUNCATION_NOTICE.length;
  const capped = full.slice(0, Math.max(0, headBudget)) + TRUNCATION_NOTICE + tail;
  // Degenerate case: the tail alone exceeds the limit — hard cap, better a
  // clipped footer than a 400 from ADO.
  return capped.length <= MAX_PR_DESCRIPTION_LENGTH ? capped : capped.slice(0, MAX_PR_DESCRIPTION_LENGTH);
}
```

Change `buildPrDescription`'s final `return result;` (:128) to `return capPrDescription(result);`.

- [ ] **Step 4: Run full suite + typecheck, commit**

Run: `bun test && bun run typecheck` — PASS.

```bash
git add src/pipeline/stages/draft-pr-creator.ts tests/pipeline/stages/draft-pr-creator.test.ts
git commit -m "fix(pr): cap description at ADO's 4000-char limit, preserving the test-environment section"
```

---

### Task 8: PAT-safe git auth — extraHeader injection, redaction, force-with-lease push

**Files:**
- Create: `src/utils/git-auth.ts`
- Create: `tests/utils/git-auth.test.ts`
- Modify: `src/pipeline/stages/draft-pr-creator.ts` (defaultPushBranch :32-43, push default :154)
- Modify: `src/services/worktree-manager.ts` (runGit :72-104, fetch :164)
- Modify: `tests/services/worktree-manager.test.ts`
- Modify: `README.md` (push-auth section, ~:188)

**Interfaces:**
- Produces (in `src/utils/git-auth.ts`):
  ```ts
  export function buildGitAuthArgs(pat: string): string[];   // ['-c', 'http.extraHeader=Authorization: Basic <b64>']
  export function redactPat(text: string, pat: string): string;
  ```
- Both `worktree-manager` and `draft-pr-creator` consume these. The injectable `pushBranch?: (branch, cwd) => Promise<void>` seam keeps its signature.

- [ ] **Step 1: Write the failing util tests**

Create `tests/utils/git-auth.test.ts`:

```ts
import { describe, it, expect } from 'bun:test';
import { buildGitAuthArgs, redactPat } from '../../src/utils/git-auth.ts';

describe('buildGitAuthArgs', () => {
  it('builds a per-invocation extraHeader with Basic base64(":"+pat)', () => {
    const args = buildGitAuthArgs('my-long-secret-pat');
    const basic = Buffer.from(':my-long-secret-pat').toString('base64');
    expect(args).toEqual(['-c', `http.extraHeader=Authorization: Basic ${basic}`]);
  });
});

describe('redactPat', () => {
  it('redacts both the raw PAT and its base64 basic-auth form', () => {
    const pat = 'super-secret-pat-1234';
    const basic = Buffer.from(`:${pat}`).toString('base64');
    const text = `push failed: header Basic ${basic} rejected for token ${pat}`;
    const out = redactPat(text, pat);
    expect(out).not.toContain(pat);
    expect(out).not.toContain(basic);
    expect(out).toContain('<redacted>');
  });

  it('does not mangle unrelated words when the PAT is a short string', () => {
    // Short test PATs like "pat" appear inside words like "path" — skip raw
    // replacement below 8 chars (real PATs are long random strings).
    expect(redactPat('the path is fine', 'pat')).toBe('the path is fine');
  });

  it('is a no-op for an empty pat', () => {
    expect(redactPat('anything', '')).toBe('anything');
  });
});
```

- [ ] **Step 2: Run to verify failure, then implement the util**

Run: `bun test tests/utils/git-auth.test.ts` — FAIL (module missing). Create `src/utils/git-auth.ts`:

```ts
/**
 * Per-invocation git auth for Azure DevOps over HTTPS: an `http.extraHeader`
 * config argument carrying `Basic base64(":" + PAT)`. Passed as argv on each
 * call — never written to .git/config — so persisted remote URLs stay
 * credential-free. Harmless on file:// remotes (http.* config is ignored),
 * which keeps the real-git test sandboxes working unchanged.
 */
export function buildGitAuthArgs(pat: string): string[] {
  const basic = Buffer.from(`:${pat}`).toString('base64');
  return ['-c', `http.extraHeader=Authorization: Basic ${basic}`];
}

/**
 * Strip the PAT (raw and base64 basic-auth forms) from text destined for
 * error messages, logs, or WI comments. The sibling repo leaked its PAT into
 * ADO comments through a git error message that embedded argv — any error
 * text derived from an authenticated git call must pass through here.
 */
export function redactPat(text: string, pat: string): string {
  if (!pat) return text;
  const basic = Buffer.from(`:${pat}`).toString('base64');
  let out = text.replaceAll(basic, '<redacted>');
  // Raw PATs are long random strings; skip short values so a test PAT like
  // "pat" can't mangle unrelated words ("path").
  if (pat.length >= 8) out = out.replaceAll(pat, '<redacted>');
  return out;
}
```

Run: `bun test tests/utils/git-auth.test.ts` — PASS. Commit checkpoint:

```bash
git add src/utils/git-auth.ts tests/utils/git-auth.test.ts
git commit -m "feat(git): PAT auth via per-invocation http.extraHeader + redaction helper"
```

- [ ] **Step 3: Write the failing worktree-manager leak test**

In `tests/services/worktree-manager.test.ts` add (uses the file's existing `setupTestRepo`/`makeConfig`/`runGit` helpers):

```ts
  it('authenticates fetch per-invocation and never leaks the PAT into errors', async () => {
    const config = {
      ...makeConfig(sandbox.targetRepoPath, sandbox.worktreeBase),
      pat: 'super-secret-pat-value-1234',
    };
    const mgr = createWorktreeManager({ config });
    // Break the remote so the initial `git fetch origin` fails.
    await runGit(
      ['remote', 'set-url', 'origin', join(sandbox.root, 'does-not-exist.git')],
      sandbox.targetRepoPath,
    );
    let caught: unknown;
    try {
      await mgr.ensureWorktree({ workItemId: 101, slug: 'x' });
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(WorktreeError);
    const err = caught as WorktreeError;
    const basic = Buffer.from(':super-secret-pat-value-1234').toString('base64');
    // The fetch argv carries the auth header, so the message proves both that
    // auth args are present and that they are redacted.
    expect(err.message).toContain('http.extraHeader');
    expect(err.message).not.toContain('super-secret-pat-value-1234');
    expect(err.message).not.toContain(basic);
    expect(err.command.join(' ')).not.toContain(basic);
  }, 30000);
```

Run: `bun test tests/services/worktree-manager.test.ts` — the new test FAILS (`http.extraHeader` not in the message).

- [ ] **Step 4: Implement in worktree-manager**

In `src/services/worktree-manager.ts`:
- Add `import { buildGitAuthArgs, redactPat } from '../utils/git-auth.ts';`
- In `runGit` (:72-104): compute `const pat = deps.config.pat;` and `const describe = redactPat(`git ${args.join(' ')}`, pat);` at the top; pass a no-prompt env to `Bun.spawn`:

```ts
      proc = Bun.spawn(['git', ...args], {
        cwd,
        stdout: 'pipe',
        stderr: 'pipe',
        // Never block on a credential prompt (matters inside the container).
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' },
      });
```

Both `WorktreeError` constructions use `describe` for the command portion, redact the detail text, and store a redacted argv:

```ts
      throw new WorktreeError(
        `${describe} failed (spawn error): ${redactPat(msg, pat)}`,
        ['git', ...args.map((a) => redactPat(a, pat))],
        -1, '', msg,
      );
```

```ts
      throw new WorktreeError(
        `${describe} failed (exit ${exitCode}): ${redactPat(stderr.trim() || stdout.trim() || '(no output)', pat)}`,
        ['git', ...args.map((a) => redactPat(a, pat))],
        exitCode, stdout, stderr,
      );
```

- Change the fetch (:164) to: `await runGit([...buildGitAuthArgs(deps.config.pat), 'fetch', 'origin'], baseRepoPath);`

Run: `bun test tests/services/worktree-manager.test.ts` — PASS (file:// remotes ignore `http.extraHeader`, so all pre-existing tests stay green).

- [ ] **Step 5: Harden the default push**

In `src/pipeline/stages/draft-pr-creator.ts`, add `import { buildGitAuthArgs, redactPat } from '../../utils/git-auth.ts';` and replace `defaultPushBranch` (:32-43):

```ts
async function defaultPushBranch(branch: string, cwd: string, pat: string): Promise<void> {
  // --force-with-lease: agent/wi-* branches are agent-owned; the fix loop's
  // reset path can rewrite history, and a plain push then dies non-fast-forward
  // on re-entry. Auth is per-invocation extraHeader — the origin URL stays
  // credential-free (see README "Push auth").
  const proc = Bun.spawn(
    ['git', ...buildGitAuthArgs(pat), 'push', '--force-with-lease', 'origin', branch],
    {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' },
    },
  );
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr as ReadableStream).text();
    throw new Error(
      `git push origin ${branch} failed (exit ${exitCode}): ${redactPat(stderr.trim(), pat)}`,
    );
  }
}
```

And in `execute` (:154): `const push = deps.pushBranch ?? ((b: string, cwd: string) => defaultPushBranch(b, cwd, deps.config.pat));`

- [ ] **Step 6: Update the README push-auth section**

Replace the "Push auth" guidance (README.md ~:188, the section that tells operators to embed the PAT in the origin URL) with:

```markdown
### Push auth

Git pushes and fetches authenticate per-invocation with an
`http.extraHeader=Authorization: Basic base64(":"+AZURE_DEVOPS_PAT)` argument —
the PAT is never written to `.git/config`, so the target repo's origin URL
should be the plain `https://dev.azure.com/<org>/<project>/_git/<repo>` form.
A PAT embedded in the origin URL still works but is no longer needed; prefer
removing it (`git remote set-url origin <credential-free-url>`). Error
messages from failed git calls are PAT-redacted before they reach logs or
work-item comments.
```

- [ ] **Step 7: Run full suite + typecheck, commit**

Run: `bun test && bun run typecheck` — PASS.

```bash
git add src/pipeline/stages/draft-pr-creator.ts src/services/worktree-manager.ts tests/services/worktree-manager.test.ts README.md
git commit -m "feat(git): per-invocation PAT auth on fetch/push, force-with-lease push, PAT-redacted errors"
```

---

### Task 9: Orchestrator skill wiring (`SKILLS_SOURCE_DIR` → symlinks into worktrees)

**Files:**
- Create: `src/services/skill-wiring.ts`
- Create: `tests/services/skill-wiring.test.ts`
- Modify: `src/config/index.ts`, `src/types/index.ts` (optional `skillsSourceDir`)
- Modify: `src/pipeline/stages/worktree-setup.ts` (+ its test), `src/services/pipeline-builder.ts` (:159)
- Test: `tests/config/config.test.ts`, `tests/pipeline/stages/worktree-setup.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // src/services/skill-wiring.ts
  export function wireOrchestratorSkills(skillsSourceDir: string, worktreePath: string): void;
  ```
  `AppConfig.skillsSourceDir?: string` (env `SKILLS_SOURCE_DIR`, optional — unset means wiring is a no-op; optional so existing test fixtures need no sweep). `WorktreeSetupDeps` gains `config: AppConfig` and `wireSkills?: (skillsSourceDir: string, worktreePath: string) => void`.
- Design deltas vs the sibling's `wireSkills` (deliberate): only `skills/` is linked (DevopsCoder ships nothing else), and only **directory** entries are linked — `'junction'` symlinks are directory-only on Windows, so linking files would EPERM on the dev machine.

- [ ] **Step 1: Write the failing config test**

```ts
  it('SKILLS_SOURCE_DIR is optional and maps to skillsSourceDir', () => {
    expect(loadConfig(validEnv).skillsSourceDir).toBeUndefined();
    expect(loadConfig({ ...validEnv, SKILLS_SOURCE_DIR: '/app/.claude' }).skillsSourceDir).toBe('/app/.claude');
  });
```

Implement after seeing it fail: schema line `SKILLS_SOURCE_DIR: z.string().optional(),`; mapping `skillsSourceDir: p.SKILLS_SOURCE_DIR,`; AppConfig:

```ts
  /** Dir containing an orchestrator-owned `skills/` tree (e.g. /app/.claude).
   * When set, worktree-setup symlinks each skill into the worktree's .claude/.
   * Unset → only the target repo's own committed skills are available. */
  skillsSourceDir?: string;
```

- [ ] **Step 2: Write the failing skill-wiring tests**

Create `tests/services/skill-wiring.test.ts` (real fs + real git, mirroring the worktree-manager test harness style):

```ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { wireOrchestratorSkills } from '../../src/services/skill-wiring.ts';

async function runGit(args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  if ((await proc.exited) !== 0) throw new Error(`git ${args.join(' ')} failed: ${stderr || stdout}`);
  return stdout;
}

describe('wireOrchestratorSkills', () => {
  let root: string;
  let sourceDir: string;   // plays the role of SKILLS_SOURCE_DIR (a ".claude"-like dir)
  let repoPath: string;
  let worktreePath: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'skillwire-'));
    sourceDir = join(root, 'orchestrator-claude');
    mkdirSync(join(sourceDir, 'skills', 'continia-deploy'), { recursive: true });
    writeFileSync(
      join(sourceDir, 'skills', 'continia-deploy', 'SKILL.md'),
      '---\ndescription: Deploy AL code.\n---\nbody\n',
      'utf-8',
    );
    repoPath = join(root, 'repo');
    mkdirSync(repoPath, { recursive: true });
    await runGit(['init', '--initial-branch=main'], repoPath);
    await runGit(['config', 'user.email', 't@example.com'], repoPath);
    await runGit(['config', 'user.name', 'T'], repoPath);
    writeFileSync(join(repoPath, 'README.md'), '# r\n', 'utf-8');
    await runGit(['add', '.'], repoPath);
    await runGit(['commit', '-m', 'seed'], repoPath);
    worktreePath = join(root, 'wt');
    await runGit(['worktree', 'add', worktreePath, '-b', 'test-branch'], repoPath);
  }, 30000);

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  }, 30000);

  it('symlinks each skill directory (link, not copy — source edits show through)', () => {
    wireOrchestratorSkills(sourceDir, worktreePath);
    const linked = join(worktreePath, '.claude', 'skills', 'continia-deploy');
    expect(lstatSync(linked).isSymbolicLink()).toBe(true);
    writeFileSync(
      join(sourceDir, 'skills', 'continia-deploy', 'SKILL.md'),
      '---\ndescription: EDITED.\n---\n',
      'utf-8',
    );
    expect(readFileSync(join(linked, 'SKILL.md'), 'utf-8')).toContain('EDITED');
  });

  it('never clobbers a skill the target repo ships itself', () => {
    const theirs = join(worktreePath, '.claude', 'skills', 'continia-deploy');
    mkdirSync(theirs, { recursive: true });
    writeFileSync(join(theirs, 'SKILL.md'), 'THEIRS\n', 'utf-8');
    wireOrchestratorSkills(sourceDir, worktreePath);
    expect(lstatSync(theirs).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(theirs, 'SKILL.md'), 'utf-8')).toBe('THEIRS\n');
  });

  it('is idempotent', () => {
    wireOrchestratorSkills(sourceDir, worktreePath);
    wireOrchestratorSkills(sourceDir, worktreePath);
    expect(lstatSync(join(worktreePath, '.claude', 'skills', 'continia-deploy')).isSymbolicLink()).toBe(true);
  });

  it('registers /.claude/ in the COMMON git dir info/exclude so links never reach a diff', async () => {
    wireOrchestratorSkills(sourceDir, worktreePath);
    // A linked worktree's own gitdir info/exclude is inert; git reads the
    // main repo's .git/info/exclude (the common dir).
    const exclude = readFileSync(join(repoPath, '.git', 'info', 'exclude'), 'utf-8');
    expect(exclude).toContain('/.claude/');
    const status = await runGit(['status', '--porcelain'], worktreePath);
    expect(status.trim()).toBe('');
  });

  it('is a no-op when the source has no skills/ dir', () => {
    wireOrchestratorSkills(join(root, 'nowhere'), worktreePath);
    expect(existsSync(join(worktreePath, '.claude'))).toBe(false);
  });
});
```

- [ ] **Step 3: Run to verify failure, then implement the service**

Run: `bun test tests/services/skill-wiring.test.ts` — FAIL (module missing). Create `src/services/skill-wiring.ts`:

```ts
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
} from 'fs';
import { join, resolve } from 'path';

/**
 * Symlink the orchestrator's own skills into a per-WI worktree's `.claude/`.
 * The Agent SDK loads `.claude/` relative to its cwd when
 * `settingSources: ['project']` is set (which every DevopsCoder stage does),
 * so this is what puts orchestrator-shipped skills in the agent's hands.
 * Symlinks, not copies: editing a skill takes effect on the next job.
 *
 * Ported from ADONewDirectCombuilder's wireSkills with two deliberate deltas:
 * only `skills/` is linked (we ship nothing else), and only DIRECTORY entries
 * are linked — 'junction' symlinks are directory-only on Windows, so file
 * entries would fail on the dev machine.
 */
export function wireOrchestratorSkills(skillsSourceDir: string, worktreePath: string): void {
  const sourceSkills = resolve(skillsSourceDir, 'skills');
  if (!existsSync(sourceSkills)) return;

  const destSkills = join(worktreePath, '.claude', 'skills');
  mkdirSync(destSkills, { recursive: true });

  for (const entry of readdirSync(sourceSkills)) {
    const sourceEntry = join(sourceSkills, entry);
    if (!statSync(sourceEntry).isDirectory()) continue;
    const dest = join(destSkills, entry);
    // Never clobber a skill the target repo ships itself — theirs wins.
    if (existsSync(dest) || isSymlink(dest)) continue;
    // 'junction' needs no admin/Developer Mode on Windows; ignored on Linux.
    // The target must be absolute for junctions — resolve() above guarantees it.
    symlinkSync(sourceEntry, dest, 'junction');
  }

  // Exclude the whole directory: whatever lands under .claude/ (links now,
  // SDK runtime files later) must never reach a commit or a PR diff. This
  // cannot hide files a repo genuinely tracks — info/exclude only affects
  // untracked files.
  addGitExclude(worktreePath, '/.claude/');
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Append one path to the repo's info/exclude, skipping if already present. */
function addGitExclude(worktree: string, pattern: string): void {
  const gitDir = resolveGitCommonDir(worktree);
  if (!gitDir) return;

  const infoDir = join(gitDir, 'info');
  mkdirSync(infoDir, { recursive: true });
  const excludeFile = join(infoDir, 'exclude');

  const existing = existsSync(excludeFile)
    ? readFileSync(excludeFile, 'utf-8').split(/\r?\n/)
    : [];
  if (existing.some((l) => l.trim() === pattern)) return;

  const header = existing.length === 0 ? '# added by DevopsCoder\n' : '';
  appendFileSync(excludeFile, `${header}${pattern}\n`, 'utf-8');
}

/**
 * Resolve the directory whose `info/exclude` git actually reads. In a linked
 * worktree `.git` is a FILE containing `gitdir: <path>`, and that per-worktree
 * gitdir is NOT where exclusions belong: git reads `info/exclude` from the
 * common dir, so anything written under `worktrees/<name>/info/` is silently
 * inert (this was a real, shipped bug in the sibling before it followed the
 * `commondir` file — mirror its fix).
 */
function resolveGitCommonDir(worktree: string): string | undefined {
  const dotGit = join(worktree, '.git');
  if (!existsSync(dotGit)) return undefined;

  let gitDir: string;
  if (lstatSync(dotGit).isDirectory()) {
    gitDir = dotGit;
  } else {
    const contents = readFileSync(dotGit, 'utf-8').trim();
    const match = /^gitdir:\s*(.+)$/.exec(contents);
    if (!match || !match[1]) return undefined;
    gitDir = resolve(worktree, match[1].trim());
  }

  const commonDirFile = join(gitDir, 'commondir');
  if (!existsSync(commonDirFile)) return gitDir;

  const commonDir = readFileSync(commonDirFile, 'utf-8').trim();
  if (commonDir === '') return gitDir;
  return resolve(gitDir, commonDir);
}
```

Run: `bun test tests/services/skill-wiring.test.ts` — PASS.

- [ ] **Step 4: Wire into worktree-setup (failing tests first)**

In `tests/pipeline/stages/worktree-setup.test.ts`: extract the `AppConfig` literal out of `makeCtx` into a shared `baseConfig` const, add `config: baseConfig` (or `config: { ...baseConfig, skillsSourceDir: … }`) to every `createWorktreeSetupStage({ … })` call, and add:

```ts
  it('wires orchestrator skills into the fresh worktree when skillsSourceDir is set', async () => {
    const wireCalls: Array<[string, string]> = [];
    const stage = createWorktreeSetupStage({
      worktreeManager: makeMgr(sampleCtx),
      config: { ...baseConfig, skillsSourceDir: '/app/.claude' },
      wireSkills: (src, wt) => { wireCalls.push([src, wt]); },
    });
    await stage.execute(makeState(), makeCtx());
    expect(wireCalls).toEqual([['/app/.claude', sampleCtx.path]]);
  });

  it('skips skill wiring when skillsSourceDir is unset', async () => {
    const wireCalls: Array<[string, string]> = [];
    const stage = createWorktreeSetupStage({
      worktreeManager: makeMgr(sampleCtx),
      config: baseConfig,
      wireSkills: (src, wt) => { wireCalls.push([src, wt]); },
    });
    await stage.execute(makeState(), makeCtx());
    expect(wireCalls).toEqual([]);
  });
```

Run to verify failure, then implement `src/pipeline/stages/worktree-setup.ts`:

```ts
import type { Stage } from '../stage.ts';
import type { WorktreeManager } from '../../services/worktree-manager.ts';
import type { AppConfig, WorktreeContext } from '../../types/index.ts';
import { wireOrchestratorSkills } from '../../services/skill-wiring.ts';

export interface WorktreeSetupDeps {
  worktreeManager: WorktreeManager;
  config: AppConfig;
  /** Test override for the skill symlinker. */
  wireSkills?: (skillsSourceDir: string, worktreePath: string) => void;
}

/**
 * Stage that ensures a per-WI git worktree exists. On first entry, creates a fresh
 * worktree branched off origin/main. On re-entry, forwards the persisted
 * `state.outputs.worktree` to the manager for state-driven reuse (so branch name
 * stays stable across slug renames; orphaned dirs get re-created).
 *
 * When `config.skillsSourceDir` is set, the orchestrator's skills are symlinked
 * into the worktree's `.claude/` (idempotent — re-runs on every entry).
 *
 * Stores the resulting `WorktreeContext` in `state.outputs.worktree`.
 */
export function createWorktreeSetupStage(deps: WorktreeSetupDeps): Stage {
  const wire = deps.wireSkills ?? wireOrchestratorSkills;
  return {
    name: 'worktree-setup',
    canRun: () => true,
    async execute(state) {
      const persisted = state.outputs.worktree as WorktreeContext | undefined;
      const ctx = await deps.worktreeManager.ensureWorktree({
        workItemId: state.workItemId,
        slug: state.slug,
        persistedWorktree: persisted,
      });
      if (deps.config.skillsSourceDir) {
        wire(deps.config.skillsSourceDir, ctx.path);
      }
      state.outputs.worktree = ctx;
      return state;
    },
  };
}
```

In `src/services/pipeline-builder.ts` (:159): `createWorktreeSetupStage({ worktreeManager, config: deps.config }),`.

- [ ] **Step 5: Run full suite + typecheck, commit**

Run: `bun test && bun run typecheck` — PASS. (Other suites that build the pipeline pass `config` already through `deps.config`; only direct `createWorktreeSetupStage` call sites need the new field — grep for `createWorktreeSetupStage(` to confirm none were missed.)

```bash
git add src/services/skill-wiring.ts src/pipeline/stages/worktree-setup.ts src/services/pipeline-builder.ts src/config/index.ts src/types/index.ts tests/
git commit -m "feat(skills): symlink orchestrator-owned skills into per-WI worktrees (SKILLS_SOURCE_DIR)"
```

---

### Task 10: Advertise orchestrator skills to the agents

**Files:**
- Modify: `src/services/skill-loader.ts` (refactor + merge)
- Modify: `src/services/pipeline-builder.ts` (default at :107-109)
- Test: `tests/services/skill-loader.test.ts`

**Interfaces:**
- Produces (in `skill-loader.ts`):
  ```ts
  export function discoverSkillsIn(skillsRoot: string): DiscoveredSkill[];       // scan any skills/ dir
  export function discoverTargetRepoSkills(targetRepoPath: string): DiscoveredSkill[]; // unchanged behavior, now delegates
  export function mergeSkills(targetRepo: DiscoveredSkill[], orchestrator: DiscoveredSkill[]): DiscoveredSkill[];
  ```
- `mergeSkills` dedupes by `name`; on collision the target repo's skill wins (mirrors the no-clobber symlink rule in Task 9).

- [ ] **Step 1: Write the failing tests**

In `tests/services/skill-loader.test.ts`:

```ts
describe('discoverSkillsIn', () => {
  it('scans an arbitrary skills root (not just <repo>/.claude/skills)', () => {
    const root = mkdtempSync(join(tmpdir(), 'skills-'));
    try {
      mkdirSync(join(root, 'my-skill'), { recursive: true });
      writeFileSync(join(root, 'my-skill', 'SKILL.md'), '---\ndescription: Does things.\n---\n', 'utf-8');
      expect(discoverSkillsIn(root)).toEqual([{ name: 'my-skill', description: 'Does things.' }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('mergeSkills', () => {
  it('unions the lists; on a name collision the target repo wins', () => {
    const merged = mergeSkills(
      [{ name: 'continia-deploy', description: 'repo version' }],
      [
        { name: 'continia-deploy', description: 'orchestrator version' },
        { name: 'continia-test', description: 'orchestrator only' },
      ],
    );
    expect(merged).toEqual([
      { name: 'continia-deploy', description: 'repo version' },
      { name: 'continia-test', description: 'orchestrator only' },
    ]);
  });
});
```

(Import `discoverSkillsIn, mergeSkills` and the fs helpers the file already uses.)

- [ ] **Step 2: Run to verify failure, then implement**

Run: `bun test tests/services/skill-loader.test.ts` — FAIL. In `src/services/skill-loader.ts`: rename the body of `discoverTargetRepoSkills` into

```ts
/** Scan a skills directory: each subdirectory containing a SKILL.md with a
 * frontmatter description is one invocable skill. */
export function discoverSkillsIn(skillsRoot: string): DiscoveredSkill[] {
  // …existing body of discoverTargetRepoSkills, with `skillsRoot` replacing
  // the joined path…
}

export function discoverTargetRepoSkills(targetRepoPath: string): DiscoveredSkill[] {
  return discoverSkillsIn(join(targetRepoPath, '.claude', 'skills'));
}

/** Union of target-repo and orchestrator-shipped skills; on a name collision
 * the target repo's skill wins (mirrors the no-clobber symlink rule). */
export function mergeSkills(
  targetRepo: DiscoveredSkill[],
  orchestrator: DiscoveredSkill[],
): DiscoveredSkill[] {
  const names = new Set(targetRepo.map((s) => s.name));
  return [...targetRepo, ...orchestrator.filter((s) => !names.has(s.name))];
}
```

In `src/services/pipeline-builder.ts` (:107-109), with `import { join } from 'path';` added:

```ts
  const discoveredSkills =
    deps.discoveredSkills ??
    mergeSkills(
      discoverTargetRepoSkills(deps.config.targetRepoPath),
      deps.config.skillsSourceDir
        ? discoverSkillsIn(join(deps.config.skillsSourceDir, 'skills'))
        : [],
    );
```

(update the skill-loader import to include `discoverSkillsIn, mergeSkills`).

- [ ] **Step 3: Run full suite + typecheck, commit**

Run: `bun test && bun run typecheck` — PASS.

```bash
git add src/services/skill-loader.ts src/services/pipeline-builder.ts tests/services/skill-loader.test.ts
git commit -m "feat(skills): advertise orchestrator skills to agents, target-repo skills win on collision"
```

---

### Task 11: `SKIP_BUILD_TEST` smoke bypass

**Files:**
- Modify: `src/config/index.ts` (boolFlag + conditional requirement), `src/types/index.ts` (`skipBuildTest: boolean`)
- Modify: `src/services/pipeline-builder.ts` (stage list :150-206)
- Modify: `src/prompts/draft-pr-description.md` (:29-30)
- Test: `tests/config/config.test.ts`, `tests/services/pipeline-builder.test.ts`, fixture sweep

**Interfaces:**
- Produces: `AppConfig.skipBuildTest: boolean` (required field — fixture sweep applies). When true: `env-provision` and `build-and-test` stages are omitted from the chain, and `CONTINIA_ENV_PROFILE_ID` / `CONTINIA_API_TOKEN` / `CONTINIA_APP_PATHS` become optional (empty-string defaults). When false (default): behavior identical to today, including the same error messages naming the missing vars.

- [ ] **Step 1: Write the failing config tests**

```ts
  describe('SKIP_BUILD_TEST', () => {
    it('defaults to false and CONTINIA_* stay required', () => {
      expect(loadConfig(validEnv).skipBuildTest).toBe(false);
      const env = { ...validEnv };
      delete env.CONTINIA_API_TOKEN;
      expect(() => loadConfig(env)).toThrow(/CONTINIA_API_TOKEN/);
    });

    it('accepts 1/true/yes/on case-insensitively', () => {
      for (const v of ['1', 'true', 'YES', 'On']) {
        expect(loadConfig({ ...validEnv, SKIP_BUILD_TEST: v }).skipBuildTest).toBe(true);
      }
      expect(loadConfig({ ...validEnv, SKIP_BUILD_TEST: '0' }).skipBuildTest).toBe(false);
    });

    it('true → the three CONTINIA_* vars become optional (harness smoke tests need no DemoPortal token)', () => {
      const env = { ...validEnv, SKIP_BUILD_TEST: 'true' };
      delete env.CONTINIA_ENV_PROFILE_ID;
      delete env.CONTINIA_API_TOKEN;
      delete env.CONTINIA_APP_PATHS;
      const config = loadConfig(env);
      expect(config.skipBuildTest).toBe(true);
      expect(config.continiaAppPaths).toEqual([]);
    });

    it('false + missing var → error names the var and the bypass', () => {
      const env = { ...validEnv };
      delete env.CONTINIA_ENV_PROFILE_ID;
      expect(() => loadConfig(env)).toThrow(/CONTINIA_ENV_PROFILE_ID.*SKIP_BUILD_TEST/);
    });
  });
```

- [ ] **Step 2: Run to verify failure, then implement the config**

In `src/config/index.ts`, above `envSchema`:

```ts
/** '1' | 'true' | 'yes' | 'on' (case-insensitive) → true; blank/unset → default. */
const boolFlag = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v.trim() === '') return defaultValue;
      return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
    });
```

Schema changes: `SKIP_BUILD_TEST: boolFlag(false),` and relax the three Continia vars to `z.string().default('')` (drop their `.min(1, …)`).

After `const p = result.data;`, add the cross-field check (before the existing splitPaths logic):

```ts
  // A harness smoke test should not need a DemoPortal token — the Continia
  // config is only required when the verification gate actually runs.
  if (!p.SKIP_BUILD_TEST) {
    const missing = (
      [
        ['CONTINIA_ENV_PROFILE_ID', p.CONTINIA_ENV_PROFILE_ID],
        ['CONTINIA_API_TOKEN', p.CONTINIA_API_TOKEN],
        ['CONTINIA_APP_PATHS', p.CONTINIA_APP_PATHS],
      ] as const
    ).filter(([, v]) => v.trim() === '');
    if (missing.length > 0) {
      throw new Error(
        `Invalid configuration:\n${missing
          .map(([k]) => `  - ${k}: required unless SKIP_BUILD_TEST=true (the verification gate uses the Continia CLI)`)
          .join('\n')}`,
      );
    }
  }
```

Guard the existing empty-paths throw with `if (!p.SKIP_BUILD_TEST && continiaAppPaths.length === 0)`. Add `skipBuildTest: p.SKIP_BUILD_TEST,` to the returned object. `src/types/index.ts`: add `/** Skip env-provision + build-and-test (harness smoke tests). */ skipBuildTest: boolean;` to `AppConfig`. Fixture sweep: `grep -rn "dryRun: false" tests/` → add `skipBuildTest: false,`.

- [ ] **Step 3: Write the failing pipeline-builder test, then implement**

In `tests/services/pipeline-builder.test.ts`, following that file's existing deps fixture:

```ts
  it('omits env-provision and build-and-test when skipBuildTest is set', () => {
    const stages = buildPipeline({ ...makeDeps(), config: { ...baseConfig, skipBuildTest: true } });
    expect(stages.map((s) => s.name)).toEqual([
      'analyzer', 'worktree-setup', 'revision-loop', 'test-author', 'draft-pr-creator', 'worktree-teardown',
    ]);
  });
```

(adapt `makeDeps()`/`baseConfig` to the file's actual helper names). Implement in `buildPipeline`'s returned array: wrap the two stages in conditional spreads —

```ts
    ...(deps.config.skipBuildTest
      ? []
      : [createEnvProvisionStage({ config: deps.config, continiaCli, logger: deps.logger })]),
```

and the same pattern around `createBuildAndTestStage({ … })`.

- [ ] **Step 4: Reword the PR template's environment sentence**

The current wording claims tests passed even when verification was skipped. In `src/prompts/draft-pr-description.md` replace lines 29-30 with (keep the `## Test environment` heading — Task 7's cap anchors on it):

```markdown
Deployed and tested on Business Central environment `{{environment-id}}`.
Manual testing: {{environment-url}} (the environment auto-deletes ~10 days after creation).
```

(When verification was skipped the substitutions render `(none)` / `(not available)`, which reads honestly.)

- [ ] **Step 5: Run full suite + typecheck, commit**

Run: `bun test && bun run typecheck` — PASS.

```bash
git add src/config/index.ts src/types/index.ts src/services/pipeline-builder.ts src/prompts/draft-pr-description.md tests/
git commit -m "feat(config): SKIP_BUILD_TEST bypass — verification stages skipped, Continia config conditionally required"
```

---

### Task 12: Docker — Linux Continia CLI, node runtime, AL compiler wiring

**Files:**
- Modify: `Dockerfile`, `.dockerignore`, `docker-compose.example.yml`

No `bun:test` coverage — verification is `docker compose build` + in-container probes (below). This task only changes deployment artifacts; source behavior is untouched.

- [ ] **Step 1: Replace the Dockerfile**

Full new content (preserves the existing claude-user/entrypoint structure, adds the sibling's runtime pieces):

```dockerfile
# syntax=docker/dockerfile:1

# Node.js 22, copied from the official image rather than installed from a
# distro repo. Bun runs this project's own code, but the Agent SDK spawns
# `node` (and npx-launched MCP servers, if configured) — without it agent
# runs fail silently inside the container.
FROM node:22-bookworm-slim AS node

FROM oven/bun:1

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && node --version && npm --version && npx --version

WORKDIR /app

# git      — target repo + worktree ops
# curl     — Claude Code installer
# libicu   — the self-contained .NET AL compiler dlopens ICU at runtime (never
#            shows in `ldd alc`); resolved by name, not pinned — the oven/bun
#            base has moved Debian releases before and a pinned libicuNN
#            breaks the build.
# libssl3 / libstdc++6 — also for the compiler toolchain.
RUN apt-get update && apt-get install -y --no-install-recommends \
        git curl bash ca-certificates libssl3 libstdc++6 \
    && apt-get install -y --no-install-recommends \
        "$(apt-cache search --names-only '^libicu[0-9]+$' | sort -V | tail -1 | cut -d' ' -f1)" \
    && rm -rf /var/lib/apt/lists/*

# Linux build of the Continia CLI. `.tools/` is gitignored — copy
# .tools/continia-linux into the build context before building (see README
# "VM Deployment"). The build fails fast here if it is missing.
COPY .tools/continia-linux /usr/local/bin/continia
RUN chmod +x /usr/local/bin/continia

# Install dependencies as root before switching user
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copy application source (includes .claude/ — those skills are symlinked
# into each per-WI worktree at runtime; see src/services/skill-wiring.ts)
COPY . .

# Create non-root user — Claude Code refuses --dangerously-skip-permissions as root
RUN useradd -m -s /bin/bash claude && \
    chown -R claude:claude /app && \
    mkdir -p /repos && \
    mkdir -p /tmp && chmod 1777 /tmp

# Install Claude Code CLI as the claude user
USER claude
RUN curl -fsSL https://claude.ai/install.sh | bash
USER root

ENV PATH="/home/claude/.local/bin:$PATH"

# CONTINIA_AUTO_INSTALL_ALC is deliberately 0: the CLI's auto-installed
# compiler resolves the wrong target-framework path (lib/net10.0 vs the
# shipped lib/net8.0) and extracts alc as mode 644. The compose file
# bind-mounts the host's AL VS Code extension at /opt/al/bin instead.
ENV CONTINIA_CLI_PATH=/usr/local/bin/continia \
    CONTINIA_ALC_PATH=/opt/al/bin/linux/alc \
    CONTINIA_AUTO_INSTALL_ALC=0 \
    SKILLS_SOURCE_DIR=/app/.claude \
    GIT_TERMINAL_PROMPT=0

# Persist state and Claude auth across restarts
VOLUME /app/.state
VOLUME /home/claude/.claude

COPY --chmod=755 entrypoint.sh /entrypoint.sh

# Start as root; entrypoint fixes volume permissions, then drops to claude user
ENTRYPOINT ["/entrypoint.sh"]
```

- [ ] **Step 2: Extend .dockerignore**

Append to the existing file:

```
.tools/continia.exe
docs/
```

(The 117 MB Windows binary must never bloat the image; `docs/` ships nothing runtime-relevant. `.claude/` must NOT be ignored — the skills ship in the image.)

- [ ] **Step 3: Extend docker-compose.example.yml**

Inside the `devops-coder` service add, after `env_file`:

```yaml
    environment:
      # env_file wins over the image's ENV — re-pin the image paths so a stray
      # var in .env.devops-coder can't silently repoint the CLI or compiler.
      CONTINIA_CLI_PATH: /usr/local/bin/continia
      CONTINIA_ALC_PATH: /opt/al/bin/linux/alc
      CONTINIA_AUTO_INSTALL_ALC: "0"
      SKILLS_SOURCE_DIR: /app/.claude
    deploy:
      resources:
        limits:
          # alc peaks ~0.6 GiB compiling the base application (measured on the
          # sibling); 2G leaves headroom for bun + git.
          memory: 2g
    logging:
      driver: json-file
      options:
        max-size: 20m
        max-file: "5"
```

And under `volumes:` of the service, after the worktrees mount:

```yaml
      # AL compiler — read-only bind mount of the host's AL VS Code extension
      # bin dir (contains linux/alc). Required by `continia deploy`; the CLI's
      # auto-install path is broken upstream (see Dockerfile).
      - ${HOME}/tools/al/al-ext/extension/bin:/opt/al/bin:ro
```

Also add a comment line in the header block noting that `.env.devops-coder` must now define `CONTINIA_ENV_PROFILE_ID`, `CONTINIA_API_TOKEN`, `CONTINIA_APP_PATHS` (or `SKIP_BUILD_TEST=true` for a smoke bring-up).

- [ ] **Step 4: Verify the build (requires `.tools/continia-linux` in the context and Docker locally; otherwise mark for VM bring-up)**

```bash
docker compose -f docker-compose.example.yml build 2>&1 | tail -5          # or docker build .
docker compose run --rm --entrypoint /usr/local/bin/continia devops-coder env list --json   # fails in seconds if the CLI/token is broken, not 40 min into a verify
docker compose run --rm --entrypoint node devops-coder --version
docker compose run --rm --entrypoint /opt/al/bin/linux/alc devops-coder /? | head -2         # AL compiler through the mount
```

Note: `--entrypoint` is required for probes because the image's entrypoint always execs the watcher.

- [ ] **Step 5: Commit**

```bash
git add Dockerfile .dockerignore docker-compose.example.yml
git commit -m "feat(docker): Linux continia CLI, node runtime, libicu, AL-compiler mount — container can verify"
```

---

### Task 13: Docs sweep

**Files:**
- Modify: `README.md`, `.env.example`, `CLAUDE.md`

- [ ] **Step 1: README fixes**

- Layout section (~:39-58): remove `checkpoint.ts` (deleted); add `env-provision`, `build-and-test` to the stage list; add `continia-cli.ts`, `skill-wiring.ts` to services; `al-test-discovery.ts`, `git-auth.ts` to utils; `test-fixer.md` to prompts.
- Fix the stage-timeout count claim (~:7): there are now 11 `STAGE_TIMEOUT_MS_*` env vars (ANALYZER, WORKTREE_SETUP, CODER, REVIEWER, REVISION_LOOP, ENV_PROVISION, VERIFY_PASS, BUILD_AND_TEST, TEST_AUTHOR, DRAFT_PR_CREATOR, WORKTREE_TEARDOWN).
- Fix any "Plans 1–8 done" claim (~:57) → milestone-11.
- VM Deployment section: add a numbered step "copy `.tools/continia-linux` into the repo checkout on the VM before `docker compose build` (the file is gitignored; get it from the Continia CLI release share or from `ADONewDirectCombuilder/.tools/`)"; document the `/opt/al/bin` mount and the three `CONTINIA_*` env vars + `SKIP_BUILD_TEST` smoke path; document the probe commands from Task 12 Step 4.
- Environment-variables table: add `CONTINIA_TEST_TIMEOUT_S`, `SKILLS_SOURCE_DIR`, `SKIP_BUILD_TEST`, and the CLI passthrough vars `CONTINIA_ALC_PATH` / `CONTINIA_AUTO_INSTALL_ALC` (read by the spawned CLI, not by the Zod schema).

- [ ] **Step 2: .env.example additions**

Add to the optional block (~:36-40):

```
# Optional: Max agent turns for the coder / test-author stages (defaults: 80 / 50)
# CODER_MAX_TURNS=80
# TEST_AUTHOR_MAX_TURNS=50
```

In the Plan-10 block: note beside `STAGE_TIMEOUT_MS_VERIFY_PASS` that it only sizes the derived `build-and-test` stage budget, and add:

```
# Optional: --timeout (seconds) for each `continia test run` (default: 600).
# CONTINIA_TEST_TIMEOUT_S=600

# Optional: skip env-provision + build-and-test entirely (harness smoke tests).
# When true, the three CONTINIA_* vars above become optional.
# SKIP_BUILD_TEST=false

# Optional: dir containing an orchestrator-owned skills/ tree to symlink into
# each worktree's .claude/ (the Docker image sets /app/.claude). Unset locally
# unless you want this repo's .claude/skills available to the agents.
# SKILLS_SOURCE_DIR=/app/.claude

# Read by the spawned Continia CLI itself (not validated by this service):
# CONTINIA_ALC_PATH=/opt/al/bin/linux/alc
# CONTINIA_AUTO_INSTALL_ALC=0
```

- [ ] **Step 3: CLAUDE.md**

Append a Plan 11 paragraph to the Project Overview (after the Plan 10 paragraph), covering: corrected deploy invocation (`--workspace-root`/`--allow-downgrade`, no `--with-deps`), activation-app install, strict test-result schema, `CONTINIA_TEST_TIMEOUT_S`, WI-linked draft PRs + 4000-char description cap, per-invocation PAT auth with redaction (`src/utils/git-auth.ts`) + `--force-with-lease` push, orchestrator skill symlinking (`SKILLS_SOURCE_DIR`, `src/services/skill-wiring.ts`, target-repo skills win), `SKIP_BUILD_TEST` bypass, and the Docker changes (continia-linux on PATH, `/opt/al/bin` mount, `CONTINIA_AUTO_INSTALL_ALC=0`). Update the 8-stage-chain sentence if `SKIP_BUILD_TEST` wording fits better as "8-stage chain (6 when SKIP_BUILD_TEST=true)".

- [ ] **Step 4: Verify and commit**

Run: `bun test && bun run typecheck` (unchanged code, but cheap). Grep for stale claims: `grep -rn "checkpoint.ts\|with-deps\|Plans 1-8\|7 configurable" README.md CLAUDE.md .env.example` → zero hits expected (except intentional "no --with-deps" phrasing).

```bash
git add README.md .env.example CLAUDE.md
git commit -m "docs: plan-11 parity — deployment steps, new env vars, corrected stage/timeout inventory"
```

---

## Self-Review (performed at authoring time)

- **Coverage vs findings:** finding 1 → Task 1; 2+3 → Task 3; 4 → Task 1; 5 → Task 2; 6 → Task 8; 7 → Tasks 6+7; 8 → Tasks 9+10; 9 → Task 12; 10 → Task 11; docs drift → Task 13. The sibling's `STAGE_TIMEOUT_MS_VERIFY_PASS`-style dead-knob issue → Task 4.
- **Type consistency:** `DepsInstallInfo`/`installAppById` defined in Task 3 and consumed only there; `continiaTestTimeoutS` (Task 4), `skillsSourceDir` (Task 9), `skipBuildTest` (Task 11) each added to `AppConfig` in the task that first uses them; `buildGitAuthArgs`/`redactPat` defined and consumed within Task 8; `discoverSkillsIn`/`mergeSkills` defined in Task 10 before use; `capPrDescription`'s `## Test environment` anchor is kept verbatim by Task 11's template edit.
- **Known deviations executors may hit:** exact fixture/helper names in `tests/sdk/azure-devops-client.test.ts` and `tests/services/pipeline-builder.test.ts` (both instructed to adapt to the file's existing pattern); the Task 12 build verification needs Docker + the `continia-linux` binary and may be deferred to VM bring-up — everything else is fully verifiable with `bun test` on the dev machine.
