export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** True when the process was killed because it exceeded `timeoutMs`. */
  timedOut?: boolean;
}

export type Env = Record<string, string | undefined>;

/** `env` replaces the inherited environment when given; `timeoutMs` kills the process; `onLine` gets each output line as it arrives. */
export type RunProcess = (
  cmd: string[],
  cwd: string,
  env?: Env,
  timeoutMs?: number,
  onLine?: (line: string) => void,
) => Promise<ProcessResult>;

/**
 * On POSIX the command runs in its own session (setsid), so a timeout can
 * kill the whole process group: a hung grandchild (continia, alc, claude, git)
 * would otherwise survive and hold the output pipes open.
 */
export function spawnCommand(cmd: string[], platform: NodeJS.Platform = process.platform): string[] {
  return platform === 'win32' ? cmd : ['setsid', ...cmd];
}

/** SIGTERM to the group, SIGKILL after this; give up on the pipes after OUTPUT_GRACE_MS. */
const KILL_GRACE_MS = 5_000;
const OUTPUT_GRACE_MS = 7_000;

/** Reads a stream to its end; with `onLine`, also hands over each line as it arrives. */
async function readStream(stream: ReadableStream<Uint8Array>, onLine?: (line: string) => void): Promise<string> {
  if (!onLine) return new Response(stream).text();
  const decoder = new TextDecoder();
  let text = '';
  let partial = '';
  for await (const chunk of stream) {
    const piece = decoder.decode(chunk, { stream: true });
    text += piece;
    const lines = (partial + piece).split(/\r?\n/);
    partial = lines.pop() ?? '';
    for (const line of lines) onLine(line);
  }
  const rest = decoder.decode();
  text += rest;
  partial += rest;
  if (partial) onLine(partial);
  return text;
}

/** Runs a command and returns its full output; `onLine` streams it. Never throws on non-zero exit. */
export const runProcess: RunProcess = async (cmd, cwd, env, timeoutMs, onLine) => {
  const proc = Bun.spawn(spawnCommand(cmd), { cwd, env, stdout: 'pipe', stderr: 'pipe' });
  const killGroup = (signal: NodeJS.Signals) => {
    try {
      if (process.platform === 'win32') proc.kill(signal);
      else process.kill(-proc.pid, signal);
    } catch {
      // already gone
    }
  };
  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let startGrace: () => void = () => {};
  const gaveUp = new Promise<null>((resolve) => {
    startGrace = () => { graceTimer = setTimeout(() => resolve(null), OUTPUT_GRACE_MS); };
  });
  const timer = timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        killGroup('SIGTERM');
        killTimer = setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS);
        startGrace();
      }, timeoutMs)
    : undefined;
  try {
    const output = Promise.all([
      readStream(proc.stdout, onLine),
      readStream(proc.stderr, onLine),
      proc.exited,
    ]);
    const done = await Promise.race([output, gaveUp]);
    if (done === null) {
      return { exitCode: -1, stdout: '', stderr: 'killed after timeout; output pipes still held open', timedOut: true };
    }
    const [stdout, stderr, exitCode] = done;
    return { exitCode, stdout, stderr, timedOut };
  } finally {
    // Leader gone does not mean the group is: make sure nothing survives a timeout.
    if (timedOut) killGroup('SIGKILL');
    clearTimeout(timer);
    clearTimeout(killTimer);
    clearTimeout(graceTimer);
  }
};

/** mutant-fixer's own config keys (src/config/index.ts). */
const OWN_KEYS = new Set([
  'STATE_DIR',
  'WORK_DIR',
  'CLAUDE_MODEL',
  'POLL_INTERVAL_MINUTES',
  'PRODUCTS_CONFIG',
  'AL_MUTATION_PATH',
  'DEVOPSCODER_PATH',
  'BOT_IDENTITIES',
  'MAX_ATTEMPTS',
  'RUN_NO_START',
  'PWSH_PATH',
  'AL_MUTATION_RESULTS_DIR',
  'PROCESS_TIMEOUT_MINUTES',
  'SKILL_TIMEOUT_MINUTES',
  'VERIFY_TIMEOUT_MINUTES',
  'NO_START_AFTER_UTC',
  'KEEP_FAILED_ENVIRONMENT',
  // DevOpsCoder spends against the limit in its own .env; an inherited value would win over it.
  'MAX_COST_USD_PER_WI',
]);

/** Environment without the ADO PAT, org and project. */
export function withoutAdoCredentials(env: Env): Env {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('AZURE_DEVOPS_')));
}

/**
 * Environment for a sibling tool with its own `.env`: Bun does not override
 * inherited variables, so drop everything mutant-fixer's config defines.
 */
export function siblingEnv(env: Env): Env {
  return Object.fromEntries(
    Object.entries(withoutAdoCredentials(env)).filter(([key]) => !OWN_KEYS.has(key)),
  );
}

/** Output lines without ANSI colours, pwsh's `|` gutter, `~~~` markers and blank lines. */
function meaningfulLines(text: string): string[] {
  return text
    .replace(/\x1b\[[0-9;]*m/g, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\|\s?/, '').trim())
    .filter((line) => line && !/^~+$/.test(line));
}

/**
 * pwsh prints a script-level `throw` as `Exception: <message>` wrapped over
 * several lines; the message is that line and the rest, joined. Undefined when
 * the last `Exception:` line names a script location instead: then the
 * message is the last line.
 */
function wrappedException(lines: string[]): string | undefined {
  const start = lines.findLastIndex((line) => line.startsWith('Exception:'));
  if (start < 0) return undefined;
  const first = lines[start]!.slice('Exception:'.length).trim();
  if (/\.ps(m|d)?1:\d+$/.test(first)) return undefined;
  return [first, ...lines.slice(start + 1)].join(' ');
}

/**
 * Throws when the process timed out or exited non-zero. The first line names
 * the reason (last stderr line, else last stdout line), so one-line views show
 * it; the last 20 lines follow.
 */
export function checkResult(result: ProcessResult, cmd: string[], timeoutMs?: number): void {
  const label = cmd.slice(0, 4).join(' ');
  if (result.timedOut) {
    throw new Error(`${label} timed out after ${Math.round((timeoutMs ?? 0) / 60_000)} min`);
  }
  if (result.exitCode !== 0) {
    const errLines = meaningfulLines(result.stderr);
    const lines = errLines.length > 0 ? errLines : meaningfulLines(result.stdout);
    const reason = wrappedException(lines) ?? lines.at(-1) ?? '(no output)';
    const tail = lines.slice(-20).join('\n');
    throw new Error(`${label} exited ${result.exitCode}: ${reason}${tail ? `\n${tail}` : ''}`);
  }
}

export async function runChecked(
  run: RunProcess,
  cmd: string[],
  cwd: string,
  timeoutMs?: number,
  onLine?: (line: string) => void,
): Promise<string> {
  const result = await run(cmd, cwd, undefined, timeoutMs, onLine);
  checkResult(result, cmd, timeoutMs);
  return result.stdout;
}
