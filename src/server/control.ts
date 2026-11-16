import type { DemoPortalSession } from '../services/demoportal-auth.ts';

/**
 * Internal control API for the monitor dashboard. No authentication: it is
 * reached only over the compose network, and the monitor checks roles first.
 */
export interface ControlDeps {
  /** DemoPortal's Azure AD session; absent with an API token (no sign-in from the dashboard). */
  demoPortal?: DemoPortalSession;
}

const json = (body: unknown, status = 200): Response => Response.json(body, { status });

export function createControlHandler(deps: ControlDeps): (req: Request) => Promise<Response> {
  const route = async (req: Request): Promise<Response> => {
    const { pathname } = new URL(req.url);

    if (req.method === 'GET' && pathname === '/status') {
      return json({ signIn: deps.demoPortal?.status() ?? null });
    }

    // Starts `continia auth login` (device code); the code to enter comes back here and in /status.
    if (req.method === 'POST' && pathname === '/signin') {
      if (!deps.demoPortal) return json({ error: 'CONTINIA_AUTH_METHOD is api-token: there is no sign-in' }, 409);
      return json({ signIn: await deps.demoPortal.startLogin(req.headers.get('x-remote-user') || 'unknown') });
    }

    return json({ error: 'not found' }, 404);
  };
  return async (req) => {
    try {
      return await route(req);
    } catch (err) {
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
