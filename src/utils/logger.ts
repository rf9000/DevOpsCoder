export interface Logger {
  info(message: string): void;
  warn(message: string, payload?: Record<string, unknown>): void;
  error(message: string, err?: unknown): void;
}

function timestamp(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

export function createLogger(prefix?: string): Logger {
  const fmt = (msg: string) =>
    prefix ? `[${timestamp()}] [${prefix}] ${msg}` : `[${timestamp()}] ${msg}`;
  return {
    info(msg) {
      console.log(fmt(msg));
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
      console.warn(parts.join(' :: '));
    },
    error(msg, err) {
      const line = err
        ? `${fmt(msg)} :: ${err instanceof Error ? err.message : String(err)}`
        : fmt(msg);
      console.error(line);
    },
  };
}
