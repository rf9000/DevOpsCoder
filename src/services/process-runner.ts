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
