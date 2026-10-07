# apply-suggestions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new CLI command, `apply-suggestions --input <json> [--dry-run]`. It applies mutant-fixer's verified AL test fixes to a PR head with one commit per fix. Then it either opens a stacked PR into the developer's branch (`pr` mode) or pushes to that branch (`push` mode). The last stdout line is a JSON outcome.

**Architecture:** A second pipeline, `buildSuggestionPipeline`, runs on the existing orchestrator (`runPipeline`). It reuses `createFixFindingsStage` with a new prompt builder, called once per fix. A new `SuggestionGit` module owns every git call: worktree, per-fix commit, push and removal. It never runs `git worktree prune`. The flow runs no analyzer, reviewer, test-author, build-and-test or draft-PR stage, and posts no ADO comments.

**Tech Stack:** Bun, TypeScript, zod, bun:test, git CLI, the Claude Agent SDK through the existing `AgentRunner`.

**Spec:** `C:\GeneralDev\DevOpsPullers\mutant-fixer\docs\handover\devopscoder-apply-suggestions.md`. Design background: `C:\GeneralDev\DevOpsPullers\mutant-fixer\docs\superpowers\specs\2026-10-02-handover-modes-design.md`.

## Global Constraints

- Invocation: `bun run src/cli/index.ts apply-suggestions --input <absolute path to json> [--dry-run]`, with cwd = the DevOpsCoder repo root.
- The **last line on stdout** is one JSON object: `{ ok, branch, pushedCommit, pullRequestId, appliedIds, skippedIds, error }`. Exit code 0 whenever the JSON is printed. A non-zero exit means a crash.
- `push` mode returns `error: "head-moved"` when `origin/<branch>` is not at `headCommit` at the start. Nothing is pushed in that case.
- `pr` branch: `mutant/pr-<pullRequestId>-<headCommit first 7>`. Push it with `--force`.
- One commit per fix id. Message: `test: <id> kill mutants <ids> (mutant-fixer run <runNo>)`. Author and committer are `BOT_GIT_NAME` / `BOT_GIT_EMAIL`.
- Stacked PR: target is the input `sourceRefName`, `isDraft: false`, reviewers `[{ id: reviewerId }]`. Title: `Mutation fixes for !<pullRequestId> (run <runNo>)`. Description: a link to `parentPullRequestUrl`, then one bullet per applied fix (`id`, `title`, first line of `description`).
- `push` mode: push with `HEAD:<branch>` and `--force-with-lease=<branch>:<headCommit>`, and create no PR.
- `--dry-run`: apply and commit in the worktree; no push, no PR. Keep the worktree for inspection.
- Do not abandon, delete or comment on any other PR or branch. Post no PR threads.
- Never run `git worktree prune`. Remove only this command's own worktree (`git worktree remove --force --force <path>`). Create worktrees with `--lock`.
- The command must not require watcher-only variables: `ADO_REPOSITORY_NAME` comes from the input, `MAX_COST_USD_PER_WI` gets a default, and `SKIP_BUILD_TEST` is forced on. It must not start the watcher or touch the main `STATE_DIR` files; state goes to `STATE_DIR/suggestions/`.
- Leave the tag watcher and `run-wi` unchanged.

## Review Focus

1. **Shared-clone safety:** a stale registration of another container's worktree must survive this command. Pinned by the Task 3 test "removeWorktree leaves other registrations alone".
2. **An agent that commits with its own message, or leaves edits uncommitted:** each fix must still end as exactly one bot-authored commit with the contract message. Pinned by the Task 3 `commitFix` tests.
3. **An agent that fails or declines one fix:** the other fixes still apply, and the failed id lands in `skippedIds` with the worktree reset. Pinned by the Task 5 test "a failing fix is skipped and reset".
4. **A developer push between fetch and push in `push` mode:** the lease must reject it instead of overwriting. Pinned by the Task 3 test "push mode refuses when the remote moved after the fetch".
5. **Stdout pollution:** logger lines go to stdout too. The JSON must be the very last line, printed after every log. Pinned by the Task 6 CLI test.

---

### Task 1: Bot identity config, PR reviewers, test config helper

**Files:**
- Modify: `src/config/index.ts` (schema near line 168, return object near line 376)
- Modify: `src/types/index.ts` (`AppConfig`, `CreatePullRequestArgs` at line 687)
- Modify: `src/sdk/azure-devops-client.ts:231-240`
- Create: `tests/helpers/app-config.ts`
- Test: `tests/config/config.test.ts`, `tests/sdk/azure-devops-client.test.ts`

**Interfaces:**
- Produces: `AppConfig.botGitName?: string`, `AppConfig.botGitEmail?: string`, `CreatePullRequestArgs.reviewers?: { id: string }[]`, `makeTestConfig(env?, overrides?)`.

- [ ] **Step 1: Write the test helper**

`tests/helpers/app-config.ts`:
```ts
import { loadConfig } from '../../src/config/index.ts';
import type { AppConfig } from '../../src/types/index.ts';

/** The smallest env loadConfig accepts. SKIP_BUILD_TEST avoids the Continia token. */
export const MIN_ENV: Record<string, string> = {
  AZURE_DEVOPS_PAT: 'pat-0123456789',
  AZURE_DEVOPS_ORG: 'my-org',
  AZURE_DEVOPS_PROJECT: 'my-project',
  ADO_REPOSITORY_NAME: 'test-repo',
  TARGET_REPO_PATH: '/repo',
  WORKTREE_BASE: '/worktrees',
  MAX_COST_USD_PER_WI: '5',
  SKIP_BUILD_TEST: 'true',
};

export function makeTestConfig(
  env: Record<string, string | undefined> = {},
  overrides: Partial<AppConfig> = {},
): AppConfig {
  return { ...loadConfig({ ...MIN_ENV, ...env }), ...overrides };
}
```

- [ ] **Step 2: Write the failing tests**

Append to `tests/config/config.test.ts`:
```ts
import { makeTestConfig } from '../helpers/app-config.ts';

describe('bot git identity', () => {
  it('reads BOT_GIT_NAME and BOT_GIT_EMAIL', () => {
    const c = makeTestConfig({ BOT_GIT_NAME: 'Mutant Bot', BOT_GIT_EMAIL: 'bot@example.com' });
    expect(c.botGitName).toBe('Mutant Bot');
    expect(c.botGitEmail).toBe('bot@example.com');
  });

  it('treats blank values as unset', () => {
    const c = makeTestConfig({ BOT_GIT_NAME: ' ', BOT_GIT_EMAIL: '' });
    expect(c.botGitName).toBeUndefined();
    expect(c.botGitEmail).toBeUndefined();
  });
});
```

Inside `describe('createPullRequest', ...)` in `tests/sdk/azure-devops-client.test.ts`, using that file's `setupFetch`, `jsonResponse`, `makeConfig` and `calls`:
```ts
    it('sends reviewers when given, and omits the field otherwise', async () => {
      const fetchImpl = setupFetch([
        jsonResponse(201, { pullRequestId: 1, url: 'u', sourceRefName: 's', targetRefName: 't' }),
        jsonResponse(201, { pullRequestId: 2, url: 'u', sourceRefName: 's', targetRefName: 't' }),
      ]);
      const client = createAdoClient(makeConfig(), fetchImpl);
      const base = {
        repositoryName: 'test-repo', sourceRefName: 'refs/heads/mutant/pr-1-abc1234',
        targetRefName: 'refs/heads/feature/foo', title: 't', description: 'd', isDraft: false,
      };
      await client.createPullRequest({ ...base, reviewers: [{ id: 'guid-1' }] });
      await client.createPullRequest(base);
      const first = JSON.parse(calls[0]!.init?.body as string) as Record<string, unknown>;
      const second = JSON.parse(calls[1]!.init?.body as string) as Record<string, unknown>;
      expect(first.reviewers).toEqual([{ id: 'guid-1' }]);
      expect('reviewers' in second).toBe(false);
    });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test tests/config/config.test.ts tests/sdk/azure-devops-client.test.ts`
Expected: FAIL. `botGitName` is undefined, `first.reviewers` is undefined, and typecheck complains about `reviewers`.

- [ ] **Step 4: Implement**

`src/config/index.ts`, in `envSchema` after `COST_LOG_PATH`:
```ts
  // Commit identity for apply-suggestions. mutant-fixer lists the email in its
  // BOT_IDENTITIES so it skips the commits this command pushes.
  BOT_GIT_NAME: z.string().optional(),
  BOT_GIT_EMAIL: z.string().optional(),
```
In the returned object, after `claudeCodeExecutablePath`:
```ts
    ...(model(p.BOT_GIT_NAME) !== undefined ? { botGitName: model(p.BOT_GIT_NAME) } : {}),
    ...(model(p.BOT_GIT_EMAIL) !== undefined ? { botGitEmail: model(p.BOT_GIT_EMAIL) } : {}),
```
`src/types/index.ts`, in `AppConfig`:
```ts
  /** Commit author for apply-suggestions (BOT_GIT_NAME). */
  botGitName?: string;
  /** Commit author email for apply-suggestions (BOT_GIT_EMAIL). */
  botGitEmail?: string;
```
In `CreatePullRequestArgs`:
```ts
  /** Required reviewers by identity id (ADO `reviewers[].id`). */
  reviewers?: { id: string }[];
```
`src/sdk/azure-devops-client.ts`, in the `createPullRequest` body after `isDraft`:
```ts
            ...(args.reviewers && args.reviewers.length > 0 ? { reviewers: args.reviewers } : {}),
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test tests/config/config.test.ts tests/sdk/azure-devops-client.test.ts && bun run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/config/index.ts src/types/index.ts src/sdk/azure-devops-client.ts tests/helpers/app-config.ts tests/config/config.test.ts tests/sdk/azure-devops-client.test.ts
git commit -m "feat: bot git identity config and PR reviewers"
```

---

### Task 2: Input parsing and mapping

**Files:**
- Create: `src/suggestions/input.ts`
- Create: `tests/helpers/suggestion-input.ts`
- Test: `tests/suggestions/input.test.ts`

**Interfaces:**
- Produces:
  - `type SuggestionMode = 'pr' | 'push'`
  - `interface Suggestion`, `interface SuggestionInput` (zod-inferred)
  - `parseSuggestionInput(text: string): { ok: true; input: SuggestionInput } | { ok: false; error: string }`
  - `suggestionToFinding(s: Suggestion): Finding`
  - `sha7(sha: string): string`
  - `mutantBranchName(pullRequestId: number, headCommit: string): string`, which returns `mutant/pr-<id>-<sha7>` without `refs/heads/`
  - `commitMessage(input: SuggestionInput, s: Suggestion): string`
  - `stackedPrTitle(input: SuggestionInput): string`
  - `buildStackedPrDescription(input: SuggestionInput, appliedIds: string[]): string`

- [ ] **Step 1: Write the failing tests**

`tests/helpers/suggestion-input.ts`. It lives in a helper module, not in a test file: importing a test file would register its tests again in every importer.
```ts
import type { SuggestionInput } from '../../src/suggestions/input.ts';

export const HEAD = 'abc1234def5678abc1234def5678abc1234def56';

export function makeInput(overrides: Partial<SuggestionInput> = {}): SuggestionInput {
  return {
    mode: 'pr',
    repository: 'Continia Banking',
    pullRequestId: 12345,
    parentPullRequestUrl: 'https://dev.azure.com/org/proj/_git/Continia%20Banking/pullrequest/12345',
    reviewerId: 'guid-creator',
    sourceRefName: 'refs/heads/feature/foo',
    headCommit: HEAD,
    runNo: 1003,
    suggestions: [
      {
        id: 'F001',
        file: 'Continia Banking/base-application-test/Auth/TestAuth.Codeunit.al',
        line: 68,
        title: 'F001: add-assert in SomeTest',
        description: 'Assert the target is empty.\n\nExpected effect: kills 2\nKills mutants: 140, 141',
        code: '        Assert.RecordIsEmpty(TempTarget);',
        confidence: 'high',
      },
    ],
    ...overrides,
  };
}
```

`tests/suggestions/input.test.ts`:
```ts
import { describe, it, expect } from 'bun:test';
import {
  buildStackedPrDescription,
  commitMessage,
  mutantBranchName,
  parseSuggestionInput,
  stackedPrTitle,
  suggestionToFinding,
} from '../../src/suggestions/input.ts';
import { HEAD, makeInput } from '../helpers/suggestion-input.ts';

describe('parseSuggestionInput', () => {
  it('accepts the contract example', () => {
    const r = parseSuggestionInput(JSON.stringify(makeInput()));
    expect(r.ok).toBe(true);
  });

  it('accepts push mode and a suggestion without line', () => {
    const input = makeInput({ mode: 'push' });
    delete (input.suggestions[0] as { line?: number }).line;
    const r = parseSuggestionInput(JSON.stringify(input));
    expect(r.ok).toBe(true);
  });

  it.each([
    ['unknown mode', { mode: 'comment' }],
    ['short head commit', { headCommit: 'abc1234' }],
    ['source ref without refs/heads/', { sourceRefName: 'feature/foo' }],
    ['no suggestions', { suggestions: [] }],
  ])('rejects %s', (_name, patch) => {
    const r = parseSuggestionInput(JSON.stringify({ ...makeInput(), ...patch }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toStartWith('invalid-input:');
  });

  it('rejects duplicate fix ids', () => {
    const input = makeInput();
    input.suggestions.push({ ...input.suggestions[0]! });
    const r = parseSuggestionInput(JSON.stringify(input));
    expect(r.ok).toBe(false);
  });

  it.each(['../outside.al', '/abs/path.al', 'a\\b.al'])('rejects file path %s', (file) => {
    const input = makeInput();
    input.suggestions[0]!.file = file;
    expect(parseSuggestionInput(JSON.stringify(input)).ok).toBe(false);
  });

  it('rejects text that is not JSON', () => {
    const r = parseSuggestionInput('{nope');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toStartWith('invalid-input:');
  });
});

describe('mapping', () => {
  it('maps a suggestion to a critical mutation finding', () => {
    const s = makeInput().suggestions[0]!;
    expect(suggestionToFinding(s)).toEqual({
      severity: 'critical',
      file: s.file,
      line: 68,
      title: s.title,
      description: s.description,
      suggestion: s.code,
      axis: 'mutation',
    });
  });

  it('omits line for a new procedure', () => {
    const s = { ...makeInput().suggestions[0]! };
    delete (s as { line?: number }).line;
    expect('line' in suggestionToFinding(s)).toBe(false);
  });

  it('names the branch mutant/pr-<id>-<sha7>', () => {
    expect(mutantBranchName(12345, HEAD)).toBe('mutant/pr-12345-abc1234');
  });

  it('builds the contract commit message from the Kills mutants line', () => {
    const input = makeInput();
    expect(commitMessage(input, input.suggestions[0]!)).toBe(
      'test: F001 kill mutants 140, 141 (mutant-fixer run 1003)',
    );
  });

  it('drops the mutant list when the description has none', () => {
    const input = makeInput();
    input.suggestions[0]!.description = 'no list';
    expect(commitMessage(input, input.suggestions[0]!)).toBe('test: F001 (mutant-fixer run 1003)');
  });

  it('titles and describes the stacked PR', () => {
    const input = makeInput();
    expect(stackedPrTitle(input)).toBe('Mutation fixes for !12345 (run 1003)');
    const d = buildStackedPrDescription(input, ['F001']);
    expect(d).toContain(`[!12345](${input.parentPullRequestUrl})`);
    expect(d).toContain('- **F001** F001: add-assert in SomeTest: Assert the target is empty.');
    expect(d).not.toContain('Expected effect');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/suggestions/input.test.ts`
Expected: FAIL with `Cannot find module '../../src/suggestions/input.ts'`.

- [ ] **Step 3: Implement**

`src/suggestions/input.ts`:
```ts
import { z } from 'zod';
import type { Finding } from '../types/index.ts';
import { capPrDescription } from '../pipeline/stages/draft-pr-creator.ts';

/**
 * mutant-fixer's handover file. The contract lives in mutant-fixer's
 * docs/handover/devopscoder-apply-suggestions.md; change both together.
 */
const suggestionSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]+$/, 'id must be letters, digits, - or _'),
  file: z
    .string()
    .min(1)
    .refine((f) => !f.includes('\\'), 'file must use forward slashes')
    .refine((f) => !f.startsWith('/') && !/^[A-Za-z]:/.test(f), 'file must be relative to the repo root')
    .refine((f) => !f.split('/').includes('..'), 'file must stay inside the repo'),
  line: z.number().int().positive().optional(),
  title: z.string().min(1),
  description: z.string(),
  code: z.string().min(1),
  confidence: z.string(),
});

const inputSchema = z
  .object({
    mode: z.enum(['pr', 'push']),
    repository: z.string().min(1),
    pullRequestId: z.number().int().positive(),
    parentPullRequestUrl: z.string().url(),
    reviewerId: z.string().min(1),
    sourceRefName: z.string().startsWith('refs/heads/'),
    headCommit: z.string().regex(/^[0-9a-f]{40}$/, 'headCommit must be a full 40-char sha'),
    runNo: z.number().int().nonnegative(),
    suggestions: z.array(suggestionSchema).min(1),
  })
  .superRefine((v, ctx) => {
    const seen = new Set<string>();
    for (const s of v.suggestions) {
      if (seen.has(s.id)) ctx.addIssue({ code: 'custom', path: ['suggestions'], message: `duplicate id ${s.id}` });
      seen.add(s.id);
    }
  });

export type SuggestionInput = z.infer<typeof inputSchema>;
export type Suggestion = SuggestionInput['suggestions'][number];
export type SuggestionMode = SuggestionInput['mode'];

export function parseSuggestionInput(
  text: string,
): { ok: true; input: SuggestionInput } | { ok: false; error: string } {
  let raw: unknown;
  try {
    // A UTF-8 BOM is not JSON; strip it.
    raw = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (err) {
    return { ok: false, error: `invalid-input: not JSON (${err instanceof Error ? err.message : String(err)})` };
  }
  const result = inputSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    return { ok: false, error: `invalid-input: ${issues}` };
  }
  return { ok: true, input: result.data };
}

/**
 * 'critical' so the fix-findings prompt lists it first. The severity has no
 * other meaning here: every suggestion is a verified fix to apply.
 */
export function suggestionToFinding(s: Suggestion): Finding {
  return {
    severity: 'critical',
    file: s.file,
    ...(s.line !== undefined ? { line: s.line } : {}),
    title: s.title,
    description: s.description,
    suggestion: s.code,
    axis: 'mutation',
  };
}

export function sha7(sha: string): string {
  return sha.slice(0, 7);
}

export function mutantBranchName(pullRequestId: number, headCommit: string): string {
  return `mutant/pr-${pullRequestId}-${sha7(headCommit)}`;
}

/** mutant-fixer ends each description with "Kills mutants: 140, 141". */
function killedMutants(description: string): string | undefined {
  const m = /Kills mutants:\s*([0-9][0-9 ,]*)/i.exec(description);
  return m?.[1]?.trim().replace(/,$/, '');
}

export function commitMessage(input: SuggestionInput, s: Suggestion): string {
  const ids = killedMutants(s.description);
  return ids
    ? `test: ${s.id} kill mutants ${ids} (mutant-fixer run ${input.runNo})`
    : `test: ${s.id} (mutant-fixer run ${input.runNo})`;
}

export function stackedPrTitle(input: SuggestionInput): string {
  return `Mutation fixes for !${input.pullRequestId} (run ${input.runNo})`;
}

export function buildStackedPrDescription(input: SuggestionInput, appliedIds: string[]): string {
  const applied = new Set(appliedIds);
  const bullets = input.suggestions
    .filter((s) => applied.has(s.id))
    .map((s) => `- **${s.id}** ${s.title}: ${(s.description.split('\n')[0] ?? '').trim()}`);
  return capPrDescription(
    [
      `Mutation-test fixes for [!${input.pullRequestId}](${input.parentPullRequestUrl}), from mutant-fixer run ${input.runNo}.`,
      'Each commit adds one fix that was verified on a BC environment: it compiles, passes on the PR code and kills the listed mutants.',
      '',
      ...bullets,
    ].join('\n'),
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/suggestions/input.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/suggestions/input.ts tests/suggestions/input.test.ts tests/helpers/suggestion-input.ts
git commit -m "feat: parse and map apply-suggestions input"
```

---

### Task 3: SuggestionGit (worktree, per-fix commit, push, removal)

**Files:**
- Create: `src/suggestions/suggestion-git.ts`
- Test: `tests/suggestions/suggestion-git.test.ts`

**Interfaces:**
- Consumes: `mutantBranchName`, `sha7` (Task 2); `buildGitAuthArgs`, `redactPat`; `AppConfig.botGitName/botGitEmail` (Task 1).
- Produces:
```ts
export class HeadMovedError extends Error // name 'HeadMovedError'; fields branch, expected, actual
export interface PrepareArgs { pullRequestId: number; headCommit: string; sourceRefName: string }
export interface SuggestionGit {
  createPrWorktree(a: PrepareArgs): Promise<WorktreeContext>;   // branch = mutant/pr-<id>-<sha7>, baseSha = headCommit
  createPushWorktree(a: PrepareArgs): Promise<WorktreeContext>; // throws HeadMovedError; branch = mutant-push/pr-<id>-<sha7>
  headSha(path: string): Promise<string>;
  resetHard(path: string, sha: string): Promise<void>;
  commitFix(a: { path: string; baselineSha: string; message: string }): Promise<string | null>;
  push(a: { path: string; mode: 'pr' | 'push'; remoteBranch: string; headCommit: string }): Promise<void>; // remoteBranch without refs/heads/
  removeWorktree(wt: WorktreeContext): Promise<void>;
}
export function createSuggestionGit(deps: { config: AppConfig }): SuggestionGit
```

- [ ] **Step 1: Write the failing tests**

`tests/suggestions/suggestion-git.test.ts`. Copy `runGit` (node `execFile`, for the Windows `Bun.spawn` race noted there) and `setupTestRepo` from `tests/services/worktree-manager.test.ts`. Then:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createSuggestionGit, HeadMovedError } from '../../src/suggestions/suggestion-git.ts';
import { makeTestConfig } from '../helpers/app-config.ts';

// runGit + setupTestRepo copied from tests/services/worktree-manager.test.ts

let repo: Awaited<ReturnType<typeof setupTestRepo>>;
let head: string;

async function pushFeature(): Promise<string> {
  // A developer branch feature/foo on origin with one commit over main.
  const seed = join(repo.root, 'dev');
  await runGit(['clone', repo.originPath, seed], repo.root);
  await runGit(['config', 'user.email', 'dev@example.com'], seed);
  await runGit(['config', 'user.name', 'Dev'], seed);
  await runGit(['checkout', '-b', 'feature/foo'], seed);
  writeFileSync(join(seed, 'Test.al'), 'line1\nline2\n', 'utf-8');
  await runGit(['add', 'Test.al'], seed);
  await runGit(['commit', '-m', 'dev work'], seed);
  await runGit(['push', 'origin', 'feature/foo'], seed);
  return (await runGit(['rev-parse', 'HEAD'], seed)).trim();
}

function git() {
  return createSuggestionGit({
    config: makeTestConfig({
      TARGET_REPO_PATH: repo.targetRepoPath,
      WORKTREE_BASE: repo.worktreeBase,
      BOT_GIT_NAME: 'Mutant Bot',
      BOT_GIT_EMAIL: 'bot@example.com',
    }),
  });
}

const args = () => ({ pullRequestId: 7, headCommit: head, sourceRefName: 'refs/heads/feature/foo' });

beforeEach(async () => {
  repo = await setupTestRepo();
  head = await pushFeature();
});
afterEach(() => repo.cleanup());

describe('createPrWorktree', () => {
  it('checks out the head commit on mutant/pr-<id>-<sha7>, locked', async () => {
    const wt = await git().createPrWorktree(args());
    expect(wt.branch).toBe(`mutant/pr-7-${head.slice(0, 7)}`);
    expect(wt.baseSha).toBe(head);
    expect((await runGit(['rev-parse', 'HEAD'], wt.path)).trim()).toBe(head);
    const list = await runGit(['worktree', 'list', '--porcelain'], repo.targetRepoPath);
    expect(list).toContain('locked');
  });

  it('replaces its own leftover worktree from a crashed run', async () => {
    const first = await git().createPrWorktree(args());
    writeFileSync(join(first.path, 'junk.txt'), 'x', 'utf-8');
    const second = await git().createPrWorktree(args());
    expect(second.path).toBe(first.path);
    expect(existsSync(join(second.path, 'junk.txt'))).toBe(false);
  });
});

describe('createPushWorktree', () => {
  it('starts at headCommit when origin is there', async () => {
    const wt = await git().createPushWorktree(args());
    expect((await runGit(['rev-parse', 'HEAD'], wt.path)).trim()).toBe(head);
  });

  it('throws HeadMovedError when the developer pushed since', async () => {
    const dev = join(repo.root, 'dev');
    writeFileSync(join(dev, 'Other.al'), 'x\n', 'utf-8');
    await runGit(['add', 'Other.al'], dev);
    await runGit(['commit', '-m', 'more'], dev);
    await runGit(['push', 'origin', 'feature/foo'], dev);
    await expect(git().createPushWorktree(args())).rejects.toBeInstanceOf(HeadMovedError);
  });
});

describe('commitFix', () => {
  it('turns the agent commits into one bot commit with the given message', async () => {
    const g = git();
    const wt = await g.createPrWorktree(args());
    await runGit(['config', 'user.email', 'agent@example.com'], wt.path);
    await runGit(['config', 'user.name', 'Agent'], wt.path);
    writeFileSync(join(wt.path, 'Test.al'), 'line1\nline2\nassert\n', 'utf-8');
    await runGit(['commit', '-am', 'agent says hi'], wt.path);
    writeFileSync(join(wt.path, 'New.al'), 'new\n', 'utf-8');
    await runGit(['add', 'New.al'], wt.path);
    await runGit(['commit', '-m', 'second agent commit'], wt.path);
    const sha = await g.commitFix({ path: wt.path, baselineSha: head, message: 'test: F001 kill mutants 1 (mutant-fixer run 9)' });
    expect(sha).not.toBeNull();
    expect((await runGit(['rev-list', '--count', `${head}..HEAD`], wt.path)).trim()).toBe('1');
    const log = await runGit(['log', '-1', '--format=%an|%ae|%cn|%ce|%s'], wt.path);
    expect(log.trim()).toBe('Mutant Bot|bot@example.com|Mutant Bot|bot@example.com|test: F001 kill mutants 1 (mutant-fixer run 9)');
    expect((await runGit(['show', '--name-only', '--format=', 'HEAD'], wt.path)).trim().split('\n').sort()).toEqual(['New.al', 'Test.al']);
  });

  it('commits tracked edits the agent left uncommitted', async () => {
    const g = git();
    const wt = await g.createPrWorktree(args());
    writeFileSync(join(wt.path, 'Test.al'), 'changed\n', 'utf-8');
    expect(await g.commitFix({ path: wt.path, baselineSha: head, message: 'm' })).not.toBeNull();
  });

  it('returns null and commits nothing when there is no change', async () => {
    const g = git();
    const wt = await g.createPrWorktree(args());
    expect(await g.commitFix({ path: wt.path, baselineSha: head, message: 'm' })).toBeNull();
    expect((await runGit(['rev-parse', 'HEAD'], wt.path)).trim()).toBe(head);
  });
});

describe('push', () => {
  async function oneFix(g: ReturnType<typeof git>, mode: 'pr' | 'push') {
    const wt = mode === 'pr' ? await g.createPrWorktree(args()) : await g.createPushWorktree(args());
    writeFileSync(join(wt.path, 'Test.al'), 'fixed\n', 'utf-8');
    const sha = await g.commitFix({ path: wt.path, baselineSha: head, message: 'm' });
    return { wt, sha: sha! };
  }

  it('pr mode force-pushes the mutant branch', async () => {
    const g = git();
    const { wt, sha } = await oneFix(g, 'pr');
    await g.push({ path: wt.path, mode: 'pr', remoteBranch: wt.branch, headCommit: head });
    const remote = await runGit(['ls-remote', repo.originPath, `refs/heads/${wt.branch}`], repo.root);
    expect(remote).toContain(sha);
  });

  it('push mode updates the developer branch', async () => {
    const g = git();
    const { wt, sha } = await oneFix(g, 'push');
    await g.push({ path: wt.path, mode: 'push', remoteBranch: 'feature/foo', headCommit: head });
    expect(await runGit(['ls-remote', repo.originPath, 'refs/heads/feature/foo'], repo.root)).toContain(sha);
  });

  it('push mode refuses when the remote moved after the fetch', async () => {
    const g = git();
    const { wt } = await oneFix(g, 'push');
    const dev = join(repo.root, 'dev');
    writeFileSync(join(dev, 'Other.al'), 'x\n', 'utf-8');
    await runGit(['add', 'Other.al'], dev);
    await runGit(['commit', '-m', 'race'], dev);
    await runGit(['push', 'origin', 'feature/foo'], dev);
    const devHead = (await runGit(['rev-parse', 'HEAD'], dev)).trim();
    await expect(g.push({ path: wt.path, mode: 'push', remoteBranch: 'feature/foo', headCommit: head })).rejects.toThrow();
    expect(await runGit(['ls-remote', repo.originPath, 'refs/heads/feature/foo'], repo.root)).toContain(devHead);
  });
});

describe('removeWorktree', () => {
  it('removes its locked worktree and local branch', async () => {
    const g = git();
    const wt = await g.createPrWorktree(args());
    await g.removeWorktree(wt);
    expect(existsSync(wt.path)).toBe(false);
    expect(await runGit(['branch', '--list', wt.branch], repo.targetRepoPath)).toBe('');
  });

  it('removeWorktree leaves other registrations alone (no prune)', async () => {
    // Another container's worktree: registered, but its path does not exist here.
    const other = join(repo.root, 'other-wt');
    await runGit(['worktree', 'add', '--detach', other, 'main'], repo.targetRepoPath);
    rmSync(other, { recursive: true, force: true });
    const g = git();
    await g.removeWorktree(await g.createPrWorktree(args()));
    const list = await runGit(['worktree', 'list', '--porcelain'], repo.targetRepoPath);
    expect(list.replace(/\\/g, '/')).toContain(other.replace(/\\/g, '/'));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/suggestions/suggestion-git.test.ts`
Expected: FAIL with `Cannot find module '../../src/suggestions/suggestion-git.ts'`.

- [ ] **Step 3: Implement**

`src/suggestions/suggestion-git.ts`:
```ts
import { existsSync, mkdirSync, rmSync } from 'fs';
import { resolve } from 'path';
import type { AppConfig, WorktreeContext } from '../types/index.ts';
import { buildGitAuthArgs, redactPat } from '../utils/git-auth.ts';
import { mutantBranchName, sha7 } from './input.ts';

/** push mode: origin/<branch> is no longer the commit the fixes were computed against. */
export class HeadMovedError extends Error {
  override readonly name = 'HeadMovedError';
  constructor(
    public readonly branch: string,
    public readonly expected: string,
    public readonly actual: string,
  ) {
    super(`origin/${branch} is at ${actual}, expected ${expected}`);
  }
}

export interface PrepareArgs {
  pullRequestId: number;
  headCommit: string;
  sourceRefName: string;
}

export interface SuggestionGit {
  createPrWorktree(a: PrepareArgs): Promise<WorktreeContext>;
  createPushWorktree(a: PrepareArgs): Promise<WorktreeContext>;
  headSha(path: string): Promise<string>;
  resetHard(path: string, sha: string): Promise<void>;
  commitFix(a: { path: string; baselineSha: string; message: string }): Promise<string | null>;
  push(a: { path: string; mode: 'pr' | 'push'; remoteBranch: string; headCommit: string }): Promise<void>;
  removeWorktree(wt: WorktreeContext): Promise<void>;
}

/**
 * Every git call apply-suggestions makes. The clone is shared with the
 * devops-coder service and with mutant-fixer, whose worktree paths do not
 * exist in this container: `git worktree prune` would delete their
 * registrations, so nothing here prunes. Worktrees are added `--lock`ed, which
 * is why removal and re-adding pass `--force` twice.
 */
export function createSuggestionGit(deps: { config: AppConfig }): SuggestionGit {
  const repo = deps.config.targetRepoPath;
  const pat = deps.config.pat;

  async function runGit(args: string[], cwd: string, opts: { allowExit?: number[] } = {}): Promise<{ stdout: string; exitCode: number }> {
    const describe = redactPat(`git ${args.join(' ')}`, pat);
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(['git', ...args], {
        cwd,
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' },
      });
    } catch (spawnErr) {
      const msg = spawnErr instanceof Error ? spawnErr.message : String(spawnErr);
      throw new Error(`${describe} failed (spawn error): ${redactPat(msg, pat)}`);
    }
    const stdout = await new Response(proc.stdout as ReadableStream).text();
    const stderr = await new Response(proc.stderr as ReadableStream).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0 && !(opts.allowExit ?? []).includes(exitCode)) {
      throw new Error(`${describe} failed (exit ${exitCode}): ${redactPat(stderr.trim() || stdout.trim() || '(no output)', pat)}`);
    }
    return { stdout, exitCode };
  }

  async function tryRunGit(args: string[], cwd: string): Promise<void> {
    try {
      await runGit(args, cwd);
    } catch {
      // best-effort
    }
  }

  function shortBranch(ref: string): string {
    return ref.replace(/^refs\/heads\//, '');
  }

  async function fetchBranch(ref: string): Promise<void> {
    const short = shortBranch(ref);
    await runGit([...buildGitAuthArgs(pat), 'fetch', 'origin', `+refs/heads/${short}:refs/remotes/origin/${short}`], repo);
  }

  async function addWorktree(path: string, branch: string, start: string): Promise<WorktreeContext> {
    mkdirSync(deps.config.worktreeBase, { recursive: true });
    // Our own leftover from a crashed run: remove it, never prune.
    await tryRunGit(['worktree', 'remove', '--force', '--force', path], repo);
    if (existsSync(path)) rmSync(path, { recursive: true, force: true });
    await runGit(['worktree', 'add', '--force', '--force', '--lock', '-B', branch, path, start], repo);
    return { path, branch, baseSha: start };
  }

  function worktreePath(kind: 'pr' | 'push', a: PrepareArgs): string {
    return resolve(deps.config.worktreeBase, `mutant-${kind}-${a.pullRequestId}-${sha7(a.headCommit)}`);
  }

  return {
    async createPrWorktree(a) {
      await fetchBranch(a.sourceRefName);
      await runGit(['cat-file', '-e', `${a.headCommit}^{commit}`], repo);
      return addWorktree(worktreePath('pr', a), mutantBranchName(a.pullRequestId, a.headCommit), a.headCommit);
    },

    async createPushWorktree(a) {
      await fetchBranch(a.sourceRefName);
      const short = shortBranch(a.sourceRefName);
      const actual = (await runGit(['rev-parse', `refs/remotes/origin/${short}`], repo)).stdout.trim();
      if (actual !== a.headCommit) throw new HeadMovedError(short, a.headCommit, actual);
      return addWorktree(worktreePath('push', a), `mutant-push/pr-${a.pullRequestId}-${sha7(a.headCommit)}`, a.headCommit);
    },

    async headSha(path) {
      return (await runGit(['rev-parse', 'HEAD'], path)).stdout.trim();
    },

    async resetHard(path, sha) {
      await runGit(['reset', '--hard', sha], path);
      await runGit(['clean', '-fd'], path);
    },

    async commitFix(a) {
      const name = deps.config.botGitName;
      const email = deps.config.botGitEmail;
      if (!name || !email) throw new Error('BOT_GIT_NAME and BOT_GIT_EMAIL are required to commit fixes');
      // Whatever the agent committed, and the tracked edits it did not, become
      // one commit with the contract message and the bot identity.
      await runGit(['reset', '--soft', a.baselineSha], a.path);
      await runGit(['add', '-u'], a.path);
      const { exitCode } = await runGit(['diff', '--cached', '--quiet'], a.path, { allowExit: [1] });
      if (exitCode === 0) return null;
      await runGit(['-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit', '--no-verify', '-m', a.message], a.path);
      return (await runGit(['rev-parse', 'HEAD'], a.path)).stdout.trim();
    },

    async push(a) {
      const target = `refs/heads/${a.remoteBranch}`;
      const lease = a.mode === 'pr' ? ['--force'] : [`--force-with-lease=${target}:${a.headCommit}`];
      await runGit([...buildGitAuthArgs(pat), 'push', ...lease, 'origin', `HEAD:${target}`], a.path);
    },

    async removeWorktree(wt) {
      await tryRunGit(['worktree', 'remove', '--force', '--force', wt.path], repo);
      if (existsSync(wt.path)) rmSync(wt.path, { recursive: true, force: true });
      await tryRunGit(['branch', '-D', wt.branch], repo);
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/suggestions/suggestion-git.test.ts && bun run typecheck`
Expected: PASS. If `git worktree add --force --force` with `-B` fails on the git version in use, fix the code and keep the tests.

- [ ] **Step 5: Commit**

```bash
git add src/suggestions/suggestion-git.ts tests/suggestions/suggestion-git.test.ts
git commit -m "feat: git operations for apply-suggestions (no prune, locked worktrees)"
```

---

### Task 4: Prompt for applying one verified fix

**Files:**
- Modify: `src/pipeline/stages/fix-findings.ts` (`FixFindingsStageDeps`, the `buildFixFindingsPrompt` call at line 239)
- Create: `src/suggestions/prompt.ts`, `src/prompts/apply-suggestions.md`
- Test: `tests/pipeline/stages/fix-findings.test.ts`, `tests/suggestions/prompt.test.ts`

**Interfaces:**
- Produces: `FixFindingsStageDeps.buildPrompt?: (args: BuildFixFindingsPromptArgs) => string`, and `buildApplySuggestionPrompt(args: BuildFixFindingsPromptArgs): string`.

- [ ] **Step 1: Write the failing tests**

In `tests/pipeline/stages/fix-findings.test.ts`, inside the `createFixFindingsStage` describe, follow that file's existing stage tests for the runner fake, state and ctx:
```ts
  it('uses the injected prompt builder when given', async () => {
    let seenPrompt = '';
    // build the runner fake the way the neighbouring tests do, capturing opts.prompt into seenPrompt
    const stage = createFixFindingsStage({ /* same deps as neighbouring tests */, buildPrompt: () => 'CUSTOM PROMPT' });
    await stage.execute(/* state with worktree, wiContext, reviewer */, /* ctx */);
    expect(seenPrompt).toBe('CUSTOM PROMPT');
  });
```
Write it concretely by copying the closest existing `createFixFindingsStage` happy-path test and changing only `buildPrompt` and the assertion.

`tests/suggestions/prompt.test.ts`:
```ts
import { describe, it, expect } from 'bun:test';
import { buildApplySuggestionPrompt } from '../../src/suggestions/prompt.ts';
import { suggestionToFinding } from '../../src/suggestions/input.ts';
import { makeInput } from '../helpers/suggestion-input.ts';

const worktree = { path: '/wt/mutant-pr-12345-abc1234', branch: 'mutant/pr-12345-abc1234', baseSha: 'abc' };

function render(line: number | undefined) {
  const s = { ...makeInput().suggestions[0]! };
  if (line === undefined) delete (s as { line?: number }).line;
  return buildApplySuggestionPrompt({
    findings: [suggestionToFinding(s)], diff: '', worktree, workItemId: 12345,
    workItemTitle: 'Mutation fixes for !12345 (run 1003)', skills: [], round: 1, maxRounds: 3,
  });
}

describe('buildApplySuggestionPrompt', () => {
  it('gives file, anchor line, rationale and the code verbatim', () => {
    const p = render(68);
    expect(p).toContain('Continia Banking/base-application-test/Auth/TestAuth.Codeunit.al');
    expect(p).toContain('after line 68');
    expect(p).toContain('Kills mutants: 140, 141');
    expect(p).toContain('        Assert.RecordIsEmpty(TempTarget);');
    expect(p).toContain('Do not push');
  });

  it('says to add a new procedure when there is no line', () => {
    expect(render(undefined)).toContain('new test procedure');
  });

  it('carries none of the reviewer framing', () => {
    const p = render(68);
    expect(p).not.toContain('rejected');
    expect(p).not.toContain('diff under review');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/pipeline/stages/fix-findings.test.ts tests/suggestions/prompt.test.ts`
Expected: FAIL. The custom prompt is not used, and the module `../../src/suggestions/prompt.ts` is missing.

- [ ] **Step 3: Implement**

`src/pipeline/stages/fix-findings.ts`: add to `FixFindingsStageDeps`:
```ts
  /** Prompt builder override. apply-suggestions uses its own; default buildFixFindingsPrompt. */
  buildPrompt?: (args: BuildFixFindingsPromptArgs) => string;
```
and change `const prompt = buildFixFindingsPrompt({` to `const prompt = (deps.buildPrompt ?? buildFixFindingsPrompt)({`.

`src/suggestions/prompt.ts`:
```ts
import type { BuildFixFindingsPromptArgs } from '../pipeline/stages/fix-findings.ts';

/**
 * User prompt for one verified mutation-test fix. Replaces the fix-findings
 * prompt, whose "the reviewer rejected this" framing and diff section do not
 * apply: the fix was written and verified by al-mutation, and the job is to
 * place it.
 */
export function buildApplySuggestionPrompt(args: BuildFixFindingsPromptArgs): string {
  const f = args.findings[0];
  if (!f) throw new Error('buildApplySuggestionPrompt needs exactly one finding');
  const where =
    f.line !== undefined
      ? `Insert the code after line ${f.line} of \`${f.file}\`.`
      : `The code is a new test procedure: add it to the codeunit in \`${f.file}\`.`;
  return [
    `# Apply one verified mutation-test fix — PR !${args.workItemId}: ${args.workItemTitle}`,
    '',
    `The worktree at \`${args.worktree.path}\` (branch \`${args.worktree.branch}\`) is the PR head. Apply the fix below there and commit.`,
    '',
    `## ${f.title}`,
    '',
    where,
    '',
    f.description,
    '',
    '```al',
    f.suggestion ?? '',
    '```',
    '',
    '## Rules',
    '- The code is already verified on a BC environment: it compiles, passes on this code and kills the named mutants. Apply it as given.',
    '- Change it only to make it fit: a missing local variable, a name clash with an existing procedure, indentation.',
    '- If the line no longer matches (the file changed), find the same place by the procedure name and the surrounding code.',
    '- Edit only this file. Do not change other tests and do not refactor.',
    '- Stage the file (git add <file>), then git commit. Do not push.',
    '- Report the fix in `findingsAddressed` as `fixed`, or `declined` with the reason it cannot be applied.',
  ].join('\n');
}
```

`src/prompts/apply-suggestions.md`:
```md
# Apply-suggestions agent

You place AL test code that another tool already wrote and verified. Each
suggestion compiled, passed on the pull request's code and killed specific
mutants on a Business Central environment. Your job is narrow: put it in the
right place, unchanged unless it cannot fit as given, and commit.

## What you do not do

- **Do not rewrite the test logic.** Adjust only what placement needs: a local
  variable declaration, a name clash, indentation.
- **Do not touch other files or tests.**
- **Do not push.** Stage the file with `git add <file>` and commit.
- **Do not touch files outside the worktree.**

## Output

Your last message must be a single JSON object and nothing else:

{
  "summary": "1-2 sentences on where you put the code",
  "filesChanged": ["path/relative/to/worktree.al"],
  "commits": ["<sha>"],
  "findingsAddressed": [
    { "file": "path.al", "line": 68, "action": "fixed", "reason": "inserted after the Init call" }
  ]
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/pipeline/stages/fix-findings.test.ts tests/suggestions/prompt.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/stages/fix-findings.ts src/suggestions/prompt.ts src/prompts/apply-suggestions.md tests/pipeline/stages/fix-findings.test.ts tests/suggestions/prompt.test.ts
git commit -m "feat: prompt for applying one verified mutation fix"
```

---

### Task 5: Suggestion stages and buildSuggestionPipeline

**Files:**
- Create: `src/pipeline/stages/suggestions.ts`
- Modify: `src/services/pipeline-builder.ts` (add `buildSuggestionPipeline` after `buildPipeline`)
- Test: `tests/pipeline/stages/suggestions.test.ts`, `tests/services/pipeline-builder.test.ts`

**Interfaces:**
- Consumes: `SuggestionGit`, `HeadMovedError` (Task 3); input helpers (Task 2); `buildApplySuggestionPrompt` (Task 4); `createFixFindingsStage`.
- Produces:
  - state output keys: `suggestionInput`, `worktree`, `wiContext`, `appliedIds: string[]`, `skippedIds: string[]`, `pushedCommit: string`, `suggestionPr: { id: number; url: string }`
  - `class NothingAppliedError extends Error` (name `'NothingAppliedError'`)
  - `createSuggestionWorktreeStage({ git })` named `'suggestion-worktree'`
  - `createApplyFixesStage({ git, fixFindings })` named `'apply-fixes'`
  - `createPushSuggestionsStage({ git })` named `'push-suggestions'`
  - `createStackedPrStage({ ado })` named `'create-stacked-pr'`
  - `buildSuggestionPipeline(deps: SuggestionPipelineDeps, mode: SuggestionMode): Stage[]`

- [ ] **Step 1: Write the failing tests**

`tests/pipeline/stages/suggestions.test.ts`:
```ts
import { describe, it, expect } from 'bun:test';
import {
  createApplyFixesStage,
  createPushSuggestionsStage,
  createStackedPrStage,
  createSuggestionWorktreeStage,
  NothingAppliedError,
} from '../../../src/pipeline/stages/suggestions.ts';
import type { SuggestionGit } from '../../../src/suggestions/suggestion-git.ts';
import type { Stage, PipelineContext } from '../../../src/pipeline/stage.ts';
import { createInitialState } from '../../../src/pipeline/orchestrator.ts';
import type { AdoClient } from '../../../src/sdk/azure-devops-client.ts';
import type { CreatePullRequestArgs, PipelineState, ReviewerOutput } from '../../../src/types/index.ts';
import { makeTestConfig } from '../../helpers/app-config.ts';
import { makeInput } from '../../helpers/suggestion-input.ts';

const WT = { path: '/wt/x', branch: 'mutant/pr-12345-abc1234', baseSha: 'abc1234def5678abc1234def5678abc1234def56' };

function fakeGit(over: Partial<SuggestionGit> = {}): SuggestionGit & { calls: string[] } {
  const calls: string[] = [];
  let n = 0;
  return {
    calls,
    createPrWorktree: async () => { calls.push('pr-worktree'); return WT; },
    createPushWorktree: async () => { calls.push('push-worktree'); return WT; },
    headSha: async () => `sha${n}`,
    resetHard: async (_p, sha) => { calls.push(`reset ${sha}`); },
    commitFix: async ({ message }) => { calls.push(`commit ${message}`); n++; return `sha${n}`; },
    push: async (a) => { calls.push(`push ${a.mode} ${a.remoteBranch}`); },
    removeWorktree: async () => { calls.push('remove'); },
    ...over,
  };
}

function ctx(dryRun = false): PipelineContext {
  return {
    config: makeTestConfig({}, { dryRun }),
    logger: { info() {}, warn() {}, error() {} },
    abortFlag: { aborted: false },
    signal: new AbortController().signal,
    now: () => new Date('2026-10-07T00:00:00Z'),
  };
}

function stateFor(input = makeInput()): PipelineState {
  const s = createInitialState(input.pullRequestId, 'pr-abc1234');
  s.outputs.suggestionInput = input;
  s.outputs.worktree = WT;
  return s;
}

describe('suggestion-worktree', () => {
  it('uses the pr worktree in pr mode and sets a minimal wiContext', async () => {
    const git = fakeGit();
    const s = createInitialState(12345, 'x');
    s.outputs.suggestionInput = makeInput();
    await createSuggestionWorktreeStage({ git }).execute(s, ctx());
    expect(git.calls).toEqual(['pr-worktree']);
    expect(s.outputs.worktree).toEqual(WT);
    expect((s.outputs.wiContext as { id: number; title: string })).toMatchObject({ id: 12345, title: 'Mutation fixes for !12345 (run 1003)' });
  });

  it('uses the push worktree in push mode', async () => {
    const git = fakeGit();
    const s = createInitialState(12345, 'x');
    s.outputs.suggestionInput = makeInput({ mode: 'push' });
    await createSuggestionWorktreeStage({ git }).execute(s, ctx());
    expect(git.calls).toEqual(['push-worktree']);
  });
});

describe('apply-fixes', () => {
  function twoFixInput() {
    const input = makeInput();
    input.suggestions.push({ ...input.suggestions[0]!, id: 'F002', title: 'F002: t', description: 'Kills mutants: 9' });
    return input;
  }

  it('runs fix-findings once per fix, each with only its own finding, and commits each', async () => {
    const git = fakeGit();
    const seen: string[][] = [];
    const fixFindings: Stage = {
      name: 'fix-findings', canRun: () => true,
      async execute(state) {
        seen.push((state.outputs.reviewer as ReviewerOutput).findings.map((f) => f.title));
        return state;
      },
    };
    const s = stateFor(twoFixInput());
    await createApplyFixesStage({ git, fixFindings }).execute(s, ctx());
    expect(seen).toEqual([['F001: add-assert in SomeTest'], ['F002: t']]);
    expect(git.calls).toEqual([
      'commit test: F001 kill mutants 140, 141 (mutant-fixer run 1003)',
      'commit test: F002 kill mutants 9 (mutant-fixer run 1003)',
    ]);
    expect(s.outputs.appliedIds).toEqual(['F001', 'F002']);
    expect(s.outputs.skippedIds).toEqual([]);
    expect(s.outputs.reviewer).toBeUndefined();
  });

  it('a failing fix is skipped and reset, the next one still applies', async () => {
    const git = fakeGit();
    let i = 0;
    const fixFindings: Stage = {
      name: 'fix-findings', canRun: () => true,
      async execute(state) { if (i++ === 0) throw new Error('agent blew up'); return state; },
    };
    const s = stateFor(twoFixInput());
    await createApplyFixesStage({ git, fixFindings }).execute(s, ctx());
    expect(git.calls[0]).toBe('reset sha0');
    expect(s.outputs.appliedIds).toEqual(['F002']);
    expect(s.outputs.skippedIds).toEqual(['F001']);
  });

  it('a fix that changes nothing is skipped', async () => {
    const git = fakeGit({ commitFix: async () => null });
    const fixFindings: Stage = { name: 'fix-findings', canRun: () => true, execute: async (st) => st };
    const s = stateFor();
    await createApplyFixesStage({ git, fixFindings }).execute(s, ctx());
    expect(s.outputs.skippedIds).toEqual(['F001']);
  });

  it('stops when the cost cap is exceeded', async () => {
    const git = fakeGit();
    const fixFindings: Stage = {
      name: 'fix-findings', canRun: () => true,
      async execute(state) { state.outputs.cost = { total: 999 } as unknown; return state; },
    };
    await expect(createApplyFixesStage({ git, fixFindings }).execute(stateFor(twoFixInput()), ctx())).rejects.toThrow();
  });
});

describe('push-suggestions', () => {
  it('pr mode pushes the mutant branch and records HEAD', async () => {
    const git = fakeGit();
    const s = stateFor();
    s.outputs.appliedIds = ['F001'];
    await createPushSuggestionsStage({ git }).execute(s, ctx());
    expect(git.calls).toEqual(['push pr mutant/pr-12345-abc1234']);
    expect(s.outputs.pushedCommit).toBe('sha0');
  });

  it('push mode pushes to the developer branch', async () => {
    const git = fakeGit();
    const s = stateFor(makeInput({ mode: 'push' }));
    s.outputs.appliedIds = ['F001'];
    await createPushSuggestionsStage({ git }).execute(s, ctx());
    expect(git.calls).toEqual(['push push feature/foo']);
  });

  it('does not push in a dry run', async () => {
    const git = fakeGit();
    const s = stateFor();
    s.outputs.appliedIds = ['F001'];
    await createPushSuggestionsStage({ git }).execute(s, ctx(true));
    expect(git.calls).toEqual([]);
  });

  it('throws NothingAppliedError when no fix applied', async () => {
    const s = stateFor();
    s.outputs.appliedIds = [];
    await expect(createPushSuggestionsStage({ git: fakeGit() }).execute(s, ctx())).rejects.toBeInstanceOf(NothingAppliedError);
  });
});

describe('create-stacked-pr', () => {
  function fakeAdo(seen: CreatePullRequestArgs[]): AdoClient {
    return {
      createPullRequest: async (a: CreatePullRequestArgs) => { seen.push(a); return { id: 12399, url: 'u', sourceRefName: a.sourceRefName, targetRefName: a.targetRefName }; },
    } as unknown as AdoClient;
  }

  it('opens a non-draft PR into the developer branch with the creator as reviewer', async () => {
    const seen: CreatePullRequestArgs[] = [];
    const s = stateFor();
    s.outputs.appliedIds = ['F001'];
    await createStackedPrStage({ ado: fakeAdo(seen) }).execute(s, ctx());
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      repositoryName: 'Continia Banking',
      sourceRefName: 'refs/heads/mutant/pr-12345-abc1234',
      targetRefName: 'refs/heads/feature/foo',
      title: 'Mutation fixes for !12345 (run 1003)',
      isDraft: false,
      reviewers: [{ id: 'guid-creator' }],
    });
    expect(seen[0]!.workItemId).toBeUndefined();
    expect(s.outputs.suggestionPr).toEqual({ id: 12399, url: 'u' });
  });

  it('creates nothing in a dry run', async () => {
    const seen: CreatePullRequestArgs[] = [];
    const s = stateFor();
    s.outputs.appliedIds = ['F001'];
    await createStackedPrStage({ ado: fakeAdo(seen) }).execute(s, ctx(true));
    expect(seen).toHaveLength(0);
  });
});
```

Append to `tests/services/pipeline-builder.test.ts`:
```ts
import { buildSuggestionPipeline } from '../../src/services/pipeline-builder.ts';
import { makeTestConfig } from '../helpers/app-config.ts';

describe('buildSuggestionPipeline', () => {
  const deps = () => ({
    config: makeTestConfig(),
    logger: { info() {}, warn() {}, error() {} },
    ado: {} as never,
    git: {} as never,
    runner: {} as never,
    discoveredSkills: [],
    promptTemplate: 'x',
  });

  it('pr mode: worktree, apply, push, stacked PR', () => {
    expect(buildSuggestionPipeline(deps(), 'pr').map((s) => s.name)).toEqual([
      'suggestion-worktree', 'apply-fixes', 'push-suggestions', 'create-stacked-pr',
    ]);
  });

  it('push mode: no PR stage', () => {
    expect(buildSuggestionPipeline(deps(), 'push').map((s) => s.name)).toEqual([
      'suggestion-worktree', 'apply-fixes', 'push-suggestions',
    ]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/pipeline/stages/suggestions.test.ts tests/services/pipeline-builder.test.ts`
Expected: FAIL. The suggestions stages module is missing, and `buildSuggestionPipeline` is not exported.

- [ ] **Step 3: Implement**

`src/pipeline/stages/suggestions.ts`:
```ts
import type { Stage } from '../stage.ts';
import type { ReviewerOutput, WorktreeContext } from '../../types/index.ts';
import { CostExceededError } from '../../types/index.ts';
import type { AdoClient } from '../../sdk/azure-devops-client.ts';
import type { WorkItemContext } from '../../services/wi-context.ts';
import type { SuggestionGit } from '../../suggestions/suggestion-git.ts';
import {
  buildStackedPrDescription,
  commitMessage,
  mutantBranchName,
  stackedPrTitle,
  suggestionToFinding,
  type SuggestionInput,
} from '../../suggestions/input.ts';
import { assertWithinCostCap } from '../../utils/cost-tracker.ts';

/** No fix produced a change: nothing to push. Reported as ok:false, not a crash. */
export class NothingAppliedError extends Error {
  override readonly name = 'NothingAppliedError';
  constructor() {
    super('nothing-applied');
  }
}

function inputOf(state: { outputs: Record<string, unknown> }): SuggestionInput {
  const input = state.outputs.suggestionInput as SuggestionInput | undefined;
  if (!input) throw new Error('suggestion stages require state.outputs.suggestionInput');
  return input;
}

function worktreeOf(state: { outputs: Record<string, unknown> }): WorktreeContext {
  const wt = state.outputs.worktree as WorktreeContext | undefined;
  if (!wt) throw new Error('suggestion stages require state.outputs.worktree');
  return wt;
}

export function createSuggestionWorktreeStage(deps: { git: SuggestionGit }): Stage {
  return {
    name: 'suggestion-worktree',
    canRun: () => true,
    async execute(state) {
      const input = inputOf(state);
      const args = { pullRequestId: input.pullRequestId, headCommit: input.headCommit, sourceRefName: input.sourceRefName };
      state.outputs.worktree =
        input.mode === 'pr' ? await deps.git.createPrWorktree(args) : await deps.git.createPushWorktree(args);
      // fix-findings reads only id and title; the rest exists to satisfy the type.
      state.outputs.wiContext = {
        id: input.pullRequestId,
        title: stackedPrTitle(input),
        workItemType: 'Pull Request',
        state: 'active',
        description: '',
        reproSteps: '',
        acceptanceCriteria: '',
        images: [],
        comments: [],
      } satisfies WorkItemContext;
      return state;
    },
  };
}

/**
 * One fix-findings run per fix id, then one commit per fix: the contract asks
 * for a commit per id with a fixed message, and the agent's own commits carry
 * neither. A fix the agent fails on or leaves unchanged is skipped and the
 * worktree reset, so one bad fix does not cost the others.
 */
export function createApplyFixesStage(deps: { git: SuggestionGit; fixFindings: Stage }): Stage {
  return {
    name: 'apply-fixes',
    canRun: () => true,
    async execute(state, ctx) {
      const input = inputOf(state);
      const wt = worktreeOf(state);
      const applied: string[] = [];
      const skipped: string[] = [];
      for (const s of input.suggestions) {
        const baseline = await deps.git.headSha(wt.path);
        state.outputs.reviewer = { approved: false, findings: [suggestionToFinding(s)], attempts: 0 } satisfies ReviewerOutput;
        let sha: string | null = null;
        try {
          await deps.fixFindings.execute(state, ctx);
          sha = await deps.git.commitFix({ path: wt.path, baselineSha: baseline, message: commitMessage(input, s) });
        } catch (err) {
          if (ctx.signal.aborted || err instanceof CostExceededError) throw err;
          ctx.logger.warn(`apply-suggestions: ${s.id} failed, skipping :: ${err instanceof Error ? err.message : String(err)}`);
          await deps.git.resetHard(wt.path, baseline);
        }
        (sha ? applied : skipped).push(s.id);
        assertWithinCostCap(state, ctx.config.maxCostUsdPerWi, 'apply-fixes');
      }
      delete state.outputs.reviewer;
      state.outputs.appliedIds = applied;
      state.outputs.skippedIds = skipped;
      return state;
    },
  };
}

export function createPushSuggestionsStage(deps: { git: SuggestionGit }): Stage {
  return {
    name: 'push-suggestions',
    canRun: () => true,
    async execute(state, ctx) {
      const input = inputOf(state);
      const wt = worktreeOf(state);
      if (((state.outputs.appliedIds as string[] | undefined) ?? []).length === 0) throw new NothingAppliedError();
      state.outputs.pushedCommit = await deps.git.headSha(wt.path);
      if (ctx.config.dryRun) return state;
      await deps.git.push({
        path: wt.path,
        mode: input.mode,
        remoteBranch: input.mode === 'pr' ? mutantBranchName(input.pullRequestId, input.headCommit) : input.sourceRefName.replace(/^refs\/heads\//, ''),
        headCommit: input.headCommit,
      });
      return state;
    },
  };
}

export function createStackedPrStage(deps: { ado: AdoClient }): Stage {
  return {
    name: 'create-stacked-pr',
    canRun: () => true,
    async execute(state, ctx) {
      if (ctx.config.dryRun) return state;
      const input = inputOf(state);
      const applied = (state.outputs.appliedIds as string[] | undefined) ?? [];
      const pr = await deps.ado.createPullRequest(
        {
          repositoryName: input.repository,
          sourceRefName: `refs/heads/${mutantBranchName(input.pullRequestId, input.headCommit)}`,
          targetRefName: input.sourceRefName,
          title: stackedPrTitle(input),
          description: buildStackedPrDescription(input, applied),
          isDraft: false,
          reviewers: [{ id: input.reviewerId }],
        },
        { signal: ctx.signal },
      );
      state.outputs.suggestionPr = { id: pr.id, url: pr.url };
      return state;
    },
  };
}
```

`src/services/pipeline-builder.ts`: add imports
```ts
import type { SuggestionGit } from '../suggestions/suggestion-git.ts';
import type { SuggestionMode } from '../suggestions/input.ts';
import { buildApplySuggestionPrompt } from '../suggestions/prompt.ts';
import {
  createApplyFixesStage,
  createPushSuggestionsStage,
  createStackedPrStage,
  createSuggestionWorktreeStage,
} from '../pipeline/stages/suggestions.ts';
```
a constant next to the other prompt paths
```ts
const APPLY_SUGGESTIONS_PROMPT_PATH = `${import.meta.dir}/../prompts/apply-suggestions.md`;
```
and at the end of the file:
```ts
export interface SuggestionPipelineDeps {
  config: AppConfig;
  logger: Logger;
  ado: AdoClient;
  git: SuggestionGit;
  runner?: AgentRunner;
  discoveredSkills?: DiscoveredSkill[];
  /** System-prompt append override. Default reads src/prompts/apply-suggestions.md. */
  promptTemplate?: string;
}

/**
 * apply-suggestions: [suggestion-worktree, apply-fixes, push-suggestions,
 * (pr) create-stacked-pr]. The fixes were verified by al-mutation on a BC
 * environment, so there is no analyzer, reviewer, test-author or
 * build-and-test. Worktree removal runs in the caller's finally, because the
 * orchestrator stops at the first failing stage.
 */
export function buildSuggestionPipeline(deps: SuggestionPipelineDeps, mode: SuggestionMode): Stage[] {
  const runner = deps.runner ?? createClaudeAgentRunner({ config: deps.config, logger: deps.logger });
  const fixFindings = createFixFindingsStage({
    config: deps.config,
    runner,
    promptTemplate: deps.promptTemplate ?? readFileSync(APPLY_SUGGESTIONS_PROMPT_PATH, 'utf-8'),
    discoveredSkills: deps.discoveredSkills ?? discoverTargetRepoSkills(deps.config.targetRepoPath),
    buildPrompt: buildApplySuggestionPrompt,
    getCurrentHeadSha: (p) => deps.git.headSha(p),
    resetWorktree: (p, sha) => deps.git.resetHard(p, sha),
  });
  return [
    createSuggestionWorktreeStage({ git: deps.git }),
    createApplyFixesStage({ git: deps.git, fixFindings }),
    createPushSuggestionsStage({ git: deps.git }),
    ...(mode === 'pr' ? [createStackedPrStage({ ado: deps.ado })] : []),
  ];
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/pipeline/stages/suggestions.test.ts tests/services/pipeline-builder.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/stages/suggestions.ts src/services/pipeline-builder.ts tests/pipeline/stages/suggestions.test.ts tests/services/pipeline-builder.test.ts
git commit -m "feat: suggestion pipeline stages for pr and push modes"
```

---

### Task 6: Runner, config loading and the CLI command

**Files:**
- Create: `src/services/apply-suggestions.ts`
- Modify: `src/cli/index.ts` (help text, `case 'apply-suggestions'`, `runApplySuggestionsCommand`)
- Test: `tests/services/apply-suggestions.test.ts`, `tests/integration/apply-suggestions-cli.test.ts`

**Interfaces:**
- Consumes: everything above; `runPipeline` and `createInitialState` from `src/pipeline/orchestrator.ts`; `PipelineStateStore`.
- Produces:
```ts
export interface SuggestionOutcome { ok: boolean; branch: string | null; pushedCommit: string | null; pullRequestId: number | null; appliedIds: string[]; skippedIds: string[]; error: string | null }
export const DEFAULT_SUGGESTION_COST_CAP_USD = 20;
export function failureOutcome(error: string, partial?: Partial<SuggestionOutcome>): SuggestionOutcome
export function loadSuggestionConfig(env: Record<string, string | undefined>, input: SuggestionInput): AppConfig
export async function applySuggestions(deps: { config; logger; input; git; stages; store; now? }): Promise<SuggestionOutcome>
```

- [ ] **Step 1: Write the failing tests**

`tests/services/apply-suggestions.test.ts`:
```ts
import { describe, it, expect } from 'bun:test';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { applySuggestions, loadSuggestionConfig } from '../../src/services/apply-suggestions.ts';
import { HeadMovedError, type SuggestionGit } from '../../src/suggestions/suggestion-git.ts';
import { NothingAppliedError } from '../../src/pipeline/stages/suggestions.ts';
import { PipelineStateStore } from '../../src/state/state-store.ts';
import type { Stage } from '../../src/pipeline/stage.ts';
import { MIN_ENV, makeTestConfig } from '../helpers/app-config.ts';
import { makeInput } from '../helpers/suggestion-input.ts';

const WT = { path: '/wt/x', branch: 'mutant/pr-12345-abc1234', baseSha: 'b' };
const logger = { info() {}, warn() {}, error() {} };

function gitSpy(): SuggestionGit & { removed: unknown[] } {
  const removed: unknown[] = [];
  return { removed, removeWorktree: async (wt: unknown) => { removed.push(wt); } } as unknown as SuggestionGit & { removed: unknown[] };
}

function stage(name: string, fn: (o: Record<string, unknown>) => void): Stage {
  return { name, canRun: () => true, async execute(s) { fn(s.outputs); return s; } };
}

function run(stages: Stage[], opts: { dryRun?: boolean; mode?: 'pr' | 'push' } = {}) {
  const git = gitSpy();
  const config = makeTestConfig({ STATE_DIR: mkdtempSync(join(tmpdir(), 'sugg-')) }, { dryRun: opts.dryRun ?? false });
  return {
    git,
    outcome: applySuggestions({
      config, logger, input: makeInput({ mode: opts.mode ?? 'pr' }), git, stages,
      store: new PipelineStateStore(join(config.stateDir, 'suggestions')),
    }),
  };
}

const happy = [
  stage('suggestion-worktree', (o) => { o.worktree = WT; }),
  stage('apply-fixes', (o) => { o.appliedIds = ['F001']; o.skippedIds = ['F002']; }),
  stage('push-suggestions', (o) => { o.pushedCommit = 'c0ffee'; }),
  stage('create-stacked-pr', (o) => { o.suggestionPr = { id: 12399, url: 'u' }; }),
];

describe('applySuggestions', () => {
  it('pr mode: ok outcome with branch, commit, PR id; worktree removed', async () => {
    const { git, outcome } = run(happy);
    expect(await outcome).toEqual({
      ok: true, branch: 'refs/heads/mutant/pr-12345-abc1234', pushedCommit: 'c0ffee',
      pullRequestId: 12399, appliedIds: ['F001'], skippedIds: ['F002'], error: null,
    });
    expect(git.removed).toEqual([WT]);
  });

  it('push mode: branch is the developer branch and there is no PR id', async () => {
    const { outcome } = run(happy.slice(0, 3), { mode: 'push' });
    const o = await outcome;
    expect(o.branch).toBe('refs/heads/feature/foo');
    expect(o.pullRequestId).toBeNull();
  });

  it('head moved: ok false, error head-moved, nothing to remove', async () => {
    const { git, outcome } = run([
      { name: 'suggestion-worktree', canRun: () => true, execute: async () => { throw new HeadMovedError('feature/foo', 'a', 'b'); } },
    ], { mode: 'push' });
    expect(await outcome).toMatchObject({ ok: false, error: 'head-moved', appliedIds: [], pushedCommit: null });
    expect(git.removed).toEqual([]);
  });

  it('nothing applied: ok false with the skipped ids', async () => {
    const { outcome } = run([
      happy[0]!,
      stage('apply-fixes', (o) => { o.appliedIds = []; o.skippedIds = ['F001']; }),
      { name: 'push-suggestions', canRun: () => true, execute: async () => { throw new NothingAppliedError(); } },
    ]);
    expect(await outcome).toMatchObject({ ok: false, error: 'nothing-applied', skippedIds: ['F001'] });
  });

  it('other failures: ok false naming the stage, PAT redacted', async () => {
    const { git, outcome } = run([
      happy[0]!,
      { name: 'apply-fixes', canRun: () => true, execute: async () => { throw new Error(`boom ${MIN_ENV.AZURE_DEVOPS_PAT}`); } },
    ]);
    const o = await outcome;
    expect(o.ok).toBe(false);
    expect(o.error).toStartWith('apply-fixes: boom');
    expect(o.error).not.toContain(MIN_ENV.AZURE_DEVOPS_PAT);
    expect(git.removed).toEqual([WT]);
  });

  it('dry run keeps the worktree and reports no pushed commit', async () => {
    const { git, outcome } = run(happy, { dryRun: true });
    const o = await outcome;
    expect(o.ok).toBe(true);
    expect(o.pushedCommit).toBeNull();
    expect(o.pullRequestId).toBeNull();
    expect(git.removed).toEqual([]);
  });
});

describe('loadSuggestionConfig', () => {
  const env = { ...MIN_ENV, BOT_GIT_NAME: 'Bot', BOT_GIT_EMAIL: 'bot@x' };

  it('needs neither ADO_REPOSITORY_NAME, MAX_COST_USD_PER_WI nor CONTINIA_API_TOKEN', () => {
    const { ADO_REPOSITORY_NAME: _r, MAX_COST_USD_PER_WI: _m, SKIP_BUILD_TEST: _s, ...rest } = env;
    const c = loadSuggestionConfig(rest, makeInput());
    expect(c.repositoryName).toBe('Continia Banking');
    expect(c.skipBuildTest).toBe(true);
    expect(c.maxCostUsdPerWi).toBe(20);
  });

  it('keeps an explicit MAX_COST_USD_PER_WI', () => {
    expect(loadSuggestionConfig({ ...env, MAX_COST_USD_PER_WI: '7' }, makeInput()).maxCostUsdPerWi).toBe(7);
  });

  it('sizes the apply-fixes timeout by the number of fixes', () => {
    const input = makeInput();
    input.suggestions.push({ ...input.suggestions[0]!, id: 'F002' });
    const c = loadSuggestionConfig(env, input);
    expect(c.stageTimeoutMs['apply-fixes']).toBe(2 * c.stageTimeoutMs['fix-findings']!);
  });

  it('requires BOT_GIT_NAME and BOT_GIT_EMAIL', () => {
    expect(() => loadSuggestionConfig({ ...env, BOT_GIT_EMAIL: '' }, makeInput())).toThrow(/BOT_GIT_EMAIL/);
  });
});
```

`tests/integration/apply-suggestions-cli.test.ts`:
```ts
import { describe, it, expect } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const CLI = join(import.meta.dir, '..', '..', 'src', 'cli', 'index.ts');

async function cli(args: string[]): Promise<{ code: number; stdout: string }> {
  try {
    const { stdout } = await execFileAsync('bun', ['run', CLI, ...args], { encoding: 'utf-8' });
    return { code: 0, stdout };
  } catch (err) {
    const e = err as { code?: number; stdout?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? '' };
  }
}

describe('apply-suggestions CLI', () => {
  it('prints ok:false JSON as the last line and exits 0 for invalid input', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sugg-cli-'));
    const file = join(dir, 'in.json');
    writeFileSync(file, JSON.stringify({ mode: 'nope' }), 'utf-8');
    const { code, stdout } = await cli(['apply-suggestions', '--input', file]);
    expect(code).toBe(0);
    const last = stdout.trim().split('\n').at(-1)!;
    const outcome = JSON.parse(last) as { ok: boolean; error: string };
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toStartWith('invalid-input:');
  });

  it('exits non-zero without --input', async () => {
    expect((await cli(['apply-suggestions'])).code).not.toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/services/apply-suggestions.test.ts tests/integration/apply-suggestions-cli.test.ts`
Expected: FAIL. The module is missing, and the CLI prints `Unknown command: apply-suggestions` with exit 1.

- [ ] **Step 3: Implement**

`src/services/apply-suggestions.ts`:
```ts
import { loadConfig } from '../config/index.ts';
import { createInitialState, runPipeline } from '../pipeline/orchestrator.ts';
import type { Stage } from '../pipeline/stage.ts';
import { NothingAppliedError } from '../pipeline/stages/suggestions.ts';
import type { PipelineStateStore } from '../state/state-store.ts';
import { mutantBranchName, sha7, type SuggestionInput } from '../suggestions/input.ts';
import { HeadMovedError, type SuggestionGit } from '../suggestions/suggestion-git.ts';
import type { AppConfig, WorktreeContext } from '../types/index.ts';
import { redactPat } from '../utils/git-auth.ts';
import type { Logger } from '../utils/logger.ts';

/** The JSON mutant-fixer reads from the last stdout line. */
export interface SuggestionOutcome {
  ok: boolean;
  branch: string | null;
  pushedCommit: string | null;
  pullRequestId: number | null;
  appliedIds: string[];
  skippedIds: string[];
  error: string | null;
}

/** One fix costs a single fix-findings call; 20 USD covers a large run. */
export const DEFAULT_SUGGESTION_COST_CAP_USD = 20;

export function failureOutcome(error: string, partial: Partial<SuggestionOutcome> = {}): SuggestionOutcome {
  return { ok: false, branch: null, pushedCommit: null, pullRequestId: null, appliedIds: [], skippedIds: [], ...partial, error };
}

/**
 * The full pipeline's config with the watcher-only parts filled in: the
 * repository comes from the input, build-and-test is off (al-mutation already
 * verified the fixes on BC), and the cost cap has a default.
 */
export function loadSuggestionConfig(env: Record<string, string | undefined>, input: SuggestionInput): AppConfig {
  const config = loadConfig({
    ...env,
    ADO_REPOSITORY_NAME: input.repository,
    SKIP_BUILD_TEST: 'true',
    MAX_COST_USD_PER_WI: env.MAX_COST_USD_PER_WI?.trim() || String(DEFAULT_SUGGESTION_COST_CAP_USD),
  });
  const missing = [
    ['BOT_GIT_NAME', config.botGitName],
    ['BOT_GIT_EMAIL', config.botGitEmail],
  ].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length > 0) {
    throw new Error(`Invalid configuration:\n${missing.map((k) => `  - ${k}: required for apply-suggestions`).join('\n')}`);
  }
  const fixBudget = config.stageTimeoutMs['fix-findings'] ?? 1_800_000;
  config.stageTimeoutMs = {
    ...config.stageTimeoutMs,
    'suggestion-worktree': 300_000,
    'apply-fixes': input.suggestions.length * fixBudget,
    'push-suggestions': 300_000,
    'create-stacked-pr': 120_000,
  };
  return config;
}

export interface ApplySuggestionsDeps {
  config: AppConfig;
  logger: Logger;
  input: SuggestionInput;
  git: SuggestionGit;
  stages: Stage[];
  store: PipelineStateStore;
  now?: () => Date;
}

export async function applySuggestions(deps: ApplySuggestionsDeps): Promise<SuggestionOutcome> {
  const { config, input } = deps;
  const now = deps.now ?? (() => new Date());
  const state = createInitialState(input.pullRequestId, `${input.mode}-${sha7(input.headCommit)}`, now());
  state.outputs.suggestionInput = input;
  const ids = () => ({
    appliedIds: (state.outputs.appliedIds as string[] | undefined) ?? [],
    skippedIds: (state.outputs.skippedIds as string[] | undefined) ?? [],
  });
  try {
    await runPipeline({
      stages: deps.stages,
      state,
      context: { config, logger: deps.logger, abortFlag: { aborted: false }, signal: new AbortController().signal, now },
      store: deps.store,
    });
    const pr = state.outputs.suggestionPr as { id: number } | undefined;
    return {
      ok: true,
      branch: input.mode === 'pr' ? `refs/heads/${mutantBranchName(input.pullRequestId, input.headCommit)}` : input.sourceRefName,
      pushedCommit: config.dryRun ? null : ((state.outputs.pushedCommit as string | undefined) ?? null),
      pullRequestId: pr?.id ?? null,
      ...ids(),
      error: null,
    };
  } catch (err) {
    if (err instanceof HeadMovedError) return failureOutcome('head-moved');
    if (err instanceof NothingAppliedError) return failureOutcome('nothing-applied', ids());
    const stage = state.terminalError?.stage ?? 'apply-suggestions';
    const message = redactPat(err instanceof Error ? err.message : String(err), config.pat);
    return failureOutcome(`${stage}: ${message}`, ids());
  } finally {
    const wt = state.outputs.worktree as WorktreeContext | undefined;
    if (wt && !config.dryRun) {
      try {
        await deps.git.removeWorktree(wt);
      } catch (err) {
        deps.logger.warn(`apply-suggestions: worktree removal failed :: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}
```

`src/cli/index.ts`:
- Help text, after the `run-wi` line:
```
  bun run src/cli/index.ts apply-suggestions --input <file> [--dry-run]
                                      Apply mutant-fixer's verified test fixes to a PR
                                      (last stdout line: JSON outcome)
```
- Add imports:
```ts
import { readFileSync } from 'fs';  // merge into the existing 'fs' import
import { applySuggestions, failureOutcome, loadSuggestionConfig } from '../services/apply-suggestions.ts';
import { parseSuggestionInput } from '../suggestions/input.ts';
import { createSuggestionGit } from '../suggestions/suggestion-git.ts';
import { buildSuggestionPipeline } from '../services/pipeline-builder.ts';  // merge into the existing import
```
- Switch case before `experiment`:
```ts
    case 'apply-suggestions': {
      await runApplySuggestionsCommand();
      return;
    }
```
- Function after `flagValue`:
```ts
/**
 * mutant-fixer's handover. Expected failures print an ok:false outcome and
 * exit 0; only a crash (bad config, unreadable file) exits non-zero. The JSON
 * is printed last, after every log line, because the logger writes to stdout.
 */
async function runApplySuggestionsCommand(): Promise<void> {
  const inputPath = flagValue('--input');
  if (!inputPath) {
    console.error('apply-suggestions requires --input <file>');
    process.exitCode = 1;
    return;
  }
  const parsed = parseSuggestionInput(readFileSync(inputPath, 'utf-8'));
  if (!parsed.ok) {
    console.log(JSON.stringify(failureOutcome(parsed.error)));
    return;
  }
  const input = parsed.input;
  const config = loadSuggestionConfig(process.env, input);
  if (process.argv.includes('--dry-run')) config.dryRun = true;
  const logger = createLogger('apply-suggestions');
  const ado = createAdoClient(config);
  const git = createSuggestionGit({ config });
  const outcome = await applySuggestions({
    config,
    logger,
    input,
    git,
    stages: buildSuggestionPipeline({ config, logger, ado, git }, input.mode),
    store: new PipelineStateStore(join(config.stateDir, 'suggestions')),
  });
  console.log(JSON.stringify(outcome));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/services/apply-suggestions.test.ts tests/integration/apply-suggestions-cli.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Run the whole suite**

Run: `bun test && bun run typecheck`
Expected: all pass, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/services/apply-suggestions.ts src/cli/index.ts tests/services/apply-suggestions.test.ts tests/integration/apply-suggestions-cli.test.ts
git commit -m "feat: apply-suggestions CLI command"
```

---

### Task 7: Docs, then the live dry run

**Files:**
- Modify: `README.md` (Commands section line 96, Local setup / VM sections), `CLAUDE.md` (command list near line 129), `.env.example`
- Modify (mutant-fixer repo): `docs/handover/devopscoder-apply-suggestions.md` (add a "Status" section like the al-mutation brief has)

- [ ] **Step 1: Document**

- `.env.example`: add
```
# apply-suggestions (mutant-fixer handover): commit author for the fixes.
# mutant-fixer must list BOT_GIT_EMAIL in its BOT_IDENTITIES.
# BOT_GIT_NAME=DevOpsCoder Bot
# BOT_GIT_EMAIL=devopscoder-bot@example.com
```
- `README.md`, Commands: the `apply-suggestions` line. Add a short "apply-suggestions" section covering:
  - input and output contract: a link to mutant-fixer's brief;
  - variables it needs: `AZURE_DEVOPS_PAT`, `AZURE_DEVOPS_ORG`, `AZURE_DEVOPS_PROJECT`, `TARGET_REPO_PATH`, `WORKTREE_BASE`, `BOT_GIT_NAME`, `BOT_GIT_EMAIL`, with optional `STATE_DIR` and `MAX_COST_USD_PER_WI` (default 20);
  - variables it ignores: `ADO_REPOSITORY_NAME`, which comes from the input, and `SKIP_BUILD_TEST`, which is forced on;
  - state lives in `STATE_DIR/suggestions/<prId>.json`;
  - it never prunes worktrees.
- `CLAUDE.md`: the command line next to `run-wi`.
- mutant-fixer brief: a "Status (2026-10-07)" section with the branch, the env var names, the `nothing-applied` error and the 20 USD default cost cap.

- [ ] **Step 2: Commit both repos**

```bash
git add README.md CLAUDE.md .env.example
git commit -m "docs: apply-suggestions command"
```
In mutant-fixer:
```bash
git add docs/handover/devopscoder-apply-suggestions.md
git commit -m "docs: DevOpsCoder apply-suggestions status"
```

- [ ] **Step 3: Live dry run (Done-when 2)**

You need a real draft PR in Continia Banking that mutant-fixer would pick, and a local `.env` with the bot PAT plus `BOT_GIT_*`. Ask the user for the PR id if none is known. Write a hand-made input file in the scratchpad: `mode: "pr"`, the PR's head commit, one trivial suggestion (for example a comment line in a test codeunit), and `reviewerId` = the PR creator's id. Then run:

`bun run src/cli/index.ts apply-suggestions --input <file> --dry-run`

Expected: the last line is `{"ok":true,"branch":"refs/heads/mutant/pr-<id>-<sha7>","pushedCommit":null,"pullRequestId":null,"appliedIds":["F001"],...}`. The worktree under `WORKTREE_BASE` shows one bot commit per fix (`git log --format='%an %s'`). Afterwards, remove the worktree with `git worktree remove --force --force <path>` and delete the branch.

- [ ] **Step 4: Non-dry `pr` run (Done-when 3)**

Ask the user first. This pushes a branch and opens a PR on ADO. Only on a test PR the user names. Expected: a non-draft PR into the developer's branch, with the creator as reviewer.
