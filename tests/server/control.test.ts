import { describe, test, expect } from 'bun:test';
import { createControlHandler, startControlServer } from '../../src/server/control.ts';
import { DemoPortalAuth, type DemoPortalSession, type SignInStatus } from '../../src/services/demoportal-auth.ts';
import type { ProcessResult, RunProcess } from '../../src/services/process-runner.ts';

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
    expect(await res.json()).toEqual({ signIn: null });
  });

  test('GET /status returns the session status', async () => {
    const res = await createControlHandler({ demoPortal: fakeSession().session })(get('/status'));
    expect(await res.json()).toEqual({ signIn: SIGNIN });
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
