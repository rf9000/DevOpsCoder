# Plan 15 — `fix-pr`: rebase a PR branch onto its target Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A manual `fix-pr <prId>` command that rebases an existing PR's source branch onto its target branch, resolves rebase conflicts with a capped LLM step, verifies the result on DemoPortal, pushes with `--force-with-lease`, and comments on the PR.

**Architecture:** A second pipeline in this repo, built the way `apply-suggestions` is: its own stage list run by the existing `runPipeline`, its own git wrapper (`PrFixGit`, modelled on `SuggestionGit`), its own state directory (`.state/prfix/`), and a JSON outcome on the last stdout line. It reuses `env-provision` and `build-and-test` unchanged for verification, with the test-fix loop switched off: phase 1 only rebases and never changes what the PR does. A clean rebase makes no LLM call.

**Tech Stack:** Bun, TypeScript, Zod, `@anthropic-ai/claude-agent-sdk` (through `AgentRunner`), git CLI, Azure DevOps REST 7.1, Continia CLI.

**Spec:** No separate spec doc. The design was settled in conversation on 2026-11-16 and recorded in memory as `project-pr-fixer-pipeline`. The decisions this plan implements:
- Lives in DevOpsCoder as a second pipeline, not as a new agent.
- Conflicts with the target branch are fixed by **rebase onto the target + `--force-with-lease`**, never by merging main into the PR branch.
- Started manually on one PR. May touch any PR, so there is no author check. The initial use is the user's own PRs.
- Phase 1 = rebase only. Phases 2 (unresolved comments) and 3 (failed pipeline runs) are later plans.

## Global Constraints

- Command: `bun run src/cli/index.ts fix-pr <prId> [--dry-run] [--keep-env]`.
- Rebase target = the PR's `targetRefName`, not hard-coded `main`.
- Push only with `--force-with-lease=refs/heads/<source>:<pre-rebase head sha>`. Never use a plain `--force`. If the lease is rejected, the run stops with outcome `head-moved` and does not refetch or retry.
- Commit authors are preserved. The committer identity is `BOT_GIT_NAME` / `BOT_GIT_EMAIL`, passed as `-c user.name=… -c user.email=…` per call. Both are required.
- Commits are never squashed, reworded or reordered. Commits that become empty are dropped (`--empty=drop`).
- Conflict caps: `PRFIX_MAX_CONFLICT_COMMITS` (default `3`) commits that stop with conflicts, and `PRFIX_MAX_CONFLICT_FILES` (default `10`) conflicted files in any one commit. Exceeding either aborts the rebase before any further LLM call.
- The resolver is a new model step `rebase-resolver`: `CLAUDE_MODEL_REBASE_RESOLVER` / `CLAUDE_EFFORT_REBASE_RESOLVER`, cost key `rebase-resolver`, max turns `REBASE_RESOLVER_MAX_TURNS` (default `40`).
- The resolver may not run git commands that change state. It only edits files. The pipeline code stages files and runs `git rebase --continue`.
- `build-and-test` runs with `maxTestFixAttempts = 0`. Red means no push. `SKIP_BUILD_TEST=true` skips verification, and the PR comment states it is unverified.
- State lives in `join(config.stateDir, 'prfix')`, so a PR id never collides with a WI id in `.state/`. Every run starts fresh; there is no resume.
- The DemoPortal environment is deleted at the end of the run unless `--keep-env` is passed. The closed-PR sweep never sees `.state/prfix/`.
- The cost cap is `MAX_COST_USD_PER_WI`, checked before every resolver call.
- `--dry-run` runs everything except the push and the PR comments. The environment is still created and still deleted at the end (unless `--keep-env`), so a dry run leaks nothing.
- Every git error text goes through `redactPat` before it reaches a log, the outcome or a PR comment.

## Review Focus

1. **Source branch moves during the run** (the author pushes while the agent works). Expected: the lease rejects the push, outcome `head-moved`, the remote branch is untouched. Pinned in Task 3 (`push rejects when the remote moved`).
2. **The resolver leaves conflict markers or never touches a file.** Expected: the pipeline refuses to `--continue`, aborts the rebase and reports `unresolved-conflict`. Pinned in Task 4 (`refuses to continue while markers remain`).
3. **The PR is already up to date with its target.** Expected: nothing is rebased, pushed or provisioned. Outcome `up-to-date`, cost 0. Pinned in Task 3 (`isUpToDate`) and Task 6 (`up-to-date skips every later stage`).
4. **A PR commit becomes empty after rebase** (its change already landed on main). Expected: the commit is dropped and the rebase does not stop. Pinned in Task 3 (`drops a commit that became empty`).
5. **The PR is not active** (completed, abandoned) **or its source branch has been deleted.** Expected: the run stops at intake with a clear error and makes no git writes. Pinned in Task 5 (`intake refuses a non-active PR`) and Task 3 (`createWorktree throws when the source branch is gone`).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/sdk/azure-devops-client.ts` (modify) | `getPullRequest` |
| `src/types/index.ts` (modify) | `PullRequestDetails` |
| `src/services/read-only-ado.ts` (modify) | passthrough read for `getPullRequest` |
| `src/utils/model-selection.ts`, `src/config/index.ts` (modify) | `rebase-resolver` step model/effort |
| `src/prfix/types.ts` (create) | `PrFixInput`, `ConflictResolution`, `RebaseOutput`, `PrFixOutcome`, error classes |
| `src/prfix/config.ts` (create) | `loadPrFixConfig` |
| `src/prfix/prfix-git.ts` (create) | every git call `fix-pr` makes |
| `src/prompts/rebase-resolver.md` (create) | resolver system prompt |
| `src/prfix/resolver.ts` (create) | one resolver agent call for one stopped commit |
| `src/prfix/stages.ts` (create) | `pr-intake`, `pr-worktree`, `rebase-onto-target`, `push-rebased`, `pr-comment` stages |
| `src/prfix/comment.ts` (create) | PR comment markdown for success and failure |
| `src/prfix/fix-pr.ts` (create) | `fixPr` runner: pipeline, outcome mapping, failure comment, cleanup |
| `src/services/pipeline-builder.ts` (modify) | `buildPrFixPipeline` |
| `src/cli/index.ts` (modify) | `fix-pr` command |
| `CLAUDE.md`, `README.md` (modify) | docs |

Tests mirror these under `tests/prfix/`, `tests/sdk/`, `tests/services/`.

---

### Task 1: ADO `getPullRequest`

**Files:**
- Modify: `src/types/index.ts`, `src/sdk/azure-devops-client.ts`, `src/services/read-only-ado.ts`
- Modify: every test double that implements `AdoClient` (`grep -rln "getPullRequestStatus:" tests` — 16 hits today)
- Test: `tests/sdk/azure-devops-client.test.ts`, `tests/services/read-only-ado.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface PullRequestDetails {
    id: number;
    status: PullRequestStatus;          // existing union
    title: string;
    sourceRefName: string;              // refs/heads/...
    targetRefName: string;              // refs/heads/...
    headCommit: string;                 // lastMergeSourceCommit.commitId
    isDraft: boolean;
    url: string;
  }
  // AdoClient
  getPullRequest(repositoryName: string, pullRequestId: number, opts?: { signal?: AbortSignal }): Promise<PullRequestDetails>;
  ```

- [ ] **Step 1: Write failing tests.** `getPullRequest maps the REST payload`: a fetch stub returning `{ pullRequestId: 7, status: 'active', title: 'T', sourceRefName: 'refs/heads/feat/x', targetRefName: 'refs/heads/main', lastMergeSourceCommit: { commitId: 'abc' }, isDraft: true, url: 'u' }` gives exactly those values, and the URL requested is `/<project>/_apis/git/repositories/<repo>/pullrequests/7?api-version=7.1`. `getPullRequest throws when lastMergeSourceCommit is missing`. In `read-only-ado.test.ts`: `getPullRequest passes through` (it is a read, so it must not throw).
- [ ] **Step 2: Run** `bun test tests/sdk/azure-devops-client.test.ts tests/services/read-only-ado.test.ts`. Expected: FAIL, `getPullRequest is not a function`.
- [ ] **Step 3: Implement.** Use `adoFetchWithRetry`, the same path shape as `getPullRequestStatus`, and the same status normalisation. Add the passthrough in `read-only-ado.ts`. Add `getPullRequest: mock(...)` to each test double.
- [ ] **Step 4: Run** `bun test && bun run typecheck`. Expected: PASS, no type errors.
- [ ] **Step 5: Commit** `feat: AdoClient.getPullRequest for PR details`

---

### Task 2: Types, config and the `rebase-resolver` model step

**Files:**
- Create: `src/prfix/types.ts`, `src/prfix/config.ts`
- Modify: `src/utils/model-selection.ts` (add `'rebase-resolver'` to `PipelineStep`), `src/config/index.ts` (`setStep('rebase-resolver', model(p.CLAUDE_MODEL_REBASE_RESOLVER))`, `setEffort('rebase-resolver', p.CLAUDE_EFFORT_REBASE_RESOLVER)`)
- Test: `tests/prfix/config.test.ts`, `tests/config/*` (the existing step-model test)

**Interfaces:**
- Produces (`src/prfix/types.ts`):
  ```ts
  export interface PrFixInput { pullRequestId: number; repository: string; pr: PullRequestDetails }
  export interface ConflictResolution { commit: string; subject: string; files: string[] }
  export interface RebaseOutput {
    preRebaseSha: string; targetSha: string; newHeadSha: string;
    commitsReplayed: number; conflicts: ConflictResolution[];
  }
  export type PrFixStatus =
    | 'rebased' | 'up-to-date' | 'head-moved' | 'conflict-cap' | 'unresolved-conflict'
    | 'verification-failed' | 'cost-cap' | 'cancelled' | 'error';
  export interface PrFixOutcome {
    ok: boolean; status: PrFixStatus; pullRequestId: number;
    oldHead: string | null; newHead: string | null;
    conflicts: ConflictResolution[]; costUsd: number; error: string | null;
  }
  export class PrUpToDateError extends Error {}          // name 'PrUpToDateError'
  export class ConflictCapError extends Error { constructor(readonly reason: string, readonly files: string[]) }
  export class UnresolvedConflictError extends Error { constructor(readonly commit: string, readonly files: string[]) }
  ```
  `HeadMovedError` is reused from `src/suggestions/suggestion-git.ts`. Do not add a second one.
- Produces (`src/prfix/config.ts`):
  ```ts
  export interface PrFixConfig { app: AppConfig; maxConflictCommits: number; maxConflictFiles: number; resolverMaxTurns: number }
  export function loadPrFixConfig(env: Record<string, string | undefined>): PrFixConfig;
  ```

- [ ] **Step 1: Write failing tests** in `tests/prfix/config.test.ts`:
  - `defaults`: `maxConflictCommits === 3`, `maxConflictFiles === 10`, `resolverMaxTurns === 40`, `app.maxTestFixAttempts === 0`.
  - `reads PRFIX_MAX_CONFLICT_COMMITS / PRFIX_MAX_CONFLICT_FILES / REBASE_RESOLVER_MAX_TURNS`.
  - `rejects 0 and non-integers` for the three knobs.
  - `requires BOT_GIT_NAME and BOT_GIT_EMAIL`: the message names both.
  - `sets stage timeouts`: `pr-intake` 120000, `pr-worktree` 300000, `rebase-onto-target` = `(maxConflictCommits + 1) × 1_800_000`, `push-rebased` 300000, `pr-comment` 120000. Explicit `STAGE_TIMEOUT_MS_*` values win.

  Add `CLAUDE_MODEL_REBASE_RESOLVER sets stepModel['rebase-resolver']` to the existing config test.
- [ ] **Step 2: Run** `bun test tests/prfix/config.test.ts tests/config`. Expected: FAIL.
- [ ] **Step 3: Implement.** `loadPrFixConfig` calls `loadConfig(env)`, then overrides `maxTestFixAttempts = 0`. It parses the three knobs with Zod `z.coerce.number().int().positive()` and validates the bot identity the way `loadSuggestionConfig` does.
- [ ] **Step 4: Run** `bun test && bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: fix-pr types, config and rebase-resolver model step`

---

### Task 3: `PrFixGit`

**Files:**
- Create: `src/prfix/prfix-git.ts`
- Test: `tests/prfix/prfix-git.test.ts` (real git sandbox; copy `setupTestRepo` / `runGit` from `tests/suggestions/suggestion-git.test.ts`, `setDefaultTimeout(30000)`, `node:child_process` in the test helper)

**Interfaces:**
- Consumes: `buildGitAuthArgs`, `redactPat` (`src/utils/git-auth.ts`); `HeadMovedError` (`src/suggestions/suggestion-git.ts`).
- Produces:
  ```ts
  export type RebaseStep =
    | { kind: 'done'; head: string }
    | { kind: 'conflict'; commit: string; subject: string; files: string[] };

  export interface PrFixGit {
    /** Fetch source + target, check origin/<source> === headCommit (else HeadMovedError), add a locked worktree on branch `prfix/pr-<id>` at headCommit. */
    createWorktree(a: { pullRequestId: number; sourceRefName: string; targetRefName: string; headCommit: string }): Promise<WorktreeContext & { targetSha: string }>;
    /** origin/<target> is already an ancestor of HEAD. */
    isUpToDate(path: string, targetSha: string): Promise<boolean>;
    /** `git rebase --empty=drop <targetSha>` with the bot committer identity. */
    startRebase(path: string, targetSha: string): Promise<RebaseStep>;
    /** Stage `files`, then `rebase --continue` (GIT_EDITOR=true). */
    continueRebase(path: string, files: string[]): Promise<RebaseStep>;
    abortRebase(path: string): Promise<void>;
    /** Files of `files` that still contain a conflict marker line (^<<<<<<< , ^=======$, ^>>>>>>> ). */
    filesWithMarkers(path: string, files: string[]): Promise<string[]>;
    headSha(path: string): Promise<string>;
    /** `git rev-list --count <from>..HEAD`. */
    countCommits(path: string, from: string): Promise<number>;
    push(a: { path: string; sourceRefName: string; expectedRemoteSha: string }): Promise<void>;
    removeWorktree(wt: WorktreeContext): Promise<void>;
  }
  export function createPrFixGit(deps: { config: AppConfig; logger?: Logger }): PrFixGit;
  ```
  When the rebase stops: the commit is `cat .git/rebase-merge/stopped-sha`, or `git rev-parse REBASE_HEAD`. The subject is `git log -1 --format=%s <commit>`. The files are `git diff --name-only --diff-filter=U`. Worktree path: `resolve(worktreeBase, \`prfix-${prId}\`)`. Like `SuggestionGit`, never run `git worktree prune`.
- [ ] **Step 1: Write failing tests** against a sandbox where origin has `main` and `feat/x` branched from the seed:
  - `createWorktree checks out the PR head on prfix/pr-<id>`
  - `createWorktree throws HeadMovedError when origin/<source> moved`
  - `createWorktree throws when the source branch is gone`: error message contains the branch name.
  - `isUpToDate`: true before main moves, false after main gains a commit.
  - `clean rebase returns done and keeps the author`: `%an` unchanged, `%cn` equals `BOT_GIT_NAME`.
  - `conflicting rebase returns conflict with commit, subject and files`
  - `continueRebase after a manual resolution returns done`
  - `drops a commit that became empty`: the same change is on main, the result is `done`, and the commit count drops by 1.
  - `filesWithMarkers` finds a file with `<<<<<<< ` and ignores a resolved one.
  - `abortRebase restores the pre-rebase head`
  - `push updates the remote when the lease holds`
  - `push rejects when the remote moved`: throws `HeadMovedError`, and the remote sha is unchanged.
- [ ] **Step 2: Run** `bun test tests/prfix/prfix-git.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement `createPrFixGit`.** Use the `runGit` shape from `suggestion-git.ts` (Bun.spawn, `GIT_TERMINAL_PROMPT=0`, `allowExit`). A rebase that stops exits 1, so `startRebase`/`continueRebase` allow exit 1 and then check for `.git/rebase-merge` (resolve the worktree's git dir with `git rev-parse --git-path rebase-merge`). For the push, map a `stale info` / `rejected` stderr to `HeadMovedError(source, expectedRemoteSha, <ls-remote sha>)`.
- [ ] **Step 4: Run** `bun test tests/prfix/prfix-git.test.ts && bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: PrFixGit — worktree, rebase steps and lease push for fix-pr`

---

### Task 4: Resolver prompt, resolver call and the `rebase-onto-target` stage

**Files:**
- Create: `src/prompts/rebase-resolver.md`, `src/prfix/resolver.ts`, and `createRebaseStage` in `src/prfix/stages.ts`
- Test: `tests/prfix/resolver.test.ts`, `tests/prfix/rebase-stage.test.ts`

**Interfaces:**
- Consumes: `PrFixGit`, `RebaseStep` (Task 3); `PrFixConfig`, `ConflictCapError`, `UnresolvedConflictError`, `RebaseOutput` (Task 2); `AgentRunner`; `composeCanUseTool`, `STRUCTURED_OUTPUT_DENIED_TOOLS`, `MAX_TRANSIENT_RETRIES` (`_stage-helpers.ts`); `createBashAllowlist`; `createPathEscapeFilter`; `createCostTracker`, `assertWithinCostCap`; `createToolUsageTracker`; `modelFor` / `effortFor`.
- Produces:
  ```ts
  // resolver.ts
  export const RESOLVER_BASH_ALLOW: RegExp[];   // ^git (status|diff|log|show|blame)\b, ^ls\b, ^cat\b, ^pwd\b
  export const resolverOutputSchema: z.ZodObject<{ files: …; summary: … }>; // files: {path, resolution: string}[]
  export function buildResolverPrompt(a: { commit: string; subject: string; files: string[]; targetSha: string; prTitle: string }): string;
  export async function resolveConflict(a: {
    runner: AgentRunner; config: AppConfig; promptTemplate: string; maxTurns: number;
    worktreePath: string; step: Extract<RebaseStep, { kind: 'conflict' }>; targetSha: string; prTitle: string;
    state: PipelineState; signal: AbortSignal;
  }): Promise<void>;
  // stages.ts
  export function createRebaseStage(deps: { git: PrFixGit; prfix: PrFixConfig; runner: AgentRunner; promptTemplate: string }): Stage; // name 'rebase-onto-target'
  ```
  The stage reads `state.outputs.worktree` (`WorktreeContext & { targetSha }`) and `state.outputs.prFixInput`. It writes `state.outputs.rebase: RebaseOutput` and sets `worktree.baseSha = targetSha`, so `build-and-test`'s test selection diffs against the new base.

**Prompt content** (`rebase-resolver.md`, exact intent; wording is the implementer's):
- You are mid-`git rebase`. One commit of a PR is being replayed onto a newer target branch.
- Resolve the listed files only. Keep both sides' intent: the target side is already merged, and the PR commit must still do what its subject says.
- Never delete a file to resolve it. Never run a git command that changes state. Leave no conflict markers.
- Inspect with `git show <commit>`, `git log <targetSha> -- <file>` and `git diff`.
- Reply with JSON: `{ "files": [{ "path", "resolution" }], "summary" }`.

- [ ] **Step 1: Write failing tests.**
  - `resolver.test.ts`:
    - `buildResolverPrompt names the commit, subject, every file and targetSha`.
    - `resolveConflict passes tools Read/Grep/Glob/Bash/Edit/Write, disallows ReportFindings, uses modelFor(config,'rebase-resolver'), bills cost key 'rebase-resolver'`.
    - `RESOLVER_BASH_ALLOW rejects git add, git rebase, git checkout`.
    - `retries an AgentOutputParseError up to MAX_TRANSIENT_RETRIES`.
  - `rebase-stage.test.ts` (fake `PrFixGit` and fake runner):
    - `clean rebase makes no agent call and records commitsReplayed`.
    - `one conflict → resolver called once → continueRebase with exactly the conflicted files → conflicts[0] recorded`.
    - `refuses to continue while markers remain`: `filesWithMarkers` returns `['a.al']`, so the stage throws `UnresolvedConflictError`, `abortRebase` is called, and `continueRebase` is not.
    - `aborts with ConflictCapError when conflicted commits exceed maxConflictCommits`: with cap 1 and two conflicting steps, the resolver runs once, then the stage aborts.
    - `aborts with ConflictCapError when one commit has more than maxConflictFiles files, before calling the resolver`.
    - `checks the cost cap before every resolver call`: spend already over cap means `CostExceededError` and `abortRebase` is called.
    - `an aborted signal aborts the rebase and rethrows`.
    - `sets worktree.baseSha to targetSha`.
- [ ] **Step 2: Run** `bun test tests/prfix/resolver.test.ts tests/prfix/rebase-stage.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** The stage loop:
  1. `startRebase`.
  2. While the step is `conflict`: check the caps, `assertWithinCostCap(state, cap, 'rebase-onto-target')`, run `resolveConflict`, check `filesWithMarkers`, then `continueRebase`.
  3. On any throw, call `abortRebase` (best-effort) and rethrow.

  `commitsReplayed` = `git.countCommits(path, targetSha)` after the rebase is done.
- [ ] **Step 4: Run** `bun test tests/prfix && bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: rebase-onto-target stage with capped LLM conflict resolution`

---

### Task 5: Intake, worktree, push and comment stages

**Files:**
- Create: `src/prfix/comment.ts`; add stages to `src/prfix/stages.ts`
- Test: `tests/prfix/stages.test.ts`, `tests/prfix/comment.test.ts`

**Interfaces:**
- Consumes: `AdoClient.getPullRequest`, `AdoClient.createPullRequestThread` (Task 1); `PrFixGit` (Task 3); `RebaseOutput`, `PrFixOutcome` (Task 2); `VerificationOutput`, `EnvironmentOutput` (`src/types`).
- Produces:
  ```ts
  export function createPrIntakeStage(deps: { ado: AdoClient }): Stage;   // 'pr-intake', costFree
  export function createPrWorktreeStage(deps: { git: PrFixGit }): Stage;  // 'pr-worktree', costFree
  export function createPushRebasedStage(deps: { git: PrFixGit }): Stage; // 'push-rebased', costFree
  export function createPrCommentStage(deps: { ado: AdoClient }): Stage;  // 'pr-comment', costFree
  // comment.ts
  export function renderSuccessComment(a: { pr: PullRequestDetails; rebase: RebaseOutput; verification?: VerificationOutput; environment?: EnvironmentOutput; skippedVerification: boolean }): string;
  export function renderFailureComment(a: { pr: PullRequestDetails; outcome: PrFixOutcome }): string;
  ```
  - `pr-intake`: reads `state.outputs.prFixInput.pullRequestId` / `.repository` and fills `.pr`. It throws `Error('PR <id> is <status>, not active')` unless the status is `active`. It also writes the synthetic `state.outputs.wiContext`, as `createSuggestionWorktreeStage` does (`id = prId`, `title = pr.title`, `workItemType: 'Pull Request'`), because `build-and-test` requires it.
  - `pr-worktree`: `createWorktree` into `outputs.worktree`, then throws `PrUpToDateError` when `isUpToDate`.
  - `push-rebased`: in a dry run, record `outputs.pushedCommit` and return. Otherwise `push({ expectedRemoteSha: rebase.preRebaseSha })`.
  - `pr-comment`: skipped in a dry run. Otherwise `createPullRequestThread` with `renderSuccessComment`.

**Comment content** (Markdown):
- Headline: `Rebased onto <target> @ <sha7>`.
- `<old sha7> → <new sha7>`, N commits replayed.
- A per-commit list of conflicts with each file's `resolution`, or "no conflicts".
- The verification result. When verification was skipped: "**Not verified** (SKIP_BUILD_TEST)". When the environment is kept: the env URL.
- A "Local branch" block: `git fetch && git reset --hard origin/<source>`, or `git pull --rebase` if you have unpushed commits.

The failure comment gives the status, the error (already redacted), the conflicted files, and "the branch was not changed".

- [ ] **Step 1: Write failing tests.**
  - `intake refuses a non-active PR`.
  - `intake writes prFixInput.pr and wiContext`.
  - `pr-worktree throws PrUpToDateError when up to date`.
  - `push-rebased passes preRebaseSha as the lease`.
  - `push-rebased does not push in a dry run`.
  - `pr-comment posts renderSuccessComment, not in dry run`.
  - Comment tests:
    - Success with conflicts lists every file.
    - Success without conflicts says "no conflicts".
    - Skipped verification says "Not verified".
    - The reset instructions name the source branch without `refs/heads/`.
    - The failure comment says the branch was not changed.
- [ ] **Step 2: Run** `bun test tests/prfix/stages.test.ts tests/prfix/comment.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the four stages and the two renderers.
- [ ] **Step 4: Run** `bun test tests/prfix && bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: fix-pr intake, worktree, push and comment stages`

---

### Task 6: `fixPr` runner, pipeline builder, CLI and docs

**Files:**
- Create: `src/prfix/fix-pr.ts`
- Modify: `src/services/pipeline-builder.ts`, `src/cli/index.ts`, `CLAUDE.md`, `README.md`
- Test: `tests/prfix/fix-pr.test.ts`, `tests/services/pipeline-builder.test.ts`

**Interfaces:**
- Consumes: all of the above; `createEnvProvisionStage`, `createBuildAndTestStage`, `VerificationFailedError` (`src/types/index.ts`); `CostExceededError`; `HeadMovedError`; `ContiniaCli.deleteEnvironment`; `runPipeline`, `createInitialState`.
- Produces:
  ```ts
  // pipeline-builder.ts
  export interface PrFixPipelineDeps { prfix: PrFixConfig; logger: Logger; ado: AdoClient; git: PrFixGit; continiaCli?: ContiniaCli; runner?: AgentRunner; resolverPromptTemplate?: string }
  export function buildPrFixPipeline(deps: PrFixPipelineDeps): Stage[];
  // order: pr-intake, pr-worktree, rebase-onto-target, [env-provision, build-and-test unless skipBuildTest], push-rebased, pr-comment
  // fix-pr.ts
  export interface FixPrDeps { prfix: PrFixConfig; logger: Logger; ado: AdoClient; git: PrFixGit; continiaCli?: Pick<ContiniaCli, 'deleteEnvironment'>; stages: Stage[]; store: PipelineStateStore; pullRequestId: number; keepEnv: boolean; abortFlag?: AbortFlag; now?: () => Date }
  export async function fixPr(deps: FixPrDeps): Promise<PrFixOutcome>;
  ```
  - State: `createInitialState(prId, \`pr-${prId}\`, now())`, with `outputs.prFixInput = { pullRequestId, repository: config.repositoryName }`. The slug makes the env name `wi-<prId>-pr-<prId>`, so env-provision's `wi-<id>-` prefix check holds.
  - Error to status mapping:
    - `PrUpToDateError`: `up-to-date`, `ok: true`.
    - `HeadMovedError`: `head-moved`.
    - `ConflictCapError`: `conflict-cap`.
    - `UnresolvedConflictError`: `unresolved-conflict`.
    - `VerificationFailedError`: `verification-failed`.
    - `CostExceededError`: `cost-cap`.
    - `state.cancelled`: `cancelled`.
    - Anything else: `error`, with `\`${stage}: ${redactPat(message)}\``.
  - On every failure except `up-to-date` and `cancelled`, and only when not a dry run: post `renderFailureComment` best-effort. A comment failure logs a warning and never changes the outcome.
  - `finally`:
    - Delete `outputs.environment` unless `keepEnv` (dry runs included). Best-effort, and only for names starting with `wi-<prId>-pr-`.
    - Remove the worktree on success and up-to-date. Keep it on failure and log its path. The next run's `createWorktree` removes the leftover.
- CLI:
  - `fix-pr <prId> [--dry-run] [--keep-env]` uses `loadPrFixConfig(process.env)` and `new PipelineStateStore(join(stateDir, 'prfix'))`.
  - SIGINT/SIGTERM sets `abortFlag`, as `apply-suggestions` does.
  - The last stdout line is `JSON.stringify(outcome)`. The exit code is 0 for `ok`, 1 otherwise. A non-integer `prId` prints usage and exits 1.
  - Add the command to `help()`.

- [ ] **Step 1: Write failing tests.**
  - `fix-pr.test.ts`, with fake stages that throw each sentinel:
    - One test per mapping row.
    - `up-to-date skips every later stage`.
    - `posts a failure comment on conflict-cap, not on up-to-date, not in dry run`.
    - `deletes the environment unless keepEnv`.
    - `never deletes an environment whose name is not wi-<id>-pr-`.
    - `keeps the worktree on failure, removes it on success`.
    - `redacts the PAT in error`.
  - `pipeline-builder.test.ts`:
    - `buildPrFixPipeline stage order with and without SKIP_BUILD_TEST`.
    - `build-and-test gets maxTestFixAttempts 0`.
- [ ] **Step 2: Run** `bun test tests/prfix/fix-pr.test.ts tests/services/pipeline-builder.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `fixPr`, `buildPrFixPipeline` and the CLI command.
- [ ] **Step 4: Docs.**
  - `CLAUDE.md`: add a short **fix-pr (Plan 15)** paragraph covering:
    - rebase, not merge;
    - the lease against the pre-rebase head;
    - the conflict caps;
    - the resolver edits files only;
    - the fix loop is off, so red means no push;
    - `.state/prfix/`;
    - the environment is deleted at the end unless `--keep-env`.

    Add the command to **Commands**, and `src/prfix/` to **File Layout**.
  - `README.md`: a `fix-pr` section with the command, flags, the env knobs (`PRFIX_MAX_CONFLICT_COMMITS`, `PRFIX_MAX_CONFLICT_FILES`, `REBASE_RESOLVER_MAX_TURNS`, `CLAUDE_MODEL_REBASE_RESOLVER`, `CLAUDE_EFFORT_REBASE_RESOLVER`) and the outcome JSON shape.
- [ ] **Step 5: Run** `bun test && bun run typecheck`. Expected: PASS, no type errors.
- [ ] **Step 6: Smoke.** Run `bun run src/cli/index.ts fix-pr <one of your own PR ids> --dry-run` against a PR that is behind main. Expected: the last line is JSON with `status: 'rebased'`, `oldHead != newHead`, and the remote branch is unchanged (`git ls-remote origin <source>`).
- [ ] **Step 7: Commit** `feat: fix-pr command — rebase a PR onto its target, verify, lease-push`
