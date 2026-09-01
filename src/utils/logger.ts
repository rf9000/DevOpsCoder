export interface Logger {
  info(message: string): void;
  warn(message: string, payload?: Record<string, unknown>): void;
  error(message: string, err?: unknown): void;
}

/**
 * Receives each fully formatted log line, exactly as the console got it.
 *
 * Taking the formatted line — rather than the raw message — is what lets a
 * per-WI log file be byte-identical to `docker logs`. A sink that re-formatted
 * would drift the moment the format changed in one place and not the other.
 */
export type LogSink = (line: string) => void;

function timestamp(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

export function createLogger(prefix?: string, sinks?: LogSink[]): Logger {
  const fmt = (msg: string) =>
    prefix ? `[${timestamp()}] [${prefix}] ${msg}` : `[${timestamp()}] ${msg}`;

  // A failing sink is a bookkeeping problem, never a reason to lose the line or
  // fail the run — the console write has already happened by this point.
  const fanOut = (line: string) => {
    if (!sinks) return;
    for (const sink of sinks) {
      try {
        sink(line);
      } catch {
        // Deliberately silent: warning here would recurse back through the sink.
      }
    }
  };

  return {
    info(msg) {
      const line = fmt(msg);
      console.log(line);
      fanOut(line);
    },
    warn(msg, payload) {
      const parts = [fmt(msg)];
      if (payload) {
        const { err, ...rest } = payload;
        const errStr = err instanceof Error ? err.message : err !== undefined ? String(err) : undefined;
        if (errStr) parts.push(errStr);
        const extraKeys = Object.keys(rest);
        if (extraKeys.length > 0) {
          parts.push(JSON.stringify(rest));
        }
      }
      const line = parts.join(' :: ');
      console.warn(line);
      fanOut(line);
    },
    error(msg, err) {
      const line = err
        ? `${fmt(msg)} :: ${err instanceof Error ? err.message : String(err)}`
        : fmt(msg);
      console.error(line);
      fanOut(line);
    },
  };
}
