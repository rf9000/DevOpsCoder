import type {
  AppConfig,
  CreatePullRequestArgs,
  PullRequest,
  WiqlQueryResponse,
  WorkItem,
  WorkItemComment,
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
  getWorkItemComments(workItemId: number): Promise<WorkItemComment[]>;
  addTagToWorkItem(workItemId: number, tag: string): Promise<void>;
  removeTagFromWorkItem(workItemId: number, tag: string): Promise<void>;
  addWorkItemComment(workItemId: number, html: string): Promise<void>;
  createPullRequest(opts: CreatePullRequestArgs): Promise<PullRequest>;
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

  async function fetchWorkItem(workItemId: number): Promise<WorkItem> {
    return adoFetchWithRetry<WorkItem>(
      `/_apis/wit/workitems/${workItemId}?api-version=7.1&$expand=all`,
    );
  }

  async function patchTags(workItemId: number, tags: string[]): Promise<void> {
    await adoFetchWithRetry(
      `/_apis/wit/workitems/${workItemId}?api-version=7.1`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json-patch+json' },
        body: JSON.stringify([
          { op: 'replace', path: '/fields/System.Tags', value: joinTags(tags) },
        ]),
      },
    );
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

    getWorkItem: fetchWorkItem,

    async getWorkItemComments(workItemId: number): Promise<WorkItemComment[]> {
      const response = await adoFetchWithRetry<{ comments?: WorkItemComment[] }>(
        `/${encodeURIComponent(config.project)}/_apis/wit/workItems/${workItemId}/comments?api-version=7.1-preview.3`,
      );
      return response.comments ?? [];
    },

    async addTagToWorkItem(workItemId: number, tag: string): Promise<void> {
      const wi = await fetchWorkItem(workItemId);
      const tags = splitTags(wi.fields['System.Tags']);
      if (hasTagCi(tags, tag)) return;
      tags.push(tag);
      await patchTags(workItemId, tags);
    },

    async removeTagFromWorkItem(workItemId: number, tag: string): Promise<void> {
      const wi = await fetchWorkItem(workItemId);
      const tags = splitTags(wi.fields['System.Tags']);
      if (!hasTagCi(tags, tag)) return;
      const n = tag.toLowerCase();
      const updated = tags.filter((t) => t.toLowerCase() !== n);
      await patchTags(workItemId, updated);
    },

    async addWorkItemComment(workItemId: number, html: string): Promise<void> {
      await adoFetchWithRetry(
        `/${encodeURIComponent(config.project)}/_apis/wit/workItems/${workItemId}/comments?api-version=7.1-preview.3`,
        { method: 'POST', body: JSON.stringify({ text: html }) },
      );
    },

    async createPullRequest(opts: CreatePullRequestArgs): Promise<PullRequest> {
      const response = await adoFetchWithRetry<{
        pullRequestId: number;
        url: string;
        sourceRefName: string;
        targetRefName: string;
      }>(
        `/${encodeURIComponent(config.project)}/_apis/git/repositories/${encodeURIComponent(opts.repositoryName)}/pullrequests?api-version=7.1`,
        {
          method: 'POST',
          body: JSON.stringify({
            sourceRefName: opts.sourceRefName,
            targetRefName: opts.targetRefName,
            title: opts.title,
            description: opts.description,
            isDraft: opts.isDraft,
          }),
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
