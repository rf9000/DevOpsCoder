import type { RunProcess } from './process-runner.ts';

/** The device-code sign-in started from the dashboard (`continia auth login`). */
export interface SignInLogin {
  /** `starting` until the CLI prints the code; `waiting` until someone enters it. */
  state: 'starting' | 'waiting' | 'done' | 'failed';
  userCode: string | null;
  verificationUri: string | null;
  startedBy: string;
  startedAt: string;
  endedAt: string | null;
  account: string | null;
  error: string | null;
}

/** DemoPortal's Azure AD session as /status reports it. */
export interface SignInStatus {
  /** True when the last check found no usable session: no job starts until someone signs in. */
  needed: boolean;
  reason: string | null;
  checkedAt: string | null;
  /** The newest dashboard sign-in since the service started; null when none. */
  login: SignInLogin | null;
}

/** What the watcher and the control API use; tests pass fakes. */
export interface DemoPortalSession {
  status(): SignInStatus;
  /** Reads the cached session without network calls; updates `needed`. */
  peek(): Promise<void>;
  /** Before a job: refreshes an expired access token with one API call. True when a session is usable. */
  ensure(): Promise<boolean>;
  /** Starts `continia auth login` unless one is in progress; resolves once the code is known or the login ended. */
  startLogin(startedBy: string): Promise<SignInStatus>;
  /** Called after a sign-in completed (wakes the watcher). */
  onSignedIn?: () => void;
}

interface AuthStatusJson {
  azureAd?: { signedIn?: boolean; sessionValid?: boolean; canRefresh?: boolean };
}

/** A device code stays valid for 15 minutes; give the CLI a little longer. */
const LOGIN_TIMEOUT_MS = 16 * 60_000;
const CHECK_TIMEOUT_MS = 2 * 60_000;
/** How long POST /signin waits for the CLI to print the code. */
const CODE_WAIT_MS = 20_000;

export class DemoPortalAuth implements DemoPortalSession {
  private needed = false;
  private reason: string | null = null;
  private checkedAt: string | null = null;
  private login: SignInLogin | null = null;
  private codeShown: (() => void) | null = null;
  onSignedIn?: () => void;

  constructor(
    private cli: string,
    private cwd: string,
    private run: RunProcess,
    private log: (message: string) => void,
    private now: () => Date = () => new Date(),
  ) {}

  status(): SignInStatus {
    return { needed: this.needed, reason: this.reason, checkedAt: this.checkedAt, login: this.login ? { ...this.login } : null };
  }

  /** `auth status --json`; null when the CLI fails or prints no JSON. */
  private async readStatus(): Promise<AuthStatusJson['azureAd'] | null> {
    const cmd = [this.cli, 'auth', 'status', '--json'];
    const result = await this.run(cmd, this.cwd, undefined, CHECK_TIMEOUT_MS);
    if (result.exitCode !== 0) {
      this.log(`  DemoPortal sign-in check failed: continia auth status exited ${result.exitCode}`);
      return null;
    }
    try {
      return (JSON.parse(result.stdout) as AuthStatusJson).azureAd ?? null;
    } catch {
      this.log('  DemoPortal sign-in check failed: continia auth status printed no JSON');
      return null;
    }
  }

  private mark(needed: boolean, reason: string | null): void {
    if (needed && !this.needed) this.log(`DemoPortal sign-in needed (${reason}): no job starts until someone signs in from the dashboard or runs continia auth login`);
    this.needed = needed;
    this.reason = needed ? reason : null;
    this.checkedAt = this.now().toISOString();
  }

  async peek(): Promise<void> {
    const s = await this.readStatus();
    if (!s) return;
    if (s.sessionValid || s.canRefresh) this.mark(false, null);
    else this.mark(true, s.signedIn ? 'session expired' : 'not signed in');
  }

  async ensure(): Promise<boolean> {
    let s = await this.readStatus();
    // The check itself failing must not hold jobs back: the job reports its own sign-in error.
    if (!s) return true;
    if (!s.sessionValid && s.canRefresh) {
      // Any API call refreshes the access token; a refused refresh (invalid_grant) clears the session.
      await this.run([this.cli, 'env', 'list', '--json'], this.cwd, undefined, CHECK_TIMEOUT_MS);
      s = await this.readStatus();
      if (!s) return true;
    }
    if (s.sessionValid) {
      this.mark(false, null);
      return true;
    }
    this.mark(true, s.signedIn ? 'session expired and could not be refreshed' : 'not signed in');
    return false;
  }

  async startLogin(startedBy: string): Promise<SignInStatus> {
    if (this.login?.state === 'starting' || this.login?.state === 'waiting') return this.status();
    const login: SignInLogin = {
      state: 'starting', userCode: null, verificationUri: null, startedBy,
      startedAt: this.now().toISOString(), endedAt: null, account: null, error: null,
    };
    this.login = login;
    this.log(`DemoPortal sign-in started from the dashboard by ${startedBy}`);
    const shown = new Promise<void>((resolve) => { this.codeShown = resolve; });
    void this.runLogin(login);
    await Promise.race([shown, new Promise((resolve) => setTimeout(resolve, CODE_WAIT_MS))]);
    return this.status();
  }

  private async runLogin(login: SignInLogin): Promise<void> {
    // The CLI prints "  URL:  <uri>" and "  Code: <code>" on stderr, then waits for the sign-in.
    const onLine = (line: string) => {
      const url = line.match(/^\s*URL:\s+(\S+)/);
      if (url) login.verificationUri = url[1]!;
      const code = line.match(/^\s*Code:\s+(\S+)/);
      if (code) login.userCode = code[1]!;
      if (login.state === 'starting' && login.userCode && login.verificationUri) {
        login.state = 'waiting';
        this.codeShown?.();
      }
    };
    let error: string | null = null;
    try {
      const result = await this.run([this.cli, 'auth', 'login', '--json'], this.cwd, undefined, LOGIN_TIMEOUT_MS, onLine);
      let out: { signedIn?: boolean; account?: string | null; error?: string } = {};
      try {
        out = JSON.parse(result.stdout);
      } catch {
        // no JSON: the exit code decides
      }
      if (result.timedOut) error = 'timed out waiting for the code to be entered';
      else if (result.exitCode !== 0 || out.signedIn !== true) error = out.error ?? `continia auth login exited ${result.exitCode}`;
      else login.account = out.account ?? null;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    login.endedAt = this.now().toISOString();
    login.userCode = null;
    if (error) {
      login.state = 'failed';
      login.error = error;
      this.log(`DemoPortal sign-in failed: ${error}`);
    } else {
      login.state = 'done';
      this.mark(false, null);
      this.log(`DemoPortal signed in${login.account ? ` as ${login.account}` : ''}`);
      this.onSignedIn?.();
    }
    this.codeShown?.();
    this.codeShown = null;
  }
}
