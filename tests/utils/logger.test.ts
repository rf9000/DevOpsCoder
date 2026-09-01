import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { createLogger } from '../../src/utils/logger.ts';

describe('createLogger', () => {
  let logSpy: ReturnType<typeof mock>;
  let errorSpy: ReturnType<typeof mock>;
  const originalLog = console.log;
  const originalError = console.error;

  beforeEach(() => {
    logSpy = mock(() => {});
    errorSpy = mock(() => {});
    console.log = logSpy as unknown as typeof console.log;
    console.error = errorSpy as unknown as typeof console.error;
  });

  afterEach(() => {
    console.log = originalLog;
    console.error = originalError;
  });

  it('info() writes timestamped message to console.log', () => {
    const logger = createLogger();
    logger.info('hello');
    expect(logSpy).toHaveBeenCalledTimes(1);
    const call = logSpy.mock.calls[0]?.[0] as string;
    expect(call).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] hello$/);
  });

  it('info() includes prefix when provided', () => {
    const logger = createLogger('wi-123');
    logger.info('working');
    const call = logSpy.mock.calls[0]?.[0] as string;
    expect(call).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] \[wi-123\] working$/);
  });

  it('error() writes to console.error and includes Error message', () => {
    const logger = createLogger();
    logger.error('boom', new Error('disk full'));
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const call = errorSpy.mock.calls[0]?.[0] as string;
    expect(call).toContain('boom');
    expect(call).toContain('disk full');
  });

  it('error() works without an error argument', () => {
    const logger = createLogger();
    logger.error('lone');
    const call = errorSpy.mock.calls[0]?.[0] as string;
    expect(call).toContain('lone');
    expect(call).not.toContain('::');
  });
});

describe('createLogger sinks', () => {
  let logSpy: ReturnType<typeof mock>;
  let warnSpy: ReturnType<typeof mock>;
  let errorSpy: ReturnType<typeof mock>;
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;

  beforeEach(() => {
    logSpy = mock(() => {});
    warnSpy = mock(() => {});
    errorSpy = mock(() => {});
    console.log = logSpy as unknown as typeof console.log;
    console.warn = warnSpy as unknown as typeof console.warn;
    console.error = errorSpy as unknown as typeof console.error;
  });

  afterEach(() => {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  });

  // The per-WI log file must be byte-identical to what the operator saw in
  // `docker logs`; a sink that re-formats would drift from the console.
  it('sends info() the same formatted line the console received', () => {
    const seen: string[] = [];
    createLogger(undefined, [(line) => seen.push(line)]).info('hello');
    expect(seen).toEqual([logSpy.mock.calls[0]?.[0] as string]);
  });

  it('sends warn() the same formatted line the console received', () => {
    const seen: string[] = [];
    createLogger(undefined, [(line) => seen.push(line)]).warn('careful', { err: 'oops' });
    expect(seen).toEqual([warnSpy.mock.calls[0]?.[0] as string]);
  });

  it('sends error() the same formatted line the console received', () => {
    const seen: string[] = [];
    createLogger(undefined, [(line) => seen.push(line)]).error('boom', new Error('disk full'));
    expect(seen).toEqual([errorSpy.mock.calls[0]?.[0] as string]);
  });

  it('includes the prefix in the sink line', () => {
    const seen: string[] = [];
    createLogger('wi-123', [(line) => seen.push(line)]).info('working');
    expect(seen[0]).toContain('[wi-123] working');
  });

  it('fans out to every sink', () => {
    const a: string[] = [];
    const b: string[] = [];
    createLogger(undefined, [(l) => a.push(l), (l) => b.push(l)]).info('x');
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  // A broken log file must not take the pipeline down with it.
  it('still writes to the console when a sink throws', () => {
    const logger = createLogger(undefined, [
      () => {
        throw new Error('disk full');
      },
    ]);
    expect(() => logger.info('survives')).not.toThrow();
    expect(logSpy).toHaveBeenCalledTimes(1);
  });
});
