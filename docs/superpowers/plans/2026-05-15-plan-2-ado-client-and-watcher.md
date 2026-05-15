# DevopsCoder — Plan 2: ADO REST Client + Watcher Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the orchestrator skeleton from Plan 1 to a real Azure DevOps REST client and a polling watcher loop so that `bun run start` connects to ADO, finds work items tagged `agent implement`, runs each through the pipeline (still empty in this plan), removes the trigger tag on completion, and persists state. After Plan 2 the service runs end-to-end on real work items — but the pipeline itself does no AI/code work yet (Plans 3-5 fill in real stages).

**Architecture:** Mirror the sibling `DevOpsInvestigateWorkItems` layout: `src/sdk/azure-devops-client.ts` for REST, `src/services/watcher.ts` for the polling loop, `src/services/processor.ts` for the per-WI processing, and a `src/services/pipeline-builder.ts` factory that returns the stage list (empty array in this plan; Plans 3-5 replace the body). Concurrency is bounded by a hand-rolled async pool in `src/utils/pool.ts` so the only dependency added is conceptual, not on a new package. Dependency injection via interfaces (`AdoClient`, `Processor`, `WatcherDeps`) keeps every layer unit-testable with `bun:test` mocks — no `globalThis.fetch` monkey-patching, no real network calls in tests.

**Tech Stack:** Native Bun `fetch` for HTTP, Zod for ADO response shape validation, `bun:test` for tests. No new package dependencies.

**Scope (this plan):**
- ADO REST client: PAT auth, retries with exponential backoff on 5xx, WIQL query by tag with assigned-to filter, `getWorkItem`, `addTagToWorkItem`, `removeTagFromWorkItem`, `addWorkItemComment`.
- Concurrency pool helper.
- Pipeline builder factory (returns empty `Stage[]` — Plans 3-5 add stages).
- Per-WI processor: load/create state → run pipeline → handle outcome (remove trigger tag on completed, add blocked tag on failure, leave state untouched on pause).
- Polling watcher loop: `runPollCycle` + long-running `startWatcher`, concurrency-bounded, graceful SIGINT/SIGTERM via shared `AbortFlag`.
- CLI: real `watch` / `run-once`, plus `run-wi <id>`, `reset-state <id>`, `debug-tags`.
- Integration test: mock ADO + empty pipeline + real state store + real watcher cycle, end-to-end.
- README / CLAUDE.md / PATTERNS.md updates.

**Out of scope (later plans):**
- Worktree manager and `git worktree add/remove` (Plan 3).
- Analyzer / coder / test-author / reviewer / draft-PR-creator stages (Plans 3-5).
- Multi-target-repo support — `TARGET_REPO_PATH` is still a single path in this plan.
- Real ADO writes inside the pipeline — only the watcher's tag I/O and the processor's outcome handling touch ADO.

---

## File Structure

Files created or modified by this plan:

| Path | Responsibility |
|------|----------------|
| `src/types/index.ts` | **Modify** — add `WorkItem`, `WorkItemListResponse`, `ProcessOutcome`, `CycleStats`. |
| `src/sdk/azure-devops-client.ts` | **Create** — `AdoClient` interface, `createAdoClient(config, fetchImpl?)`, `AzureDevOpsError`. |
| `src/utils/pool.ts` | **Create** — `runPool(items, n, worker)` — bounded-parallel async worker pool. |
| `src/services/pipeline-builder.ts` | **Create** — `buildPipeline(deps)` factory returning `Stage[]` (empty array in Plan 2). |
| `src/services/processor.ts` | **Create** — `createProcessor(deps)` returning `{ processWorkItem(id) }`. |
| `src/services/watcher.ts` | **Create** — `runPollCycle(deps)`, `startWatcher(deps)`, `createAbortFlag()`. |
| `src/cli/index.ts` | **Modify** — replace placeholders with real `watch` / `run-once`; add `run-wi`, `reset-state`, `debug-tags`; `--dry-run` flag. |
| `tests/sdk/azure-devops-client.test.ts` | **Create** — ADO client spec (~15 tests with mock fetch). |
| `tests/utils/pool.test.ts` | **Create** — pool spec (4 tests). |
| `tests/services/pipeline-builder.test.ts` | **Create** — 1 test confirming empty stage list. |
| `tests/services/processor.test.ts` | **Create** — processor spec (6 tests). |
| `tests/services/watcher.test.ts` | **Create** — watcher spec (7 tests). |
| `tests/integration/watcher-e2e.test.ts` | **Create** — end-to-end mock-ADO watcher test (3 tests). |
| `CLAUDE.md` | **Modify** — note that the watcher is wired; mark Plan 2 done in scope section. |
| `README.md` | **Modify** — replace "placeholder" wording for `bun run start` / `bun run once`. |
| `PATTERNS.md` | **Modify** — add ADO-client + watcher + concurrency-pool patterns. |

Expected test count after this plan: **59 (from Plan 1) + 35 (new) = 94** tests across **16** files.

---

## Conventions used throughout this plan

- **Imports use `.ts` extensions** (`import { foo } from '../utils/logger.ts'`) — required by `verbatimModuleSyntax: true`.
- **`type` imports use the `type` keyword.**
- **Test framework:** `bun:test` with `describe`, `it`, `expect`, `mock`, `beforeEach`, `afterEach`.
- **Conventional commits:** `feat:`, `fix:`, `test:`, `chore:`, `docs:` prefixes.
- **Run all bash/PowerShell commands from the repo root** (`C:\GeneralDev\DevOpsPullers\DevOpsCoder`).
- **Mock injection:** SDK tests inject a `fetch`-shaped mock via the `fetchImpl` parameter on `createAdoClient`. Service tests inject `AdoClient`, `PipelineStateStore`, `buildPipeline`, and `Processor` shapes as plain objects satisfying the interface — no `globalThis` mutation.
- **No real network in tests.** Any test that would call `fetch` without a mock is a bug.
- **Strict TS caveats** (carried from Plan 1's pitfall memory): `mock.calls[i]?.[N]` requires either a typed mock generic or a cast. Use typed mocks where possible.

---

## Task 1: Extend shared types

**Files:**
- Modify: `src/types/index.ts`

Add the ADO response shapes and the processor/watcher result types so every downstream file references one source of truth.

- [ ] **Step 1: Append the new types to `src/types/index.ts`**

Open `src/types/index.ts` and append (after the existing `PipelineState` block) exactly:

```typescript
export interface WorkItemReference {
  id: number;
  url?: string;
}

export interface WiqlQueryResponse {
  workItems: WorkItemReference[];
}

export interface WorkItemFields {
  'System.Title'?: string;
  'System.State'?: string;
  'System.Tags'?: string;
  'System.AssignedTo'?: { displayName?: string; uniqueName?: string } | string;
}

export interface WorkItem {
  id: number;
  rev?: number;
  fields: WorkItemFields;
  url?: string;
}

export interface CommentResponse {
  id?: number;
  text?: string;
  createdDate?: string;
}

export type ProcessOutcome =
  | { kind: 'completed'; workItemId: number }
  | { kind: 'paused'; workItemId: number; stage: string }
  | { kind: 'failed'; workItemId: number; error: PipelineTerminalError }
  | { kind: 'skipped'; workItemId: number; reason: string };

export interface CycleStats {
  considered: number;
  completed: number;
  paused: number;
  failed: number;
  skipped: number;
}
```

- [ ] **Step 2: Typecheck**

```powershell
bun run typecheck
```

Expected: PASS, exit 0.

- [ ] **Step 3: Commit**

```powershell
git add src/types/index.ts
git commit -m "feat(types): add ADO response + ProcessOutcome + CycleStats types"
```

---

## Task 2: ADO REST client

**Files:**
- Create: `src/sdk/azure-devops-client.ts`
- Test: `tests/sdk/azure-devops-client.test.ts`

A single module exporting an `AdoClient` interface and a `createAdoClient(config, fetchImpl?)` factory. The factory accepts an injected `fetchImpl` (defaulting to `globalThis.fetch`) so unit tests pass a mock without touching globals.

Endpoints used (all api-version 7.1):
- `POST {orgUrl}/{project}/_apis/wit/wiql?api-version=7.1` — WIQL query (returns `WiqlQueryResponse`).
- `GET {orgUrl}/_apis/wit/workitems/{id}?api-version=7.1&fields=System.Title,System.State,System.Tags,System.AssignedTo` — fetch one WI.
- `PATCH {orgUrl}/_apis/wit/workitems/{id}?api-version=7.1` — update `System.Tags` (used by add/remove tag).
- `POST {orgUrl}/{project}/_apis/wit/workItems/{id}/comments?api-version=7.1-preview.3` — add comment.

Auth header: `Authorization: Basic <base64(":" + pat)>`.

Retry policy: `adoFetchWithRetry` retries on 5xx with delays `[1000, 2000, 4000]` ms (default), no retry on 4xx, returns parsed JSON. Plain `adoFetch` is the no-retry primitive used internally.

- [ ] **Step 1: Write the failing test file**

Create `tests/sdk/azure-devops-client.test.ts`:

```typescript
import { describe, it, expect, mock, beforeEach } from 'bun:test';
import {
  createAdoClient,
  AzureDevOpsError,
} from '../../src/sdk/azure-devops-client.ts';
import type { AppConfig } from '../../src/types/index.ts';

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    org: 'my-org',
    orgUrl: 'https://dev.azure.com/my-org',
    project: 'my-project',
    pat: 'test-pat',
    targetRepoPath: '/repos/x',
    worktreeBase: '/repos/.worktrees',
    triggerTag: 'agent implement',
    blockedTag: 'agent-blocked',
    needInputTag: 'need-input',
    pollIntervalMinutes: 5,
    concurrency: 1,
    maxRevisions: 3,
    maxRejectCycles: 3,
    claudeModel: 'claude-opus-4-7',
    stateDir: '.state',
    assignedToFilter: [],
    dryRun: false,
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('createAdoClient', () => {
  let calls: { url: string; init?: RequestInit }[];
  let fetchMock: ReturnType<typeof mock>;

  beforeEach(() => {
    calls = [];
  });

  function setupFetch(responses: Response[] | ((url: string, init?: RequestInit) => Response)): typeof globalThis.fetch {
    fetchMock = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const u = typeof url === 'string' ? url : url.toString();
      calls.push({ url: u, init });
      if (Array.isArray(responses)) {
        const next = responses.shift();
        if (!next) throw new Error('mock fetch: no more responses queued');
        return next.clone();
      }
      return responses(u, init).clone();
    });
    return fetchMock as unknown as typeof globalThis.fetch;
  }

  describe('queryWorkItemsByTag', () => {
    it('POSTs WIQL with the trigger tag and returns work item IDs', async () => {
      const fetchImpl = setupFetch([
        jsonResponse(200, { workItems: [{ id: 101 }, { id: 102 }] }),
      ]);
      const client = createAdoClient(makeConfig(), fetchImpl);
      const ids = await client.queryWorkItemsByTag('agent implement');
      expect(ids).toEqual([101, 102]);
      expect(calls).toHaveLength(1);
      const call = calls[0]!;
      expect(call.url).toBe(
        'https://dev.azure.com/my-org/my-project/_apis/wit/wiql?api-version=7.1',
      );
      expect(call.init?.method).toBe('POST');
      const body = JSON.parse(call.init?.body as string) as { query: string };
      expect(body.query).toContain("[System.Tags] CONTAINS 'agent implement'");
      expect(body.query).toContain("[System.State] NOT IN");
    });

    it('includes assigned-to filter when configured', async () => {
      const fetchImpl = setupFetch([jsonResponse(200, { workItems: [] })]);
      const client = createAdoClient(
        makeConfig({ assignedToFilter: ['Alice Smith', "O'Brien"] }),
        fetchImpl,
      );
      await client.queryWorkItemsByTag('agent implement');
      const body = JSON.parse(calls[0]!.init?.body as string) as { query: string };
      expect(body.query).toContain("[System.AssignedTo] IN ('Alice Smith', 'O''Brien')");
    });

    it('omits assigned-to filter when list is empty', async () => {
      const fetchImpl = setupFetch([jsonResponse(200, { workItems: [] })]);
      const client = createAdoClient(makeConfig(), fetchImpl);
      await client.queryWorkItemsByTag('agent implement');
      const body = JSON.parse(calls[0]!.init?.body as string) as { query: string };
      expect(body.query).not.toContain('System.AssignedTo');
    });

    it('escapes single quotes in the tag', async () => {
      const fetchImpl = setupFetch([jsonResponse(200, { workItems: [] })]);
      const client = createAdoClient(makeConfig(), fetchImpl);
      await client.queryWorkItemsByTag("agent's tag");
      const body = JSON.parse(calls[0]!.init?.body as string) as { query: string };
      expect(body.query).toContain("agent''s tag");
    });
  });

  describe('getWorkItem', () => {
    it('GETs the work item and returns id + fields', async () => {
      const fetchImpl = setupFetch([
        jsonResponse(200, {
          id: 101,
          rev: 4,
          fields: { 'System.Title': 'Fix login', 'System.Tags': 'agent implement; bug' },
        }),
      ]);
      const client = createAdoClient(makeConfig(), fetchImpl);
      const wi = await client.getWorkItem(101);
      expect(wi.id).toBe(101);
      expect(wi.fields['System.Title']).toBe('Fix login');
      expect(calls[0]!.url).toBe(
        'https://dev.azure.com/my-org/_apis/wit/workitems/101?api-version=7.1&fields=System.Title,System.State,System.Tags,System.AssignedTo',
      );
      expect(calls[0]!.init?.method ?? 'GET').toBe('GET');
    });

    it('sends the Basic auth header derived from the PAT', async () => {
      const fetchImpl = setupFetch([jsonResponse(200, { id: 1, fields: {} })]);
      const client = createAdoClient(makeConfig({ pat: 'secret' }), fetchImpl);
      await client.getWorkItem(1);
      const headers = new Headers(calls[0]!.init?.headers);
      const expected = `Basic ${Buffer.from(':secret').toString('base64')}`;
      expect(headers.get('authorization')).toBe(expected);
    });
  });

  describe('removeTagFromWorkItem', () => {
    it('fetches current tags, filters case-insensitively, PATCHes the rest', async () => {
      const fetchImpl = setupFetch([
        jsonResponse(200, {
          id: 101,
          fields: { 'System.Tags': 'Agent Implement; bug; urgent' },
        }),
        jsonResponse(200, { id: 101, fields: {} }),
      ]);
      const client = createAdoClient(makeConfig(), fetchImpl);
      await client.removeTagFromWorkItem(101, 'agent implement');
      expect(calls).toHaveLength(2);
      expect(calls[1]!.url).toContain('/_apis/wit/workitems/101?api-version=7.1');
      expect(calls[1]!.init?.method).toBe('PATCH');
      const headers = new Headers(calls[1]!.init?.headers);
      expect(headers.get('content-type')).toBe('application/json-patch+json');
      const patch = JSON.parse(calls[1]!.init?.body as string) as {
        op: string;
        path: string;
        value: string;
      }[];
      expect(patch).toHaveLength(1);
      expect(patch[0]!.op).toBe('add');
      expect(patch[0]!.path).toBe('/fields/System.Tags');
      expect(patch[0]!.value).toBe('bug; urgent');
    });

    it('is a no-op (no PATCH) when the tag is not present', async () => {
      const fetchImpl = setupFetch([
        jsonResponse(200, { id: 101, fields: { 'System.Tags': 'bug; urgent' } }),
      ]);
      const client = createAdoClient(makeConfig(), fetchImpl);
      await client.removeTagFromWorkItem(101, 'agent implement');
      expect(calls).toHaveLength(1);
    });
  });

  describe('addTagToWorkItem', () => {
    it('appends the tag to existing System.Tags', async () => {
      const fetchImpl = setupFetch([
        jsonResponse(200, { id: 101, fields: { 'System.Tags': 'bug' } }),
        jsonResponse(200, { id: 101, fields: {} }),
      ]);
      const client = createAdoClient(makeConfig(), fetchImpl);
      await client.addTagToWorkItem(101, 'agent-blocked');
      const patch = JSON.parse(calls[1]!.init?.body as string) as { value: string }[];
      expect(patch[0]!.value).toBe('bug; agent-blocked');
    });

    it('is a no-op when the tag is already present (case-insensitive)', async () => {
      const fetchImpl = setupFetch([
        jsonResponse(200, { id: 101, fields: { 'System.Tags': 'BUG; Agent-Blocked' } }),
      ]);
      const client = createAdoClient(makeConfig(), fetchImpl);
      await client.addTagToWorkItem(101, 'agent-blocked');
      expect(calls).toHaveLength(1);
    });
  });

  describe('addWorkItemComment', () => {
    it('POSTs HTML to the comments endpoint with preview api-version', async () => {
      const fetchImpl = setupFetch([
        jsonResponse(201, { id: 999, text: '<p>hi</p>' }),
      ]);
      const client = createAdoClient(makeConfig(), fetchImpl);
      await client.addWorkItemComment(101, '<p>hi</p>');
      expect(calls[0]!.url).toBe(
        'https://dev.azure.com/my-org/my-project/_apis/wit/workItems/101/comments?api-version=7.1-preview.3',
      );
      expect(calls[0]!.init?.method).toBe('POST');
      const body = JSON.parse(calls[0]!.init?.body as string) as { text: string };
      expect(body.text).toBe('<p>hi</p>');
    });
  });

  describe('error + retry behaviour', () => {
    it('throws AzureDevOpsError with statusCode on 4xx', async () => {
      const fetchImpl = setupFetch([
        new Response('unauthorized', { status: 401 }),
      ]);
      const client = createAdoClient(makeConfig(), fetchImpl);
      let caught: unknown;
      try {
        await client.getWorkItem(101);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(AzureDevOpsError);
      expect((caught as AzureDevOpsError).statusCode).toBe(401);
    });

    it('retries 5xx responses up to 3 times then surfaces the last error', async () => {
      const fetchImpl = setupFetch([
        new Response('boom', { status: 500 }),
        new Response('boom', { status: 502 }),
        new Response('boom', { status: 503 }),
        new Response('boom', { status: 504 }),
      ]);
      const client = createAdoClient(makeConfig(), fetchImpl, [0, 0, 0]);
      let caught: unknown;
      try {
        await client.getWorkItem(101);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(AzureDevOpsError);
      expect((caught as AzureDevOpsError).statusCode).toBe(504);
      expect(calls).toHaveLength(4);
    });

    it('recovers when a transient 5xx is followed by a 2xx', async () => {
      const fetchImpl = setupFetch([
        new Response('boom', { status: 503 }),
        jsonResponse(200, { id: 101, fields: { 'System.Title': 'ok' } }),
      ]);
      const client = createAdoClient(makeConfig(), fetchImpl, [0, 0, 0]);
      const wi = await client.getWorkItem(101);
      expect(wi.fields['System.Title']).toBe('ok');
      expect(calls).toHaveLength(2);
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```powershell
bun test tests/sdk/azure-devops-client.test.ts
```

Expected: FAIL with `Cannot find module '../../src/sdk/azure-devops-client.ts'`.

- [ ] **Step 3: Create `src/sdk/azure-devops-client.ts`**

```typescript
import type {
  AppConfig,
  WiqlQueryResponse,
  WorkItem,
} from '../types/index.ts';

export class AzureDevOpsError extends Error {
  override readonly name = 'AzureDevOpsError';
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
  }
}

export interface AdoClient {
  queryWorkItemsByTag(tag: string): Promise<number[]>;
  getWorkItem(workItemId: number): Promise<WorkItem>;
  addTagToWorkItem(workItemId: number, tag: string): Promise<void>;
  removeTagFromWorkItem(workItemId: number, tag: string): Promise<void>;
  addWorkItemComment(workItemId: number, html: string): Promise<void>;
}

const DEFAULT_RETRY_DELAYS_MS = [1000, 2000, 4000];

function authHeader(pat: string): string {
  return `Basic ${Buffer.from(`:${pat}`).toString('base64')}`;
}

function escapeWiql(s: string): string {
  return s.replace(/'/g, "''");
}

function splitTags(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(';')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

function joinTags(tags: string[]): string {
  return tags.join('; ');
}

function hasTagCi(tags: string[], needle: string): boolean {
  const n = needle.toLowerCase();
  return tags.some((t) => t.toLowerCase() === n);
}

export function createAdoClient(
  config: AppConfig,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
  retryDelaysMs: number[] = DEFAULT_RETRY_DELAYS_MS,
): AdoClient {
  async function adoFetch(path: string, init?: RequestInit): Promise<Response> {
    const url = `${config.orgUrl}${path}`;
    const headers = new Headers(init?.headers ?? {});
    headers.set('Authorization', authHeader(config.pat));
    if (init?.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    headers.set('Accept', 'application/json');
    return fetchImpl(url, { ...init, headers });
  }

  async function adoFetchWithRetry<T>(
    path: string,
    init?: RequestInit,
  ): Promise<T> {
    const attempts = retryDelaysMs.length + 1;
    let lastErr: AzureDevOpsError | null = null;
    for (let i = 0; i < attempts; i++) {
      const response = await adoFetch(path, init);
      if (response.ok) {
        if (response.status === 204) return undefined as T;
        return (await response.json()) as T;
      }
      const text = await response.text();
      lastErr = new AzureDevOpsError(
        `ADO ${init?.method ?? 'GET'} ${path} failed (${response.status}): ${text}`,
        response.status,
      );
      if (response.status < 500 || response.status >= 600) throw lastErr;
      const delay = retryDelaysMs[i];
      if (i < attempts - 1 && delay !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw lastErr!;
  }

  return {
    async queryWorkItemsByTag(tag: string): Promise<number[]> {
      const tagLit = `'${escapeWiql(tag)}'`;
      const filterClause =
        config.assignedToFilter.length > 0
          ? ` AND [System.AssignedTo] IN (${config.assignedToFilter
              .map((n) => `'${escapeWiql(n)}'`)
              .join(', ')})`
          : '';
      const query = [
        'SELECT [System.Id] FROM WorkItems',
        `WHERE [System.Tags] CONTAINS ${tagLit}`,
        `  AND [System.State] NOT IN ('Resolved', 'Closed', 'Removed')${filterClause}`,
      ].join('\n');
      const result = await adoFetchWithRetry<WiqlQueryResponse>(
        `/${encodeURIComponent(config.project)}/_apis/wit/wiql?api-version=7.1`,
        { method: 'POST', body: JSON.stringify({ query }) },
      );
      return result.workItems.map((w) => w.id);
    },

    async getWorkItem(workItemId: number): Promise<WorkItem> {
      return adoFetchWithRetry<WorkItem>(
        `/_apis/wit/workitems/${workItemId}?api-version=7.1&fields=System.Title,System.State,System.Tags,System.AssignedTo`,
      );
    },

    async addTagToWorkItem(workItemId: number, tag: string): Promise<void> {
      const wi = await this.getWorkItem(workItemId);
      const tags = splitTags(wi.fields['System.Tags']);
      if (hasTagCi(tags, tag)) return;
      tags.push(tag);
      await adoFetchWithRetry(
        `/_apis/wit/workitems/${workItemId}?api-version=7.1`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json-patch+json' },
          body: JSON.stringify([
            { op: 'add', path: '/fields/System.Tags', value: joinTags(tags) },
          ]),
        },
      );
    },

    async removeTagFromWorkItem(workItemId: number, tag: string): Promise<void> {
      const wi = await this.getWorkItem(workItemId);
      const tags = splitTags(wi.fields['System.Tags']);
      if (!hasTagCi(tags, tag)) return;
      const n = tag.toLowerCase();
      const updated = tags.filter((t) => t.toLowerCase() !== n);
      await adoFetchWithRetry(
        `/_apis/wit/workitems/${workItemId}?api-version=7.1`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json-patch+json' },
          body: JSON.stringify([
            { op: 'add', path: '/fields/System.Tags', value: joinTags(updated) },
          ]),
        },
      );
    },

    async addWorkItemComment(workItemId: number, html: string): Promise<void> {
      await adoFetchWithRetry(
        `/${encodeURIComponent(config.project)}/_apis/wit/workItems/${workItemId}/comments?api-version=7.1-preview.3`,
        { method: 'POST', body: JSON.stringify({ text: html }) },
      );
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```powershell
bun test tests/sdk/azure-devops-client.test.ts
```

Expected: PASS, 14 tests.

- [ ] **Step 5: Typecheck**

```powershell
bun run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add src/sdk/azure-devops-client.ts tests/sdk/azure-devops-client.test.ts
git commit -m "feat(sdk): add Azure DevOps REST client with retry and tag ops"
```

---

## Task 3: Concurrency pool helper

**Files:**
- Create: `src/utils/pool.ts`
- Test: `tests/utils/pool.test.ts`

A small async worker pool: `runPool(items, n, worker)` spawns up to `n` workers that pull from a shared queue. Each worker awaits its `worker(item)` call serially; the pool resolves when the queue is empty and all workers have finished. Worker errors do **not** abort the pool — they are caught, recorded in the returned `errors` array, and the pool keeps draining (this matches the sibling watcher's "isolate per-item failures" behaviour).

- [ ] **Step 1: Write the failing test**

Create `tests/utils/pool.test.ts`:

```typescript
import { describe, it, expect } from 'bun:test';
import { runPool } from '../../src/utils/pool.ts';

describe('runPool', () => {
  it('processes every item exactly once', async () => {
    const items = [1, 2, 3, 4, 5];
    const seen: number[] = [];
    const result = await runPool(items, 2, async (n) => {
      seen.push(n);
    });
    expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect(result.errors).toEqual([]);
  });

  it('runs at most N items concurrently', async () => {
    let active = 0;
    let peak = 0;
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    await runPool(items, 3, async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  it('isolates worker errors and continues draining the queue', async () => {
    const items = [1, 2, 3, 4];
    const succeeded: number[] = [];
    const result = await runPool(items, 2, async (n) => {
      if (n === 2) throw new Error(`fail-${n}`);
      succeeded.push(n);
    });
    expect(succeeded.sort((a, b) => a - b)).toEqual([1, 3, 4]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.item).toBe(2);
    expect((result.errors[0]?.error as Error).message).toBe('fail-2');
  });

  it('handles empty input without spawning workers', async () => {
    const result = await runPool<number>([], 4, async () => {
      throw new Error('should not run');
    });
    expect(result.errors).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```powershell
bun test tests/utils/pool.test.ts
```

Expected: FAIL with `Cannot find module '../../src/utils/pool.ts'`.

- [ ] **Step 3: Create `src/utils/pool.ts`**

```typescript
export interface PoolError<T> {
  item: T;
  error: unknown;
}

export interface PoolResult<T> {
  errors: PoolError<T>[];
}

export async function runPool<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<PoolResult<T>> {
  const queue = [...items];
  const errors: PoolError<T>[] = [];
  const workerCount = Math.max(1, Math.min(concurrency, queue.length));
  if (queue.length === 0) return { errors };

  const drainOne = async (): Promise<void> => {
    while (queue.length > 0) {
      const item = queue.shift() as T;
      try {
        await worker(item);
      } catch (error) {
        errors.push({ item, error });
      }
    }
  };

  const runners: Promise<void>[] = [];
  for (let i = 0; i < workerCount; i++) runners.push(drainOne());
  await Promise.all(runners);
  return { errors };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```powershell
bun test tests/utils/pool.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```powershell
git add src/utils/pool.ts tests/utils/pool.test.ts
git commit -m "feat(utils): add bounded-parallel async runPool helper"
```

---

## Task 4: Pipeline builder factory

**Files:**
- Create: `src/services/pipeline-builder.ts`
- Test: `tests/services/pipeline-builder.test.ts`

A single factory function that returns the list of stages a pipeline will run for one WI. In Plan 2 it returns `[]` (empty pipeline → orchestrator immediately marks `completedAt`). Plans 3-5 replace the body with the real stage chain. The processor and the watcher both depend on this factory via injection so the wiring is locked in now.

- [ ] **Step 1: Write the failing test**

Create `tests/services/pipeline-builder.test.ts`:

```typescript
import { describe, it, expect } from 'bun:test';
import { buildPipeline } from '../../src/services/pipeline-builder.ts';
import { createLogger } from '../../src/utils/logger.ts';
import type { AdoClient } from '../../src/sdk/azure-devops-client.ts';
import type { AppConfig } from '../../src/types/index.ts';

const config = {
  org: 'o',
  orgUrl: 'https://x',
  project: 'p',
  pat: 'pat',
  targetRepoPath: '/r',
  worktreeBase: '/w',
  triggerTag: 'agent implement',
  blockedTag: 'agent-blocked',
  needInputTag: 'need-input',
  pollIntervalMinutes: 5,
  concurrency: 1,
  maxRevisions: 3,
  maxRejectCycles: 3,
  claudeModel: 'claude-opus-4-7',
  stateDir: '.state',
  assignedToFilter: [],
  dryRun: false,
} satisfies AppConfig;

const ado: AdoClient = {
  queryWorkItemsByTag: async () => [],
  getWorkItem: async () => ({ id: 0, fields: {} }),
  addTagToWorkItem: async () => {},
  removeTagFromWorkItem: async () => {},
  addWorkItemComment: async () => {},
};

describe('buildPipeline', () => {
  it('returns an empty stage list until Plan 3 wires the analyzer', () => {
    const stages = buildPipeline({ config, logger: createLogger(), ado });
    expect(stages).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```powershell
bun test tests/services/pipeline-builder.test.ts
```

Expected: FAIL with `Cannot find module '../../src/services/pipeline-builder.ts'`.

- [ ] **Step 3: Create `src/services/pipeline-builder.ts`**

```typescript
import type { Stage } from '../pipeline/stage.ts';
import type { AppConfig } from '../types/index.ts';
import type { AdoClient } from '../sdk/azure-devops-client.ts';
import type { Logger } from '../utils/logger.ts';

export interface PipelineBuilderDeps {
  config: AppConfig;
  logger: Logger;
  ado: AdoClient;
}

export function buildPipeline(_deps: PipelineBuilderDeps): Stage[] {
  // Plans 3-5 fill this in: analyzer, coder, revision loop, test author, reviewer, draft PR.
  return [];
}
```

- [ ] **Step 4: Run the test to verify it passes**

```powershell
bun test tests/services/pipeline-builder.test.ts
```

Expected: PASS, 1 test.

- [ ] **Step 5: Commit**

```powershell
git add src/services/pipeline-builder.ts tests/services/pipeline-builder.test.ts
git commit -m "feat(services): add buildPipeline factory (empty for Plan 2)"
```

---

## Task 5: Per-WI processor

**Files:**
- Create: `src/services/processor.ts`
- Test: `tests/services/processor.test.ts`

The processor handles one WI from start to terminal-state. It:

1. Fetches the WI (lets caller skip on 404/wrong state).
2. Loads existing state from the store, or creates a fresh one via `createInitialState(id, slug)`.
3. Builds the pipeline via `buildPipeline(deps)`.
4. Calls `runPipeline({ stages, state, context, store })`.
5. Inspects the resulting state and ADO-side effects:
   - `state.completedAt` set → `removeTagFromWorkItem(id, triggerTag)`, return `{ kind: 'completed' }`.
   - `state.currentStage != null && state.history` ends in `pause` → return `{ kind: 'paused', stage }`. No ADO write — the checkpoint stage is responsible for any "what's missing" comment.
   - Threw a non-pause error → `state.terminalError` set by orchestrator → `addTagToWorkItem(id, blockedTag)`, return `{ kind: 'failed', error }`.

If `config.dryRun` is true, suppress all ADO writes (no tag add/remove, no comment). Still run the pipeline and persist state — dry-run is a write filter, not a read filter.

Skip outcomes:
- Work item not found (404 from `getWorkItem`) → `{ kind: 'skipped', reason: 'not-found' }`.
- Work item state is one of Resolved / Closed / Removed → `{ kind: 'skipped', reason: 'closed-state' }`.
- AbortFlag aborted before any work → `{ kind: 'skipped', reason: 'aborted' }`.

- [ ] **Step 1: Write the failing test**

Create `tests/services/processor.test.ts`:

```typescript
import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { createProcessor } from '../../src/services/processor.ts';
import { PipelineStateStore } from '../../src/state/state-store.ts';
import { createLogger } from '../../src/utils/logger.ts';
import { PipelinePauseError } from '../../src/pipeline/stage.ts';
import type { AdoClient } from '../../src/sdk/azure-devops-client.ts';
import type { AppConfig, WorkItem } from '../../src/types/index.ts';
import type { Stage } from '../../src/pipeline/stage.ts';

const baseConfig = {
  org: 'o',
  orgUrl: 'https://x',
  project: 'p',
  pat: 'pat',
  targetRepoPath: '/r',
  worktreeBase: '/w',
  triggerTag: 'agent implement',
  blockedTag: 'agent-blocked',
  needInputTag: 'need-input',
  pollIntervalMinutes: 5,
  concurrency: 1,
  maxRevisions: 3,
  maxRejectCycles: 3,
  claudeModel: 'claude-opus-4-7',
  stateDir: '.state',
  assignedToFilter: [],
  dryRun: false,
} satisfies AppConfig;

function makeAdo(overrides: Partial<AdoClient> = {}): AdoClient {
  return {
    queryWorkItemsByTag: mock(async () => []),
    getWorkItem: mock(async () =>
      ({
        id: 101,
        fields: {
          'System.Title': 'Fix login',
          'System.State': 'Active',
          'System.Tags': 'agent implement',
        },
      }) satisfies WorkItem,
    ),
    addTagToWorkItem: mock(async () => {}),
    removeTagFromWorkItem: mock(async () => {}),
    addWorkItemComment: mock(async () => {}),
    ...overrides,
  };
}

describe('createProcessor', () => {
  let dir: string;
  let store: PipelineStateStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'proc-'));
    store = new PipelineStateStore(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('runs an empty pipeline, sets completedAt, and removes the trigger tag', async () => {
    const ado = makeAdo();
    const proc = createProcessor({
      config: baseConfig,
      logger: createLogger(),
      ado,
      store,
      buildPipeline: () => [],
      abortFlag: { aborted: false },
    });
    const outcome = await proc.processWorkItem(101);
    expect(outcome.kind).toBe('completed');
    const state = store.load(101)!;
    expect(state.completedAt).toBeTruthy();
    expect(ado.removeTagFromWorkItem).toHaveBeenCalledWith(101, 'agent implement');
    expect(ado.addTagToWorkItem).not.toHaveBeenCalled();
  });

  it('skips when getWorkItem throws a 404-shaped AzureDevOpsError', async () => {
    class FakeAdoError extends Error {
      readonly statusCode = 404;
    }
    const ado = makeAdo({
      getWorkItem: mock(async () => {
        throw new FakeAdoError('not found');
      }),
    });
    const proc = createProcessor({
      config: baseConfig,
      logger: createLogger(),
      ado,
      store,
      buildPipeline: () => [],
      abortFlag: { aborted: false },
    });
    const outcome = await proc.processWorkItem(101);
    expect(outcome).toEqual({ kind: 'skipped', workItemId: 101, reason: 'not-found' });
    expect(store.load(101)).toBeNull();
  });

  it('skips when the work item is in a closed state', async () => {
    const ado = makeAdo({
      getWorkItem: mock(async () => ({
        id: 101,
        fields: { 'System.Title': 't', 'System.State': 'Closed' },
      })),
    });
    const proc = createProcessor({
      config: baseConfig,
      logger: createLogger(),
      ado,
      store,
      buildPipeline: () => [],
      abortFlag: { aborted: false },
    });
    const outcome = await proc.processWorkItem(101);
    expect(outcome).toEqual({ kind: 'skipped', workItemId: 101, reason: 'closed-state' });
  });

  it('returns paused and does NOT remove the trigger tag when a stage pauses', async () => {
    const pauseStage: Stage = {
      name: 'await-human',
      canRun: () => true,
      execute: async (state) => {
        state.currentStage = 'await-human';
        throw new PipelinePauseError('waiting for human input');
      },
    };
    const ado = makeAdo();
    const proc = createProcessor({
      config: baseConfig,
      logger: createLogger(),
      ado,
      store,
      buildPipeline: () => [pauseStage],
      abortFlag: { aborted: false },
    });
    const outcome = await proc.processWorkItem(101);
    expect(outcome).toEqual({ kind: 'paused', workItemId: 101, stage: 'await-human' });
    expect(ado.removeTagFromWorkItem).not.toHaveBeenCalled();
    expect(ado.addTagToWorkItem).not.toHaveBeenCalled();
  });

  it('returns failed and adds the blocked tag on terminal error', async () => {
    const boomStage: Stage = {
      name: 'boom',
      canRun: () => true,
      execute: async () => {
        throw new Error('exploded');
      },
    };
    const ado = makeAdo();
    const proc = createProcessor({
      config: baseConfig,
      logger: createLogger(),
      ado,
      store,
      buildPipeline: () => [boomStage],
      abortFlag: { aborted: false },
    });
    const outcome = await proc.processWorkItem(101);
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(outcome.error.stage).toBe('boom');
      expect(outcome.error.message).toBe('exploded');
    }
    expect(ado.addTagToWorkItem).toHaveBeenCalledWith(101, 'agent-blocked');
    expect(ado.removeTagFromWorkItem).not.toHaveBeenCalled();
  });

  it('suppresses ADO writes when dryRun is true', async () => {
    const ado = makeAdo();
    const proc = createProcessor({
      config: { ...baseConfig, dryRun: true },
      logger: createLogger(),
      ado,
      store,
      buildPipeline: () => [],
      abortFlag: { aborted: false },
    });
    const outcome = await proc.processWorkItem(101);
    expect(outcome.kind).toBe('completed');
    expect(ado.removeTagFromWorkItem).not.toHaveBeenCalled();
    expect(ado.addTagToWorkItem).not.toHaveBeenCalled();
    expect(store.load(101)?.completedAt).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```powershell
bun test tests/services/processor.test.ts
```

Expected: FAIL with `Cannot find module '../../src/services/processor.ts'`.

- [ ] **Step 3: Create `src/services/processor.ts`**

```typescript
import type { AppConfig, ProcessOutcome } from '../types/index.ts';
import type { Logger } from '../utils/logger.ts';
import type { AdoClient } from '../sdk/azure-devops-client.ts';
import type { PipelineStateStore } from '../state/state-store.ts';
import type { Stage, AbortFlag } from '../pipeline/stage.ts';
import { createInitialState, runPipeline } from '../pipeline/orchestrator.ts';
import { slugify } from '../utils/slug.ts';
import type { PipelineBuilderDeps } from './pipeline-builder.ts';

export interface ProcessorDeps {
  config: AppConfig;
  logger: Logger;
  ado: AdoClient;
  store: PipelineStateStore;
  buildPipeline: (deps: PipelineBuilderDeps) => Stage[];
  abortFlag: AbortFlag;
}

export interface Processor {
  processWorkItem(workItemId: number): Promise<ProcessOutcome>;
}

const CLOSED_STATES = new Set(['Resolved', 'Closed', 'Removed']);

function hasStatusCode(err: unknown, code: number): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'statusCode' in err &&
    (err as { statusCode: unknown }).statusCode === code
  );
}

export function createProcessor(deps: ProcessorDeps): Processor {
  const { config, logger, ado, store, buildPipeline, abortFlag } = deps;

  return {
    async processWorkItem(workItemId: number): Promise<ProcessOutcome> {
      if (abortFlag.aborted) {
        return { kind: 'skipped', workItemId, reason: 'aborted' };
      }

      let workItem;
      try {
        workItem = await ado.getWorkItem(workItemId);
      } catch (err) {
        if (hasStatusCode(err, 404)) {
          return { kind: 'skipped', workItemId, reason: 'not-found' };
        }
        throw err;
      }

      const wiState = workItem.fields['System.State'];
      if (wiState && CLOSED_STATES.has(wiState)) {
        return { kind: 'skipped', workItemId, reason: 'closed-state' };
      }

      const title = workItem.fields['System.Title'] ?? `wi-${workItemId}`;
      const state =
        store.load(workItemId) ?? createInitialState(workItemId, slugify(title));
      store.save(state);

      const stages = buildPipeline({ config, logger, ado });
      const context = {
        config,
        logger,
        abortFlag,
        now: () => new Date(),
      };

      try {
        const final = await runPipeline({ stages, state, context, store });
        if (final.completedAt) {
          if (!config.dryRun) {
            await ado.removeTagFromWorkItem(workItemId, config.triggerTag);
          }
          return { kind: 'completed', workItemId };
        }
        const last = final.history[final.history.length - 1];
        const pausedStage = last?.outcome === 'pause' ? last.stage : (final.currentStage ?? 'unknown');
        return { kind: 'paused', workItemId, stage: pausedStage };
      } catch (err) {
        const persisted = store.load(workItemId);
        const terminalError =
          persisted?.terminalError ?? {
            stage: persisted?.currentStage ?? 'unknown',
            message: err instanceof Error ? err.message : String(err),
            at: new Date().toISOString(),
          };
        if (!config.dryRun) {
          try {
            await ado.addTagToWorkItem(workItemId, config.blockedTag);
          } catch (tagErr) {
            logger.error(
              `failed to add blocked tag to WI ${workItemId}`,
              tagErr,
            );
          }
        }
        return { kind: 'failed', workItemId, error: terminalError };
      }
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```powershell
bun test tests/services/processor.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Typecheck**

```powershell
bun run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add src/services/processor.ts tests/services/processor.test.ts
git commit -m "feat(services): add per-WI processor with outcome dispatch"
```

---

## Task 6: Polling watcher loop

**Files:**
- Create: `src/services/watcher.ts`
- Test: `tests/services/watcher.test.ts`

The watcher exposes three things:
- `createAbortFlag(): AbortFlag` — a tiny factory used by the CLI to share an abort flag with both the watcher loop and the processor context.
- `runPollCycle(deps): Promise<CycleStats>` — one cycle. Queries ADO for trigger-tagged WIs, unions with `store.listResumable()` (so an in-progress pipeline keeps running even if the human removed the tag mid-flight), dispatches each through the processor via `runPool`, and aggregates outcomes into `CycleStats`.
- `startWatcher(deps): Promise<void>` — long-running loop. Repeats `runPollCycle` every `pollIntervalMinutes`. Wires SIGINT/SIGTERM to the abort flag and returns cleanly after the in-flight cycle finishes.

Resume semantics: if a WI appears in `listResumable()` but not in the tag query (e.g. the human removed `agent implement` after work started, or the trigger tag was already removed by a previous cycle that crashed before deleting state), we still process it — pipelines run to completion or pause, not "until the tag stays applied".

- [ ] **Step 1: Write the failing test**

Create `tests/services/watcher.test.ts`:

```typescript
import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  runPollCycle,
  createAbortFlag,
} from '../../src/services/watcher.ts';
import { PipelineStateStore } from '../../src/state/state-store.ts';
import { createLogger } from '../../src/utils/logger.ts';
import type { AppConfig, ProcessOutcome } from '../../src/types/index.ts';
import type { AdoClient } from '../../src/sdk/azure-devops-client.ts';
import type { Processor } from '../../src/services/processor.ts';

const baseConfig = {
  org: 'o',
  orgUrl: 'https://x',
  project: 'p',
  pat: 'pat',
  targetRepoPath: '/r',
  worktreeBase: '/w',
  triggerTag: 'agent implement',
  blockedTag: 'agent-blocked',
  needInputTag: 'need-input',
  pollIntervalMinutes: 5,
  concurrency: 2,
  maxRevisions: 3,
  maxRejectCycles: 3,
  claudeModel: 'claude-opus-4-7',
  stateDir: '.state',
  assignedToFilter: [],
  dryRun: false,
} satisfies AppConfig;

function makeAdo(ids: number[]): AdoClient {
  return {
    queryWorkItemsByTag: mock(async () => ids),
    getWorkItem: mock(async () => ({ id: 0, fields: {} })),
    addTagToWorkItem: mock(async () => {}),
    removeTagFromWorkItem: mock(async () => {}),
    addWorkItemComment: mock(async () => {}),
  };
}

function makeProcessor(
  fn: (id: number) => Promise<ProcessOutcome>,
): Processor {
  return { processWorkItem: mock(fn) };
}

describe('runPollCycle', () => {
  let dir: string;
  let store: PipelineStateStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'watcher-'));
    store = new PipelineStateStore(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('aggregates outcomes across all candidate WIs', async () => {
    const ado = makeAdo([101, 102, 103, 104]);
    const proc = makeProcessor(async (id) => {
      if (id === 101) return { kind: 'completed', workItemId: id };
      if (id === 102) return { kind: 'paused', workItemId: id, stage: 'await-human' };
      if (id === 103)
        return {
          kind: 'failed',
          workItemId: id,
          error: { stage: 'x', message: 'boom', at: 'now' },
        };
      return { kind: 'skipped', workItemId: id, reason: 'closed-state' };
    });
    const stats = await runPollCycle({
      config: baseConfig,
      logger: createLogger(),
      ado,
      store,
      processor: proc,
      abortFlag: createAbortFlag(),
    });
    expect(stats).toEqual({
      considered: 4,
      completed: 1,
      paused: 1,
      failed: 1,
      skipped: 1,
    });
  });

  it('queries ADO with the configured trigger tag', async () => {
    const ado = makeAdo([]);
    const proc = makeProcessor(async (id) => ({ kind: 'completed', workItemId: id }));
    await runPollCycle({
      config: { ...baseConfig, triggerTag: 'custom-tag' },
      logger: createLogger(),
      ado,
      store,
      processor: proc,
      abortFlag: createAbortFlag(),
    });
    expect(ado.queryWorkItemsByTag).toHaveBeenCalledWith('custom-tag');
  });

  it('unions tagged IDs with resumable state files (dedup)', async () => {
    store.save({
      workItemId: 999,
      slug: 'resume-me',
      startedAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      currentStage: 'something',
      history: [],
      attempts: {},
      outputs: {},
    });
    const ado = makeAdo([101, 999]);
    const seen: number[] = [];
    const proc = makeProcessor(async (id) => {
      seen.push(id);
      return { kind: 'completed', workItemId: id };
    });
    const stats = await runPollCycle({
      config: baseConfig,
      logger: createLogger(),
      ado,
      store,
      processor: proc,
      abortFlag: createAbortFlag(),
    });
    expect(stats.considered).toBe(2);
    expect(seen.sort()).toEqual([101, 999]);
  });

  it('respects config.concurrency by running at most N processors at once', async () => {
    let active = 0;
    let peak = 0;
    const proc = makeProcessor(async (id) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return { kind: 'completed', workItemId: id };
    });
    const ado = makeAdo([1, 2, 3, 4, 5, 6, 7, 8]);
    await runPollCycle({
      config: { ...baseConfig, concurrency: 3 },
      logger: createLogger(),
      ado,
      store,
      processor: proc,
      abortFlag: createAbortFlag(),
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  it('counts processor exceptions as failed without aborting the cycle', async () => {
    const proc = makeProcessor(async (id) => {
      if (id === 2) throw new Error('processor blew up');
      return { kind: 'completed', workItemId: id };
    });
    const ado = makeAdo([1, 2, 3]);
    const stats = await runPollCycle({
      config: baseConfig,
      logger: createLogger(),
      ado,
      store,
      processor: proc,
      abortFlag: createAbortFlag(),
    });
    expect(stats.considered).toBe(3);
    expect(stats.completed).toBe(2);
    expect(stats.failed).toBe(1);
  });

  it('returns zero stats and does not call the processor when no candidates', async () => {
    const proc = makeProcessor(async (id) => ({ kind: 'completed', workItemId: id }));
    const ado = makeAdo([]);
    const stats = await runPollCycle({
      config: baseConfig,
      logger: createLogger(),
      ado,
      store,
      processor: proc,
      abortFlag: createAbortFlag(),
    });
    expect(stats).toEqual({
      considered: 0,
      completed: 0,
      paused: 0,
      failed: 0,
      skipped: 0,
    });
    expect(proc.processWorkItem).not.toHaveBeenCalled();
  });

  it('stops dispatching new work when abortFlag flips mid-cycle', async () => {
    const abortFlag = createAbortFlag();
    let processed = 0;
    const proc = makeProcessor(async (id) => {
      processed++;
      if (processed === 1) abortFlag.aborted = true;
      return { kind: 'completed', workItemId: id };
    });
    const ado = makeAdo([1, 2, 3, 4, 5]);
    const stats = await runPollCycle({
      config: { ...baseConfig, concurrency: 1 },
      logger: createLogger(),
      ado,
      store,
      processor: proc,
      abortFlag,
    });
    // 'considered' is the number of candidates found in the cycle (5).
    // The abort signal cuts the actual work short, so the four outcome counters
    // sum to LESS than 'considered' — that gap is the abort signature.
    expect(processed).toBeLessThan(5);
    expect(stats.considered).toBe(5);
    const dispatched =
      stats.completed + stats.paused + stats.failed + stats.skipped;
    expect(dispatched).toBeLessThan(stats.considered);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```powershell
bun test tests/services/watcher.test.ts
```

Expected: FAIL with `Cannot find module '../../src/services/watcher.ts'`.

- [ ] **Step 3: Create `src/services/watcher.ts`**

```typescript
import type { AppConfig, CycleStats } from '../types/index.ts';
import type { AdoClient } from '../sdk/azure-devops-client.ts';
import type { PipelineStateStore } from '../state/state-store.ts';
import type { Logger } from '../utils/logger.ts';
import type { Processor } from './processor.ts';
import type { AbortFlag } from '../pipeline/stage.ts';
import { runPool } from '../utils/pool.ts';

export interface WatcherDeps {
  config: AppConfig;
  logger: Logger;
  ado: AdoClient;
  store: PipelineStateStore;
  processor: Processor;
  abortFlag: AbortFlag;
}

export function createAbortFlag(): AbortFlag {
  return { aborted: false };
}

function emptyStats(): CycleStats {
  return { considered: 0, completed: 0, paused: 0, failed: 0, skipped: 0 };
}

export async function runPollCycle(deps: WatcherDeps): Promise<CycleStats> {
  const { config, logger, ado, store, processor, abortFlag } = deps;
  const stats = emptyStats();

  const tagged = await ado.queryWorkItemsByTag(config.triggerTag);
  const resumable = store.listResumable().map((s) => s.workItemId);
  const candidates = Array.from(new Set<number>([...tagged, ...resumable]));
  stats.considered = candidates.length;

  if (candidates.length === 0) {
    logger.info('poll cycle: no candidates');
    return stats;
  }

  logger.info(`poll cycle: ${candidates.length} candidate(s)`);

  await runPool(candidates, Math.max(1, config.concurrency), async (id) => {
    if (abortFlag.aborted) return;
    try {
      const outcome = await processor.processWorkItem(id);
      switch (outcome.kind) {
        case 'completed':
          stats.completed++;
          logger.info(`WI ${id}: completed`);
          break;
        case 'paused':
          stats.paused++;
          logger.info(`WI ${id}: paused at ${outcome.stage}`);
          break;
        case 'failed':
          stats.failed++;
          logger.error(`WI ${id}: failed at ${outcome.error.stage}: ${outcome.error.message}`);
          break;
        case 'skipped':
          stats.skipped++;
          logger.info(`WI ${id}: skipped (${outcome.reason})`);
          break;
      }
    } catch (err) {
      stats.failed++;
      logger.error(`WI ${id}: processor threw`, err);
    }
  });

  return stats;
}

async function sleepInterruptible(
  ms: number,
  abortFlag: AbortFlag,
): Promise<void> {
  const stepMs = 250;
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (abortFlag.aborted) return;
    const remaining = deadline - Date.now();
    await new Promise((resolve) => setTimeout(resolve, Math.min(stepMs, remaining)));
  }
}

export async function startWatcher(deps: WatcherDeps): Promise<void> {
  const { config, logger, abortFlag } = deps;
  const onSignal = (sig: string) => {
    logger.info(`received ${sig}, stopping after current cycle`);
    abortFlag.aborted = true;
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  logger.info(
    `watcher starting (poll every ${config.pollIntervalMinutes} min, concurrency ${config.concurrency})`,
  );
  while (!abortFlag.aborted) {
    try {
      const stats = await runPollCycle(deps);
      logger.info(
        `cycle done: considered=${stats.considered} completed=${stats.completed} paused=${stats.paused} failed=${stats.failed} skipped=${stats.skipped}`,
      );
    } catch (err) {
      logger.error('poll cycle threw, continuing', err);
    }
    if (abortFlag.aborted) break;
    await sleepInterruptible(config.pollIntervalMinutes * 60_000, abortFlag);
  }
  logger.info('watcher stopped');
}
```

- [ ] **Step 4: Run the test to verify it passes**

```powershell
bun test tests/services/watcher.test.ts
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Typecheck**

```powershell
bun run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add src/services/watcher.ts tests/services/watcher.test.ts
git commit -m "feat(services): add polling watcher with concurrency and graceful shutdown"
```

---

## Task 7: Wire up real CLI commands

**Files:**
- Modify: `src/cli/index.ts`

Replace the Plan 1 placeholders. After this task `bun run start` actually polls Azure DevOps; `bun run once` runs a single cycle and exits.

Subcommands after this task:
- `help` / `--help` / `-h` — usage.
- `version` / `--version` / `-v` — print version.
- `watch` — long-running, calls `startWatcher`.
- `run-once` — calls `runPollCycle` once and exits with the cycle's stats.
- `run-wi <id>` — calls `processor.processWorkItem(id)` and prints the outcome.
- `reset-state <id>` — deletes `.state/{id}.json`.
- `debug-tags` — prints the WI IDs returned by `queryWorkItemsByTag(triggerTag)`.

`--dry-run` is honoured by checking `process.argv.includes('--dry-run')` after `loadConfig()` and setting `config.dryRun = true`.

- [ ] **Step 1: Overwrite `src/cli/index.ts`**

```typescript
import { loadConfig } from '../config/index.ts';
import { createLogger } from '../utils/logger.ts';
import { createAdoClient } from '../sdk/azure-devops-client.ts';
import { PipelineStateStore } from '../state/state-store.ts';
import { buildPipeline } from '../services/pipeline-builder.ts';
import { createProcessor } from '../services/processor.ts';
import {
  createAbortFlag,
  runPollCycle,
  startWatcher,
} from '../services/watcher.ts';

const VERSION = '0.1.0';

function help(): void {
  console.log(`devops-coder v${VERSION}

Usage:
  bun run start                       Start the watcher (long-running)
  bun run once                        Run a single poll cycle and exit
  bun run src/cli/index.ts run-wi <id>      Process one work item by ID
  bun run src/cli/index.ts reset-state <id> Delete state for one work item
  bun run src/cli/index.ts debug-tags       List WIs tagged with TRIGGER_TAG
  bun run src/cli/index.ts version
  bun run src/cli/index.ts help

Flags:
  --dry-run         Suppress ADO writes (tags, comments). Pipeline still runs.
`);
}

function buildDeps() {
  const config = loadConfig();
  if (process.argv.includes('--dry-run')) config.dryRun = true;
  const logger = createLogger();
  const ado = createAdoClient(config);
  const store = new PipelineStateStore(config.stateDir);
  const abortFlag = createAbortFlag();
  const processor = createProcessor({
    config,
    logger,
    ado,
    store,
    buildPipeline,
    abortFlag,
  });
  return { config, logger, ado, store, processor, abortFlag };
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? 'help';

  switch (cmd) {
    case 'help':
    case '--help':
    case '-h':
      help();
      return;

    case 'version':
    case '--version':
    case '-v':
      console.log(VERSION);
      return;

    case 'watch': {
      const deps = buildDeps();
      await startWatcher(deps);
      return;
    }

    case 'run-once': {
      const deps = buildDeps();
      const stats = await runPollCycle(deps);
      console.log(JSON.stringify(stats, null, 2));
      return;
    }

    case 'run-wi': {
      const idArg = process.argv[3];
      if (!idArg) {
        console.error('run-wi requires a work item ID');
        process.exitCode = 1;
        return;
      }
      const id = Number(idArg);
      if (!Number.isFinite(id)) {
        console.error(`invalid work item ID: ${idArg}`);
        process.exitCode = 1;
        return;
      }
      const deps = buildDeps();
      const outcome = await deps.processor.processWorkItem(id);
      console.log(JSON.stringify(outcome, null, 2));
      return;
    }

    case 'reset-state': {
      const idArg = process.argv[3];
      if (!idArg) {
        console.error('reset-state requires a work item ID');
        process.exitCode = 1;
        return;
      }
      const id = Number(idArg);
      if (!Number.isFinite(id)) {
        console.error(`invalid work item ID: ${idArg}`);
        process.exitCode = 1;
        return;
      }
      const { store } = buildDeps();
      store.delete(id);
      console.log(`state for WI ${id} deleted`);
      return;
    }

    case 'debug-tags': {
      const { config, ado, logger } = buildDeps();
      logger.info(`querying WIs tagged '${config.triggerTag}'`);
      const ids = await ado.queryWorkItemsByTag(config.triggerTag);
      console.log(JSON.stringify({ tag: config.triggerTag, ids }, null, 2));
      return;
    }

    default:
      console.error(`Unknown command: ${cmd}`);
      help();
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exitCode = 1;
});
```

- [ ] **Step 2: Typecheck**

```powershell
bun run typecheck
```

Expected: PASS.

- [ ] **Step 3: Smoke-test CLI parsing without env vars**

The CLI must still respond to `help` / `version` without any env vars set.

```powershell
bun run src/cli/index.ts help
```

Expected: prints the usage block above, exit 0.

```powershell
bun run src/cli/index.ts version
```

Expected: prints `0.1.0`, exit 0.

- [ ] **Step 4: Smoke-test that an unknown command exits 1**

```powershell
bun run src/cli/index.ts garbage
```

Expected: prints "Unknown command: garbage" followed by help, exit code 1.

- [ ] **Step 5: Commit**

```powershell
git add src/cli/index.ts
git commit -m "feat(cli): wire watch, run-once, run-wi, reset-state, debug-tags"
```

---

## Task 8: End-to-end integration test

**Files:**
- Create: `tests/integration/watcher-e2e.test.ts`

A cross-cutting test that wires the real `runPollCycle` + real `PipelineStateStore` + real `createProcessor` + real `buildPipeline` (returning `[]`) against a mock `AdoClient`. Three scenarios:

1. Happy path: ADO returns two tagged WIs → both complete → trigger tag removed for both → state files show `completedAt`.
2. Resumable carries over: a state file with no `completedAt` exists → next cycle finds it via `listResumable()` even though the tag query returns nothing → it runs to completion.
3. Dry-run: same as #1 but `config.dryRun = true` → state files complete, but `removeTagFromWorkItem` is never called.

- [ ] **Step 1: Write the test**

Create `tests/integration/watcher-e2e.test.ts`:

```typescript
import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { runPollCycle, createAbortFlag } from '../../src/services/watcher.ts';
import { createProcessor } from '../../src/services/processor.ts';
import { buildPipeline } from '../../src/services/pipeline-builder.ts';
import { PipelineStateStore } from '../../src/state/state-store.ts';
import { createLogger } from '../../src/utils/logger.ts';
import type { AdoClient } from '../../src/sdk/azure-devops-client.ts';
import type { AppConfig } from '../../src/types/index.ts';

const baseConfig: AppConfig = {
  org: 'o',
  orgUrl: 'https://x',
  project: 'p',
  pat: 'pat',
  targetRepoPath: '/r',
  worktreeBase: '/w',
  triggerTag: 'agent implement',
  blockedTag: 'agent-blocked',
  needInputTag: 'need-input',
  pollIntervalMinutes: 5,
  concurrency: 2,
  maxRevisions: 3,
  maxRejectCycles: 3,
  claudeModel: 'claude-opus-4-7',
  stateDir: '',
  assignedToFilter: [],
  dryRun: false,
};

function makeAdo(taggedIds: number[]): AdoClient {
  return {
    queryWorkItemsByTag: mock(async () => taggedIds),
    getWorkItem: mock(async (id: number) => ({
      id,
      fields: {
        'System.Title': `WI ${id}`,
        'System.State': 'Active',
        'System.Tags': 'agent implement',
      },
    })),
    addTagToWorkItem: mock(async () => {}),
    removeTagFromWorkItem: mock(async () => {}),
    addWorkItemComment: mock(async () => {}),
  };
}

describe('watcher end-to-end (empty pipeline)', () => {
  let dir: string;
  let store: PipelineStateStore;
  let config: AppConfig;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'watcher-e2e-'));
    config = { ...baseConfig, stateDir: dir };
    store = new PipelineStateStore(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('completes every tagged WI and removes the trigger tag', async () => {
    const ado = makeAdo([201, 202]);
    const abortFlag = createAbortFlag();
    const processor = createProcessor({
      config,
      logger: createLogger(),
      ado,
      store,
      buildPipeline,
      abortFlag,
    });

    const stats = await runPollCycle({
      config,
      logger: createLogger(),
      ado,
      store,
      processor,
      abortFlag,
    });

    expect(stats).toEqual({
      considered: 2,
      completed: 2,
      paused: 0,
      failed: 0,
      skipped: 0,
    });
    expect(store.load(201)?.completedAt).toBeTruthy();
    expect(store.load(202)?.completedAt).toBeTruthy();
    expect(ado.removeTagFromWorkItem).toHaveBeenCalledTimes(2);
  });

  it('processes a resumable WI even when no tagged WIs are returned', async () => {
    store.save({
      workItemId: 777,
      slug: 'resume',
      startedAt: '2026-05-01T00:00:00Z',
      updatedAt: '2026-05-01T00:00:00Z',
      currentStage: null,
      history: [],
      attempts: {},
      outputs: {},
    });
    const ado = makeAdo([]);
    const abortFlag = createAbortFlag();
    const processor = createProcessor({
      config,
      logger: createLogger(),
      ado,
      store,
      buildPipeline,
      abortFlag,
    });

    const stats = await runPollCycle({
      config,
      logger: createLogger(),
      ado,
      store,
      processor,
      abortFlag,
    });

    expect(stats.considered).toBe(1);
    expect(stats.completed).toBe(1);
    expect(store.load(777)?.completedAt).toBeTruthy();
  });

  it('does not touch ADO tags when dryRun=true but still completes pipelines', async () => {
    const ado = makeAdo([301]);
    const abortFlag = createAbortFlag();
    const dryConfig = { ...config, dryRun: true };
    const processor = createProcessor({
      config: dryConfig,
      logger: createLogger(),
      ado,
      store,
      buildPipeline,
      abortFlag,
    });

    const stats = await runPollCycle({
      config: dryConfig,
      logger: createLogger(),
      ado,
      store,
      processor,
      abortFlag,
    });

    expect(stats.completed).toBe(1);
    expect(ado.removeTagFromWorkItem).not.toHaveBeenCalled();
    expect(ado.addTagToWorkItem).not.toHaveBeenCalled();
    expect(store.load(301)?.completedAt).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the integration test**

```powershell
bun test tests/integration/watcher-e2e.test.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 3: Run the full suite**

```powershell
bun test
```

Expected: PASS, **94 tests across 16 files**:

- `tests/utils/logger.test.ts` (4)
- `tests/utils/slug.test.ts` (6)
- `tests/utils/pool.test.ts` (4)
- `tests/config/config.test.ts` (8)
- `tests/state/state-store.test.ts` (11)
- `tests/pipeline/orchestrator.test.ts` (9)
- `tests/pipeline/agent-stage.test.ts` (4)
- `tests/pipeline/revision-loop.test.ts` (6)
- `tests/pipeline/checkpoint.test.ts` (4)
- `tests/services/claude-agent-runner.test.ts` (5)
- `tests/services/pipeline-builder.test.ts` (1)
- `tests/services/processor.test.ts` (6)
- `tests/services/watcher.test.ts` (7)
- `tests/sdk/azure-devops-client.test.ts` (14)
- `tests/integration/orchestrator-e2e.test.ts` (2)
- `tests/integration/watcher-e2e.test.ts` (3)

(Sum: 4+6+4+8+11+9+4+6+4+5+1+6+7+14+2+3 = 94.) If your local count differs by even one, treat it as a bug — re-run the failing file with `--verbose` and reconcile before moving on.

- [ ] **Step 4: Typecheck**

```powershell
bun run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add tests/integration/watcher-e2e.test.ts
git commit -m "test(integration): add end-to-end watcher + empty-pipeline test"
```

---

## Task 9: Documentation + final verification

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`
- Modify: `PATTERNS.md`

- [ ] **Step 1: Update `README.md` — replace the "placeholder" wording**

Find this block in `README.md`:

```
| `bun run start` | Start the watcher (placeholder until the watcher lands) |
| `bun run once` | Single poll cycle (placeholder) |
```

Replace with:

```
| `bun run start` | Start the long-running watcher; polls every POLL_INTERVAL_MINUTES |
| `bun run once` | Run a single poll cycle and exit with the cycle stats as JSON |
| `bun run src/cli/index.ts run-wi <id>` | Process a single work item by ID |
| `bun run src/cli/index.ts reset-state <id>` | Delete `.state/{id}.json` |
| `bun run src/cli/index.ts debug-tags` | List work item IDs tagged TRIGGER_TAG |
```

Also find the milestone line:

```
This repo currently contains the **milestone-1/2 skeleton** — project bootstrap and a generic stage-based pipeline orchestrator. Real stages (analyzer, coder, test-author, reviewer, draft-pr-creator), the ADO REST client, the worktree manager, and the watcher loop land in subsequent plans under `docs/superpowers/plans/`.
```

Replace with:

```
The repo is at the **milestone-3 stage** (Plan 2 done): the orchestrator, the Azure DevOps REST client, and the polling watcher are all wired. `bun run start` connects to ADO, finds work items tagged `agent implement`, runs each through the pipeline (currently empty), removes the trigger tag on completion, and persists per-WI state under `.state/`. Real stages (analyzer, coder, test-author, reviewer, draft-pr-creator) and the worktree manager land in Plans 3-5 under `docs/superpowers/plans/`.
```

- [ ] **Step 2: Update `CLAUDE.md`**

Add the SDK file to the "File Layout" section:

```
- `src/sdk/` — Azure DevOps REST client (PAT auth, retries, WIQL, tag/comment ops)
```

Update the "Out of scope (do not introduce)" section by removing entries that are no longer out of scope. Keep:

```
- Plan-stage / human plan-approval gate
- Self-research analyzer mode
- Multi-target-repo support
- Migration of the existing 4 agents
- Test-suggestion functionality (lives in the separate `DevopsTestSuggester` repo)
```

- [ ] **Step 3: Update `PATTERNS.md` — add three patterns**

Append:

```markdown
## ADO REST client

- `src/sdk/azure-devops-client.ts` — single module, no class. `createAdoClient(config, fetchImpl?, retryDelaysMs?)` returns an `AdoClient` interface. `fetchImpl` defaults to `globalThis.fetch.bind(globalThis)` so unit tests can pass a mock without monkey-patching globals.
- Auth: `Basic <base64(":" + pat)>` per request.
- Retry: `adoFetchWithRetry` retries 5xx up to `retryDelaysMs.length + 1` attempts with the given delays; 4xx is fatal. Tests pass `[0, 0, 0]` to make the retry loop synchronous.
- Tag I/O: tags are a single semicolon-separated `System.Tags` string. Add/remove go through `getWorkItem` → split → filter → PATCH back. Case-insensitive matching. No-op when the tag is already absent (remove) or already present (add).

## Concurrency pool

- `src/utils/pool.ts` — `runPool(items, n, worker)` spawns up to `n` workers that drain a shared queue. Worker errors are caught and returned in `result.errors` rather than aborting the pool. Used by the watcher to dispatch processor calls under `config.concurrency`.

## Watcher loop

- `src/services/watcher.ts` — `runPollCycle(deps)` is one cycle; `startWatcher(deps)` is the long-running form. Both share an injected `AbortFlag`. `startWatcher` registers SIGINT/SIGTERM to flip the flag and uses `sleepInterruptible` to wake on shutdown rather than wait the full poll interval.
- Resume semantics: each cycle queries ADO for `triggerTag` WIs, unions with `store.listResumable()`, dedups, dispatches the union through the processor. A pipeline started in cycle N continues in cycle N+1 even if the human removed the tag in between.
```

- [ ] **Step 4: Final verification**

```powershell
bun install
```

Expected: exit 0, no changes to `bun.lock`.

```powershell
bun run typecheck
```

Expected: PASS.

```powershell
bun test
```

Expected: PASS, 94 tests across 16 files. (If the file count or test count differs, fix the docs to match the actual output before committing.)

```powershell
bun run src/cli/index.ts help
```

Expected: prints the help block, exit 0.

```powershell
git status
```

Expected: only the doc files in the staging area.

- [ ] **Step 5: Commit docs**

```powershell
git add README.md CLAUDE.md PATTERNS.md
git commit -m "docs: update README / CLAUDE.md / PATTERNS.md for Plan 2"
```

- [ ] **Step 6: Confirm working tree clean**

```powershell
git status
```

Expected: `nothing to commit, working tree clean`.

## Plan completion checklist

- `src/sdk/azure-devops-client.ts` with `createAdoClient` and `AzureDevOpsError`
- `src/utils/pool.ts` with `runPool`
- `src/services/pipeline-builder.ts` returning `Stage[]` (empty in this plan)
- `src/services/processor.ts` with `createProcessor` and the four `ProcessOutcome` shapes
- `src/services/watcher.ts` with `runPollCycle`, `startWatcher`, `createAbortFlag`
- `src/cli/index.ts` with real `watch`, `run-once`, `run-wi`, `reset-state`, `debug-tags`, `--dry-run`
- Test suite green: 94 tests across 16 files
- `bun run typecheck` green
- README / CLAUDE.md / PATTERNS.md updated; working tree clean
