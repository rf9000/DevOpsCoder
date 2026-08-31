import type {
  AppConfig,
  CreatePullRequestArgs,
  PullRequest,
  WiqlQueryResponse,
  WorkItem,
  WorkItemComment,
  WorkItemUpdate,
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
  queryWorkItemsByTag(tag: string, opts?: { signal?: AbortSignal }): Promise<number[]>;
  getWorkItem(workItemId: number, opts?: { signal?: AbortSignal }): Promise<WorkItem>;
  getWorkItemComments(workItemId: number, opts?: { signal?: AbortSignal }): Promise<WorkItemComment[]>;
  getWorkItemUpdates(workItemId: number, opts?: { signal?: AbortSignal }): Promise<WorkItemUpdate[]>;
  addTagToWorkItem(workItemId: number, tag: string, opts?: { signal?: AbortSignal }): Promise<void>;
  removeTagFromWorkItem(workItemId: number, tag: string, opts?: { signal?: AbortSignal }): Promise<void>;
  addWorkItemComment(workItemId: number, html: string, opts?: { signal?: AbortSignal }): Promise<void>;
  createPullRequest(args: CreatePullRequestArgs, opts?: { signal?: AbortSignal }): Promise<PullRequest>;
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

  function delayOrAbort(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException('aborted', 'AbortError'));
        return;
      }
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new DOMException('aborted', 'AbortError'));
        },
        { once: true },
      );
    });
  }

  async function adoFetchWithRetry<T>(
    path: string,
    init?: RequestInit,
  ): Promise<T> {
    // init?.signal is `AbortSignal | null | undefined` (RequestInit types signal
    // as `AbortSignal | null`); coerce the null case to undefined for downstream
    // helpers that expect `AbortSignal | undefined`.
    const signal = init?.signal ?? undefined;
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
      const delayMs = retryDelaysMs[i];
      if (i < attempts - 1 && delayMs !== undefined) {
        await delayOrAbort(delayMs, signal);
      }
    }
    throw lastErr!;
  }

  async function fetchWorkItem(workItemId: number, signal?: AbortSignal): Promise<WorkItem> {
    return adoFetchWithRetry<WorkItem>(
      `/_apis/wit/workitems/${workItemId}?api-version=7.1&$expand=all`,
      signal !== undefined ? { signal } : undefined,
    );
  }

  async function patchTags(workItemId: number, tags: string[], signal?: AbortSignal): Promise<void> {
    await adoFetchWithRetry(
      `/_apis/wit/workitems/${workItemId}?api-version=7.1`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json-patch+json' },
        body: JSON.stringify([
          { op: 'replace', path: '/fields/System.Tags', value: joinTags(tags) },
        ]),
        signal,
      },
    );
  }

  return {
    async queryWorkItemsByTag(tag: string, opts: { signal?: AbortSignal } = {}): Promise<number[]> {
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
        { method: 'POST', body: JSON.stringify({ query }), signal: opts.signal },
      );
      return result.workItems.map((w) => w.id);
    },

    async getWorkItem(workItemId: number, opts: { signal?: AbortSignal } = {}): Promise<WorkItem> {
      return fetchWorkItem(workItemId, opts.signal);
    },

    async getWorkItemComments(workItemId: number, opts: { signal?: AbortSignal } = {}): Promise<WorkItemComment[]> {
      const response = await adoFetchWithRetry<{ comments?: WorkItemComment[] }>(
        `/${encodeURIComponent(config.project)}/_apis/wit/workItems/${workItemId}/comments?api-version=7.1-preview.3`,
        { signal: opts.signal },
      );
      return response.comments ?? [];
    },

    async getWorkItemUpdates(workItemId: number, opts: { signal?: AbortSignal } = {}): Promise<WorkItemUpdate[]> {
      const response = await adoFetchWithRetry<{ value?: WorkItemUpdate[] }>(
        `/_apis/wit/workItems/${workItemId}/updates?api-version=7.1`,
        opts.signal !== undefined ? { signal: opts.signal } : undefined,
      );
      return response.value ?? [];
    },

    async addTagToWorkItem(workItemId: number, tag: string, opts: { signal?: AbortSignal } = {}): Promise<void> {
      const wi = await fetchWorkItem(workItemId, opts.signal);
      const tags = splitTags(wi.fields['System.Tags']);
      if (hasTagCi(tags, tag)) return;
      tags.push(tag);
      await patchTags(workItemId, tags, opts.signal);
    },

    async removeTagFromWorkItem(workItemId: number, tag: string, opts: { signal?: AbortSignal } = {}): Promise<void> {
      const wi = await fetchWorkItem(workItemId, opts.signal);
      const tags = splitTags(wi.fields['System.Tags']);
      if (!hasTagCi(tags, tag)) return;
      const n = tag.toLowerCase();
      const updated = tags.filter((t) => t.toLowerCase() !== n);
      await patchTags(workItemId, updated, opts.signal);
    },

    async addWorkItemComment(workItemId: number, html: string, opts: { signal?: AbortSignal } = {}): Promise<void> {
      await adoFetchWithRetry(
        `/${encodeURIComponent(config.project)}/_apis/wit/workItems/${workItemId}/comments?api-version=7.1-preview.3`,
        { method: 'POST', body: JSON.stringify({ text: html }), signal: opts.signal },
      );
    },

    async createPullRequest(args: CreatePullRequestArgs, opts: { signal?: AbortSignal } = {}): Promise<PullRequest> {
      const response = await adoFetchWithRetry<{
        pullRequestId: number;
        url: string;
        sourceRefName: string;
        targetRefName: string;
      }>(
        `/${encodeURIComponent(config.project)}/_apis/git/repositories/${encodeURIComponent(args.repositoryName)}/pullrequests?api-version=7.1`,
        {
          method: 'POST',
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
          signal: opts.signal,
        },
      );
      return {
        id: response.pullRequestId,
        url: response.url,
        sourceRefName: response.sourceRefName,
        targetRefName: response.targetRefName,
      };
    },
  };
}
