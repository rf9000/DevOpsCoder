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
    repositoryName: 'test-repo',
    targetRepoPath: '/repos/x',
    worktreeBase: '/repos/.worktrees',
    triggerTag: 'agent implement',
    blockedTag: 'agent-blocked',
    needInputTag: 'need-input',
    pollIntervalMinutes: 5,
    concurrency: 1,
    maxRevisions: 3,
    maxRejectCycles: 3,
    coderMaxTurns: 80,
    testAuthorMaxTurns: 50,
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
        'https://dev.azure.com/my-org/_apis/wit/workitems/101?api-version=7.1&$expand=all',
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
      expect(patch[0]!.op).toBe('replace');
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
      const patch = JSON.parse(calls[1]!.init?.body as string) as { op: string; value: string }[];
      expect(patch[0]!.op).toBe('replace');
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

  describe('getWorkItemComments', () => {
    it('GETs the comments endpoint and returns the comments array', async () => {
      const fetchImpl = setupFetch([
        jsonResponse(200, {
          totalCount: 2,
          count: 2,
          comments: [
            { id: 1, text: '<p>first</p>', createdDate: '2026-01-01T00:00:00Z' },
            { id: 2, text: '<p>second</p>', createdDate: '2026-01-02T00:00:00Z' },
          ],
        }),
      ]);
      const client = createAdoClient(makeConfig(), fetchImpl);
      const comments = await client.getWorkItemComments(101);
      expect(comments).toHaveLength(2);
      expect(comments[0]?.text).toBe('<p>first</p>');
      expect(comments[1]?.id).toBe(2);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe(
        'https://dev.azure.com/my-org/my-project/_apis/wit/workItems/101/comments?api-version=7.1-preview.3',
      );
      expect(calls[0]!.init?.method ?? 'GET').toBe('GET');
    });

    it('returns an empty array when the response has no comments field', async () => {
      const fetchImpl = setupFetch([
        jsonResponse(200, { totalCount: 0, count: 0 }),
      ]);
      const client = createAdoClient(makeConfig(), fetchImpl);
      const comments = await client.getWorkItemComments(101);
      expect(comments).toEqual([]);
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
