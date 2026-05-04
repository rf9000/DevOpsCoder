export interface Logger {
  info(message: string): void;
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
    error(msg, err) {
      const line = err
        ? `${fmt(msg)} :: ${err instanceof Error ? err.message : String(err)}`
        : fmt(msg);
      console.error(line);
    },
  };
}
