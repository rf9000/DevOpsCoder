import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createWiLogFactory } from '../../src/services/wi-log.ts';
import type { Logger } from '../../src/utils/logger.ts';

function makeLogger(): Logger & { warns: string[] } {
  const warns: string[] = [];
  return {
    warns,
    info: () => {},
    warn: (m) => warns.push(m),
    error: () => {},
  };
}

describe('createWiLogFactory', () => {
  let dir: string;
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wilog-'));
    console.log = mock(() => {}) as unknown as typeof console.log;
    console.warn = mock(() => {}) as unknown as typeof console.warn;
    console.error = mock(() => {}) as unknown as typeof console.error;
  });

  afterEach(() => {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
    rmSync(dir, { recursive: true, force: true });
  });

  const read = (id: number) => readFileSync(join(dir, `WI${id}.log`), 'utf-8');

  it('names the file WI<id>.log', () => {
    createWiLogFactory({ dir, logger: makeLogger() }).open(77843);
    expect(existsSync(join(dir, 'WI77843.log'))).toBe(true);
  });

  it('creates the log directory when it does not exist', () => {
    const nested = join(dir, 'a', 'b');
    createWiLogFactory({ dir: nested, logger: makeLogger() }).open(1);
    expect(existsSync(join(nested, 'WI1.log'))).toBe(true);
  });

  it('opens with a run separator carrying the timestamp', () => {
    const now = () => new Date('2026-09-01T07:45:57.000Z');
    createWiLogFactory({ dir, logger: makeLogger(), now }).open(77843);
    expect(read(77843)).toContain('=== run 2026-09-01T07:45:57.000Z ===');
  });

  it('writes logger lines into the file', () => {
    const wi = createWiLogFactory({ dir, logger: makeLogger() }).open(77843);
    wi.logger.info('build-and-test: deploying 6 app(s)');
    expect(read(77843)).toContain('build-and-test: deploying 6 app(s)');
  });

  it('writes warn and error lines into the file too', () => {
    const wi = createWiLogFactory({ dir, logger: makeLogger() }).open(1);
    wi.logger.warn('102 codeunit(s) dropped');
    wi.logger.error('stage failed', new Error('boom'));
    const out = read(1);
    expect(out).toContain('102 codeunit(s) dropped');
    expect(out).toContain('stage failed');
    expect(out).toContain('boom');
  });

  it('timestamps each logger line the same way the console does', () => {
    const wi = createWiLogFactory({ dir, logger: makeLogger() }).open(1);
    wi.logger.info('hello');
    expect(read(1)).toMatch(/\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] hello/);
  });

  it('append() writes a raw block with no timestamp prefix', () => {
    const wi = createWiLogFactory({ dir, logger: makeLogger() }).open(1);
    wi.append('| **Total** | **$17.3600** |\n');
    expect(read(1)).toContain('| **Total** | **$17.3600** |');
    expect(read(1)).not.toMatch(/\] \| \*\*Total/);
  });

  // A resumed WI banks most of its spend in an earlier cycle. Truncating on
  // reopen would throw away the very lines that explain the running total.
  it('appends to an existing file rather than truncating it', () => {
    const factory = createWiLogFactory({ dir, logger: makeLogger() });
    factory.open(77843).logger.info('first cycle');
    factory.open(77843).logger.info('second cycle');
    const out = read(77843);
    expect(out).toContain('first cycle');
    expect(out).toContain('second cycle');
  });

  it('writes one run separator per open', () => {
    const factory = createWiLogFactory({ dir, logger: makeLogger() });
    factory.open(77843);
    factory.open(77843);
    expect(read(77843).match(/=== run /g)).toHaveLength(2);
  });

  it('keeps logs for different work items in different files', () => {
    const factory = createWiLogFactory({ dir, logger: makeLogger() });
    factory.open(1).logger.info('one');
    factory.open(2).logger.info('two');
    expect(read(1)).toContain('one');
    expect(read(1)).not.toContain('two');
  });

  describe('when the log file cannot be written', () => {
    let base: ReturnType<typeof makeLogger>;
    let unwritable: string;

    beforeEach(() => {
      base = makeLogger();
      // A file where the directory is expected makes every write fail.
      unwritable = join(dir, 'blocked');
      writeFileSync(unwritable, 'not a directory');
    });

    it('does not throw from open()', () => {
      const factory = createWiLogFactory({ dir: unwritable, logger: base });
      expect(() => factory.open(1)).not.toThrow();
    });

    it('does not throw from a logged line', () => {
      const wi = createWiLogFactory({ dir: unwritable, logger: base }).open(1);
      expect(() => wi.logger.info('still runs')).not.toThrow();
    });

    it('does not throw from append()', () => {
      const wi = createWiLogFactory({ dir: unwritable, logger: base }).open(1);
      expect(() => wi.append('block')).not.toThrow();
    });

    it('warns once per factory rather than on every line', () => {
      const wi = createWiLogFactory({ dir: unwritable, logger: base }).open(1);
      wi.logger.info('a');
      wi.logger.info('b');
      wi.append('c');
      expect(base.warns).toHaveLength(1);
      expect(base.warns[0]).toContain('WI log');
    });
  });
});
