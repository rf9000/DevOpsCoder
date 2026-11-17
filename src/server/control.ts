import { z } from 'zod';
import type { PrFixWorker, WorkerResult } from '../prfix/dashboard/worker.ts';
import type { DemoPortalSession } from '../services/demoportal-auth.ts';

/**
 * Internal control API for the monitor dashboard. No authentication: it is
 * reached only over the compose network, and the monitor checks roles first.
 */
export interface ControlDeps {
  /** DemoPortal's Azure AD session; absent with an API token (no sign-in from the dashboard). */
  demoPortal?: DemoPortalSession;
  /** The dashboard's fix-pr worker; absent outside the watcher. */
  prFix?: PrFixWorker;
}

/** `repo` is there for shape-compatibility with the monitor's `PrQueueLink`; it must be the configured repository. */
const prBody = z.object({ repo: z.string().min(1), prId: z.number().int().positive() });

const json = (body: unknown, status = 200): Response => Response.json(body, { status });

const user = (req: Request): string => req.headers.get('x-remote-user') || 'unknown';

const wrongRepo = (repo: string, configured: string): Response =>
  json({ error: `repo '${repo}' is not the configured repository '${configured}'` }, 400);

export function createControlHandler(deps: ControlDeps): (req: Request) => Promise<Response> {
  /** `{ repo, prId }` from the body, or the 400 to answer. */
  const readPr = async (req: Request, worker: PrFixWorker): Promise<{ prId: number } | Response> => {
    const parsed = prBody.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return json({ error: 'body must be { repo: string, prId: positive integer }' }, 400);
    const configured = worker.status().repo;
    if (parsed.data.repo !== configured) return wrongRepo(parsed.data.repo, configured);
    return { prId: parsed.data.prId };
  };

  const answer = (result: WorkerResult, ok: () => Response): Response =>
    result.ok ? ok() : json({ error: result.error }, result.code);

  /** The PR-fixer routes; null when the request is not one of them. */
  const prFixRoute = async (req: Request, pathname: string): Promise<Response | null> => {
    const del = pathname.match(/^\/queue\/([^/]+)\/(\d+)$/);
    const isRoute =
      (req.method === 'POST' && ['/queue', '/approve', '/reject'].includes(pathname)) ||
      (req.method === 'GET' && pathname === '/stats') ||
      (req.method === 'DELETE' && del !== null);
    if (!isRoute) return null;
    const worker = deps.prFix;
    if (!worker) return json({ error: 'PR fixer not configured' }, 404);

    // Every finished fix-pr job, newest first.
    if (pathname === '/stats') return json({ jobs: worker.history() });

    if (del) {
      const repo = decodeURIComponent(del[1]!);
      const configured = worker.status().repo;
      if (repo !== configured) return wrongRepo(repo, configured);
      return answer(worker.unqueue(Number(del[2])), () => json({ queue: worker.status().queue }));
    }

    const pr = await readPr(req, worker);
    if (pr instanceof Response) return pr;
    if (pathname === '/queue') {
      return answer(worker.enqueue(pr.prId, user(req)), () => json({ queue: worker.status().queue }));
    }
    // The push runs ahead of queued jobs but not at once: accepted, not done.
    if (pathname === '/approve') return answer(worker.requestApprove(pr.prId, user(req)), () => json({ ok: true }, 202));
    return answer(worker.requestReject(pr.prId, user(req)), () => json({ ok: true }));
  };

  const route = async (req: Request): Promise<Response> => {
    const { pathname } = new URL(req.url);

    if (req.method === 'GET' && pathname === '/status') {
      return json({ signIn: deps.demoPortal?.status() ?? null, prFix: deps.prFix?.status() ?? null });
    }

    // Starts `continia auth login` (device code); the code to enter comes back here and in /status.
    if (req.method === 'POST' && pathname === '/signin') {
      if (!deps.demoPortal) return json({ error: 'CONTINIA_AUTH_METHOD is api-token: there is no sign-in' }, 409);
      return json({ signIn: await deps.demoPortal.startLogin(user(req)) });
    }

    const prFix = await prFixRoute(req, pathname);
    if (prFix) return prFix;

    return json({ error: 'not found' }, 404);
  };
  return async (req) => {
    try {
      return await route(req);
    } catch (err) {
      if (err instanceof URIError) return json({ error: 'bad path encoding' }, 400);
      return json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  };
}

/** Port 0 picks a free port (tests). `hostname` defaults to every interface (the compose network). */
export function startControlServer(
  port: number,
  handler: (req: Request) => Promise<Response>,
  hostname?: string,
): { port: number; stop(): void } {
  const server = Bun.serve({ port, ...(hostname ? { hostname } : {}), fetch: handler, maxRequestBodySize: 4 * 1024 });
  return { port: server.port ?? port, stop: () => void server.stop(true) };
}

/**
 * Serves the control API while `body` runs (the watcher loop), then stops it:
 * a live server would keep the process from exiting after SIGTERM. Without a
 * port it only runs `body`.
 */
export async function withControlServer<T>(
  port: number | undefined,
  handler: (req: Request) => Promise<Response>,
  body: () => Promise<T>,
  onListening?: (port: number) => void,
  hostname?: string,
): Promise<T> {
  if (port === undefined) return body();
  const server = startControlServer(port, handler, hostname);
  onListening?.(server.port);
  try {
    return await body();
  } finally {
    server.stop();
  }
}
