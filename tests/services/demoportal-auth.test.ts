import { describe, test, expect } from 'bun:test';
import { DemoPortalAuth } from '../../src/services/demoportal-auth.ts';
import type { ProcessResult, RunProcess } from '../../src/services/process-runner.ts';

const ok = (stdout: string): ProcessResult => ({ exitCode: 0, stdout, stderr: '' });
const status = (azureAd: Record<string, unknown>) => ok(JSON.stringify({ authMethod: 'azure-ad', azureAd }));
const VALID = { signedIn: true, sessionValid: true, canRefresh: true };
const EXPIRED = { signedIn: true, sessionValid: false, canRefresh: true };
const GONE = { signedIn: false, sessionValid: false, canRefresh: false };

/** A fake CLI: `auth status` answers from `statuses` in turn (the last one repeats). */
function fakeCli(statuses: ProcessResult[], login?: (onLine?: (l: string) => void) => Promise<ProcessResult>) {
  const calls: string[] = [];
  let i = 0;
  const run: RunProcess = async (cmd, _cwd, _env, _t, onLine) => {
    const args = cmd.slice(1).join(' ');
    calls.push(args);
    if (args === 'auth status --json') return statuses[Math.min(i++, statuses.length - 1)]!;
    if (args === 'auth login --json' && login) return login(onLine);
    return ok('[]');
  };
  const logs: string[] = [];
  const auth = new DemoPortalAuth('continia', '.', run, (m) => logs.push(m), () => new Date('2026-11-11T12:00:00Z'));
  return { auth, calls, logs };
}

describe('DemoPortalAuth.ensure', () => {
  test('a valid session passes without an API call', async () => {
    const { auth, calls } = fakeCli([status(VALID)]);
    expect(await auth.ensure()).toBe(true);
    expect(calls).toEqual(['auth status --json']);
    expect(auth.status().needed).toBe(false);
  });

  test('an expired access token is refreshed through one API call', async () => {
    const { auth, calls } = fakeCli([status(EXPIRED), status(VALID)]);
    expect(await auth.ensure()).toBe(true);
    expect(calls).toEqual(['auth status --json', 'env list --json', 'auth status --json']);
  });

  test('a refused refresh marks sign-in needed', async () => {
    const { auth, logs } = fakeCli([status(EXPIRED), status(GONE)]);
    expect(await auth.ensure()).toBe(false);
    expect(auth.status()).toMatchObject({ needed: true, reason: 'not signed in', checkedAt: '2026-11-11T12:00:00.000Z' });
    expect(logs.some((l) => l.includes('DemoPortal sign-in needed'))).toBe(true);
  });

  test('a failing check lets the job start', async () => {
    const { auth } = fakeCli([{ exitCode: 1, stdout: '', stderr: 'boom' }]);
    expect(await auth.ensure()).toBe(true);
    expect(auth.status().needed).toBe(false);
  });
});

describe('DemoPortalAuth.peek', () => {
  test('a session that can refresh counts as signed in; none marks it needed', async () => {
    const { auth, calls } = fakeCli([status(EXPIRED), status(GONE)]);
    await auth.peek();
    expect(auth.status().needed).toBe(false);
    await auth.peek();
    expect(auth.status()).toMatchObject({ needed: true, reason: 'not signed in' });
    expect(calls.every((c) => c === 'auth status --json')).toBe(true);
  });
});

describe('DemoPortalAuth.startLogin', () => {
  test('returns the code, then records the sign-in and wakes the watcher', async () => {
    let finish!: () => void;
    const { auth } = fakeCli([status(GONE)], async (onLine) => {
      onLine?.('Open https://microsoft.com/devicelogin and enter the code ABC123 to sign in.');
      onLine?.('  URL:  https://microsoft.com/devicelogin');
      onLine?.('  Code: ABC123');
      await new Promise<void>((r) => { finish = r; });
      return ok(JSON.stringify({ signedIn: true, account: 'rf@continia.com', expiresAt: 'x' }));
    });
    await auth.peek();
    let woken = 0;
    auth.onSignedIn = () => { woken++; };

    const started = await auth.startLogin('rf@continia.com');
    expect(started.login).toMatchObject({ state: 'waiting', userCode: 'ABC123', verificationUri: 'https://microsoft.com/devicelogin', startedBy: 'rf@continia.com' });
    // A second press while waiting shows the same code.
    expect((await auth.startLogin('other')).login).toMatchObject({ userCode: 'ABC123', startedBy: 'rf@continia.com' });

    finish();
    await Bun.sleep(10);
    expect(auth.status()).toMatchObject({ needed: false, login: { state: 'done', account: 'rf@continia.com', userCode: null } });
    expect(woken).toBe(1);
  });

  test('a declined sign-in fails with the CLI error and keeps sign-in needed', async () => {
    const { auth } = fakeCli([status(GONE)], async () => ({ exitCode: 1, stdout: JSON.stringify({ signedIn: false, error: 'Azure AD sign-in was declined.' }), stderr: '' }));
    await auth.peek();
    const res = await auth.startLogin('rf');
    expect(res).toMatchObject({ needed: true, login: { state: 'failed', error: 'Azure AD sign-in was declined.' } });
  });
});
