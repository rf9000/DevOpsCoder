import { describe, test, expect, mock } from 'bun:test';
import { createControlHandler, startControlServer, withControlServer } from '../../src/server/control.ts';
import { DemoPortalAuth, type DemoPortalSession, type SignInStatus } from '../../src/services/demoportal-auth.ts';
import type { ProcessResult, RunProcess } from '../../src/services/process-runner.ts';
import type { PrFixStatusView, PrFixWorker, WorkerResult } from '../../src/prfix/dashboard/worker.ts';
import type { HistoryLine } from '../../src/prfix/dashboard/store.ts';

const SIGNIN: SignInStatus = { needed: true, reason: 'no session', checkedAt: null, login: null };

function fakeSession() {
  const started: string[] = [];
  const session: DemoPortalSession = {
    status: () => SIGNIN,
    peek: async () => {},
    ensure: async () => true,
    startLogin: async (by) => {
      started.push(by);
      return SIGNIN;
    },
  };
  return { session, started };
}

const get = (path: string) => new Request(`http://x${path}`);
const post = (path: string, headers: Record<string, string> = {}) =>
  new Request(`http://x${path}`, { method: 'POST', headers });

describe('control handler', () => {
  test('GET /status without demoPortal returns signIn null', async () => {
    const res = await createControlHandler({})(get('/status'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ signIn: null, prFix: null });
  });

  test('GET /status returns the session status', async () => {
    const res = await createControlHandler({ demoPortal: fakeSession().session })(get('/status'));
    expect(await res.json()).toEqual({ signIn: SIGNIN, prFix: null });
  });

  test('POST /signin passes X-Remote-User', async () => {
    const { session, started } = fakeSession();
    const res = await createControlHandler({ demoPortal: session })(post('/signin', { 'X-Remote-User': 'alice' }));
    expect(res.status).toBe(200);
    expect(started).toEqual(['alice']);
    expect(await res.json()).toEqual({ signIn: SIGNIN });
  });

  test('POST /signin without X-Remote-User uses unknown', async () => {
    const { session, started } = fakeSession();
    await createControlHandler({ demoPortal: session })(post('/signin'));
    expect(started).toEqual(['unknown']);
  });

  test('POST /signin without demoPortal is 409', async () => {
    const res = await createControlHandler({})(post('/signin'));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'CONTINIA_AUTH_METHOD is api-token: there is no sign-in' });
  });

  test('POST /signin twice returns the login in progress', async () => {
    const runs: string[] = [];
    const run: RunProcess = async (cmd, _cwd, _env, _t, onLine) => {
      const args = cmd.slice(1).join(' ');
      runs.push(args);
      if (args.startsWith('auth login')) {
        onLine?.('Open https://microsoft.com/devicelogin and enter the code ABC123 to sign in.');
        onLine?.('  URL:  https://microsoft.com/devicelogin');
        onLine?.('  Code: ABC123');
        return new Promise<ProcessResult>(() => {});
      }
      return { exitCode: 0, stdout: '[]', stderr: '' };
    };
    const auth = new DemoPortalAuth('continia', '.', run, () => {});
    const handler = createControlHandler({ demoPortal: auth });
    const a = (await (await handler(post('/signin'))).json()) as { signIn: SignInStatus };
    const b = (await (await handler(post('/signin'))).json()) as { signIn: SignInStatus };
    expect(a.signIn.login?.userCode).toBeTruthy();
    expect(b.signIn.login?.userCode).toBe(a.signIn.login!.userCode);
    expect(runs.filter((r) => r.startsWith('auth login'))).toHaveLength(1);
  });

  test('unknown path is 404', async () => {
    const res = await createControlHandler({})(get('/nope'));
    expect(res.status).toBe(404);
  });

  test('body over 4 KB is 413', async () => {
    const server = startControlServer(0, createControlHandler({}), '127.0.0.1');
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/signin`, { method: 'POST', body: 'x'.repeat(5000) });
      expect(res.status).toBe(413);
    } finally {
      server.stop();
    }
  });
});

const PRFIX_STATUS: PrFixStatusView = {
  available: true,
  unavailableReason: null,
  repo: 'Banking',
  prs: [],
  prsAt: '2026-11-17T10:00:00.000Z',
  prsError: null,
  queue: [],
  pending: [],
  activeJob: null,
  waiting: null,
};

/** Records every call; `results` sets what each action answers. */
function fakeWorker(results: Partial<Record<'enqueue' | 'unqueue' | 'approve' | 'reject', WorkerResult>> = {}) {
  const calls: string[] = [];
  const history = [{ prId: 7, at: 'x' }] as unknown as HistoryLine[];
  const ok: WorkerResult = { ok: true };
  const worker: PrFixWorker = {
    enqueue: (prId, user) => {
      calls.push(`enqueue ${prId} ${user}`);
      return results.enqueue ?? ok;
    },
    unqueue: (prId) => {
      calls.push(`unqueue ${prId}`);
      return results.unqueue ?? ok;
    },
    requestApprove: (prId, user) => {
      calls.push(`approve ${prId} ${user}`);
      return results.approve ?? ok;
    },
    requestReject: (prId, user) => {
      calls.push(`reject ${prId} ${user}`);
      return results.reject ?? ok;
    },
    status: () => PRFIX_STATUS,
    history: () => history,
    recover: async () => {},
    expire: () => {},
    tick: () => {},
    idle: async () => {},
  };
  return { worker, calls, history };
}

const send = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://x${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });

describe('control handler: PR fixer', () => {
  test('status includes prFix', async () => {
    const { worker } = fakeWorker();
    const res = await createControlHandler({ prFix: worker })(get('/status'));
    expect(await res.json()).toEqual({ signIn: null, prFix: PRFIX_STATUS });
  });

  test('status with an unreadable PR-fixer store still reports sign-in', async () => {
    const { worker } = fakeWorker();
    worker.status = () => {
      throw new Error('Unexpected token in queue.json');
    };
    const res = await createControlHandler({ prFix: worker, demoPortal: fakeSession().session })(get('/status'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ signIn: SIGNIN, prFix: null, prFixError: 'Unexpected token in queue.json' });
  });

  test('queue passes X-Remote-User to the worker', async () => {
    const { worker, calls } = fakeWorker();
    const res = await createControlHandler({ prFix: worker })(
      send('POST', '/queue', { repo: 'Banking', prId: 61400 }, { 'X-Remote-User': 'alice' }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ queue: [] });
    expect(calls).toEqual(['enqueue 61400 alice']);
  });

  test('queue without X-Remote-User records unknown', async () => {
    const { worker, calls } = fakeWorker();
    await createControlHandler({ prFix: worker })(send('POST', '/queue', { repo: 'Banking', prId: 1 }));
    expect(calls).toEqual(['enqueue 1 unknown']);
  });

  test('queue with another repo is 400', async () => {
    const { worker, calls } = fakeWorker();
    const res = await createControlHandler({ prFix: worker })(send('POST', '/queue', { repo: 'Other', prId: 1 }));
    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });

  test('queue with a bad body is 400', async () => {
    const { worker, calls } = fakeWorker();
    const handler = createControlHandler({ prFix: worker });
    for (const body of ['not json', { repo: 'Banking' }, { repo: 'Banking', prId: -1 }, { repo: 'Banking', prId: 1.5 }]) {
      expect((await handler(send('POST', '/queue', body))).status).toBe(400);
    }
    expect(calls).toEqual([]);
  });

  test('queue answers the worker code and error', async () => {
    const { worker } = fakeWorker({ enqueue: { ok: false, code: 409, error: 'already queued' } });
    const res = await createControlHandler({ prFix: worker })(send('POST', '/queue', { repo: 'Banking', prId: 1 }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'already queued' });
  });

  test('DELETE /queue/<repo>/<prId> unqueues; 404 when not queued; 400 for another repo', async () => {
    const a = fakeWorker();
    const res = await createControlHandler({ prFix: a.worker })(send('DELETE', '/queue/Banking/12'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ queue: [] });
    expect(a.calls).toEqual(['unqueue 12']);

    const b = fakeWorker({ unqueue: { ok: false, code: 404, error: 'PR 12 is not queued' } });
    const missing = await createControlHandler({ prFix: b.worker })(send('DELETE', '/queue/Banking/12'));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'PR 12 is not queued' });

    const c = fakeWorker();
    expect((await createControlHandler({ prFix: c.worker })(send('DELETE', '/queue/Other/12'))).status).toBe(400);
    expect(c.calls).toEqual([]);
  });

  test('approve is 202 and passes the user; reject is 200', async () => {
    const { worker, calls } = fakeWorker();
    const handler = createControlHandler({ prFix: worker });
    const approve = await handler(send('POST', '/approve', { repo: 'Banking', prId: 5 }, { 'X-Remote-User': 'rf' }));
    expect(approve.status).toBe(202);
    const reject = await handler(send('POST', '/reject', { repo: 'Banking', prId: 6 }, { 'X-Remote-User': 'kj' }));
    expect(reject.status).toBe(200);
    expect(calls).toEqual(['approve 5 rf', 'reject 6 kj']);
  });

  test('approve unknown PR is 404', async () => {
    const { worker } = fakeWorker({ approve: { ok: false, code: 404, error: 'PR 5 is not awaiting approval' } });
    const res = await createControlHandler({ prFix: worker })(send('POST', '/approve', { repo: 'Banking', prId: 5 }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'PR 5 is not awaiting approval' });
  });

  test('reject unknown PR is 404; approve or reject for another repo is 400', async () => {
    const { worker, calls } = fakeWorker({ reject: { ok: false, code: 404, error: 'PR 5 is not awaiting approval' } });
    const handler = createControlHandler({ prFix: worker });
    expect((await handler(send('POST', '/reject', { repo: 'Banking', prId: 5 }))).status).toBe(404);
    expect((await handler(send('POST', '/approve', { repo: 'Other', prId: 5 }))).status).toBe(400);
    expect((await handler(send('POST', '/reject', { repo: 'Other', prId: 5 }))).status).toBe(400);
    expect(calls).toEqual(['reject 5 unknown']);
  });

  test('GET /stats returns the history as jobs', async () => {
    const { worker, history } = fakeWorker();
    const res = await createControlHandler({ prFix: worker })(get('/stats'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jobs: history });
  });

  test('routes are 404 without a worker', async () => {
    const handler = createControlHandler({});
    const requests = [
      send('POST', '/queue', { repo: 'Banking', prId: 1 }),
      send('DELETE', '/queue/Banking/1'),
      send('POST', '/approve', { repo: 'Banking', prId: 1 }),
      send('POST', '/reject', { repo: 'Banking', prId: 1 }),
      get('/stats'),
    ];
    for (const req of requests) {
      const res = await handler(req);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'PR fixer not configured' });
    }
  });

  test('body over 4 KB is rejected on /queue', async () => {
    const { worker, calls } = fakeWorker();
    const server = startControlServer(0, createControlHandler({ prFix: worker }), '127.0.0.1');
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/queue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo: 'Banking', prId: 1, pad: 'x'.repeat(5000) }),
      });
      expect(res.status).toBe(413);
      expect(calls).toEqual([]);
    } finally {
      server.stop();
    }
  });
});

describe('withControlServer', () => {
  test('serves while the body runs and stops once it ends, so the process can exit', async () => {
    let port = 0;
    const result = await withControlServer(0, createControlHandler({}), async () => {
      const res = await fetch(`http://127.0.0.1:${port}/status`);
      expect(res.status).toBe(200);
      return 'done';
    }, (p) => {
      port = p;
    }, '127.0.0.1');
    expect(result).toBe('done');
    expect(port).toBeGreaterThan(0);
    await expect(fetch(`http://127.0.0.1:${port}/status`)).rejects.toThrow();
  });

  test('stops the server when the body throws', async () => {
    let port = 0;
    await expect(withControlServer(0, createControlHandler({}), async () => {
      throw new Error('loop crashed');
    }, (p) => {
      port = p;
    }, '127.0.0.1')).rejects.toThrow('loop crashed');
    await expect(fetch(`http://127.0.0.1:${port}/status`)).rejects.toThrow();
  });

  test('without a port it only runs the body', async () => {
    const onListening = mock(() => {});
    expect(await withControlServer(undefined, createControlHandler({}), async () => 1, onListening)).toBe(1);
    expect(onListening).not.toHaveBeenCalled();
  });
});
