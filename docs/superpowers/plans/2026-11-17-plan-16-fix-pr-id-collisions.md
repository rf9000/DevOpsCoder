# Plan 16 — `fix-pr`: renumber AL object ID collisions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After `fix-pr` rebases a PR, detect AL object IDs that the PR introduced and that collide with an object on the target branch. Give only the PR's object a new ID, reserved through Object ID Ninja. Commit that as one separate bot commit. Show real AL compile errors when verification still fails.

**Architecture:** A new deterministic stage, `renumber-collisions`, runs between `rebase-onto-target` and `env-provision`. It makes no LLM call.
- A pure scanner finds object declarations and collisions.
- `PrFixGit` gains the reads and the commit it needs.
- A small MCP client (`NinjaClient`) starts `@vjeko.com/al-object-id-ninja-mcp` over stdio and calls its `ninja_assignObjectId` / `ninja_unassignObjectId` tools.
- IDs reserved in a run that ends without a push are released again.

**Tech Stack:** Bun, TypeScript, Zod, `@modelcontextprotocol/sdk` (client + `InMemoryTransport` for tests), git CLI.

**Spec:** No separate spec doc. The decisions were made in conversation on 2026-11-16/17 and recorded in memory as `project-pr-fixer-pipeline`:
- Renumber **only objects coming from the PR branch**.
- Get the new ID from **Object ID Ninja**, not from a repo scan.
- Land it as a **separate commit** on top. Never amend the PR's commits.

Motivating case: PR 61400's `PontoFeature.Codeunit.al` declares codeunit 72918753. Main's PR 61281 had already added `ExportFileHash.Codeunit.al` with the same ID. That caused `AL0264` and `verification-failed`, and the error was visible only in `.state/prfix/61400.json`. Builds on Plan 15 (`docs/superpowers/plans/2026-11-16-plan-15-fix-pr-rebase.md`).

## Global Constraints

**What gets renumbered**
- Only a declaration the **PR introduced** is ever renumbered. "PR-introduced" means the `(type, id)` declared in a file at `HEAD` that the same path did not declare at `targetSha` (the file was added, or its declaration line was changed).
- Collision scope is **one AL app**: the directory holding the `app.json`. Two declarations collide when they have the same lowercase object type and the same ID within one app. `external/**` is never scanned.
- Object types scanned: `table`, `tableextension`, `page`, `pageextension`, `codeunit`, `report`, `reportextension`, `query`, `xmlport`, `enum`, `enumextension`, `permissionset`, `permissionsetextension`. Field IDs and enum value IDs are out of scope.

**When to refuse instead of renumbering**
- A collision group with **exactly one** PR-introduced declaration is renumbered.
- Any other group throws `IdCollisionError`, which maps to the new status `id-collision`:
  - all members are PR-introduced, or none are;
  - two or more members are PR-introduced.

**What a renumber changes**
- It edits the object's declaration line. It also replaces every whole-word occurrence (`\b<oldId>\b`) of the old ID in files the PR **added**.
- If a file the PR **modified** but did not add contains the old ID as a whole word, throw `IdCollisionError`. The reference is ambiguous and nothing is edited.

**Getting the new ID**
- New IDs come only from `ninja_assignObjectId` with `{ objectType, targetFilePath: <absolute path of the renumbered .al file> }`.
- The returned ID must lie inside the app's `app.json` `idRanges` and must not be declared for that type anywhere in the app at `HEAD`.
  - On a violation, ask again, up to `NINJA_MAX_ASSIGN_ATTEMPTS = 5` times. Never unassign an ID that turned out to be in use.
  - After 5 attempts, throw `Error('ninja: no usable <type> ID for <file>')`.

**Releasing IDs**
- IDs reserved in a run are released with `ninja_unassignObjectId` when the run ends **without a push**: any failure, cancel, or `--dry-run`.
- A run that pushed keeps them.
- A release failure only logs a warning.

**The commit**
- All renumbers of one run land as **one** commit, committed with the bot identity (`BOT_GIT_NAME`/`BOT_GIT_EMAIL`), author the same.
- Message, exactly: `fix: renumber AL object IDs that collide with <target branch short name>`. Its body has one line per renumber: `<type> <name> <oldId> -> <newId> (<path>)`.

**Configuration**
- `PRFIX_RENUMBER_COLLISIONS`: default `true`. When `false` the stage is a no-op.
- `NINJA_MCP_COMMAND`: default `npx -y @vjeko.com/al-object-id-ninja-mcp`. It is split on whitespace into command and args. On `win32` it is prefixed with `cmd /c`.
- `NINJA_CALL_TIMEOUT_MS`: default `60000`, per tool call.
- The Ninja server is started lazily: only when there is at least one collision to renumber. A run with no collisions spawns nothing.

**Surfacing AL errors**
- On `verification-failed`, the outcome `error` and the PR failure comment carry up to `10` lines matching `/: error AL\d{4}:/` taken from the failed deploy rows. The surrounding comment text is unchanged.

## Review Focus

1. **Ninja hands out an ID already used in the repo** (its backend was never synced for this app). Expected: the ID is rejected, another is requested, and nothing collides. Pinned in Task 4 (`retries when Ninja returns an ID declared in the app`).
2. **Dry run.** A dry run must not leak reservations. Expected: every ID reserved is unassigned at the end. Pinned in Task 5 (`dry run releases reserved IDs`).
3. **The PR changed an existing object's ID line to a colliding ID** (not a new file). Expected: that counts as PR-introduced and gets renumbered. Pinned in Task 1 (`modified declaration line counts as PR-introduced`).
4. **CRLF files and a BOM before `codeunit 123 "X"`.** Expected: the declaration is still found, and the rewritten file keeps its line endings and BOM byte-for-byte except the ID. Pinned in Task 1 (`parses a BOM + CRLF declaration`) and Task 4 (`renumber keeps CRLF and BOM`).
5. **Ninja server cannot start** (no `npx`, no network). Expected: status `error` with a message naming `NINJA_MCP_COMMAND`, nothing committed, and the rebase result untouched for inspection. Pinned in Task 3 (`connect failure names the command`).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/prfix/al-objects.ts` (create) | parse AL object declarations; find collision groups; decide what to renumber |
| `src/prfix/ninja.ts` (create) | MCP stdio client for the two Ninja tools; parse the assigned ID |
| `src/prfix/prfix-git.ts` (modify) | `changedFiles`, `showFileAtRef`, `commitAll` |
| `src/prfix/stages.ts` (modify) | `createRenumberStage` |
| `src/prfix/types.ts` (modify) | `RenumberedObject`, `IdCollisionError`, status `id-collision`, outcome `renumbered` |
| `src/prfix/config.ts` (modify) | the three knobs |
| `src/prfix/fix-pr.ts` (modify) | release on no-push; outcome; AL error lines |
| `src/prfix/comment.ts` (modify) | renumber section; AL error lines |
| `src/services/pipeline-builder.ts`, `src/cli/index.ts` (modify) | wiring |
| `package.json` (modify) | `@modelcontextprotocol/sdk` as a direct dependency, pinned to the installed `1.29.0` |
| `README.md`, `CLAUDE.md`, `.env.example` (modify) | docs |

---

### Task 1: AL object scanner and collision decision

**Files:**
- Create: `src/prfix/al-objects.ts`
- Test: `tests/prfix/al-objects.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const AL_OBJECT_TYPES: readonly string[]; // the 13 lowercase types from Global Constraints
  export interface AlDeclaration { type: string; id: number; name: string; file: string /* repo-relative, forward slashes */; app: string /* repo-relative app dir */ }
  /** First object declaration in an .al file's text, or null. Tolerates BOM, CRLF, leading comments/blank lines, quoted or bare names, `extends`/`implements` tails. */
  export function parseDeclaration(text: string): { type: string; id: number; name: string } | null;
  export interface CollisionGroup { app: string; type: string; id: number; members: AlDeclaration[] }
  export function findCollisions(decls: AlDeclaration[]): CollisionGroup[];
  export interface RenumberPlan { target: AlDeclaration; keep: AlDeclaration[] }
  /** One plan per group with exactly one PR-introduced member; throws IdCollisionError (Task 2 type, import from ./types.ts) listing every group that does not qualify. */
  export function planRenumbers(groups: CollisionGroup[], isPrIntroduced: (d: AlDeclaration) => boolean): RenumberPlan[];
  ```
  `IdCollisionError` lives in `src/prfix/types.ts`, and this task adds it there: `class IdCollisionError extends Error { constructor(readonly groups: CollisionGroup[], reason: string) }`, `name = 'IdCollisionError'`. Import `CollisionGroup` as a type from `al-objects.ts` to avoid a value cycle.

- [ ] **Step 1: Write failing tests.**
  - `parseDeclaration`:
    - `codeunit 72918753 "CTS-CB Ponto Feature" implements "X"` → `{type:'codeunit', id:72918753, name:'CTS-CB Ponto Feature'}`.
    - `tableextension 71553600 "A" extends "Customer"` → type `tableextension`.
    - `parses a BOM + CRLF declaration`: `'﻿// c\r\n\r\npage 5 MyPage\r\n{'` → `{type:'page', id:5, name:'MyPage'}`.
    - Text without a declaration → `null`.
    - `Codeunit.Run(5)` inside a procedure body is not a declaration → `null` (only a line-start keyword counts).
  - `findCollisions`:
    - Same type and id in the same app → one group with 2 members.
    - Same id but different type → no group.
    - Same type and id in different apps → no group.
  - `planRenumbers`:
    - One PR-introduced plus one target member → plan with `target` = the PR member.
    - Two PR-introduced → throws `IdCollisionError`.
    - None PR-introduced → throws `IdCollisionError`.
    - `modified declaration line counts as PR-introduced`: the predicate is the caller's, so assert that `planRenumbers` uses only the predicate. Pass a member whose file existed at the target and get it as `target`.
- [ ] **Step 2: Run** `bun test tests/prfix/al-objects.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement.** Use `parseDeclaration` with a multiline regex anchored at line start, case-insensitive on the keyword, and output the type lowercased: `^\s*(table|tableextension|…)\s+(\d+)\s+("[^"]+"|[A-Za-z_][\w]*)` with the `m` and `i` flags. Strip quotes from the name. The 13 types come from `AL_OBJECT_TYPES`; build the alternation from it with the longer names first.
- [ ] **Step 4: Run** `bun test tests/prfix/al-objects.test.ts && bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: AL object declaration scanner and collision planning for fix-pr`

---

### Task 2: `PrFixGit` additions

**Files:**
- Modify: `src/prfix/prfix-git.ts`
- Test: `tests/prfix/prfix-git.test.ts` (real git sandbox, as existing)

**Interfaces:**
- Produces, as additions to `PrFixGit`:
  ```ts
  /** `git diff --name-status -z --no-renames <from> HEAD`: repo-relative paths with A|M|D. */
  changedFiles(path: string, from: string): Promise<{ status: 'A' | 'M' | 'D'; file: string }[]>;
  /** `git show <ref>:<file>`; null when the path does not exist at ref. Returns raw text (no newline normalisation). */
  showFileAtRef(path: string, ref: string, file: string): Promise<string | null>;
  /** `git ls-files -z -- <pathspec>` at HEAD, repo-relative, forward slashes (e.g. pathspec `*.al`). */
  listFiles(path: string, pathspec: string): Promise<string[]>;
  /** Stage exactly `files` (`git add -- <files>`) and commit them with the bot identity as author AND committer; returns the new sha. Throws if nothing is staged. */
  commitFiles(path: string, files: string[], message: string): Promise<string>;
  ```
- [ ] **Step 1: Write failing tests.**
  - `changedFiles lists A and M against the target`.
  - `listFiles returns tracked .al files only`.
  - `showFileAtRef returns null for a path added after ref`.
  - `showFileAtRef preserves CRLF`: write a file with `\r\n` using `core.autocrlf=false` in the sandbox, and check the returned text contains `\r\n`.
  - `commitFiles commits only the listed files with the bot as author and committer`: `%an` and `%cn` both equal `BOT_GIT_NAME`. An unlisted dirty file stays unstaged.
  - `commitFiles throws when nothing changed`.
- [ ] **Step 2: Run** `bun test tests/prfix/prfix-git.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** with the existing `runGit`. For `commitFiles`:
  - Pass `-c user.name -c user.email` and `--author="<name> <email>"`.
  - Check `diff --cached --quiet` before committing.
  - Use `-c core.autocrlf=false` on `show` so the bytes round-trip.
- [ ] **Step 4: Run** `bun test tests/prfix/prfix-git.test.ts && bun run typecheck`. Expected: PASS. If the whole file exceeds the 120s tool timeout, run it in the background.
- [ ] **Step 5: Commit** `feat: PrFixGit changedFiles, showFileAtRef and commitFiles`

---

### Task 3: Ninja MCP client

**Files:**
- Create: `src/prfix/ninja.ts`
- Modify: `package.json` (`"@modelcontextprotocol/sdk": "1.29.0"` in `dependencies`), `src/prfix/config.ts` (the three knobs), `tests/prfix/config.test.ts`
- Test: `tests/prfix/ninja.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const NINJA_MAX_ASSIGN_ATTEMPTS = 5;
  export interface NinjaClient {
    assign(objectType: string, targetFilePath: string): Promise<number>;
    unassign(objectType: string, objectId: number, targetFilePath: string): Promise<void>;
    close(): Promise<void>;
  }
  /** Parse an assign tool result: structuredContent.id / .objectId if numeric, else the single integer of >= 5 digits in the text content. Throws if none or several. */
  export function parseAssignedId(result: { content?: { type: string; text?: string }[]; structuredContent?: unknown; isError?: boolean }): number;
  export function createNinjaClient(opts: { command: string; args: string[]; timeoutMs: number; transport?: Transport /* test seam */ }): NinjaClient;
  ```
  - `PrFixConfig` gains `renumberCollisions: boolean` (`PRFIX_RENUMBER_COLLISIONS`, default `true`), `ninjaCommand: { command: string; args: string[] }` (`NINJA_MCP_COMMAND` split on whitespace, `cmd /c` prefixed on `win32`) and `ninjaCallTimeoutMs: number` (`NINJA_CALL_TIMEOUT_MS`, default `60000`).
  - The client connects lazily on the first call and tool names are exactly `ninja_assignObjectId` / `ninja_unassignObjectId`.
  - A result with `isError: true` throws `Error('ninja: ' + <text>)`. A connect failure throws `Error('ninja: could not start "<command args>" (NINJA_MCP_COMMAND): <cause>')`.
- [ ] **Step 1: Write failing tests**, using `InMemoryTransport.createLinkedPair()` from `@modelcontextprotocol/sdk/inMemory.js` and an in-test `McpServer` that registers fake tools:
  - `assign calls ninja_assignObjectId with objectType and targetFilePath and returns the id`. The fake returns text `Assigned codeunit ID 72918790`, and the client returns `72918790`.
  - `parseAssignedId prefers structuredContent.id`.
  - `parseAssignedId throws on two candidate integers`.
  - `isError result throws with the server text`.
  - `unassign passes objectId`.
  - `does not connect until the first call`. A transport spy has seen no `start()` after construction.
  - `connect failure names the command`. Use a nonexistent command with no transport override. The error message contains `NINJA_MCP_COMMAND` and the command.
  - Config tests:
    - The defaults.
    - The `win32` prefix (call the split helper with an explicit platform argument).
    - `PRFIX_RENUMBER_COLLISIONS=false`.
- [ ] **Step 2: Run** `bun test tests/prfix/ninja.test.ts tests/prfix/config.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Use `Client` + `StdioClientTransport` from the SDK. Each `callTool` races a `timeoutMs` timer that rejects with `Error('ninja: <tool> timed out after <ms> ms')`. `close()` is a no-op when the client never connected. Run `bun install` after the `package.json` change.
- [ ] **Step 4: Run** `bun test tests/prfix/ninja.test.ts tests/prfix/config.test.ts && bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: Object ID Ninja MCP client for fix-pr`

---

### Task 4: `renumber-collisions` stage

**Files:**
- Modify: `src/prfix/stages.ts` (`createRenumberStage`), `src/prfix/types.ts`
- Test: `tests/prfix/renumber-stage.test.ts`

**Interfaces:**
- Consumes: Task 1 (`parseDeclaration`, `findCollisions`, `planRenumbers`, `AlDeclaration`); Task 2 (`changedFiles`, `showFileAtRef`, `commitFiles`, `headSha`); Task 3 (`NinjaClient`, `NINJA_MAX_ASSIGN_ATTEMPTS`); `PrFixConfig.renumberCollisions`; `state.outputs.worktree` (`WorktreeContext & { targetSha }`) and `state.outputs.prFixInput.pr.targetRefName`.
- Produces:
  ```ts
  // types.ts
  export interface RenumberedObject { type: string; name: string; file: string; app: string; oldId: number; newId: number }
  export interface RenumberOutput { commit: string | null; renumbered: RenumberedObject[]; reserved: { type: string; id: number; file: string /* absolute */ }[] }
  // PrFixStatus gains 'id-collision'; PrFixOutcome gains renumbered: RenumberedObject[]
  // stages.ts
  export function createRenumberStage(deps: { git: PrFixGit; prfix: PrFixConfig; ninja: () => NinjaClient /* lazy factory */ }): Stage; // name 'renumber-collisions', costFree
  ```
  - The stage writes `state.outputs.renumber: RenumberOutput`.
  - It pushes each successful `assign` onto `reserved` **immediately**, before validation, so Task 5 can release it even if the stage then throws.
  - It always calls `ninja.close()` in `finally` if the factory was invoked.
  - It reports `ctx.reportProgress?.('renumber N/M')`.

**Algorithm** (the step the signatures leave open):
1. Find the app directories: every `app.json` under the worktree, excluding `external/**` and `.alpackages`.
2. List all `.al` files with `git.listFiles(path, '*.al')`, excluding `external/**`. Read each at HEAD from the worktree and map it to its app, the deepest `app.json` dir that is a prefix.
3. Compute `decls` and `findCollisions`. If there are none, write `{ commit: null, renumbered: [], reserved: [] }` and return **without calling the factory**.
4. Find PR-introduced declarations: take `changedFiles(targetSha)` with status A or M. A declaration is PR-introduced when `showFileAtRef(targetSha, file)` is null, or when it parses to a different `(type, id)`.
5. `planRenumbers` (it throws `IdCollisionError`). For each plan, check the ambiguity rule for M files (Global Constraints), then assign:
   - Loop up to `NINJA_MAX_ASSIGN_ATTEMPTS`.
   - Accept the ID only if it is inside the app's `idRanges` and not declared for that type in the app.
6. Rewrite the declaration with an exact byte-preserving replace of the first `\b<oldId>\b` on the declaration line. Rewrite whole-word occurrences in PR-added files.
7. `commitFiles(touched, message)`. The message is per Global Constraints, with the short target name from `targetRefName` minus `refs/heads/`.

- [ ] **Step 1: Write failing tests** (fake `PrFixGit` over an in-memory file map, fake `NinjaClient`):
  - `no collisions: no Ninja factory call, no commit`.
  - `renumbers only the PR-added codeunit and commits once`:
    - Fixture: main's `ExportFileHash` and the PR-added `PontoFeature`, both codeunit `72918753`, in app `base-application` with `idRanges` covering `72918625–72918824`.
    - Ninja returns `72918790`.
    - Expect the PontoFeature declaration to now read `72918790` and ExportFileHash to be unchanged.
    - Expect `commitFiles` called once with the message `fix: renumber AL object IDs that collide with main` and the body line `codeunit CTS-CB Ponto Feature 72918753 -> 72918790 (base-application/…/PontoFeature.Codeunit.al)`.
  - `retries when Ninja returns an ID declared in the app`: the first assign returns an existing ID and the second a free one. Both appear in `reserved`. The final ID is the second.
  - `rejects an ID outside idRanges and retries`.
  - `gives up after NINJA_MAX_ASSIGN_ATTEMPTS`: throws `ninja: no usable codeunit ID for …`.
  - `both members PR-introduced → IdCollisionError, no Ninja call`.
  - `old ID in a PR-modified file → IdCollisionError`.
  - `replaces the old ID in other PR-added files` (e.g. a PR-added permission set line `codeunit 72918753 = X`).
  - `renumber keeps CRLF and BOM`: the rewritten bytes equal the input with only the digits changed.
  - `renumberCollisions=false: no-op`.
  - `reserved is recorded before a later failure`: Ninja returns OK, then `commitFiles` throws. `state.outputs.renumber.reserved` has the ID.
  - `closes the Ninja client when it was created`.
- [ ] **Step 2: Run** `bun test tests/prfix/renumber-stage.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** per the algorithm.
- [ ] **Step 4: Run** `bun test tests/prfix/renumber-stage.test.ts tests/prfix/stages.test.ts && bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: renumber-collisions stage reserves IDs via Object ID Ninja`

---

### Task 5: Wiring, release, AL errors, docs

**Files:**
- Modify: `src/services/pipeline-builder.ts`, `src/cli/index.ts`, `src/prfix/fix-pr.ts`, `src/prfix/comment.ts`, `README.md`, `CLAUDE.md`, `.env.example`
- Test: `tests/prfix/fix-pr.test.ts`, `tests/prfix/comment.test.ts`, `tests/services/pipeline-builder.test.ts`

**Interfaces:**
- Consumes: `createRenumberStage`, `createNinjaClient`, `RenumberOutput`, `IdCollisionError`, `PrFixConfig` knobs, `VerificationOutput.deploy[].error`.
- Produces:
  - `buildPrFixPipeline` order: `pr-intake, pr-worktree, rebase-onto-target, renumber-collisions, [env-provision, build-and-test], push-rebased, pr-comment`.
  - `PrFixPipelineDeps` gains `ninja?: () => NinjaClient`. The default builds `createNinjaClient` from `prfix.ninjaCommand` and `prfix.ninjaCallTimeoutMs` once and memoises it.
  - `fix-pr.ts`:
    - `statusOf` maps `IdCollisionError` to `'id-collision'`.
    - The outcome gains `renumbered` (from `outputs.renumber.renumbered`, else `[]`).
    - `export function alErrorLines(verification: VerificationOutput | undefined, max = 10): string[]`.
    - On `verification-failed`, the outcome `error` becomes `<existing message>\n<lines joined by \n>`.
    - In cleanup, when `outputs.pushed !== true`, call `ninja.unassign` for every `outputs.renumber.reserved` entry. That covers dry run, failure and cancel. Each call is best-effort with a warning. Close the client after.
  - `comment.ts`:
    - The success comment gains a `### Renumbered object IDs` section listing `<type> <name>: <oldId> → <newId>` when `renumbered` is non-empty.
    - The failure comment for `verification-failed` lists the AL error lines in a fenced block.
    - `id-collision` gets the heading "Object ID collision needs a manual fix" and lists each group's members.

- [ ] **Step 1: Write failing tests.**
  - `fix-pr.test.ts`:
    - `IdCollisionError maps to id-collision`.
    - `dry run releases reserved IDs`: a fake stage writes `renumber.reserved` with two entries and the run is a dry run. `unassign` is called twice and `close` once.
    - `failure before push releases reserved IDs`.
    - `pushed run keeps reserved IDs`: `outputs.pushed = true`, so no `unassign` call.
    - `unassign failure only warns`.
    - `verification-failed outcome error carries AL error lines`: a deploy row error containing two `: error AL0264:` lines and noise `info AL0749` lines. Only the two error lines are appended.
    - `outcome carries renumbered`.
  - `comment.test.ts`:
    - The renumber section renders.
    - The AL error block renders.
    - The `id-collision` heading.
  - `pipeline-builder.test.ts`: the stage order with and without `SKIP_BUILD_TEST`, with `renumber-collisions` after `rebase-onto-target`.
- [ ] **Step 2: Run** `bun test tests/prfix/fix-pr.test.ts tests/prfix/comment.test.ts tests/services/pipeline-builder.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** In the CLI, pass nothing new; the builder default creates the client from config.
- [ ] **Step 4: Docs.**
  - README fix-pr section:
    - The stage.
    - The rules: PR-introduced only, the refusal cases, the separate commit.
    - The `id-collision` status and the release behaviour.
    - The three knobs.
    - The VM requirement: `npx` (present in the image), plus outbound HTTPS to the Ninja backend.
    - That `.objidconfig` must be committed per app.
  - `.env.example`: the three knobs, commented, in the fix-pr block.
  - `CLAUDE.md`: two or three sentences appended to the fix-pr paragraph.
- [ ] **Step 5: Run** `bun run typecheck` and `bun test tests/prfix tests/services/pipeline-builder.test.ts`, running files individually if the directory times out. Expected: PASS.
- [ ] **Step 6: Commit** `feat: wire renumber-collisions into fix-pr; release unused IDs; show AL errors`
- [ ] **Step 7: Smoke (controller, with the user).** Every run starts fresh, and the next run removes the kept `prfix-61400` worktree. Run `bun run src/cli/index.ts fix-pr 61400 --dry-run`.
  - Expected outcome: `renumbered` holds `PontoFeature 72918753 -> <new>`, and status is `rebased`, or `verification-failed` with real AL error lines if something else is wrong.
  - Expected log: the reserved ID was unassigned at the end of the dry run.
