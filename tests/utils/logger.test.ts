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
